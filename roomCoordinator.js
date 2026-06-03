/**
 * roomCoordinator.js — Simple Room placement service
 *
 * - Queries Redis-based SFU node registry (set `sfu:nodes` and per-node `sfu:node:<id>:meta`)
 * - Picks the healthiest node by (region match, clients, rooms)
 * - Falls back to local node when registry is unavailable
 */
import os from 'os';

export default function createRoomCoordinator({ redis, localNodeId, localNodeUrl }) {
  if (!redis) throw new Error('Redis client required');
  const NODE_REGISTRY_KEY = 'sfu:nodes';

  async function listNodes() {
    try {
      const ids = await redis.zrange(NODE_REGISTRY_KEY, 0, -1);
      const metas = await Promise.all(ids.map(async id => {
        try {
          const raw = await redis.get(`sfu:node:${id}:meta`);
          return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
      }));
      return ids.map((id, i) => ({ id, meta: metas[i] })).filter(n => n.meta);
    } catch (e) {
      return [];
    }
  }

  // Pick the healthiest node. Optionally provide preferredRegion (string).
  async function selectNodeForRoom({ roomId, preferredRegion = null } = {}) {
    const nodes = await listNodes();
    if (!nodes || nodes.length === 0) {
      return { nodeId: localNodeId, url: localNodeUrl, reason: 'no-registry' };
    }

    let candidates = nodes.filter(n => n.meta && n.meta.status === 'healthy');
    if (candidates.length === 0) candidates = nodes;

    if (preferredRegion) {
      const preferred = candidates.filter(n => String(n.meta.region).toLowerCase() === String(preferredRegion).toLowerCase());
      if (preferred.length > 0) candidates = preferred;
    }

    candidates.sort((a, b) => {
      const ma = a.meta || {};
      const mb = b.meta || {};
      const aClients = Number(ma.clients || 0);
      const bClients = Number(mb.clients || 0);
      const aRooms = Number(ma.rooms || 0);
      const bRooms = Number(mb.rooms || 0);
      const aBandwidth = Number(ma.bandwidth || 0);
      const bBandwidth = Number(mb.bandwidth || 0);
      const aScore = aClients * 3 + aRooms * 2 + Math.max(0, aBandwidth / 1000);
      const bScore = bClients * 3 + bRooms * 2 + Math.max(0, bBandwidth / 1000);
      return aScore - bScore;
    });

    const chosen = candidates[0];
    if (!chosen) return { nodeId: localNodeId, url: localNodeUrl, reason: 'empty-candidates' };
    return { nodeId: chosen.id, url: chosen.meta.url || chosen.meta.nodeUrl || localNodeUrl, reason: 'selected' };
  }

  return {
    listNodes,
    selectNodeForRoom,
    localNodeId,
    localNodeUrl,
    hostname: os.hostname(),
  };
}

/**
 * pipeManager.js — Cross-worker PipeTransport routing for 500-user rooms
 *
 * WHY THIS EXISTS:
 *   Mediasoup Routers are bound 1:1 to a Worker process (one CPU core).
 *   A single Worker can safely handle ~100-150 concurrent participants.
 *   For 500 users in one Room, we need ALL CPU cores to share the forwarding load.
 *
 * HOW IT WORKS:
 *   1. A Room's "home" Router lives on Worker A (selected via round-robin at room creation).
 *   2. When a new User joins and their Worker (B, C, D…) differs from the home Worker,
 *      we create a bidirectional PipeTransport pair between the home Router (A) and the
 *      new Worker's Router (B, C, D…).
 *   3. All existing producers on the home Router are piped into the new router,
 *      so the new user can consume them locally (on their assigned core).
 *   4. The new user's producers are also piped back to the home Router,
 *      so ALL other workers see and can forward them.
 *
 * RESULT:
 *   All N CPU cores participate. Effective capacity per room ≈ N × 100-150 users.
 *   On an 8-core machine: ~800-1200 per room is achievable.
 */

const pipeTransportPairs = new Map();
// Key: `${srcRouterId}::${dstRouterId}` → { pipeA, pipeB }

// Per-room state: roomId → { homeRouter, satelliteRouters: Map<workerId, Router> }
const roomRouterTopology = new Map();

/**
 * Get or create a pipe between two routers (on different workers).
 * Pipes are bidirectional and reused across multiple produce operations.
 */
async function getOrCreatePipe(srcRouter, dstRouter) {
  const fwdKey = `${srcRouter.id}::${dstRouter.id}`;
  const revKey = `${dstRouter.id}::${srcRouter.id}`;

  if (pipeTransportPairs.has(fwdKey)) {
    return pipeTransportPairs.get(fwdKey);
  }
  if (pipeTransportPairs.has(revKey)) {
    return pipeTransportPairs.get(revKey);
  }

  console.log(`[PipeManager] Creating pipe: router ${srcRouter.id} ↔ router ${dstRouter.id}`);

  // Create a pair of PipeTransports, one on each router
  const [pipeA, pipeB] = await Promise.all([
    srcRouter.createPipeTransport({
      listenIp: process.env.MEDIASOUP_LISTEN_IP || '127.0.0.1',
      enableRtx: true,   // Retransmission — reduces inter-worker packet loss
      enableSrtp: true,  // Encrypt inter-worker media (SRTP)
    }),
    dstRouter.createPipeTransport({
      listenIp: process.env.MEDIASOUP_LISTEN_IP || '127.0.0.1',
      enableRtx: true,
      enableSrtp: true,
    }),
  ]);

  // Connect the pair to each other
  await Promise.all([
    pipeA.connect({
      ip: pipeB.tuple.localIp,
      port: pipeB.tuple.localPort,
      srtpParameters: pipeB.srtpParameters,
    }),
    pipeB.connect({
      ip: pipeA.tuple.localIp,
      port: pipeA.tuple.localPort,
      srtpParameters: pipeA.srtpParameters,
    }),
  ]);

  const pair = { pipeA, pipeB };
  pipeTransportPairs.set(fwdKey, pair);

  // Clean up pipe references when either transport closes
  pipeA.on('close', () => {
    pipeTransportPairs.delete(fwdKey);
    pipeTransportPairs.delete(revKey);
    console.log(`[PipeManager] Pipe closed: ${fwdKey}`);
  });

  return pair;
}

/**
 * Pipe a producer from srcRouter → dstRouter.
 * Returns the pipeProducer visible on dstRouter so consumers there can consume it.
 *
 * @param {mediasoup.types.Producer} producer - The original producer on srcRouter
 * @param {mediasoup.types.Router}  srcRouter  - Router that owns the producer
 * @param {mediasoup.types.Router}  dstRouter  - Router that needs to forward it
 * @returns {mediasoup.types.Producer} pipeProducer on dstRouter
 */
export async function pipeProducerToRouter(producer, srcRouter, dstRouter) {
  if (srcRouter.id === dstRouter.id) return producer; // Same router, no pipe needed

  const { pipeConsumer, pipeProducer } = await srcRouter.pipeToRouter({
    producerId: producer.id,
    router: dstRouter,
  });

  console.log(
    `[PipeManager] Piped producer ${producer.id} (${producer.kind}) ` +
    `from router ${srcRouter.id} → router ${dstRouter.id}`
  );

  // When the original producer closes, the pipe consumer/producer close automatically
  producer.on('close', () => {
    pipeConsumer?.close();
    pipeProducer?.close();
  });

  return pipeProducer;
}

/**
 * Register the home router for a room (first router created for this room).
 */
export function setHomeRouter(roomId, router) {
  if (!roomRouterTopology.has(roomId)) {
    roomRouterTopology.set(roomId, {
      homeRouter: router,
      satelliteRouters: new Map(),
    });
    console.log(`[PipeManager] Room ${roomId} → home router set (${router.id})`);
  }
}

/**
 * Get the home router for a room.
 */
export function getHomeRouter(roomId) {
  return roomRouterTopology.get(roomId)?.homeRouter || null;
}

/**
 * Register a satellite router for a room (used by consumers on a different worker).
 * Returns the router so the caller can chain operations.
 */
export function addSatelliteRouter(roomId, workerId, router) {
  const topology = roomRouterTopology.get(roomId);
  if (topology) {
    topology.satelliteRouters.set(workerId, router);
  }
  return router;
}

/**
 * Get all satellite routers for a room (all non-home worker routers).
 */
export function getSatelliteRouters(roomId) {
  return roomRouterTopology.get(roomId)?.satelliteRouters || new Map();
}

/**
 * Clean up all pipe data for a room when it closes.
 */
export function cleanupRoomPipes(roomId) {
  const topology = roomRouterTopology.get(roomId);
  if (!topology) return;

  // Close all satellite router pipes (home router is closed by worker.js)
  for (const [, satelliteRouter] of topology.satelliteRouters) {
    try { satelliteRouter.close(); } catch { /* already closed */ }
  }

  roomRouterTopology.delete(roomId);
  console.log(`[PipeManager] Cleaned up all pipe topology for room ${roomId}`);
}

/**
 * worker.js — Mediasoup Worker & Router management
 *
 * Scalability design for 500+ users per room:
 *  - One Worker per CPU core (parallel WebRTC processing)
 *  - Round-robin worker selection (load distribution)
 *  - Per-room Router with full codec support (Opus, VP8, VP9, H264)
 *  - Large port range to support many simultaneous ICE transports
 *    (each user needs 2 transports × 2 ports = 4 ports minimum)
 */
import * as mediasoup from 'mediasoup';
import os from 'os';
import { setHomeRouter, addSatelliteRouter, cleanupRoomPipes } from './pipeManager.js';

// ROUTER_MEDIA_CODECS is already exported below via `export const`

const workers = [];
let nextWorkerIndex = 0;

// ─── Codec configuration ────────────────────────────────────────────────────
// All codecs pre-declared so every router can handle whichever codec the client
// negotiates. VP9 + H264 provide much better compression than VP8 alone, which
// is critical at scale (lower bandwidth per consumer = more users supportable).
export const ROUTER_MEDIA_CODECS = [
  // ── Audio ──
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: {
      useinbandfec: 1,      // Forward-error-correction (reduces audio glitches)
      minptime: 10,
    },
  },
  // ── Video: VP8 (widest browser support) ──
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
  // ── Video: VP9 (better compression — ~50% less bandwidth than VP8) ──
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: {
      'profile-id': 2,
      'x-google-start-bitrate': 1000,
    },
  },
  // ── Video: H264 (hardware-accelerated on mobile, Safari) ──
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '4d0032',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 1000,
    },
  },
  // ── Video: H264 Baseline (older Android / iOS) ──
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 1000,
    },
  },
];

// ─── Worker configuration ────────────────────────────────────────────────────
const WORKER_CONFIG = {
  rtcMinPort: Number(process.env.MEDIASOUP_MIN_PORT || 10000),
  rtcMaxPort: Number(process.env.MEDIASOUP_MAX_PORT || 59999), // 50,000 port range
  logLevel: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
  logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
};

// ─── Transport configuration (per WebRTC transport) ──────────────────────────
export const TRANSPORT_CONFIG = {
  listenIps: [
    {
      ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
      announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null,
    },
  ],
  enableUdp: true,
  enableTcp: true,           // TCP fallback (for enterprise firewalls)
  preferUdp: true,           // UDP first (lower latency)
  enableSctp: false,         // Disabled — audio/video-only rooms don't need data channels
  // Generous bandwidth limits per transport — simulcast manages per-consumer rates
  initialAvailableOutgoingBitrate: 1_000_000,
  minimumAvailableOutgoingBitrate: 100_000,
  maxSctpMessageSize: 262144,
};

// ─── Simulcast encoding layers ────────────────────────────────────────────────
// Three spatial layers for video:
//   low  → 180p  @ ≤100 kbps  (thumbnail view, most consumers in a 500-user room)
//   mid  → 360p  @ ≤300 kbps  (standard grid view)
//   high → 720p  @ ≤900 kbps  (featured/pinned speaker)
// The SFU selects which layer to forward per-consumer, massively reducing egress.
export const VIDEO_SIMULCAST_ENCODINGS = [
  { rid: 'r0', maxBitrate: 100_000, scalabilityMode: 'S1T3', scaleResolutionDownBy: 4 },
  { rid: 'r1', maxBitrate: 300_000, scalabilityMode: 'S1T3', scaleResolutionDownBy: 2 },
  { rid: 'r2', maxBitrate: 900_000, scalabilityMode: 'S1T3', scaleResolutionDownBy: 1 },
];

export const VIDEO_PRODUCER_CODEC_OPTIONS = {
  videoGoogleStartBitrate: 1000,
};

// ─── Worker lifecycle ────────────────────────────────────────────────────────

async function createWorker() {
  const worker = await mediasoup.createWorker(WORKER_CONFIG);

  worker.on('died', (error) => {
    console.error(`[SFU Worker] Worker died (pid=${worker.pid}):`, error);
    // Remove dead worker from pool; remaining workers continue serving
    const idx = workers.findIndex(w => w.pid === worker.pid);
    if (idx !== -1) workers.splice(idx, 1);
    // Respawn a replacement worker to maintain capacity
    createWorker().then(w => {
      workers.push(w);
      console.log(`[SFU Worker] Replacement worker spawned (pid=${w.pid}). Pool size: ${workers.length}`);
    }).catch(err => {
      console.error('[SFU Worker] Failed to spawn replacement worker:', err);
    });
  });

  console.log(`[SFU Worker] Worker created (pid=${worker.pid})`);
  return worker;
}

/**
 * Initialize one Mediasoup Worker per CPU core.
 * Node.js is single-threaded; Workers are separate OS processes that handle
 * the actual media encoding/decoding in parallel across all CPU cores.
 */
export async function initializeWorkers() {
  if (workers.length > 0) return;

  const numWorkers = Number(process.env.MEDIASOUP_WORKERS || os.cpus().length);
  console.log(`[SFU Worker] Initializing ${numWorkers} worker(s) across ${os.cpus().length} CPU core(s)`);

  await Promise.all(
    Array.from({ length: numWorkers }, () =>
      createWorker().then(w => workers.push(w))
    )
  );

  console.log(`[SFU Worker] All ${workers.length} workers ready`);
}

/**
 * Round-robin worker selection ensures even load distribution.
 * In a 500-user room with 8 cores, each core handles ~62 users worth of media.
 */
export function getNextWorker() {
  if (workers.length === 0) throw new Error('No mediasoup workers available');
  const worker = workers[nextWorkerIndex % workers.length];
  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
  return worker;
}

/** Returns the full worker array (for multi-worker satellite logic in socket.js) */
export function getWorkers() {
  return workers;
}

// ─── Router management ───────────────────────────────────────────────────────

/** roomId → mediasoup home Router (the hub for that room) */
const routers = new Map();

/**
 * Get or create a Router for a room.
 *
 * For the FIRST user in a room  → create a "home" router on the next available worker
 *   and register it as the room's primary pipeline hub.
 * For SUBSEQUENT users on a DIFFERENT worker → create a per-worker "satellite" router
 *   and register it; the socket.js produce handler will pipe producers across via pipeManager.
 * For SUBSEQUENT users on the SAME worker as the home → reuse the home router directly.
 */
export async function getOrCreateRouter(roomId, preferSameWorkerAsHome = false) {
  await initializeWorkers();

  // Return existing home router if the caller just needs any router for this room
  if (routers.has(roomId) && preferSameWorkerAsHome) {
    return routers.get(roomId);
  }

  // Home router not yet created — create it
  if (!routers.has(roomId)) {
    const worker = getNextWorker();
    const router = await worker.createRouter({ mediaCodecs: ROUTER_MEDIA_CODECS });
    router._workerPid = worker.pid; // tag for satellite comparison

    router.on('workerclose', () => {
      console.warn(`[SFU Router] Home router for room ${roomId} closed (worker died). Removing.`);
      routers.delete(roomId);
      cleanupRoomPipes(roomId);
    });

    routers.set(roomId, router);
    setHomeRouter(roomId, router); // Register as the home/hub router
    console.log(`[SFU Router] Home router created for room ${roomId} on worker pid=${worker.pid} | Active rooms: ${routers.size}`);
    return router;
  }

  // Home already exists — return it
  return routers.get(roomId);
}

/**
 * Create a dedicated satellite router for a room on a DIFFERENT worker than the home router.
 * Called once per new worker that needs to serve participants in this room.
 * Returns { router, isNew } so the caller knows whether to pipe existing producers.
 */
export async function createSatelliteRouter(roomId) {
  await initializeWorkers();
  const homeRouter = routers.get(roomId);
  if (!homeRouter) return { router: await getOrCreateRouter(roomId), isNew: false };

  // Single worker — satellite IS home
  if (workers.length <= 1) return { router: homeRouter, isNew: false };

  // Round-robin, skipping the home router's worker
  const homeWorkerPid = homeRouter._workerPid;
  let targetWorker = null;
  for (let i = 0; i < workers.length; i++) {
    const candidate = workers[nextWorkerIndex % workers.length];
    nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
    if (candidate.pid !== homeWorkerPid) { targetWorker = candidate; break; }
  }
  if (!targetWorker) targetWorker = workers[nextWorkerIndex % workers.length];

  const router = await targetWorker.createRouter({ mediaCodecs: ROUTER_MEDIA_CODECS });
  router._workerPid = targetWorker.pid;
  router.on('workerclose', () => {
    console.warn(`[SFU Router] Satellite router for room ${roomId} closed`);
  });
  console.log(`[SFU Router] Satellite router for room ${roomId} on worker pid=${targetWorker.pid}`);
  return { router, isNew: true };
}

export function closeRoomRouter(roomId) {
  const router = routers.get(roomId);
  if (router) {
    router.close();
    routers.delete(roomId);
    cleanupRoomPipes(roomId); // Also clean up all pipe topology for this room
    console.log(`[SFU Router] Closed router for room ${roomId} | Active rooms: ${routers.size}`);
  }
}

// ─── Transport creation ──────────────────────────────────────────────────────

export async function createWebRtcTransport(router, appData) {
  const transport = await router.createWebRtcTransport({
    ...TRANSPORT_CONFIG,
    appData,
  });

  transport.on('dtlsstatechange', state => {
    if (state === 'closed') transport.close();
  });

  transport.on('connectionstatechange', state => {
    console.log(`[SFU Transport] ${transport.id} → ${state}`);
  });

  return transport;
}

// ─── Stats (for monitoring / autoscaling) ────────────────────────────────────

export function getSFUStats() {
  return {
    workers: workers.length,
    rooms: routers.size,
    cpus: os.cpus().length,
    workerPids: workers.map(w => w.pid),
  };
}

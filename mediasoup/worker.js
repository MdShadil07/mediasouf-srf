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

const workers = [];
let nextWorkerIndex = 0;

// ─── Codec configuration ────────────────────────────────────────────────────
// All codecs pre-declared so every router can handle whichever codec the client
// negotiates. VP9 + H264 provide much better compression than VP8 alone, which
// is critical at scale (lower bandwidth per consumer = more users supportable).
const ROUTER_MEDIA_CODECS = [
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
  enableSctp: false,         // Disable SCTP (data channel) for audio/video only rooms
  // Bandwidth limits — generous limits to avoid throttling at scale
  initialAvailableOutgoingBitrate: 600_000,
  minimumAvailableOutgoingBitrate: 100_000,
  maxSctpMessageSize: 262144,
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
function getNextWorker() {
  if (workers.length === 0) throw new Error('No mediasoup workers available');
  const worker = workers[nextWorkerIndex % workers.length];
  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
  return worker;
}

// ─── Router management ───────────────────────────────────────────────────────

/** roomId → mediasoup Router */
const routers = new Map();

/**
 * Get or create a Router for a room.
 * One Router per room — all participants in the same room share the same Router,
 * which allows the SFU to efficiently forward RTP packets between them.
 */
export async function getOrCreateRouter(roomId) {
  await initializeWorkers();

  if (routers.has(roomId)) return routers.get(roomId);

  const worker = getNextWorker();
  const router = await worker.createRouter({ mediaCodecs: ROUTER_MEDIA_CODECS });

  router.on('workerclose', () => {
    console.warn(`[SFU Router] Router for room ${roomId} closed (worker died). Removing.`);
    routers.delete(roomId);
  });

  routers.set(roomId, router);
  console.log(`[SFU Router] Created router for room ${roomId} on worker pid=${worker.pid} | Active rooms: ${routers.size}`);
  return router;
}

export function closeRoomRouter(roomId) {
  const router = routers.get(roomId);
  if (router) {
    router.close();
    routers.delete(roomId);
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

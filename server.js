// env.js MUST be imported first — ESM hoisting requires dotenv in its own module.
import './env.js';

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import Redis from 'ioredis';
import os from 'os';
import { setupSFUSocket } from './socket.js';
import { getRecentDebugEvents, getRoomDebugSnapshot } from './socket.js';
import { getSFUStats, initializeWorkers, getWorkers } from './mediasoup/worker.js';
import createRoomCoordinator from './roomCoordinator.js';
import { startMonitor, onChange as onLoadChange } from './loadMonitor.js';
import { publishSfuEvent } from './pubsub.js';

// ─── Configuration (all from environment) ────────────────────────────────────
const PORT          = Number(process.env.SFU_PORT || 3001);
const REDIS_URL     = process.env.REDIS_URL || 'redis://localhost:6379';
const SFU_NODE_ID   = process.env.SFU_NODE_ID || os.hostname();
const SFU_NODE_URL  = process.env.SFU_NODE_URL || `http://localhost:${PORT}`;
const HEARTBEAT_MS  = Number(process.env.SFU_HEARTBEAT_INTERVAL_MS || 5000);
const NODE_TTL_SEC  = Number(process.env.SFU_NODE_TTL_SECONDS || 15);

// CORS: allow multiple origins (comma-separated) or '*'
const RAW_CORS      = process.env.CORS_ORIGIN || '*';
const CORS_ORIGINS  = RAW_CORS === '*'
  ? true
  : RAW_CORS.split(',').map(o => o.trim());

const SFU_META_KEY      = `sfu:node:${SFU_NODE_ID}:meta`;
const SFU_REGISTRY_KEY  = 'sfu:nodes';

// ─── Express + HTTP ──────────────────────────────────────────────────────────
const app    = express();
const server = createServer(app);

app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// ─── Socket.IO ───────────────────────────────────────────────────────────────
const io = new SocketIOServer(server, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // Keep-alive tuning for 500 concurrent users
  pingTimeout: 10000,
  pingInterval: 10000,
  // Increase upgrade timeout for slow connections
  upgradeTimeout: 10000,
  // Transport preference: WebSocket first, polling fallback
  transports: ['websocket', 'polling'],
  // Allow 1M message size (SDP / ICE candidates can be large)
  maxHttpBufferSize: 1e6,
  // Compression (saves ~60% bandwidth on signaling messages)
  perMessageDeflate: {
    threshold: 512,
  },
  // Connection state recovery — clients auto-reconnect without losing room state
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
  },
});

// ─── Redis (node registry + heartbeat) ───────────────────────────────────────
const redis = new Redis(REDIS_URL, {
  enableReadyCheck: true,
  lazyConnect: true,
  connectTimeout: 8000,
  commandTimeout: 3000,
  maxRetriesPerRequest: null,
  retryStrategy: (times) => {
    if (times > 10) return null;
    return Math.min(times * 200, 2000);
  },
  reconnectOnError: (err) => {
    const targetErrors = ['READONLY', 'ECONNRESET'];
    return targetErrors.some(e => err.message.includes(e));
  },
});
const redisSubscriber = redis.duplicate();

let redisAvailable = false;

redis.on('ready',   () => { redisAvailable = true;  console.log('✅ SFU Redis connected'); });
redis.on('error',   (e) => { if (redisAvailable) { console.error('❌ Redis error:', e.message); redisAvailable = false; } });
redis.on('close',   () => { redisAvailable = false; });
redis.on('reconnecting', () => console.log('🔄 Redis reconnecting...'));

// ─── Heartbeat ────────────────────────────────────────────────────────────────
async function pulse() {
  if (!redisAvailable) return;
  try {
    const stats = getSFUStats();
    const payload = JSON.stringify({
      nodeId: SFU_NODE_ID,
      url:    SFU_NODE_URL,
      ts:     Date.now(),
      status: 'healthy',
      region: process.env.SFU_REGION || 'global',
      clients: io.engine.clientsCount || 0,
      rooms:   stats.rooms,
      workers: stats.workers,
      cpus:    stats.cpus,
      bandwidth: Number(process.env.SFU_ESTIMATED_BANDWIDTH_KBPS || 0),
    });
    const pipe = redis.pipeline();
    pipe.setex(SFU_META_KEY, NODE_TTL_SEC, payload);
    pipe.zadd(SFU_REGISTRY_KEY, io.engine.clientsCount || 0, SFU_NODE_ID);
    pipe.expire(SFU_REGISTRY_KEY, NODE_TTL_SEC * 2);
    await pipe.exec();
  } catch (e) {
    console.error('❌ Heartbeat failed:', e.message);
    redisAvailable = false;
  }
}

async function deregister() {
  if (!redisAvailable) return;
  try {
    await redis.pipeline()
      .del(SFU_META_KEY)
      .zrem(SFU_REGISTRY_KEY, SFU_NODE_ID)
      .exec();
    console.log('✅ Deregistered from SFU registry');
  } catch (e) {
    console.error('❌ Deregister failed:', e.message);
  }
}

// ─── Health endpoints ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const stats = getSFUStats();
  res.json({
    status:  'ok',
    service: 'mediasoup-sfu',
    nodeId:  SFU_NODE_ID,
    uptime:  Math.floor(process.uptime()),
    memory:  process.memoryUsage(),
    clients: io.engine.clientsCount || 0,
    ...stats,
    redis:   redisAvailable ? 'connected' : 'disconnected',
  });
});

// Lightweight liveness probe (used by load balancers)
app.get('/ping', (req, res) => res.send('pong'));

app.get('/', (req, res) => {
  res.json({ service: 'CognitoSpeak Mediasoup SFU', nodeId: SFU_NODE_ID, status: 'online' });
});

// Room topology for operational debugging dashboard
app.get('/debug/rooms', (req, res) => {
  const roomId = typeof req.query.roomId === 'string' ? req.query.roomId : null;
  res.json(getRoomDebugSnapshot(roomId));
});

app.get('/debug/rooms/:roomId', (req, res) => {
  res.json(getRoomDebugSnapshot(req.params.roomId));
});

app.get('/debug/events', (req, res) => {
  const limit = Number(req.query.limit || 100);
  res.json({ ts: Date.now(), events: getRecentDebugEvents(limit) });
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  console.log(`🖥️  Hardware: ${os.cpus().length} CPU cores, ${Math.round(os.totalmem() / 1e9)}GB RAM`);

  // Pre-warm mediasoup workers before accepting connections
  await initializeWorkers();

  // Register Socket.IO handler
  setupSFUSocket(io);

  // Start HTTP server
  await new Promise((resolve) => server.listen(PORT, '0.0.0.0', resolve));
  console.log(`🚀 Mediasoup SFU listening on 0.0.0.0:${PORT}  (public: ${SFU_NODE_URL})`);

  // Connect Redis (non-blocking: SFU works without it in single-node mode)
  redis.connect().catch(e => {
    console.warn('⚠️  Redis unavailable — running in single-node mode:', e.message);
  });

  // Room coordinator (placement) — lightweight API for external router
  const coordinator = createRoomCoordinator({ redis, localNodeId: SFU_NODE_ID, localNodeUrl: SFU_NODE_URL });

  // Start Redis pub/sub for cross-node signaling
  redisSubscriber.on('ready', () => console.log('✅ Redis subscriber connected'));
  redisSubscriber.on('error', (err) => console.error('❌ Redis subscriber error:', err.message));
  await redisSubscriber.connect().catch(err => console.warn('⚠️ Redis subscriber unavailable:', err.message));
  if (redisSubscriber.status === 'ready') {
    redisSubscriber.on('message', (channel, message) => {
      if (channel !== 'sfu:events') return;
      try {
        const packet = JSON.parse(message);
        if (packet.nodeId === SFU_NODE_ID) return;
        if (!packet.type) return;
        if (packet.roomId === 'global') {
          io.emit(packet.type, packet.payload);
        } else {
          io.to(packet.roomId).emit(packet.type, packet.payload);
        }
      } catch (err) {
        console.warn('[PubSub] Invalid event payload', err.message);
      }
    });
    await redisSubscriber.subscribe('sfu:events');
  }

  // Start heartbeat
  setInterval(pulse, HEARTBEAT_MS);

  app.get('/assign', async (req, res) => {
    try {
      const roomId = typeof req.query.roomId === 'string' ? req.query.roomId : null;
      const region = typeof req.query.region === 'string' ? req.query.region : null;
      const pick = await coordinator.selectNodeForRoom({ roomId, preferredRegion: region });
      res.json({ ok: true, nodeId: pick.nodeId, url: pick.url, region: region || 'auto', reason: pick.reason });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Start load monitor and broadcast degradation events to connected sockets
  startMonitor();
  onLoadChange(async (s) => {
    console.log('[LoadMonitor] state change:', s);
    const payload = { nodeId: SFU_NODE_ID, ...s };
    try {
      io.emit('sfu:degraded', payload);
      await publishSfuEvent('sfu:degraded', 'global', payload);
    } catch (e) { /* ignore */ }
  });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n🛑 ${signal} received — graceful shutdown`);

  // 1. Stop accepting new Socket.IO connections
  io.close();

  // 2. Deregister from Redis so load balancer stops routing here
  await deregister();

  // 3. Allow in-flight requests 5s to complete
  await new Promise(r => setTimeout(r, 2000));

  // 4. Close Redis
  try { await redis.quit(); } catch { /* ignore */ }

  console.log('✅ SFU shutdown complete');
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Prevent crashes from unhandled rejections — log and continue
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️  Unhandled rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught exception:', err);
  // Don't exit — PM2/Docker will restart if actually fatal
});

start().catch(err => {
  console.error('💥 SFU startup failed:', err);
  process.exit(1);
});

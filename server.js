// env.js MUST be imported first — ESM hoisting requires dotenv in its own module.
import './env.js';

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import Redis from 'ioredis';
import os from 'os';
import { setupSFUSocket } from './socket.js';
import { getSFUStats, initializeWorkers } from './mediasoup/worker.js';

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

app.use(express.json({ limit: '1mb' }));

// ─── Socket.IO ───────────────────────────────────────────────────────────────
const io = new SocketIOServer(server, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // Keep-alive tuning for 500 concurrent users
  pingTimeout: 60000,
  pingInterval: 25000,
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
  maxRetriesPerRequest: null,      // Required for Bull/BullMQ compatibility
  retryStrategy: (times) => {
    if (times > 10) return null;   // Stop after 10 retries
    return Math.min(times * 200, 2000);
  },
  reconnectOnError: (err) => {
    const targetErrors = ['READONLY', 'ECONNRESET'];
    return targetErrors.some(e => err.message.includes(e));
  },
});

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
      clients: io.engine.clientsCount || 0,
      rooms:   stats.rooms,
      workers: stats.workers,
      cpus:    stats.cpus,
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

  // Start heartbeat
  setInterval(pulse, HEARTBEAT_MS);
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

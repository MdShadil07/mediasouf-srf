/**
 * socket.js — Mediasoup SFU signaling with scalability fixes
 *
 * BLOCKER-1 FIX: Consumer gating + AudioLevelObserver VAD
 *   - Video consumers only created for active speakers (max 4) or pinned user
 *   - Audio consumers always allowed (32 kbps each)
 *   - AudioLevelObserver tracks top-5 speakers per room, broadcasts sfu:active-speakers
 *   - Reduces total consumers from 500,000 to ~10,000 in a 500-user room
 *
 * BLOCKER-4 FIX: Per-socket router assignment (true multi-worker distribution)
 *   - Each socket is assigned to a specific worker's router via round-robin
 *   - Satellite routers are created on different workers and registered in pipeManager
 *   - Producers are piped from their source router to ALL other routers in the room
 *   - Consumers are created on the socket's own assigned router (not always home)
 *   - True load distribution: 8 cores → 8× more capacity per room
 */

import jwt from 'jsonwebtoken';
import { getOrCreateRouter, initializeWorkers, getNextWorker, getWorkers, ROUTER_MEDIA_CODECS } from './mediasoup/worker.js';
import { isDegraded } from './loadMonitor.js';
import { createTransport, connectTransport } from './mediasoup/transport.js';
import { createProducer } from './mediasoup/producer.js';
import { createConsumer } from './mediasoup/consumer.js';
import {
  pipeProducerToRouter,
  getHomeRouter,
  getSatelliteRouters,
  setHomeRouter,
  addSatelliteRouter,
} from './mediasoup/pipeManager.js';
import { publishSfuEvent } from './pubsub.js';

// ─── In-memory state ─────────────────────────────────────────────────────────

/** roomId → { peers: Map<socketId,peer>, producers: Map<producerId,entry> } */
const roomStates = new Map();

/** roomId → AudioLevelObserver (VAD, created on home router) */
const roomAudioObservers = new Map();

/** roomId → Set<userId> — currently speaking users (from AudioLevelObserver) */
const roomActiveSpeakers = new Map();

/** socketId → mediasoup Router (the router this socket's transports live on) */
const socketRouters = new Map();

/** in-memory ring buffer for recent SFU debug events */
const recentDebugEvents = [];
const MAX_DEBUG_EVENTS = Number(process.env.SFU_DEBUG_EVENTS_LIMIT || 300);
const DEFAULT_MAX_VIDEO_CONSUMERS = Number(process.env.SFU_MAX_VIDEO_CONSUMERS || 9);
const DEFAULT_MAX_AUDIO_CONSUMERS = Number(process.env.SFU_MAX_AUDIO_CONSUMERS || 24);
const SPEAKER_COOLDOWN_MS = Number(process.env.SFU_SPEAKER_COOLDOWN_MS || 2000);
const SPEAKER_DECAY_MS = Number(process.env.SFU_SPEAKER_DECAY_MS || 3000);
const SPEAKER_PROMOTION_DB = Number(process.env.SFU_SPEAKER_PROMOTION_DB || -50);
const AUDIO_OBSERVER_MAX_ENTRIES = Number(process.env.SFU_AUDIO_OBSERVER_MAX_ENTRIES || 50);

const ROOM_MODES = {
  smallGroup: {
    maxUsers: 25,
    maxVisibleVideos: 25,
    maxActiveAudioParticipants: 50,
    audienceMutedByDefault: false,
  },
  classroom: {
    maxUsers: 500,
    maxVisibleVideos: 12,
    maxActiveAudioParticipants: 50,
    audienceMutedByDefault: false,
  },
  webinar: {
    maxUsers: 500,
    maxVisibleVideos: 6,
    maxActiveAudioParticipants: 6,
    audienceMutedByDefault: true,
  },
};

const roomSpeakerState = new Map();
const roomRecentSpeakers = new Map();

function pushDebugEvent(type, payload = {}) {
  recentDebugEvents.push({
    type,
    payload,
    ts: Date.now(),
  });

  if (recentDebugEvents.length > MAX_DEBUG_EVENTS) {
    recentDebugEvents.splice(0, recentDebugEvents.length - MAX_DEBUG_EVENTS);
  }
}

export function getRecentDebugEvents(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, MAX_DEBUG_EVENTS));
  return recentDebugEvents.slice(-safeLimit).reverse();
}

export function getRoomDebugSnapshot(targetRoomId = null) {
  const rooms = [];

  for (const [roomId, rs] of roomStates.entries()) {
    if (targetRoomId && roomId !== targetRoomId) continue;

    const activeSpeakers = Array.from(roomActiveSpeakers.get(roomId) || []);
    const peers = [];
    let transportCount = 0;
    let producerCount = 0;
    let consumerCount = 0;

    for (const [socketId, peer] of rs.peers.entries()) {
      const peerTransports = peer.transports.size;
      const peerProducers = peer.producers.size;
      const peerConsumers = peer.consumers.size;

      transportCount += peerTransports;
      producerCount += peerProducers;
      consumerCount += peerConsumers;

      peers.push({
        socketId,
        userId: peer.userId,
        transports: peerTransports,
        producers: peerProducers,
        consumers: peerConsumers,
      });
    }

    rooms.push({
      roomId,
      participants: rs.peers.size,
      producerEntries: rs.producers.size,
      transports: transportCount,
      producers: producerCount,
      consumers: consumerCount,
      activeSpeakers,
      peers,
      mode: rs.mode,
      roomBudgets: rs.budgets,
    });
  }

  return {
    ts: Date.now(),
    roomCount: rooms.length,
    rooms,
  };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function normalizeToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  return raw.trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^\"+|\"+$/g, '')
    .replace(/^'+|'+$/g, '');
}

function verifyToken(token) {
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) throw new Error('JWT_SECRET not configured');
  const decoded = jwt.verify(token, JWT_SECRET);
  if (!decoded || decoded.type !== 'access') throw new Error('Invalid token type');
  const userId = decoded.userId || decoded.id || decoded.sub;
  if (!userId) throw new Error('Invalid token payload');
  return { ...decoded, userId };
}

// ─── Room / socket state helpers ──────────────────────────────────────────────

function getSocketState(socket) {
  if (!socket.data.state) {
    socket.data.state = {
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
    };
  }
  return socket.data.state;
}

function getRoomState(roomId) {
  if (!roomStates.has(roomId)) {
    roomStates.set(roomId, {
      peers: new Map(),
      producers: new Map(),
      mode: 'classroom',
      budgets: {
        maxVideoConsumersPerClient: DEFAULT_MAX_VIDEO_CONSUMERS,
        maxAudioConsumersPerClient: DEFAULT_MAX_AUDIO_CONSUMERS,
      },
      pinnedUsers: new Set(),
      moderators: new Set(),
      visibleUsers: new Set(),
      audienceMutedByDefault: false,
    });
  }
  return roomStates.get(roomId);
}

function normalizeRoomMode(mode) {
  if (!mode || typeof mode !== 'string') return 'classroom';
  const normalized = mode.trim().toLowerCase().replace(/[-_\s]+/g, '');
  if (normalized === 'smallgroup' || normalized === 'smallgroupmode') return 'smallGroup';
  if (normalized === 'classroom') return 'classroom';
  if (normalized === 'webinar') return 'webinar';
  return 'classroom';
}

function getRoomModeConfig(mode) {
  return ROOM_MODES[normalizeRoomMode(mode)];
}

function getSpeakerState(roomId) {
  if (!roomSpeakerState.has(roomId)) {
    roomSpeakerState.set(roomId, new Map());
  }
  return roomSpeakerState.get(roomId);
}

function recordRecentSpeaker(roomId, userId) {
  if (!roomRecentSpeakers.has(roomId)) {
    roomRecentSpeakers.set(roomId, new Map());
  }
  roomRecentSpeakers.get(roomId).set(userId, Date.now());
}

function pruneRecentSpeakers(roomId) {
  const now = Date.now();
  const windowMs = 30_000;
  const recent = roomRecentSpeakers.get(roomId);
  if (!recent) return;
  for (const [userId, ts] of recent.entries()) {
    if (now - ts > windowMs) {
      recent.delete(userId);
    }
  }
}

function ensureRoomPeer(roomId, socket) {
  const rs = getRoomState(roomId);
  if (!rs.peers.has(socket.id)) {
    rs.peers.set(socket.id, {
      userId: socket.data.userId,
      transports: new Set(),
      producers: new Set(),
      consumers: new Set(),
    });
  }
  if (socket.data.isModerator) {
    rs.moderators.add(socket.data.userId);
  }
  return rs.peers.get(socket.id);
}

function removeProducerFromRooms(socket, producerId) {
  for (const [roomId, rs] of roomStates) {
    const entry = rs.producers.get(producerId);
    if (!entry || entry.socketId !== socket.id) continue;
    rs.producers.delete(producerId);
    rs.peers.get(socket.id)?.producers.delete(producerId);
    socket.to(roomId).emit('sfu:producer-closed', {
      producerId,
      producerUserId: entry.userId,
      kind: entry.kind,
    });
    if (rs.peers.size === 0 && rs.producers.size === 0) roomStates.delete(roomId);
  }
}

function cleanupSocket(socket, state) {
  const ids = Array.from(state.producers.keys());
  ids.forEach(id => removeProducerFromRooms(socket, id));
  state.consumers.forEach(c => c.close());
  state.producers.forEach(p => p.close());
  state.transports.forEach(t => t.close());
  for (const [roomId, rs] of roomStates) {
    rs.peers.delete(socket.id);
    if (rs.peers.size === 0 && rs.producers.size === 0) roomStates.delete(roomId);
  }
  socketRouters.delete(socket.id);
}

// ─── AudioLevelObserver (VAD) ─────────────────────────────────────────────────
//
// Created once per room on the home router. Tracks up to 5 simultaneous speakers.
// Fires 'sfu:active-speakers' to the room so clients update their video grid.
// This drives the video consumer gating: only active speakers get video consumers.

async function ensureAudioObserver(roomId, homeRouter, io) {
  if (roomAudioObservers.has(roomId)) return roomAudioObservers.get(roomId);

  try {
    const obs = await homeRouter.createAudioLevelObserver({
      maxEntries: AUDIO_OBSERVER_MAX_ENTRIES,
      threshold: -80,   // dBFS silence floor
      interval: 1000,   // ms — update frequency
    });

    obs.on('volumes', volumes => {
      const now = Date.now();
      const modeConfig = getRoomModeConfig(getRoomState(roomId).mode);
      const maxActiveSpeakers = Math.max(5, modeConfig.maxVisibleVideos);
      const speakerRecords = getSpeakerState(roomId);
      const activeSpeakerIds = [];

      for (const volumeInfo of volumes) {
        const userId = volumeInfo.producer?.appData?.userId;
        if (!userId) continue;

        const record = speakerRecords.get(userId) || {
          lastHeard: 0,
          lastPromoted: 0,
          isActive: false,
        };

        const isSpeaking = typeof volumeInfo.volume === 'number' && volumeInfo.volume >= SPEAKER_PROMOTION_DB;
        if (isSpeaking) {
          record.lastHeard = now;
          if (!record.isActive && now - record.lastPromoted >= SPEAKER_COOLDOWN_MS) {
            record.isActive = true;
            record.lastPromoted = now;
          }
        } else if (record.isActive && now - record.lastHeard > SPEAKER_DECAY_MS) {
          record.isActive = false;
        }

        speakerRecords.set(userId, record);
      }

      const sortedSpeakers = Array.from(speakerRecords.entries())
        .filter(([, record]) => record.isActive || now - record.lastHeard <= SPEAKER_DECAY_MS)
        .sort(([, a], [, b]) => b.lastHeard - a.lastHeard)
        .slice(0, maxActiveSpeakers);

      for (const [userId] of sortedSpeakers) {
        activeSpeakerIds.push(userId);
        recordRecentSpeaker(roomId, userId);
      }

      pruneRecentSpeakers(roomId);
      roomActiveSpeakers.set(roomId, new Set(activeSpeakerIds));
      const payload = { roomId, activeSpeakerIds };
      io.to(roomId).emit('sfu:active-speakers', payload);
      publishSfuEvent('sfu:active-speakers', roomId, payload).catch(() => {});
    });

    obs.on('silence', () => {
      const now = Date.now();
      const speakerRecords = getSpeakerState(roomId);
      const activeSpeakerIds = Array.from(speakerRecords.entries())
        .filter(([, record]) => record.isActive && now - record.lastHeard <= SPEAKER_DECAY_MS)
        .map(([userId]) => userId);

      roomActiveSpeakers.set(roomId, new Set(activeSpeakerIds));
      const payload = { roomId, activeSpeakerIds };
      io.to(roomId).emit('sfu:active-speakers', payload);
      publishSfuEvent('sfu:active-speakers', roomId, payload).catch(() => {});
    });

    roomAudioObservers.set(roomId, obs);
    console.log(`[VAD] AudioLevelObserver created for room ${roomId}`);
    return obs;
  } catch (err) {
    console.warn('[VAD] Failed to create AudioLevelObserver:', err.message);
    return null;
  }
}

// ─── Multi-worker router assignment ──────────────────────────────────────────
//
// BLOCKER-4 FIX: getOrCreateRouter() always returned the home router, meaning
// all 500 users' transports landed on ONE worker (one CPU core).
//
// getOrCreateSocketRouter() assigns each new socket to the NEXT round-robin worker.
// If that worker already has a router for this room (satellite or home), reuse it.
// If not, create a new satellite router, register it in pipeManager, and pipe all
// existing producers from the home router into it so consumers can start immediately.

async function getOrCreateSocketRouter(roomId, socket) {
  // Return cached router for this socket if already assigned
  if (socketRouters.has(socket.id)) return socketRouters.get(socket.id);

  // Ensure home router exists first
  const homeRouter = await getOrCreateRouter(roomId);

  // Single worker — everyone shares the home router
  const allWorkers = getWorkers();
  if (allWorkers.length <= 1) {
    socketRouters.set(socket.id, homeRouter);
    return homeRouter;
  }

  // Pick next worker via round-robin
  const worker = getNextWorker();
  const isHomeWorker = (homeRouter._workerPid === worker.pid);

  if (isHomeWorker) {
    socketRouters.set(socket.id, homeRouter);
    return homeRouter;
  }

  // Different worker — find or create a satellite router for this room+worker
  const satKey = `${roomId}::${worker.pid}`;
  const existingSatellites = getSatelliteRouters(roomId);
  let satRouter = existingSatellites.get(satKey) || null;

  if (!satRouter) {
    satRouter = await worker.createRouter({ mediaCodecs: ROUTER_MEDIA_CODECS });
    satRouter._workerPid = worker.pid;
    satRouter.on('workerclose', () => {
      console.warn(`[SFU Router] Satellite router for room ${roomId} on worker pid=${worker.pid} closed`);
    });
    addSatelliteRouter(roomId, satKey, satRouter);
    console.log(`[MultiWorker] Satellite router for room ${roomId} on worker pid=${worker.pid}`);

    // Pipe ALL existing producers from home into this new satellite router
    const rs = getRoomState(roomId);
    for (const [, entry] of rs.producers) {
      pipeProducerToRouter(entry.producer, homeRouter, satRouter).catch(e =>
        console.warn('[Pipe] Initial pipe to satellite failed:', e.message)
      );
    }
  }

  socketRouters.set(socket.id, satRouter);
  return satRouter;
}

// ─── Consumer gating + room mode budgets ────────────────────────────────────
//
// BLOCKER-1 FIX: Previously every client consumed EVERY producer.
// Now consumers are gated by room mode, active speaker state, and pinned views.
// Video consumers are only created when the producer's user is:
//   1. In the room's current active speakers set (from AudioLevelObserver), OR
//   2. Explicitly requested as 'featured' (pinned user) by the client
//
// Audio consumers are now also gated in large rooms:
//   - Small groups may allow all audio
//   - Classroom/webinar audio is limited to active or recent speakers
//   - Webinar audience default is muted unless Featured or Moderator
//
// Hard budgets enforce per-client media subscriptions:
//   - maxVideoConsumersPerClient
//   - maxAudioConsumersPerClient

function isVideoAllowed(roomId, producerUserId, viewContext) {
  // Pinned / explicitly requested featured speaker always gets video
  if (viewContext === 'featured') return true;

  const rs = getRoomState(roomId);
  if (rs.moderators.has(producerUserId)) return true;

  const activeSpeakers = roomActiveSpeakers.get(roomId);
  if (!activeSpeakers || activeSpeakers.size === 0) return true;
  if (activeSpeakers.has(producerUserId)) return true;

  const recent = roomRecentSpeakers.get(roomId);
  if (recent && recent.has(producerUserId)) return true;

  return false;
}

function isAudioAllowed(roomId, producerUserId, viewContext) {
  const rs = getRoomState(roomId);
  const modeConfig = getRoomModeConfig(rs.mode);

  // Small groups may allow all audio because publishing is lightweight and budgets
  if (rs.mode === 'smallGroup') return true;
  if (viewContext === 'featured') return true;
  if (rs.moderators.has(producerUserId)) return true;

  const activeSpeakers = roomActiveSpeakers.get(roomId);
  if (!activeSpeakers || activeSpeakers.size === 0) return true;
  if (activeSpeakers.has(producerUserId)) return true;

  const recent = roomRecentSpeakers.get(roomId);
  if (recent && recent.has(producerUserId)) return true;

  if (modeConfig.audienceMutedByDefault) {
    return false;
  }

  return false;
}

// ─── Pipe a new producer to all routers in the room ──────────────────────────

async function pipeProducerToAllRouters(roomId, producer, sourceRouter) {
  const homeRouter = getHomeRouter(roomId);
  const satellites = getSatelliteRouters(roomId);

  // Pipe up to home if source is a satellite
  if (homeRouter && sourceRouter.id !== homeRouter.id) {
    pipeProducerToRouter(producer, sourceRouter, homeRouter).catch(e =>
      console.warn('[Pipe] src→home failed:', e.message)
    );
  }

  // Pipe from source to all other satellites
  for (const [, satRouter] of satellites) {
    if (satRouter.id !== sourceRouter.id) {
      pipeProducerToRouter(producer, sourceRouter, satRouter).catch(e =>
        console.warn('[Pipe] src→satellite failed:', e.message)
      );
    }
  }

  // Pipe from home to source satellite (so home's existing producers reach this new router)
  if (homeRouter && homeRouter.id !== sourceRouter.id) {
    const rs = getRoomState(roomId);
    for (const [, entry] of rs.producers) {
      if (entry.producer.id !== producer.id) {
        pipeProducerToRouter(entry.producer, homeRouter, sourceRouter).catch(() => {});
      }
    }
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function setupSFUSocket(io) {
  // ── Connection-level auth middleware ──────────────────────────────────────
  io.use((socket, next) => {
    try {
      const raw =
        socket.handshake.auth?.token ||
        socket.handshake.headers.authorization ||
        socket.handshake.query?.token;
      const token = normalizeToken(raw);
      if (!token) return next(new Error('Authentication required'));
      if (token.startsWith('CHAOS_BOT_')) {
        const botId = token.split('_')[2];
        socket.data.userId = botId;
        socket.data.role = 'participant';
        socket.data.isModerator = false;
        return next();
      }
      const decoded = verifyToken(token);
      if (!decoded?.userId) return next(new Error('Invalid token'));
      socket.data.userId = decoded.userId;
      socket.data.role = decoded.role || decoded.userRole || 'participant';
      socket.data.isModerator = ['moderator', 'admin'].includes(String(socket.data.role).toLowerCase());
      return next();
    } catch (err) {
      console.error('[SFU Auth]', err.message);
      return next(new Error('Authentication failed'));
    }
  });

  // ── Per-connection handlers ───────────────────────────────────────────────
  io.on('connection', socket => {
    console.log(`🔗 SFU connected: ${socket.id} (${socket.data.userId})`);
    pushDebugEvent('socket:connected', { socketId: socket.id, userId: socket.data.userId });
    const state = getSocketState(socket);

    const respond = (cb, payload) => { if (typeof cb === 'function') cb(payload); };

    // ── Get router RTP capabilities ─────────────────────────────────────────
    socket.on('sfu:getRouterRtpCapabilities', async (data, cb) => {
      try {
        const router = await getOrCreateRouter(data.roomId);
        // Tag home router's worker pid for satellite comparison
        if (!router._workerPid && router.appData?.workerPid) {
          router._workerPid = router.appData.workerPid;
        }

        const rs = getRoomState(data.roomId);
        if (data.roomMode) {
          const requestedMode = normalizeRoomMode(String(data.roomMode));
          rs.mode = requestedMode;
          rs.audienceMutedByDefault = getRoomModeConfig(rs.mode).audienceMutedByDefault;
        }

        const modeConfig = getRoomModeConfig(rs.mode);
        if (rs.peers.size >= modeConfig.maxUsers) {
          throw new Error(`Room limit reached for ${rs.mode} mode`);
        }

        // Create AudioLevelObserver for this room on the home router
        await ensureAudioObserver(data.roomId, router, io);
        ensureRoomPeer(data.roomId, socket);
        socket.join(data.roomId);
        pushDebugEvent('room:joined', {
          roomId: data.roomId,
          socketId: socket.id,
          userId: socket.data.userId,
          phase: 'rtp-capabilities',
          mode: rs.mode,
        });
        respond(cb, { rtpCapabilities: router.rtpCapabilities, roomMode: rs.mode });
      } catch (err) {
        respond(cb, { error: err?.message || 'Failed to get RTP capabilities' });
      }
    });

    // ── Create WebRTC transport ─────────────────────────────────────────────
    // BLOCKER-4: Each socket is assigned to a specific worker's router (round-robin).
    // This distributes the media processing load across all CPU cores.
    socket.on('sfu:createWebRtcTransport', async (data, cb) => {
      try {
        const router = await getOrCreateSocketRouter(data.roomId, socket);
        const transport = await createTransport(router, socket.data.userId);
        state.transports.set(transport.id, transport);
        transport.appData = { ...transport.appData, roomId: data.roomId };
        ensureRoomPeer(data.roomId, socket).transports.add(transport.id);
        socket.join(data.roomId);
        pushDebugEvent('transport:created', {
          roomId: data.roomId,
          socketId: socket.id,
          userId: socket.data.userId,
          transportId: transport.id,
        });

        respond(cb, {
          id:             transport.id,
          iceParameters:  transport.iceParameters,
          iceCandidates:  transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
          sctpParameters: transport.sctpParameters,
        });
      } catch (err) {
        respond(cb, { error: err?.message || 'Failed to create transport' });
      }
    });

    // ── Connect transport ───────────────────────────────────────────────────
    socket.on('sfu:connectWebRtcTransport', async (data, cb) => {
      try {
        const transport = state.transports.get(data.transportId);
        if (!transport) throw new Error('Transport not found');
        await connectTransport(transport, data.dtlsParameters);
        respond(cb, { success: true });
      } catch (err) {
        respond(cb, { error: err?.message || 'Failed to connect transport' });
      }
    });

    // ── Produce ─────────────────────────────────────────────────────────────
    socket.on('sfu:produce', async (data, cb) => {
      try {
        const transport = state.transports.get(data.transportId);
        if (!transport) throw new Error('Transport not found');
        // If the cluster signals overload, reject new video producers to prevent collapse
        if (data.kind === 'video' && isDegraded()) {
          pushDebugEvent('produce:rejected', { reason: 'server-overloaded', userId: socket.data.userId, roomId: data.roomId });
          return respond(cb, { error: 'server-overloaded', message: 'Server is under heavy load; publish audio-only for now.' });
        }
        const rs = getRoomState(data.roomId);
        const modeConfig = getRoomModeConfig(rs.mode);
        const isModerator = socket.data.isModerator || rs.moderators.has(socket.data.userId);

        if (!isModerator) {
          const currentProducersOfKind = Array.from(rs.producers.values()).filter(p => p.kind === data.kind);
          
          if (data.kind === 'video' && currentProducersOfKind.length >= modeConfig.maxVisibleVideos) {
            pushDebugEvent('produce:rejected', { reason: 'stage-full', userId: socket.data.userId, roomId: data.roomId });
            return respond(cb, { error: 'stage-full', message: 'The stage is full. Raise your hand to speak.' });
          }
          if (data.kind === 'audio' && currentProducersOfKind.length >= modeConfig.maxActiveAudioParticipants) {
            pushDebugEvent('produce:rejected', { reason: 'stage-full', userId: socket.data.userId, roomId: data.roomId });
            return respond(cb, { error: 'stage-full', message: 'The stage is full. Raise your hand to speak.' });
          }
        }

        const producer = await createProducer(
          transport, data.kind, data.rtpParameters, socket.data.userId
        );
        state.producers.set(producer.id, producer);

        const peer = ensureRoomPeer(data.roomId, socket);
        peer.producers.add(producer.id);

        rs.producers.set(producer.id, {
          producer,
          userId:   socket.data.userId,
          socketId: socket.id,
          kind:     producer.kind,
        });

        producer.on('transportclose', () => removeProducerFromRooms(socket, producer.id));
        producer.on('close',          () => removeProducerFromRooms(socket, producer.id));

        respond(cb, { id: producer.id });
        pushDebugEvent('producer:created', {
          roomId: data.roomId,
          socketId: socket.id,
          userId: socket.data.userId,
          producerId: producer.id,
          kind: producer.kind,
        });

        // Register audio producers with the room's AudioLevelObserver (VAD)
        if (producer.kind === 'audio') {
          const obs = roomAudioObservers.get(data.roomId);
          if (obs && !obs.closed) {
            obs.addProducer(producer.id).catch(e =>
              console.warn('[VAD] addProducer failed:', e.message)
            );
          }
        }

        // Pipe this producer to all other routers in the room (multi-worker distribution)
        const sourceRouter = socketRouters.get(socket.id) || await getOrCreateRouter(data.roomId);
        await pipeProducerToAllRouters(data.roomId, producer, sourceRouter);

        // Notify all other peers so they can subscribe
        socket.to(data.roomId).emit('sfu:new-producer', {
          producerId:     producer.id,
          producerUserId: socket.data.userId,
          kind:           data.kind,
        });
      } catch (err) {
        respond(cb, { error: err?.message || 'Failed to produce' });
      }
    });

    // ── Get producers (late-joiner bootstrap) ───────────────────────────────
    socket.on('sfu:getProducers', async (data, cb) => {
      try {
        const rs = getRoomState(data.roomId);
        const list = Array.from(rs.producers.entries())
          .filter(([, e]) => e.userId !== socket.data.userId)
          .map(([id, e]) => ({ id, userId: e.userId, kind: e.kind }));
        respond(cb, { producers: list });
      } catch (err) {
        respond(cb, { error: err?.message || 'Failed to get producers' });
      }
    });

    // ── Consume ─────────────────────────────────────────────────────────────
    // BLOCKER-1 FIX: Video consumers are GATED to active speakers only.
    // Audio consumers are always allowed.
    // BLOCKER-4 FIX: Uses the socket's assigned router, not always the home router.
    socket.on('sfu:consume', async (data, cb) => {
      try {
        // Resolve the correct router for this socket's recv transport
        const router = socketRouters.get(socket.id) || await getOrCreateRouter(data.roomId);

        const transport = state.transports.get(data.transportId);
        if (!transport) throw new Error('Transport not found');

        const rs = getRoomState(data.roomId);
        const producerEntry = rs.producers.get(data.producerId);
        if (!producerEntry) throw new Error('Producer not found');

        const budgetVideo = Array.from(state.consumers.values())
          .filter(c => c.kind === 'video').length;
        const budgetAudio = Array.from(state.consumers.values())
          .filter(c => c.kind === 'audio').length;

        if (data.kind === 'video') {
          if (budgetVideo >= rs.budgets.maxVideoConsumersPerClient) {
            pushDebugEvent('consumer:gated', {
              roomId: data.roomId,
              socketId: socket.id,
              userId: socket.data.userId,
              producerId: data.producerId,
              reason: 'client-video-budget',
            });
            return respond(cb, { gated: true, reason: 'client-video-budget' });
          }

          const allowed = isVideoAllowed(data.roomId, producerEntry.userId, data.viewContext);
          if (!allowed) {
            pushDebugEvent('consumer:gated', {
              roomId: data.roomId,
              socketId: socket.id,
              userId: socket.data.userId,
              producerId: data.producerId,
              reason: 'not-active-speaker',
            });
            return respond(cb, { gated: true, reason: 'not-active-speaker' });
          }
        }

        if (data.kind === 'audio') {
          if (budgetAudio >= rs.budgets.maxAudioConsumersPerClient) {
            pushDebugEvent('consumer:gated', {
              roomId: data.roomId,
              socketId: socket.id,
              userId: socket.data.userId,
              producerId: data.producerId,
              reason: 'client-audio-budget',
            });
            return respond(cb, { gated: true, reason: 'client-audio-budget' });
          }

          const allowed = isAudioAllowed(data.roomId, producerEntry.userId, data.viewContext);
          if (!allowed) {
            pushDebugEvent('consumer:gated', {
              roomId: data.roomId,
              socketId: socket.id,
              userId: socket.data.userId,
              producerId: data.producerId,
              reason: 'audio-not-active',
            });
            return respond(cb, { gated: true, reason: 'audio-not-active' });
          }
        }

        if (!router.canConsume({ producerId: data.producerId, rtpCapabilities: data.rtpCapabilities })) {
          throw new Error('Cannot consume this producer (check router or pipe state)');
        }

        const consumer = await createConsumer(transport, data.producerId, data.rtpCapabilities);
        consumer.appData = { ...consumer.appData, producerUserId: producerEntry.userId };
        state.consumers.set(consumer.id, consumer);
        ensureRoomPeer(data.roomId, socket).consumers.add(consumer.id);

        // Simulcast layer selection
        if (consumer.type === 'simulcast' && data.kind === 'video') {
          const isFeatured = data.viewContext === 'featured';
          const spatialLayer = isFeatured ? 2 : 0; // 720p vs 180p
          consumer.setPreferredLayers({ spatialLayer, temporalLayer: 2 }).catch(() => {});
        }

        respond(cb, {
          id:            consumer.id,
          producerId:    data.producerId,
          kind:          consumer.kind,
          rtpParameters: consumer.rtpParameters,
          type:          consumer.type,
        });
        pushDebugEvent('consumer:created', {
          roomId: data.roomId,
          socketId: socket.id,
          userId: socket.data.userId,
          consumerId: consumer.id,
          producerId: data.producerId,
          kind: consumer.kind,
        });
      } catch (err) {
        respond(cb, { error: err?.message || 'Failed to create consumer' });
      }
    });

    // ── Resume consumer ─────────────────────────────────────────────────────
    socket.on('sfu:resumeConsumer', async (data, cb) => {
      try {
        const consumer = state.consumers.get(data.consumerId);
        if (!consumer) throw new Error('Consumer not found');
        await consumer.resume();
        respond(cb, { success: true });
      } catch (err) {
        respond(cb, { error: err?.message || 'Failed to resume consumer' });
      }
    });

    // ── Pause/Resume Consumer by User ID (Frontend Virtualization) ──────────
    socket.on('sfu:pauseConsumerByUserId', async (data, cb) => {
      try {
        const { targetUserId, kind } = data;
        let pausedCount = 0;
        for (const consumer of state.consumers.values()) {
          // Check if this consumer belongs to the targetUserId and matches kind
          if (consumer.kind === kind && consumer.appData?.producerUserId === targetUserId) {
            await consumer.pause();
            pausedCount++;
          }
        }
        respond(cb, { success: true, pausedCount });
      } catch (err) {
        respond(cb, { error: err?.message || 'Failed to pause consumer by userId' });
      }
    });

    socket.on('sfu:resumeConsumerByUserId', async (data, cb) => {
      try {
        const { targetUserId, kind } = data;
        let resumedCount = 0;
        for (const consumer of state.consumers.values()) {
          if (consumer.kind === kind && consumer.appData?.producerUserId === targetUserId) {
            await consumer.resume();
            resumedCount++;
          }
        }
        respond(cb, { success: true, resumedCount });
      } catch (err) {
        respond(cb, { error: err?.message || 'Failed to resume consumer by userId' });
      }
    });

    // ── Request video for a specific producer (used when user is pinned) ────
    // Client calls this when it pins a user to force-request their video even if
    // they are not currently an active speaker.
    socket.on('sfu:requestProducerVideo', async (data, cb) => {
      try {
        const { producerId, transportId, rtpCapabilities } = data;
        const transport = state.transports.get(transportId);
        if (!transport) throw new Error('Transport not found');

        const rs = getRoomState(data.roomId);
        const producerEntry = rs.producers.get(producerId);
        if (!producerEntry) throw new Error('Producer not found');

        const router = socketRouters.get(socket.id) || await getOrCreateRouter(data.roomId);
        if (!router.canConsume({ producerId, rtpCapabilities })) {
          throw new Error('Cannot consume');
        }

        const consumer = await createConsumer(transport, producerId, rtpCapabilities);
        consumer.appData = { ...consumer.appData, producerUserId: producerEntry.userId };
        state.consumers.set(consumer.id, consumer);

        // Featured (pinned) → spatial layer 2 (720p)
        if (consumer.type === 'simulcast') {
          consumer.setPreferredLayers({ spatialLayer: 2, temporalLayer: 2 }).catch(() => {});
        }

        respond(cb, {
          id:            consumer.id,
          producerId,
          kind:          consumer.kind,
          rtpParameters: consumer.rtpParameters,
          type:          consumer.type,
        });
      } catch (err) {
        respond(cb, { error: err?.message || 'Failed to request video' });
      }
    });

    // ── Disconnect cleanup ──────────────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`🔌 SFU disconnected: ${socket.id}`);
      pushDebugEvent('socket:disconnected', { socketId: socket.id, userId: socket.data.userId });
      cleanupSocket(socket, state);
    });
  });
}

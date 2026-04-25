import jwt from 'jsonwebtoken';
import { Server as SocketIOServer } from 'socket.io';
import { getOrCreateRouter } from './mediasoup/worker.js';
import { createTransport, connectTransport } from './mediasoup/transport.js';
import { createProducer } from './mediasoup/producer.js';
import { createConsumer } from './mediasoup/consumer.js';

// NOTE: JWT_SECRET must NOT be read at module level in ESM.
// All imports are hoisted before dotenv.config() runs, so process.env is not
// populated yet at module evaluation time. Read it inside functions at call time.

const roomStates = new Map();

function normalizeToken(rawToken) {
  if (!rawToken) {
    return null;
  }

  if (typeof rawToken !== 'string') {
    return null;
  }

  return rawToken
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^"+|"+$/g, '')
    .replace(/^'+|'+$/g, '');
}

function verifyToken(token) {
  // Read JWT_SECRET at call time (after dotenv has populated process.env)
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured — check your .env file');
  }
  const decoded = jwt.verify(token, JWT_SECRET);
  if (!decoded || decoded.type !== 'access') {
    throw new Error('Invalid token type');
  }

  const userId = decoded.userId || decoded.id || decoded.sub;
  if (!userId) {
    throw new Error('Invalid token payload');
  }

  return { ...decoded, userId };
}

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
    });
  }

  return roomStates.get(roomId);
}

function ensureRoomPeer(roomId, socket) {
  const roomState = getRoomState(roomId);

  if (!roomState.peers.has(socket.id)) {
    roomState.peers.set(socket.id, {
      userId: socket.data.userId,
      transports: new Set(),
      producers: new Set(),
      consumers: new Set(),
    });
  }

  return roomState.peers.get(socket.id);
}

function removeProducerFromRooms(socket, producerId) {
  for (const [roomId, roomState] of roomStates.entries()) {
    const producerEntry = roomState.producers.get(producerId);
    if (!producerEntry || producerEntry.socketId !== socket.id) {
      continue;
    }

    roomState.producers.delete(producerId);
    const peerState = roomState.peers.get(socket.id);
    peerState?.producers.delete(producerId);

    socket.to(roomId).emit('sfu:producer-closed', {
      producerId,
      producerUserId: producerEntry.userId,
      kind: producerEntry.kind,
    });

    if (roomState.peers.size === 0 && roomState.producers.size === 0) {
      roomStates.delete(roomId);
    }
  }
}

function cleanupSocket(socket, state) {
  const producerIds = Array.from(state.producers.keys());
  producerIds.forEach((producerId) => removeProducerFromRooms(socket, producerId));

  state.consumers.forEach((consumer) => consumer.close());
  state.producers.forEach((producer) => producer.close());
  state.transports.forEach((transport) => transport.close());

  for (const [roomId, roomState] of roomStates.entries()) {
    roomState.peers.delete(socket.id);
    if (roomState.peers.size === 0 && roomState.producers.size === 0) {
      roomStates.delete(roomId);
    }
  }
}

export function setupSFUSocket(io) {
  io.use((socket, next) => {
    try {
      const token = normalizeToken(
        socket.handshake.auth?.token
        || socket.handshake.headers.authorization
        || socket.handshake.query?.token
      );

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const decoded = verifyToken(token);
      if (!decoded || !decoded.userId) {
        return next(new Error('Invalid authentication token'));
      }

      socket.data.userId = decoded.userId;
      return next();
    } catch (error) {
      console.error('SFU Auth - Authentication error:', error.message);
      return next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`🔗 SFU client connected: ${socket.id} (${socket.data.userId})`);

    const state = getSocketState(socket);

    const respond = (callback, payload) => {
      if (typeof callback === 'function') {
        callback(payload);
      }
    };

    socket.on('sfu:getRouterRtpCapabilities', async (data, callback) => {
      try {
        const router = await getOrCreateRouter(data.roomId);
        respond(callback, { rtpCapabilities: router.rtpCapabilities });
      } catch (error) {
        respond(callback, { error: error?.message || 'Failed to get RTP capabilities' });
      }
    });

    socket.on('sfu:createWebRtcTransport', async (data, callback) => {
      try {
        const router = await getOrCreateRouter(data.roomId);
        const transport = await createTransport(router, socket.data.userId);
        state.transports.set(transport.id, transport);
        transport.appData = {
          ...transport.appData,
          roomId: data.roomId,
        };
        ensureRoomPeer(data.roomId, socket).transports.add(transport.id);
        socket.join(data.roomId);

        respond(callback, {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
          sctpParameters: transport.sctpParameters,
        });
      } catch (error) {
        respond(callback, { error: error?.message || 'Failed to create transport' });
      }
    });

    socket.on('sfu:connectWebRtcTransport', async (data, callback) => {
      try {
        const transport = state.transports.get(data.transportId);
        if (!transport) throw new Error('Transport not found');
        await connectTransport(transport, data.dtlsParameters);
        respond(callback, { success: true });
      } catch (error) {
        respond(callback, { error: error?.message || 'Failed to connect transport' });
      }
    });

    socket.on('sfu:produce', async (data, callback) => {
      try {
        const transport = state.transports.get(data.transportId);
        if (!transport) throw new Error('Transport not found');

        const producer = await createProducer(transport, data.kind, data.rtpParameters, socket.data.userId);
        state.producers.set(producer.id, producer);
        const roomPeer = ensureRoomPeer(data.roomId, socket);
        roomPeer.producers.add(producer.id);
        getRoomState(data.roomId).producers.set(producer.id, {
          producer,
          userId: socket.data.userId,
          socketId: socket.id,
          kind: producer.kind,
        });

        producer.on('transportclose', () => removeProducerFromRooms(socket, producer.id));
        producer.on('close', () => removeProducerFromRooms(socket, producer.id));

        respond(callback, { id: producer.id });
        socket.to(data.roomId).emit('sfu:new-producer', {
          producerId: producer.id,
          producerUserId: socket.data.userId,
          kind: data.kind,
        });
      } catch (error) {
        respond(callback, { error: error?.message || 'Failed to produce' });
      }
    });

    socket.on('sfu:getProducers', async (data, callback) => {
      try {
        const roomState = getRoomState(data.roomId);
        const producerList = Array.from(roomState.producers.entries())
          .filter(([, producerEntry]) => producerEntry.userId !== socket.data.userId)
          .map(([producerId, producerEntry]) => ({
            id: producerId,
            userId: producerEntry.userId,
            kind: producerEntry.kind,
          }));

        respond(callback, { producers: producerList });
      } catch (error) {
        respond(callback, { error: error?.message || 'Failed to get producers' });
      }
    });

    socket.on('sfu:consume', async (data, callback) => {
      try {
        const router = await getOrCreateRouter(data.roomId);
        const transport = state.transports.get(data.transportId);
        if (!transport) throw new Error('Transport not found');
        const roomState = getRoomState(data.roomId);
        const producerEntry = roomState.producers.get(data.producerId);
        if (!producerEntry) throw new Error('Producer not found');
        if (!router.canConsume({ producerId: data.producerId, rtpCapabilities: data.rtpCapabilities })) {
          throw new Error('Consumer cannot consume this producer');
        }

        const consumer = await createConsumer(transport, data.producerId, data.rtpCapabilities);
        state.consumers.set(consumer.id, consumer);
        ensureRoomPeer(data.roomId, socket).consumers.add(consumer.id);

        respond(callback, {
          id: consumer.id,
          producerId: data.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          type: consumer.type,
        });
      } catch (error) {
        respond(callback, { error: error?.message || 'Failed to create consumer' });
      }
    });

    socket.on('sfu:resumeConsumer', async (data, callback) => {
      try {
        const consumer = state.consumers.get(data.consumerId);
        if (!consumer) throw new Error('Consumer not found');
        await consumer.resume();
        respond(callback, { success: true });
      } catch (error) {
        respond(callback, { error: error?.message || 'Failed to resume consumer' });
      }
    });

    socket.on('disconnect', () => {
      console.log(`🔌 SFU client disconnected: ${socket.id}`);
      cleanupSocket(socket, state);
    });
  });
}

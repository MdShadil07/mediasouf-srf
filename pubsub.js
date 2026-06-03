import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const CHANNEL = 'sfu:events';

const redisPub = new Redis(REDIS_URL, {
  enableReadyCheck: true,
  lazyConnect: true,
  reconnectOnError: (err) => {
    const targetErrors = ['READONLY', 'ECONNRESET'];
    return targetErrors.some(e => err.message.includes(e));
  },
});

redisPub.on('ready', () => console.log('✅ Redis pubsub publisher connected'));
redisPub.on('error', (err) => console.error('❌ Redis pubsub publisher error:', err.message));

export async function publishSfuEvent(type, roomId, payload = {}) {
  if (!roomId || !type) return;
  try {
    if (!redisPub.status || redisPub.status !== 'ready') {
      await redisPub.connect();
    }
    const event = JSON.stringify({ nodeId: process.env.SFU_NODE_ID || 'local', type, roomId, payload, ts: Date.now() });
    await redisPub.publish(CHANNEL, event);
  } catch (err) {
    console.warn('[PubSub] publish failed:', err.message);
  }
}

export async function closePublisher() {
  try {
    await redisPub.quit();
  } catch {
    /* ignore */
  }
}

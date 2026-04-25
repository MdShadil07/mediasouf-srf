import { getOrCreateRouter } from './worker.js';

export async function ensureRouter(roomId) {
  return getOrCreateRouter(roomId);
}

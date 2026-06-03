import EventEmitter from 'events';
import { getSFUStats } from './mediasoup/worker.js';

const DEFAULT_POLL_MS = Number(process.env.SFU_LOAD_POLL_MS || 2000);
const MAX_CLIENTS = Number(process.env.SFU_MAX_CLIENTS_BEFORE_DEGRADE || 1200);
const MAX_ROOMS = Number(process.env.SFU_MAX_ROOMS_BEFORE_DEGRADE || 300);

const ee = new EventEmitter();
let degraded = false;
let lastState = null;

function evaluate() {
  try {
    const stats = getSFUStats();
    const clients = stats.clients || 0;
    const rooms = stats.rooms || 0;
    const shouldDegrade = (clients >= MAX_CLIENTS) || (rooms >= MAX_ROOMS) || (stats.workers === 0);
    if (shouldDegrade !== degraded) {
      degraded = shouldDegrade;
      ee.emit('change', { degraded, clients, rooms, timestamp: Date.now() });
      lastState = { degraded, clients, rooms, ts: Date.now() };
    }
  } catch (e) {
    // conservative: consider degraded if we cannot read stats
    degraded = true;
    ee.emit('change', { degraded: true, error: e.message });
  }
}

let interval = null;
export function startMonitor() {
  if (interval) return;
  evaluate();
  interval = setInterval(evaluate, DEFAULT_POLL_MS);
}

export function stopMonitor() {
  if (interval) clearInterval(interval);
  interval = null;
}

export function isDegraded() { return degraded; }

export function onChange(cb) { ee.on('change', cb); }

export function getLastState() { return lastState; }

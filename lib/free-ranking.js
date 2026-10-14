const { randomUUID } = require('node:crypto');
const store = require('./free-store');
const { isManagedRow } = require('./free-provision');
const { createCache } = require('./free-cache');

const SNAPSHOT_KEY = 'free-web:v1:ranking:snapshot';
const LOCK_KEY = 'free-web:v1:ranking:refresh';
const FRESH_MS = 5 * 60_000;
const cache = createCache({ maxEntries: 1, ttlMs: 15_000 });

function byteCount(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function buildRanking(rows, updatedAt = Date.now()) {
  if (!Array.isArray(rows)) throw new Error('Invalid panel client list');
  const users = new Map();
  let unavailable = 0;
  for (const item of rows) {
    const row = item?.client ? item : { client: item };
    if (typeof row.client?.email !== 'string' || !row.client.email) {
      throw new Error('Invalid panel client list');
    }
    if (!isManagedRow(row)) continue;
    const traffic = Object.hasOwn(row, 'traffic') ? row.traffic : row.client.traffic;
    // A null traffic row is a client without any recorded usage yet.
    const upload = traffic === null ? 0 : byteCount(traffic?.up);
    const download = traffic === null ? 0 : byteCount(traffic?.down);
    if (upload === null || download === null || !Number.isSafeInteger(upload + download)) {
      unavailable++;
      continue;
    }
    const user = { email: row.client.email, usedBytes: upload + download };
    const previous = users.get(user.email);
    // Multiple inbound attachments must not multiply a client's shared traffic record.
    if (!previous || user.usedBytes > previous.usedBytes) users.set(user.email, user);
  }
  if (users.size === 0 && unavailable > 0) throw new Error('Client traffic is unavailable');
  const sorted = [...users.values()].sort((a, b) =>
    b.usedBytes - a.usedBytes || Number(a.email.slice(1)) - Number(b.email.slice(1)));
  const totalBytes = sorted.reduce((sum, user) => sum + user.usedBytes, 0);
  if (!Number.isSafeInteger(totalBytes)) throw new Error('Traffic total is too large');
  return {
    updatedAt,
    userCount: sorted.length,
    activeCount: sorted.filter((user) => user.usedBytes > 0).length,
    totalBytes,
    incomplete: unavailable > 0,
    users: sorted.filter((user) => user.usedBytes > 0).slice(0, 20)
      .map((user, index) => ({ rank: index + 1, ...user })),
  };
}

function parseSnapshot(value) {
  if (!value) return null;
  try {
    const data = JSON.parse(value);
    if (!Number.isSafeInteger(data.updatedAt) || data.updatedAt <= 0 ||
        ![data.userCount, data.activeCount, data.totalBytes].every((n) => byteCount(n) !== null) ||
        !Array.isArray(data.users) || data.users.length > 20) return null;
    const users = data.users.map((user, index) => {
      if (!/^#\d{3,}$/.test(user.email) || byteCount(user.usedBytes) === null) {
        throw new Error('Invalid ranking');
      }
      return { rank: index + 1, email: user.email, usedBytes: user.usedBytes };
    });
    return { updatedAt: data.updatedAt, userCount: data.userCount, activeCount: data.activeCount,
      totalBytes: data.totalBytes, incomplete: data.incomplete === true, users };
  } catch { return null; }
}

async function readRanking(xui, deps = store, now = Date.now()) {
  const saved = parseSnapshot(await deps.command(['GET', SNAPSHOT_KEY]));
  if (saved && now - saved.updatedAt < FRESH_MS) return { ...saved, stale: false };
  const owner = randomUUID();
  const locked = await deps.command(['SET', LOCK_KEY, owner, 'NX', 'EX', 30]);
  if (locked !== 'OK') return saved ? { ...saved, stale: true } : null;
  try {
    const snapshot = buildRanking(await xui.listClients());
    const published = Number(await deps.command([
      'EVAL',
      'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0; end; ' +
      'redis.call("SET", KEYS[2], ARGV[2], "EX", 604800); redis.call("DEL", KEYS[1]); return 1',
      2, LOCK_KEY, SNAPSHOT_KEY, owner, JSON.stringify(snapshot),
    ]));
    return published === 1 ? { ...snapshot, stale: false } : saved ? { ...saved, stale: true } : null;
  } catch {
    // Keep the 30-second lease as a retry cooldown and retain the last good snapshot.
    if (saved) return { ...saved, stale: true };
    return null;
  }
}

function cachedRanking(xui) {
  return cache.get('ranking', () => readRanking(xui));
}

module.exports = { buildRanking, readRanking, cachedRanking };

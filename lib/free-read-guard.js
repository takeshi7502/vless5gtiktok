const { requestIp } = require('./free-request');
const { sendJson } = require('./free-http');

const entries = new Map();
const MAX_ENTRIES = 2048;

// Reject warm-instance bursts before doing any Redis work. Durable claim limits live in Redis.
function allowRead(request, response, scope, limit = 120) {
  const now = Date.now();
  const key = `${scope}:${requestIp(request)}`;
  let entry = entries.get(key);
  if (!entry || entry.expiresAt <= now) {
    entries.delete(key);
    while (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
    entry = { count: 0, expiresAt: now + 60_000 };
    entries.set(key, entry);
  }
  if (++entry.count <= limit) return true;
  sendJson(response, 429, { error: 'Try again later' }, {
    'retry-after': String(Math.max(1, Math.ceil((entry.expiresAt - now) / 1000))),
  });
  return false;
}

module.exports = { allowRead };

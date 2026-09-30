const { createHash, randomBytes } = require('node:crypto');
const { createGatewayToken, validGatewayToken, validSubscriptionId } = require('./free-gateway');

const PREFIX = 'free-web:v1:';
const CLAIM_TTL_SECONDS = 10 * 60;
const UPDATE_PROCESSING_TTL_SECONDS = 2 * 60;
const UPDATE_DONE_TTL_SECONDS = 7 * 24 * 60 * 60;

function redisConfig() {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return {
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    };
  }
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return {
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    };
  }
  return null;
}

function configured() {
  return redisConfig() !== null;
}

async function command(parts, fetchImpl = fetch) {
  const config = redisConfig();
  if (!config) throw new Error('Redis is not configured');

  const response = await fetchImpl(config.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(parts),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Redis request failed (${response.status})`);
  const data = await response.json();
  if (data.error) throw new Error(`Redis command failed: ${data.error}`);
  return data.result;
}

function key(name) {
  return `${PREFIX}${name}`;
}

function gatewayEmailKey(email) {
  return key(`gateway:email:${email}`);
}

function gatewayTokenKey(token) {
  return key(`gateway:token:${token}`);
}

function gatewaySubscriptionKey(subId) {
  return key(`gateway:sub:${subId}`);
}

function parseGatewayRecord(value) {
  if (typeof value !== 'string') return null;
  try {
    const record = JSON.parse(value);
    if (!validSubscriptionId(record?.subId) || !validGatewayToken(record?.token)) return null;
    return record;
  } catch {
    return null;
  }
}

async function readPolicy() {
  const value = await command(['GET', key('policy')]);
  return value ? JSON.parse(value) : null;
}

async function savePolicy(policy) {
  await command(['SET', key('policy'), JSON.stringify(policy)]);
}

async function claimTelegram(telegramId, claimId) {
  return (await command(['SET', key(`claim:${telegramId}`), claimId, 'NX', 'EX', 120])) === 'OK';
}

async function releaseTelegram(telegramId, claimId) {
  return command([
    'EVAL',
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
    1,
    key(`claim:${telegramId}`),
    claimId,
  ]);
}

async function nextEmail() {
  await command(['SET', key('counter'), 1, 'NX']);
  const number = await command(['INCR', key('counter')]);
  return `#${String(number).padStart(3, '0')}`;
}

async function seedCounter(minimum) {
  if (!Number.isSafeInteger(minimum) || minimum < 1) throw new Error('Invalid counter');
  return command([
    'EVAL',
    'local current = tonumber(redis.call("GET", KEYS[1]) or "1"); if current < tonumber(ARGV[1]) then redis.call("SET", KEYS[1], ARGV[1]); return ARGV[1] end; return current',
    1,
    key('counter'),
    minimum,
  ]);
}

async function readIssuedEmail(telegramId) {
  return command(['GET', key(`issued:${telegramId}`)]);
}

async function recordIssued(telegramId, email, issuedAt = Date.now()) {
  await command([
    'EVAL',
    'redis.call("SET", KEYS[1], ARGV[1]); redis.call("SET", KEYS[2], ARGV[2], "NX"); redis.call("SADD", KEYS[3], ARGV[1]); return 1',
    3,
    key(`issued:${telegramId}`),
    key(`issued-at:${email}`),
    key('issued-emails'),
    email,
    String(issuedAt),
  ]);
}

async function restoreIssued(telegramId, email, issuedAt = Date.now()) {
  await command([
    'EVAL',
    'redis.call("SET", KEYS[1], ARGV[1]); redis.call("SET", KEYS[2], ARGV[2]); redis.call("SADD", KEYS[3], ARGV[1]); return 1',
    3,
    key(`issued:${telegramId}`),
    key(`issued-at:${email}`),
    key('issued-emails'),
    email,
    String(issuedAt),
  ]);
}

async function readGatewayToken(email, subId) {
  if (typeof email !== 'string' || !email || !validSubscriptionId(subId)) return null;
  const record = parseGatewayRecord(await command(['GET', gatewayEmailKey(email)]));
  if (!record || record.subId !== subId) return null;
  const owner = await command(['GET', gatewayTokenKey(record.token)]);
  return owner === subId ? record.token : null;
}

async function ensureGatewayToken(email, subId, { rotate = false } = {}) {
  if (typeof email !== 'string' || !email || !validSubscriptionId(subId)) {
    throw new Error('Invalid gateway identity');
  }
  const previous = parseGatewayRecord(await command(['GET', gatewayEmailKey(email)]));
  if (!rotate && previous?.subId === subId) {
    const owner = await command(['GET', gatewayTokenKey(previous.token)]);
    if (owner === subId) return previous.token;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const token = createGatewayToken();
    const record = JSON.stringify({ subId, token });
    const oldTokenKey = previous ? gatewayTokenKey(previous.token) : key('gateway:missing-token');
    const oldSubscriptionKey = previous ? gatewaySubscriptionKey(previous.subId) : key('gateway:missing-sub');
    const result = await command([
      'EVAL',
      'local current = redis.call("GET", KEYS[1]); ' +
      'if current and ARGV[3] == "0" then return current end; ' +
      'redis.call("SET", KEYS[1], ARGV[1]); redis.call("SET", KEYS[2], ARGV[2]); redis.call("SET", KEYS[3], ARGV[4]); ' +
      'if current and KEYS[4] ~= KEYS[2] then redis.call("DEL", KEYS[4]); end; ' +
      'if current and KEYS[5] ~= KEYS[3] then redis.call("DEL", KEYS[5]); end; ' +
      'return ARGV[1]',
      5,
      gatewayEmailKey(email),
      gatewayTokenKey(token),
      gatewaySubscriptionKey(subId),
      oldTokenKey,
      oldSubscriptionKey,
      record,
      subId,
      (rotate || Boolean(previous)) ? '1' : '0',
      token,
    ]);
    const saved = parseGatewayRecord(result);
    if (saved?.subId === subId && validGatewayToken(saved.token)) {
      const owner = await command(['GET', gatewayTokenKey(saved.token)]);
      if (owner === subId) return saved.token;
    }
  }
  throw new Error('Unable to allocate gateway token');
}

async function readGatewayTokenForSubscription(subId) {
  if (!validSubscriptionId(subId)) return null;
  const token = await command(['GET', gatewaySubscriptionKey(subId)]);
  if (!validGatewayToken(token)) return null;
  const owner = await command(['GET', gatewayTokenKey(token)]);
  return owner === subId ? token : null;
}

async function readIssuedAt(email) {
  const value = await command(['GET', key(`issued-at:${email}`)]);
  return value ? Number(value) : null;
}

async function listIssuedEmails() {
  return (await command(['SMEMBERS', key('issued-emails')])) || [];
}

async function countIssuedEmails() {
  return Number(await command(['SCARD', key('issued-emails')])) || 0;
}

function rateKey(scope, identifier, windowSeconds, now) {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(scope)) throw new Error('Invalid rate limit scope');
  if (typeof identifier !== 'string' || !identifier || identifier.length > 512) {
    throw new Error('Invalid rate limit identifier');
  }
  const bucket = Math.floor(now / 1000 / windowSeconds);
  const digest = createHash('sha256').update(identifier).digest('base64url');
  return key(`rate:${scope}:${bucket}:${digest}`);
}

async function fixedWindowRateLimit(scope, identifier, { limit, windowSeconds, now = Date.now() }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000 ||
      !Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86400 ||
      !Number.isFinite(now)) {
    throw new Error('Invalid rate limit');
  }
  const count = Number(await command([
    'EVAL',
    'local current = redis.call("INCR", KEYS[1]); if current == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]); end; return current',
    1,
    rateKey(scope, identifier, windowSeconds, now),
    String(windowSeconds),
  ]));
  const elapsed = Math.floor(now / 1000) % windowSeconds;
  return {
    allowed: Number.isFinite(count) && count <= limit,
    count,
    retryAfter: Math.max(1, windowSeconds - elapsed),
  };
}

function validOpaqueToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{24,64}$/.test(value);
}

async function issueWebClaim() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomBytes(24).toString('base64url');
    const stored = await command([
      'SET', key(`claim:${token}`), '1', 'NX', 'EX', String(CLAIM_TTL_SECONDS),
    ]);
    if (stored === 'OK') return token;
  }
  throw new Error('Unable to issue claim');
}

async function consumeWebClaim(token) {
  if (!validOpaqueToken(token)) return false;
  const value = await command([
    'EVAL',
    'local value = redis.call("GET", KEYS[1]); if value then redis.call("DEL", KEYS[1]); return value; end; return false',
    1,
    key(`claim:${token}`),
  ]);
  return value === '1';
}

function validUpdateId(value) {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);
}

async function claimWebhookUpdate(updateId, claimId) {
  if (!validUpdateId(updateId) || !validOpaqueToken(claimId)) return false;
  return (await command([
    'SET', key(`webhook:${updateId}`), claimId, 'NX', 'EX', String(UPDATE_PROCESSING_TTL_SECONDS),
  ])) === 'OK';
}

async function completeWebhookUpdate(updateId, claimId) {
  if (!validUpdateId(updateId) || !validOpaqueToken(claimId)) return false;
  return Number(await command([
    'EVAL',
    'if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("SET", KEYS[1], "done", "EX", ARGV[2]); return 1; end; return 0',
    1,
    key(`webhook:${updateId}`), claimId, String(UPDATE_DONE_TTL_SECONDS),
  ])) === 1;
}

async function releaseWebhookUpdate(updateId, claimId) {
  if (!validUpdateId(updateId) || !validOpaqueToken(claimId)) return false;
  return Number(await command([
    'EVAL',
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]); else return 0; end',
    1,
    key(`webhook:${updateId}`), claimId,
  ])) === 1;
}

module.exports = {
  configured,
  command,
  readPolicy,
  savePolicy,
  claimTelegram,
  releaseTelegram,
  nextEmail,
  seedCounter,
  readIssuedEmail,
  recordIssued,
  restoreIssued,
  readGatewayToken,
  ensureGatewayToken,
  readGatewayTokenForSubscription,
  readIssuedAt,
  listIssuedEmails,
  countIssuedEmails,
  fixedWindowRateLimit,
  issueWebClaim,
  consumeWebClaim,
  claimWebhookUpdate,
  completeWebhookUpdate,
  releaseWebhookUpdate,
};

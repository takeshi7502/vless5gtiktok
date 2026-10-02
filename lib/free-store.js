const { createHash, randomBytes } = require('node:crypto');

const PREFIX = 'free-web:v1:';
const CLAIM_TTL_SECONDS = 5 * 60;
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

async function renewTelegramClaim(telegramId, claimId) {
  const renewed = Number(await command([
    'EVAL',
    'if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("EXPIRE", KEYS[1], 120); return 1; end; return 0',
    1, key(`claim:${telegramId}`), claimId,
  ]));
  if (renewed !== 1) throw new Error('Client creation is already in progress');
}

async function readPendingClient(telegramId) {
  const value = await command(['GET', key(`pending:${telegramId}`)]);
  return value ? JSON.parse(value) : null;
}

async function reservePendingClient(telegramId, draft, claimId) {
  const value = await command([
    'EVAL',
    'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return ""; end; ' +
    'redis.call("SET", KEYS[2], ARGV[2], "NX"); return redis.call("GET", KEYS[2])',
    2, key(`claim:${telegramId}`), key(`pending:${telegramId}`), claimId, JSON.stringify(draft),
  ]);
  if (!value) throw new Error('Client creation is already in progress');
  return JSON.parse(value);
}

async function discardPendingClient(telegramId, email, claimId) {
  const removed = Number(await command([
    'EVAL',
    'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0; end; ' +
    'local value = redis.call("GET", KEYS[2]); ' +
    'if value and cjson.decode(value).client.email == ARGV[2] then redis.call("DEL", KEYS[2]); return 1; end; return 0',
    2, key(`claim:${telegramId}`), key(`pending:${telegramId}`), claimId, email,
  ]));
  if (removed !== 1) throw new Error('Client creation is already in progress');
}

async function nextEmail() {
  await command(['SET', key('counter'), 0, 'NX']);
  const number = await command(['INCR', key('counter')]);
  return `#${String(number).padStart(3, '0')}`;
}

async function seedCounter(minimum) {
  if (!Number.isSafeInteger(minimum) || minimum < 0) throw new Error('Invalid counter');
  return command([
    'EVAL',
    'local current = tonumber(redis.call("GET", KEYS[1]) or "0"); if current < tonumber(ARGV[1]) then redis.call("SET", KEYS[1], ARGV[1]); return ARGV[1] end; return current',
    1,
    key('counter'),
    minimum,
  ]);
}

async function readIssuedEmail(telegramId) {
  return command(['GET', key(`issued:${telegramId}`)]);
}

async function recordIssued(telegramId, email, issuedAt = Date.now(), claimId = '') {
  const result = Number(await command([
    'EVAL',
    'if ARGV[3] ~= "" and redis.call("GET", KEYS[5]) ~= ARGV[3] then return 0; end; ' +
    'redis.call("SET", KEYS[1], ARGV[1]); redis.call("SET", KEYS[2], ARGV[2], "NX"); ' +
    'redis.call("SADD", KEYS[3], ARGV[1]); redis.call("DEL", KEYS[4]); return 1',
    5,
    key(`issued:${telegramId}`),
    key(`issued-at:${email}`),
    key('issued-emails'),
    key(`pending:${telegramId}`),
    key(`claim:${telegramId}`),
    email,
    String(issuedAt),
    claimId,
  ]));
  if (result !== 1) throw new Error('Client creation is already in progress');
}

async function removeIssuedEmail(email) {
  // Keep the mapping until the next verified web claim replaces a deleted client.
  await command(['SREM', key('issued-emails'), email]);
}

async function reconcileIssuedEmails(presentEmails, observedEmails, snapshotAt) {
  const present = new Set(presentEmails);
  const missing = observedEmails.filter((email) => !present.has(email));
  if (missing.length === 0 && presentEmails.length === 0) return;
  await command([
    'EVAL',
    'local present = cjson.decode(ARGV[1]); local missing = cjson.decode(ARGV[2]); ' +
    'for _, email in ipairs(present) do redis.call("SADD", KEYS[1], email); end; ' +
    'for _, email in ipairs(missing) do ' +
    'local issued = tonumber(redis.call("GET", ARGV[4] .. email) or "0"); ' +
    'if issued <= tonumber(ARGV[3]) then redis.call("SREM", KEYS[1], email); end; end; return 1',
    1,
    key('issued-emails'),
    JSON.stringify(presentEmails),
    JSON.stringify(missing),
    String(snapshotAt),
    key('issued-at:'),
  ]);
}

async function readIssuedAt(email) {
  const value = await command(['GET', key(`issued-at:${email}`)]);
  return value ? Number(value) : null;
}

async function readExpirySettings(email) {
  return command(['GET', key(`expiry-settings:${email}`)]);
}

async function saveExpirySettings(email, settings) {
  await command(['SET', key(`expiry-settings:${email}`), settings]);
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

function validClaimUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function parseWebClaim(value) {
  if (value === 'pending' || value === 'claimed') return { state: value };
  if (typeof value !== 'string') return { state: 'expired' };
  try {
    const record = JSON.parse(value);
    if (record?.state === 'ready' && validClaimUrl(record.url) && /^#\d{3,}$/.test(record.email || '')) {
      return { state: 'ready', url: record.url, email: record.email };
    }
    if (record?.state === 'disabled' || record?.state === 'failed') {
      return { state: record.state };
    }
  } catch {
    // Treat malformed claim records as expired rather than exposing them.
  }
  return { state: 'expired' };
}

async function issueWebClaim() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomBytes(24).toString('base64url');
    const stored = await command([
      'SET', key(`claim:${token}`), 'pending', 'NX', 'EX', String(CLAIM_TTL_SECONDS),
    ]);
    if (stored === 'OK') return token;
  }
  throw new Error('Unable to issue claim');
}

async function consumeWebClaim(token) {
  if (!validOpaqueToken(token)) return false;
  return Number(await command([
    'EVAL',
    'local value = redis.call("GET", KEYS[1]); if value == "pending" then redis.call("SET", KEYS[1], "claimed", "EX", ARGV[1]); return 1; end; return 0',
    1,
    key(`claim:${token}`),
    String(CLAIM_TTL_SECONDS),
  ])) === 1;
}

async function readWebClaim(token) {
  if (!validOpaqueToken(token)) return { state: 'expired' };
  return parseWebClaim(await command(['GET', key(`claim:${token}`)]));
}

async function readWebClaimLimited(token, ip, { scope, ipLimit, tokenLimit, now = Date.now() }) {
  if (!validOpaqueToken(token)) return { allowed: true, claim: { state: 'expired' } };
  const windowSeconds = 60;
  const result = await command([
    'EVAL',
    'local ip = tonumber(redis.call("GET", KEYS[2]) or "0"); ' +
    'if ip >= tonumber(ARGV[1]) then return {0, ""}; end; ' +
    'local claim = redis.call("GET", KEYS[1]); ' +
    'if not claim then ' +
    'if redis.call("INCR", KEYS[2]) == 1 then redis.call("EXPIRE", KEYS[2], 61); end; return {1, ""}; end; ' +
    'local token = tonumber(redis.call("GET", KEYS[3]) or "0"); ' +
    'if token >= tonumber(ARGV[2]) then return {0, ""}; end; ' +
    'if redis.call("INCR", KEYS[2]) == 1 then redis.call("EXPIRE", KEYS[2], 61); end; ' +
    'if redis.call("INCR", KEYS[3]) == 1 then redis.call("EXPIRE", KEYS[3], 61); end; ' +
    'return {1, claim}',
    3, key(`claim:${token}`), rateKey(`${scope}-ip`, ip, windowSeconds, now),
    rateKey(`${scope}-token`, token, windowSeconds, now), ipLimit, tokenLimit,
  ]);
  if (!Array.isArray(result)) throw new Error('Invalid claim response');
  return {
    allowed: Number(result[0]) === 1,
    retryAfter: windowSeconds - Math.floor(now / 1000) % windowSeconds,
    claim: parseWebClaim(result[1]),
  };
}

async function finishWebClaim(token, state) {
  if (!validOpaqueToken(token)) return false;
  let record;
  if (state?.state === 'ready' && validClaimUrl(state.url) && /^#\d{3,}$/.test(state.email || '')) {
    record = JSON.stringify({ state: 'ready', url: state.url, email: state.email });
  } else if (state?.state === 'disabled' || state?.state === 'failed') {
    record = JSON.stringify({ state: state.state });
  } else {
    throw new Error('Invalid web claim result');
  }

  return Number(await command([
    'EVAL',
    'if redis.call("GET", KEYS[1]) == "claimed" then redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2]); return 1; end; return 0',
    1,
    key(`claim:${token}`),
    record,
    String(CLAIM_TTL_SECONDS),
  ])) === 1;
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
  renewTelegramClaim,
  readPendingClient,
  reservePendingClient,
  discardPendingClient,
  nextEmail,
  seedCounter,
  readIssuedEmail,
  recordIssued,
  removeIssuedEmail,
  reconcileIssuedEmails,
  readIssuedAt,
  readExpirySettings,
  saveExpirySettings,
  listIssuedEmails,
  countIssuedEmails,
  fixedWindowRateLimit,
  issueWebClaim,
  consumeWebClaim,
  readWebClaim,
  readWebClaimLimited,
  finishWebClaim,
  claimWebhookUpdate,
  completeWebhookUpdate,
  releaseWebhookUpdate,
};

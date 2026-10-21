const { createHash, randomBytes } = require('node:crypto');
const { parseClientEmail, MAX_CLIENT_NUMBER } = require('./free-client-id');

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

async function registrationEnabled() {
  const value = await command(['GET', key('registration')]);
  if (value !== null && value !== 'on' && value !== 'off')
    throw new Error('Invalid registration state');
  return value !== 'off';
}

async function setRegistrationEnabled(enabled, updateId) {
  if (typeof enabled !== 'boolean' || !validUpdateId(updateId))
    throw new Error('Invalid registration update');
  // Ignore delayed/retried older commands so they cannot undo a newer switch.
  const value = await command([
    'EVAL',
    'local previous = redis.call("GET", KEYS[2]); ' +
      'if not previous or tonumber(ARGV[2]) > tonumber(previous) then ' +
      'redis.call("SET", KEYS[1], ARGV[1]); redis.call("SET", KEYS[2], ARGV[2], "EX", 604800); end; ' +
      'return redis.call("GET", KEYS[1])',
    2,
    key('registration'),
    key('registration-update'),
    enabled ? 'on' : 'off',
    updateId,
  ]);
  if (value !== 'on' && value !== 'off') throw new Error('Invalid registration state');
  return value === 'on';
}

function registrationPaused() {
  return Object.assign(new Error('Registration is paused'), { code: 'REGISTRATION_PAUSED' });
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
  const renewed = Number(
    await command([
      'EVAL',
      'if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("EXPIRE", KEYS[1], 120); return 1; end; return 0',
      1,
      key(`claim:${telegramId}`),
      claimId,
    ]),
  );
  if (renewed !== 1) throw new Error('Client creation is already in progress');
}

async function readPendingClient(telegramId) {
  const value = await command(['GET', key(`pending:${telegramId}`)]);
  return value ? JSON.parse(value) : null;
}

async function claimAllocation(claimId) {
  return (await command(['SET', key('allocation:claim'), claimId, 'NX', 'EX', 120])) === 'OK';
}

async function renewAllocationClaim(claimId) {
  const renewed = Number(
    await command([
      'EVAL',
      'if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("EXPIRE", KEYS[1], 120); return 1; end; return 0',
      1,
      key('allocation:claim'),
      claimId,
    ]),
  );
  if (renewed !== 1) throw new Error('Client creation is already in progress');
}

async function releaseAllocation(claimId) {
  return command([
    'EVAL',
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
    1,
    key('allocation:claim'),
    claimId,
  ]);
}

async function readPendingAllocation() {
  const result = await command([
    'EVAL',
    'local owner = redis.call("GET", KEYS[1]); if not owner then return {}; end; ' +
      'local value = redis.call("GET", ARGV[1] .. owner); ' +
      'if not value then return redis.error_reply("Missing pending allocation"); end; return {owner, value}',
    1,
    key('allocation:pending'),
    key('pending:'),
  ]);
  if (!Array.isArray(result)) throw new Error('Invalid pending allocation');
  if (result.length === 0) return null;
  if (result.length !== 2 || !/^[1-9]\d{0,15}$/.test(result[0]))
    throw new Error('Invalid pending allocation');
  return { telegramId: result[0], pending: JSON.parse(result[1]) };
}

async function scanClientRecords(claimId, includeClaims = false) {
  const result = new Map();
  let cursor = '0';
  let pages = 0;
  do {
    await renewAllocationClaim(claimId);
    const page = await command(['SCAN', cursor, 'MATCH', key('*'), 'COUNT', 500]);
    if (!Array.isArray(page) || page.length !== 2 || !Array.isArray(page[1]))
      throw new Error('Invalid allocation scan');
    cursor = String(page[0]);
    if (!/^\d+$/.test(cursor) || ++pages > 1000)
      throw new Error('Allocation scan exceeded its limit');
    const names = page[1].filter(
      (name) =>
        name.startsWith(key('pending:')) ||
        name.startsWith(key('issued:')) ||
        (includeClaims &&
          ['claim:', 'issued-at:', 'expiry-settings:', 'backfill:'].some((prefix) =>
            name.startsWith(key(prefix)),
          )),
    );
    for (let offset = 0; offset < names.length; offset += 100) {
      const batch = names.slice(offset, offset + 100);
      const values = await command(['MGET', ...batch]);
      if (!Array.isArray(values) || values.length !== batch.length)
        throw new Error('Invalid allocation records');
      values.forEach((value, index) => {
        if (value !== null) result.set(batch[index], value);
      });
    }
  } while (cursor !== '0');
  return result;
}

async function nextClientEmail(xui, claimId) {
  const rows = await xui.listClients();
  const records = await scanClientRecords(claimId);
  const state = await command([
    'EVAL',
    'return {redis.call("GET", KEYS[1]) or "0", redis.call("HGETALL", KEYS[2]), redis.call("HKEYS", KEYS[3])}',
    3,
    key('counter'),
    key('generations'),
    key('deletions'),
  ]);
  let maximum = Number(state[0]);
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_CLIENT_NUMBER)
    throw new Error('Invalid client counter');
  const generations = new Map();
  for (let i = 0; i < state[1].length; i += 2)
    generations.set(state[1][i], Number(state[1][i + 1]));
  const occupied = new Set();
  const occupy = (email) => {
    const id = parseClientEmail(email);
    if (!id) return;
    occupied.add(id.number);
    maximum = Math.max(maximum, id.number);
  };
  for (const item of rows) {
    const row = item?.client || item;
    if (!row || typeof row.email !== 'string') throw new Error('Invalid panel client list');
    occupy(row.email);
  }
  for (const [name, value] of records) {
    const email = name.startsWith(key('pending:')) ? JSON.parse(value).client?.email : value;
    if (!parseClientEmail(email)) throw new Error('Invalid client allocation record');
    occupy(email);
  }
  for (const base of state[2]) occupy(base);
  let number = 1;
  for (const used of [...occupied].sort((a, b) => a - b)) {
    if (used > number) break;
    if (used === number) number++;
  }
  if (number > MAX_CLIENT_NUMBER) throw new Error('Client IDs exhausted');
  const base = '#' + String(number).padStart(3, '0');
  const previous = generations.get(base);
  if (
    previous !== undefined &&
    (!Number.isSafeInteger(previous) || previous < 0 || previous >= MAX_CLIENT_NUMBER)
  )
    throw new Error('Invalid client generation');
  const generation = previous !== undefined ? previous + 1 : number <= maximum ? 1 : 0;
  return { email: base + (generation ? '-' + generation : ''), maximum };
}

async function isClientRevoked(email) {
  const id = parseClientEmail(email);
  if (!id) throw new Error('Invalid client ID');
  return (
    Number(
      await command([
        'EVAL',
        'return redis.call("SISMEMBER", KEYS[1], ARGV[1]) + redis.call("HEXISTS", KEYS[2], ARGV[2])',
        2,
        key('revoked-emails'),
        key('deletions'),
        email,
        id.base,
      ]),
    ) > 0
  );
}

async function reservePendingClient(telegramId, draft, claimId, xui) {
  const existing = await readPendingClient(telegramId);
  const selection = existing
    ? { email: existing.client.email, maximum: 0 }
    : await nextClientEmail(xui, claimId);
  const id = parseClientEmail(selection.email);
  if (!id) throw new Error('Invalid pending client');
  const value = await command([
    'EVAL',
    'if redis.call("GET", KEYS[1]) ~= ARGV[1] or redis.call("GET", KEYS[4]) ~= ARGV[1] then return ""; end; ' +
      'if redis.call("SISMEMBER", KEYS[6], ARGV[4]) == 1 or redis.call("HEXISTS", KEYS[7], ARGV[7]) == 1 then return ""; end; ' +
      'local owner = redis.call("GET", KEYS[5]); if owner and owner ~= ARGV[3] then return ""; end; ' +
      'local value = redis.call("GET", KEYS[2]); if not value then ' +
      'local draft = cjson.decode(ARGV[2]); draft.reused = tonumber(ARGV[6]) > 0; ' +
      'draft.client.email = ARGV[4]; value = cjson.encode(draft); redis.call("SET", KEYS[2], value); end; ' +
      'if tonumber(ARGV[5]) > tonumber(redis.call("GET", KEYS[3]) or "0") then redis.call("SET", KEYS[3], ARGV[5]); end; ' +
      'redis.call("SET", KEYS[5], ARGV[3]); return value',
    7,
    key('claim:' + telegramId),
    key('pending:' + telegramId),
    key('counter'),
    key('allocation:claim'),
    key('allocation:pending'),
    key('revoked-emails'),
    key('deletions'),
    claimId,
    JSON.stringify(draft),
    String(telegramId),
    selection.email,
    selection.maximum,
    id.generation,
    id.base,
  ]);
  if (!value) throw new Error('Client creation is already in progress');
  return JSON.parse(value);
}

async function discardPendingClient(telegramId, email, claimId) {
  const id = parseClientEmail(email);
  if (!id) throw new Error('Invalid client ID');
  const removed = Number(
    await command([
      'EVAL',
      'if redis.call("GET", KEYS[1]) ~= ARGV[1] or redis.call("GET", KEYS[3]) ~= ARGV[1] ' +
        'or redis.call("GET", KEYS[5]) ~= ARGV[3] then return 0; end; ' +
        'local value = redis.call("GET", KEYS[2]); if not value or cjson.decode(value).client.email ~= ARGV[2] then return 0; end; ' +
        'if tonumber(ARGV[4]) > tonumber(redis.call("GET", KEYS[4]) or "0") then redis.call("SET", KEYS[4], ARGV[4]); end; ' +
        'redis.call("DEL", KEYS[2], KEYS[5]); return 1',
      5,
      key('claim:' + telegramId),
      key('pending:' + telegramId),
      key('allocation:claim'),
      key('counter'),
      key('allocation:pending'),
      claimId,
      email,
      String(telegramId),
      id.number,
    ]),
  );
  if (removed !== 1) throw new Error('Client creation is already in progress');
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

async function recordIssued(
  telegramId,
  email,
  issuedAt = Date.now(),
  claimId,
  notifyAdmin = false,
) {
  const id = parseClientEmail(email);
  if (!id) throw new Error('Invalid client ID');
  const result = Number(
    await command([
      'EVAL',
      'if redis.call("GET", KEYS[5]) ~= ARGV[3] or redis.call("GET", KEYS[7]) ~= ARGV[3] ' +
        'or redis.call("GET", KEYS[8]) ~= ARGV[4] then return 0; end; ' +
        'local pending = redis.call("GET", KEYS[4]); ' +
        'if not pending or cjson.decode(pending).client.email ~= ARGV[1] then return 0; end; ' +
        'local number = tonumber(ARGV[7]); ' +
        'if number > tonumber(redis.call("GET", KEYS[6]) or "0") then redis.call("SET", KEYS[6], number); end; ' +
        'if ARGV[5] == "1" and redis.call("EXISTS", KEYS[1]) == 0 then ' +
        'redis.call("HSET", KEYS[10], "email", ARGV[1], "label", cjson.decode(pending).client.comment, "verifiedAt", ARGV[6]); ' +
        'redis.call("EXPIRE", KEYS[10], 604800); redis.call("ZADD", KEYS[11], ARGV[6], ARGV[4]); ' +
        'redis.call("EXPIRE", KEYS[11], 604800); end; ' +
        'redis.call("SET", KEYS[1], ARGV[1]); ' +
        'if cjson.decode(pending).reused or cjson.decode(pending).backfill then redis.call("SET", KEYS[2], ARGV[2]); ' +
        'else redis.call("SET", KEYS[2], ARGV[2], "NX"); end; ' +
        'redis.call("SADD", KEYS[3], ARGV[1]); ' +
        'local generation = tonumber(redis.call("HGET", KEYS[9], ARGV[8]) or "0"); ' +
        'redis.call("HSET", KEYS[9], ARGV[8], math.max(generation, tonumber(ARGV[9]))); ' +
        'redis.call("DEL", KEYS[4], KEYS[8]); return 1',
      11,
      key(`issued:${telegramId}`),
      key(`issued-at:${email}`),
      key('issued-emails'),
      key(`pending:${telegramId}`),
      key(`claim:${telegramId}`),
      key('counter'),
      key('allocation:claim'),
      key('allocation:pending'),
      key('generations'),
      key(`notification:user:${telegramId}`),
      key('notifications:users'),
      email,
      String(issuedAt),
      claimId,
      String(telegramId),
      notifyAdmin ? '1' : '0',
      Date.now(),
      id.number,
      id.base,
      id.generation,
    ]),
  );
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
      'for _, email in ipairs(present) do if redis.call("SISMEMBER", KEYS[2], email) == 0 then redis.call("SADD", KEYS[1], email); end; end; ' +
      'for _, email in ipairs(missing) do ' +
      'local issued = tonumber(redis.call("GET", ARGV[4] .. email) or "0"); ' +
      'if issued <= tonumber(ARGV[3]) then redis.call("SREM", KEYS[1], email); end; end; return 1',
    2,
    key('issued-emails'),
    key('revoked-emails'),
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
  const id = parseClientEmail(email);
  if (!id) throw new Error('Invalid client ID');
  await command([
    'EVAL',
    'if redis.call("SISMEMBER", KEYS[2], ARGV[2]) == 1 or redis.call("HEXISTS", KEYS[3], ARGV[3]) == 1 then return 0; end; ' +
      'redis.call("SET", KEYS[1], ARGV[1]); return 1',
    3,
    key(`expiry-settings:${email}`),
    key('revoked-emails'),
    key('deletions'),
    settings,
    email,
    id.base,
  ]);
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
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100000 ||
    !Number.isSafeInteger(windowSeconds) ||
    windowSeconds < 1 ||
    windowSeconds > 86400 ||
    !Number.isFinite(now)
  ) {
    throw new Error('Invalid rate limit');
  }
  const count = Number(
    await command([
      'EVAL',
      'local current = redis.call("INCR", KEYS[1]); if current == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]); end; return current',
      1,
      rateKey(scope, identifier, windowSeconds, now),
      String(windowSeconds),
    ]),
  );
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
    if (record?.state === 'ready' && validClaimUrl(record.url) && parseClientEmail(record.email)) {
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
      'EVAL',
      'local mode = redis.call("GET", KEYS[2]); if mode and mode ~= "on" then return "paused"; end; ' +
        'return redis.call("SET", KEYS[1], "pending", "NX", "EX", ARGV[1])',
      2,
      key(`claim:${token}`),
      key('registration'),
      String(CLAIM_TTL_SECONDS),
    ]);
    if (stored === 'paused') throw registrationPaused();
    if (stored === 'OK') return token;
  }
  throw new Error('Unable to issue claim');
}

async function consumeWebClaim(token) {
  if (!validOpaqueToken(token)) return false;
  const result = Number(
    await command([
      'EVAL',
      'local mode = redis.call("GET", KEYS[2]); if mode and mode ~= "on" then return -1; end; ' +
        'local value = redis.call("GET", KEYS[1]); if value == "pending" then redis.call("SET", KEYS[1], "claimed", "EX", ARGV[1]); return 1; end; return 0',
      2,
      key(`claim:${token}`),
      key('registration'),
      String(CLAIM_TTL_SECONDS),
    ]),
  );
  if (result === -1) throw registrationPaused();
  return result === 1;
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
      'local mode = redis.call("GET", KEYS[4]); ' +
      'if claim == "pending" and mode and mode ~= "on" then return {1, "paused"}; end; ' +
      'return {1, claim}',
    4,
    key(`claim:${token}`),
    rateKey(`${scope}-ip`, ip, windowSeconds, now),
    rateKey(`${scope}-token`, token, windowSeconds, now),
    key('registration'),
    ipLimit,
    tokenLimit,
  ]);
  if (!Array.isArray(result)) throw new Error('Invalid claim response');
  return {
    allowed: Number(result[0]) === 1,
    retryAfter: windowSeconds - (Math.floor(now / 1000) % windowSeconds),
    claim: result[1] === 'paused' ? { state: 'paused' } : parseWebClaim(result[1]),
  };
}

async function finishWebClaim(token, state) {
  if (!validOpaqueToken(token)) return false;
  let record;
  if (state?.state === 'ready' && validClaimUrl(state.url) && parseClientEmail(state.email)) {
    record = JSON.stringify({ state: 'ready', url: state.url, email: state.email });
  } else if (state?.state === 'disabled' || state?.state === 'failed') {
    record = JSON.stringify({ state: state.state });
  } else {
    throw new Error('Invalid web claim result');
  }

  return (
    Number(
      await command([
        'EVAL',
        'if ARGV[3] ~= "" and (redis.call("SISMEMBER", KEYS[2], ARGV[3]) == 1 or redis.call("HEXISTS", KEYS[3], ARGV[4]) == 1) then return 0; end; ' +
          'if redis.call("GET", KEYS[1]) == "claimed" then redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2]); return 1; end; return 0',
        3,
        key(`claim:${token}`),
        key('revoked-emails'),
        key('deletions'),
        record,
        String(CLAIM_TTL_SECONDS),
        state.state === 'ready' ? state.email : '',
        state.state === 'ready' ? parseClientEmail(state.email).base : '',
      ]),
    ) === 1
  );
}

function validUpdateId(value) {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);
}

async function claimWebhookUpdate(updateId, claimId) {
  if (!validUpdateId(updateId) || !validOpaqueToken(claimId)) return false;
  return (
    (await command([
      'SET',
      key(`webhook:${updateId}`),
      claimId,
      'NX',
      'EX',
      String(UPDATE_PROCESSING_TTL_SECONDS),
    ])) === 'OK'
  );
}

async function completeWebhookUpdate(updateId, claimId) {
  if (!validUpdateId(updateId) || !validOpaqueToken(claimId)) return false;
  return (
    Number(
      await command([
        'EVAL',
        'if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("SET", KEYS[1], "done", "EX", ARGV[2]); return 1; end; return 0',
        1,
        key(`webhook:${updateId}`),
        claimId,
        String(UPDATE_DONE_TTL_SECONDS),
      ]),
    ) === 1
  );
}

async function releaseWebhookUpdate(updateId, claimId) {
  if (!validUpdateId(updateId) || !validOpaqueToken(claimId)) return false;
  return (
    Number(
      await command([
        'EVAL',
        'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]); else return 0; end',
        1,
        key(`webhook:${updateId}`),
        claimId,
      ]),
    ) === 1
  );
}

module.exports = {
  configured,
  command,
  readPolicy,
  savePolicy,
  registrationEnabled,
  setRegistrationEnabled,
  claimTelegram,
  releaseTelegram,
  renewTelegramClaim,
  claimAllocation,
  renewAllocationClaim,
  releaseAllocation,
  readPendingAllocation,
  scanClientRecords,
  isClientRevoked,
  readPendingClient,
  reservePendingClient,
  discardPendingClient,
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

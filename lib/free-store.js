const { createHash, randomBytes } = require('node:crypto');

const PREFIX = 'free-web:v1:';
const CLAIM_TTL_SECONDS = 5 * 60;
const UPDATE_PROCESSING_TTL_SECONDS = 2 * 60;
const UPDATE_DONE_TTL_SECONDS = 7 * 24 * 60 * 60;
// Explicitly approved historical gaps; never recycle arbitrary deleted client numbers.
const BACKFILL_EMAILS = ['#187', '#267'];

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

async function findBackfillEmail(telegramId, claimId) {
  const state = await command([
    'MGET',
    key(`pending:${telegramId}`),
    key('counter'),
    ...BACKFILL_EMAILS.map((email) => key(`backfill:${email}`)),
  ]);
  if (!Array.isArray(state) || state.length !== 2 + BACKFILL_EMAILS.length) {
    throw new Error('Invalid allocation backfill state');
  }
  if (state[0] !== null) return '';
  const counter = Number(state[1] ?? 0);
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('Invalid client counter');
  const candidates = BACKFILL_EMAILS.filter(
    (email, index) => Number(email.slice(1)) < counter && state[index + 2] === null,
  );
  if (!candidates.length) return '';

  const occupied = new Set();
  for (const email of candidates) {
    if (
      (await command(['GET', key(`issued-at:${email}`)])) !== null ||
      Number(await command(['SISMEMBER', key('issued-emails'), email])) === 1
    ) {
      occupied.add(email);
    }
  }
  // Legacy reservations and retained mappings may not appear in the active-email index.
  if (occupied.size < candidates.length) {
    let cursor = '0';
    let pages = 0;
    do {
      await renewAllocationClaim(claimId);
      const page = await command(['SCAN', cursor, 'MATCH', key('*'), 'COUNT', 500]);
      if (!Array.isArray(page) || page.length !== 2 || !Array.isArray(page[1])) {
        throw new Error('Invalid allocation backfill scan');
      }
      cursor = String(page[0]);
      if (!/^\d+$/.test(cursor) || ++pages > 1000) {
        throw new Error('Allocation backfill scan exceeded its limit');
      }
      const records = page[1].filter(
        (name) => name.startsWith(key('pending:')) || name.startsWith(key('issued:')),
      );
      for (let offset = 0; offset < records.length; offset += 100) {
        const batch = records.slice(offset, offset + 100);
        const values = await command(['MGET', ...batch]);
        if (!Array.isArray(values) || values.length !== batch.length) {
          throw new Error('Invalid allocation backfill records');
        }
        for (let index = 0; index < values.length; index++) {
          const value = values[index];
          if (value === null) continue;
          const email = batch[index].startsWith(key('pending:'))
            ? JSON.parse(value).client?.email
            : value;
          if (typeof email !== 'string') throw new Error('Invalid allocation backfill record');
          if (candidates.includes(email)) occupied.add(email);
        }
      }
    } while (cursor !== '0');
  }
  for (const email of occupied) {
    const saved = await command([
      'EVAL',
      'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0; end; ' +
        'redis.call("SET", KEYS[2], "occupied"); return 1',
      2,
      key('allocation:claim'),
      key(`backfill:${email}`),
      claimId,
    ]);
    if (Number(saved) !== 1) throw new Error('Client creation is already in progress');
  }
  return candidates.find((email) => !occupied.has(email)) || '';
}

async function reservePendingClient(telegramId, draft, claimId) {
  const backfillEmail = await findBackfillEmail(telegramId, claimId);
  const value = await command([
    'EVAL',
    'if redis.call("GET", KEYS[1]) ~= ARGV[1] or redis.call("GET", KEYS[4]) ~= ARGV[1] then return ""; end; ' +
      'local owner = redis.call("GET", KEYS[5]); if owner and owner ~= ARGV[3] then return ""; end; ' +
      'local value = redis.call("GET", KEYS[2]); if not value then ' +
      'local draft = cjson.decode(ARGV[2]); local number = tonumber(redis.call("GET", KEYS[3]) or "0") + 1; ' +
      'if number < 1 or number > 999999999 then return redis.error_reply("Invalid client counter"); end; ' +
      'if ARGV[4] ~= "" then ' +
      'if redis.call("EXISTS", KEYS[6]) == 1 or redis.call("EXISTS", KEYS[7]) == 1 ' +
      'or redis.call("SISMEMBER", KEYS[8], ARGV[4]) == 1 ' +
      'or tonumber(string.sub(ARGV[4], 2)) >= number - 1 then return ""; end; ' +
      'number = tonumber(string.sub(ARGV[4], 2)); draft.backfill = true; end; ' +
      'draft.client.email = "#" .. string.format("%03d", number); value = cjson.encode(draft); ' +
      'redis.call("SET", KEYS[2], value); end; redis.call("SET", KEYS[5], ARGV[3]); return value',
    8,
    key(`claim:${telegramId}`),
    key(`pending:${telegramId}`),
    key('counter'),
    key('allocation:claim'),
    key('allocation:pending'),
    key(`backfill:${backfillEmail}`),
    key(`issued-at:${backfillEmail}`),
    key('issued-emails'),
    claimId,
    JSON.stringify(draft),
    String(telegramId),
    backfillEmail,
  ]);
  if (!value) throw new Error('Client creation is already in progress');
  return JSON.parse(value);
}

async function discardPendingClient(telegramId, email, claimId) {
  const removed = Number(
    await command([
      'EVAL',
      'if redis.call("GET", KEYS[1]) ~= ARGV[1] or redis.call("GET", KEYS[3]) ~= ARGV[1] ' +
        'or redis.call("GET", KEYS[5]) ~= ARGV[3] then return 0; end; ' +
        'local value = redis.call("GET", KEYS[2]); ' +
        'if value and cjson.decode(value).client.email == ARGV[2] then ' +
        'local number = tonumber(string.sub(ARGV[2], 2)); ' +
        'if number > tonumber(redis.call("GET", KEYS[4]) or "0") then redis.call("SET", KEYS[4], number); end; ' +
        'if ARGV[2] == "#187" or ARGV[2] == "#267" then redis.call("SET", KEYS[6], "occupied"); end; ' +
        'redis.call("DEL", KEYS[2], KEYS[5]); return 1; end; return 0',
      6,
      key(`claim:${telegramId}`),
      key(`pending:${telegramId}`),
      key('allocation:claim'),
      key('counter'),
      key('allocation:pending'),
      key(`backfill:${email}`),
      claimId,
      email,
      String(telegramId),
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

async function recordIssued(telegramId, email, issuedAt = Date.now(), claimId) {
  const result = Number(
    await command([
      'EVAL',
      'if redis.call("GET", KEYS[5]) ~= ARGV[3] or redis.call("GET", KEYS[7]) ~= ARGV[3] ' +
        'or redis.call("GET", KEYS[8]) ~= ARGV[4] then return 0; end; ' +
        'local pending = redis.call("GET", KEYS[4]); ' +
        'if not pending or cjson.decode(pending).client.email ~= ARGV[1] then return 0; end; ' +
        'local number = tonumber(string.sub(ARGV[1], 2)); ' +
        'if number > tonumber(redis.call("GET", KEYS[6]) or "0") then redis.call("SET", KEYS[6], number); end; ' +
        'redis.call("SET", KEYS[1], ARGV[1]); redis.call("SET", KEYS[2], ARGV[2], "NX"); ' +
        'redis.call("SADD", KEYS[3], ARGV[1]); ' +
        'if ARGV[1] == "#187" or ARGV[1] == "#267" then redis.call("SET", KEYS[9], "issued"); end; ' +
        'redis.call("DEL", KEYS[4], KEYS[8]); return 1',
      9,
      key(`issued:${telegramId}`),
      key(`issued-at:${email}`),
      key('issued-emails'),
      key(`pending:${telegramId}`),
      key(`claim:${telegramId}`),
      key('counter'),
      key('allocation:claim'),
      key('allocation:pending'),
      key(`backfill:${email}`),
      email,
      String(issuedAt),
      claimId,
      String(telegramId),
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
    if (
      record?.state === 'ready' &&
      validClaimUrl(record.url) &&
      /^#\d{3,}$/.test(record.email || '')
    ) {
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
  if (state?.state === 'ready' && validClaimUrl(state.url) && /^#\d{3,}$/.test(state.email || '')) {
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
        'if redis.call("GET", KEYS[1]) == "claimed" then redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2]); return 1; end; return 0',
        1,
        key(`claim:${token}`),
        record,
        String(CLAIM_TTL_SECONDS),
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

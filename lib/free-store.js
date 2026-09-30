const PREFIX = 'free-web:v1:';

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

async function readIssuedAt(email) {
  const value = await command(['GET', key(`issued-at:${email}`)]);
  return value ? Number(value) : null;
}

async function listIssuedEmails() {
  return (await command(['SMEMBERS', key('issued-emails')])) || [];
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
  readIssuedAt,
  listIssuedEmails,
};

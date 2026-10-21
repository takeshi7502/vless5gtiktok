const { randomUUID } = require('node:crypto');
const store = require('./free-store');
const { telegramAdminIds, sendTelegramMessage } = require('./telegram');
const { parseClientEmail } = require('./free-client-id');

const QUEUE_KEY = 'free-web:v1:notifications:users';
const LOCK_KEY = `${QUEUE_KEY}:delivery`;
const EVENT_PREFIX = 'free-web:v1:notification:user:';
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const RETRY_MS = 60_000;
const RECIPIENT_BATCH = 4;

function notificationMessage(telegramId, event) {
  const deleted = event.type === 'deleted';
  const owner = deleted ? event.telegramId : telegramId;
  const verifiedAt = Number(event.verifiedAt);
  if (
    (!deleted &&
      (!/^[1-9]\d{0,15}$/.test(telegramId) || !Number.isSafeInteger(Number(telegramId)))) ||
    (deleted &&
      (typeof owner !== 'string' ||
        owner.length > 1024 ||
        (owner !== '' && !/^[1-9]\d{0,15}(?:, [1-9]\d{0,15})*$/.test(owner)))) ||
    !parseClientEmail(event.email) ||
    !Number.isSafeInteger(verifiedAt) ||
    verifiedAt <= 0 ||
    verifiedAt > 8_640_000_000_000_000 ||
    typeof event.label !== 'string'
  ) {
    throw new Error('Invalid verification notification');
  }
  const label = event.label.startsWith('fw:') ? event.label.slice(3) : '';
  const name = [...label.replace(/[\x00-\x1f\x7f]/g, ' ').trim()].slice(0, 64).join('');
  const time = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    dateStyle: 'short',
    timeStyle: 'medium',
    hourCycle: 'h23',
  }).format(new Date(verifiedAt));
  return (
    (deleted
      ? 'Admin đã xoá client và dọn dữ liệu đăng ký.\n\n'
      : 'Có người dùng mới xác minh thành công.\n\n') +
    `Người dùng: ${name || 'Không có tên Telegram'}\n` +
    `Telegram ID: ${owner || 'Không còn thông tin'}\n` +
    `Client: ${event.email}\n` +
    `Thời gian: ${time} (giờ Việt Nam)`
  );
}

async function flushNewUserNotifications({ deps = store, send = sendTelegramMessage } = {}) {
  const admins = telegramAdminIds();
  if (!admins.length) return;
  const claimId = randomUUID();
  let claimed = false;
  try {
    const now = Date.now();
    if (Number(await deps.command(['ZCOUNT', QUEUE_KEY, '-inf', now])) === 0) return;
    claimed = (await deps.command(['SET', LOCK_KEY, claimId, 'NX', 'EX', 60])) === 'OK';
    if (!claimed) return;
    const entry = await deps.command([
      'EVAL',
      'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return {}; end; ' +
        'redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", ARGV[3]); ' +
        'local users = redis.call("ZRANGEBYSCORE", KEYS[2], "-inf", ARGV[2], "LIMIT", 0, 1); ' +
        'if #users == 0 then return {}; end; local event = redis.call("HGETALL", ARGV[4] .. users[1]); ' +
        'if #event == 0 then redis.call("ZREM", KEYS[2], users[1]); return {}; end; return {users[1], event}',
      2,
      LOCK_KEY,
      QUEUE_KEY,
      claimId,
      now,
      now - MAX_AGE_MS,
      EVENT_PREFIX,
    ]);
    if (!Array.isArray(entry)) throw new Error('Invalid notification queue');
    if (!entry.length) return;
    if (entry.length !== 2 || !Array.isArray(entry[1]) || entry[1].length % 2 !== 0) {
      throw new Error('Invalid notification queue');
    }
    const [telegramId, fields] = entry;
    const event = Object.fromEntries(
      Array.from({ length: fields.length / 2 }, (_, index) =>
        fields.slice(index * 2, index * 2 + 2),
      ),
    );
    // Defer before delivery so failures cannot trigger a Telegram API burst on every webhook.
    const deferred = await deps.command([
      'EVAL',
      'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0; end; ' +
        'if redis.call("HGET", KEYS[3], "email") ~= ARGV[4] or redis.call("HGET", KEYS[3], "verifiedAt") ~= ARGV[5] then return 0; end; ' +
        'redis.call("EXPIRE", KEYS[1], 60); redis.call("ZADD", KEYS[2], ARGV[2], ARGV[3]); return 1',
      3,
      LOCK_KEY,
      QUEUE_KEY,
      `${EVENT_PREFIX}${telegramId}`,
      claimId,
      now + RETRY_MS,
      telegramId,
      event.email,
      event.verifiedAt,
    ]);
    if (Number(deferred) !== 1) return;
    const message = notificationMessage(telegramId, event);
    const unsent = admins.filter((id) => event[`sent:${id}`] !== '1');
    for (const adminId of unsent.slice(0, RECIPIENT_BATCH)) {
      const limit = await deps.fixedWindowRateLimit('bot-new-user-admin', adminId, {
        limit: 20,
        windowSeconds: 60,
      });
      if (!limit.allowed) continue;
      const sent = await send(adminId, message, { timeoutMs: 3000 });
      if (!sent.sent) continue;
      const recorded = await deps.command([
        'EVAL',
        'if redis.call("GET", KEYS[1]) ~= ARGV[1] or redis.call("EXISTS", KEYS[2]) == 0 then return 0; end; ' +
          'if redis.call("HGET", KEYS[2], "email") ~= ARGV[3] or redis.call("HGET", KEYS[2], "verifiedAt") ~= ARGV[4] then return 0; end; ' +
          'redis.call("EXPIRE", KEYS[1], 60); redis.call("HSET", KEYS[2], ARGV[2], "1"); return 1',
        2,
        LOCK_KEY,
        `${EVENT_PREFIX}${telegramId}`,
        claimId,
        `sent:${adminId}`,
        event.email,
        event.verifiedAt,
      ]);
      if (Number(recorded) !== 1) return;
      event[`sent:${adminId}`] = '1';
    }
    if (admins.every((id) => event[`sent:${id}`] === '1')) {
      await deps.command([
        'EVAL',
        'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0; end; ' +
          'if redis.call("HGET", KEYS[2], "email") ~= ARGV[3] or redis.call("HGET", KEYS[2], "verifiedAt") ~= ARGV[4] then return 0; end; ' +
          'redis.call("DEL", KEYS[2]); redis.call("ZREM", KEYS[3], ARGV[2]); return 1',
        3,
        LOCK_KEY,
        `${EVENT_PREFIX}${telegramId}`,
        QUEUE_KEY,
        claimId,
        telegramId,
        event.email,
        event.verifiedAt,
      ]);
    }
  } catch {
    console.error('[free-web] admin notification deferred');
  } finally {
    if (claimed) {
      await deps
        .command([
          'EVAL',
          'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]); end; return 0',
          1,
          LOCK_KEY,
          claimId,
        ])
        .catch(() => {});
    }
  }
}

module.exports = { flushNewUserNotifications };

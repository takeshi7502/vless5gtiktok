const { randomUUID, createHash, createHmac, timingSafeEqual } = require('node:crypto');
const store = require('./free-store');
const { parseClientEmail, normalizeClientId, compareClientEmails } = require('./free-client-id');
const { isManagedRow } = require('./free-provision');
const { clearRankingCache } = require('./free-ranking');
const { clearSubscriptionCache } = require('./free-subscription');
const { flushNewUserNotifications } = require('./free-notifications');
const { telegramAdminIds } = require('./telegram');

const PREFIX = 'free-web:v1:';

class AdminClientError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

function belongs(email, base) {
  return parseClientEmail(email)?.base === base;
}

function identity(row) {
  const client = row.client;
  return {
    email: client.email,
    tgId: String(client.tgId || ''),
    subId: client.subId || '',
    id: client.id || '',
    uuid: client.uuid || '',
    comment: client.comment || '',
  };
}

function sign(value) {
  return createHmac('sha256', process.env.FREE_ADMIN_SECRET).update(value).digest('base64url');
}

function confirmation(base, digest, operationId = '') {
  const value = Buffer.from(
    JSON.stringify({ base, digest, operationId, expires: Date.now() + 5 * 60_000 }),
  ).toString('base64url');
  return `${value}.${sign(value)}`;
}

function verifyConfirmation(token, base) {
  if (typeof token !== 'string' || token.length > 2048)
    throw new AdminClientError('Hãy tra cứu client trước khi xoá.', 400);
  const [value, signature, extra] = token.split('.');
  const expected = Buffer.from(sign(value || ''));
  const actual = Buffer.from(signature || '');
  if (extra || expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new AdminClientError('Xác nhận xoá không hợp lệ. Hãy tra cứu lại.', 400);
  let data;
  try {
    data = JSON.parse(Buffer.from(value, 'base64url').toString());
  } catch {
    /* reject below */
  }
  if (
    !data ||
    data.base !== base ||
    !Number.isSafeInteger(data.expires) ||
    data.expires < Date.now()
  )
    throw new AdminClientError('Xác nhận đã hết hạn. Hãy tra cứu lại.', 409);
  return data;
}

async function locked(deps, operation) {
  const owner = randomUUID();
  if (!(await deps.claimAllocation(owner)))
    throw new AdminClientError('Đang cấp phát hoặc xử lý client khác. Vui lòng thử lại sau.');
  try {
    return await operation(owner);
  } finally {
    await deps.releaseAllocation(owner).catch(() => {});
  }
}

async function snapshot(base, xui, deps, owner) {
  const records = await deps.scanClientRecords(owner, true);
  const rows = (await xui.listClients()).map((item) => (item?.client ? item : { client: item }));
  if (rows.some((row) => typeof row.client?.email !== 'string'))
    throw new Error('Invalid panel client list');
  const clients = rows
    .filter((row) => belongs(row.client.email, base))
    .sort((a, b) => compareClientEmails(a.client.email, b.client.email));
  const matched = new Map();
  const owners = new Set();
  const emails = new Set([base]);
  const ownersDetails = [];
  for (const [name, value] of records) {
    let email;
    let pending;
    if (name.startsWith(`${PREFIX}issued:`)) email = value;
    else if (name.startsWith(`${PREFIX}pending:`)) {
      pending = JSON.parse(value);
      email = pending?.client?.email;
    } else if (name.startsWith(`${PREFIX}claim:`)) {
      try {
        email = JSON.parse(value)?.email;
      } catch {
        /* pending tokens and operation leases are not JSON */
      }
    } else email = name.slice(name.lastIndexOf(':') + 1);
    if (!belongs(email, base)) continue;
    matched.set(name, value);
    emails.add(email);
    if (name.startsWith(`${PREFIX}issued:`) || name.startsWith(`${PREFIX}pending:`)) {
      const telegramId = name.slice(name.lastIndexOf(':') + 1);
      if (!/^[1-9]\d{0,15}$/.test(telegramId)) throw new Error('Invalid client owner');
      owners.add(telegramId);
      ownersDetails.push({
        telegramId,
        email,
        state: pending ? 'pending' : 'issued',
        label: pending?.client?.comment || '',
      });
    }
  }
  for (const row of clients) {
    emails.add(row.client.email);
    if (/^[1-9]\d{0,15}$/.test(String(row.client.tgId))) owners.add(String(row.client.tgId));
  }
  for (const email of await deps.listIssuedEmails()) if (belongs(email, base)) emails.add(email);
  const [rawJournal, rawGeneration, rawCounter, revision] = await deps.command([
    'EVAL',
    'return {redis.call("HGET", KEYS[1], ARGV[1]) or "", redis.call("HGET", KEYS[2], ARGV[1]) or "0", redis.call("GET", KEYS[3]) or "0", redis.call("HGET", KEYS[4], ARGV[1]) or "0"}',
    4,
    `${PREFIX}deletions`,
    `${PREFIX}generations`,
    `${PREFIX}counter`,
    `${PREFIX}client-revisions`,
    base,
  ]);
  const journal = rawJournal ? JSON.parse(rawJournal) : null;
  const generation = Number(rawGeneration);
  const counter = Number(rawCounter);
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    !Number.isSafeInteger(counter) ||
    counter < 0
  )
    throw new Error('Invalid client lifecycle');
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        clients: clients.map(identity),
        records: [...matched]
          .filter(
            ([name]) => name.startsWith(`${PREFIX}issued:`) || name.startsWith(`${PREFIX}pending:`),
          )
          .sort(([a], [b]) => a.localeCompare(b)),
        generation,
        revision,
      }),
    )
    .digest('hex');
  return {
    base,
    clients,
    matched,
    owners: [...owners].sort(),
    ownersDetails,
    emails: [...emails].sort(compareClientEmails),
    journal,
    generation,
    counter,
    digest,
  };
}

async function inspectAdminClient(input, xui, deps = store) {
  const { base, number } = normalizeClientId(input);
  return locked(deps, async (owner) => {
    const data = await snapshot(base, xui, deps, owner);
    const supported = data.clients.every(isManagedRow);
    const known =
      data.clients.length > 0 ||
      data.matched.size > 0 ||
      number <= data.counter ||
      Boolean(data.journal);
    return {
      base,
      clients: data.clients,
      owners: data.ownersDetails,
      telegramIds: data.owners,
      redisKeys: [...data.matched.keys()],
      generation: data.generation,
      status: data.journal
        ? 'deleting'
        : data.clients.length
          ? 'present'
          : data.matched.size
            ? 'redis-only'
            : 'missing',
      canDelete: supported && known,
      message: !supported
        ? 'Có client không thuộc web quản lý. Không thể xoá tại đây.'
        : !known
          ? 'ID này chưa từng được cấp.'
          : '',
      confirmation:
        supported && known ? confirmation(base, data.digest, data.journal?.operationId) : null,
    };
  });
}

async function getClientOrNull(email, xui) {
  try {
    return await xui.getClient(email);
  } catch (error) {
    if (error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

async function deleteAdminClient(input, token, xui, deps = store) {
  const { base, number } = normalizeClientId(input);
  const approved = verifyConfirmation(token, base);
  const result = await locked(deps, async (owner) => {
    let data = await snapshot(base, xui, deps, owner);
    let journal = data.journal;
    if (journal) {
      if (approved.operationId !== journal.operationId && approved.digest !== journal.digest)
        throw new AdminClientError('Dữ liệu đã thay đổi. Hãy tra cứu lại.');
    } else {
      if (approved.operationId || approved.digest !== data.digest)
        throw new AdminClientError('Dữ liệu đã thay đổi. Hãy tra cứu lại trước khi xoá.');
      if (!data.clients.every(isManagedRow))
        throw new AdminClientError('Không được xoá client ngoài phạm vi web quản lý.', 403);
      if (!data.clients.length && !data.matched.size && number > data.counter)
        throw new AdminClientError('ID chưa từng được cấp.', 404);
      const generation = Math.max(
        data.generation,
        ...data.emails.map((email) => parseClientEmail(email).generation),
      );
      journal = {
        operationId: randomUUID(),
        base,
        digest: data.digest,
        targets: data.emails.map((email) => {
          const row = data.clients.find((item) => item.client.email === email);
          return row ? identity(row) : { email, missing: true };
        }),
        owners: data.owners,
        emails: data.emails,
        generation,
        label:
          data.clients.at(-1)?.client.comment ||
          data.ownersDetails.find((item) => item.label)?.label ||
          '',
        email: data.clients.at(-1)?.client.email || data.emails.at(-1),
      };
      // A durable fence survives crashes between the panel deletion and Redis cleanup.
      const started = await deps.command([
        'EVAL',
        'if redis.call("GET", KEYS[1]) ~= ARGV[1] or redis.call("HEXISTS", KEYS[2], ARGV[2]) == 1 then return 0; end; ' +
          'redis.call("HSET", KEYS[2], ARGV[2], ARGV[3]); for _, email in ipairs(cjson.decode(ARGV[4])) do redis.call("SADD", KEYS[3], email); end; return 1',
        3,
        `${PREFIX}allocation:claim`,
        `${PREFIX}deletions`,
        `${PREFIX}revoked-emails`,
        owner,
        base,
        JSON.stringify(journal),
        JSON.stringify(journal.emails),
      ]);
      if (Number(started) !== 1)
        throw new AdminClientError('Phiên thao tác đã thay đổi. Hãy tra cứu lại.');
    }
    for (const target of journal.targets) {
      await deps.renewAllocationClaim(owner);
      const row = await getClientOrNull(target.email, xui);
      if (
        row &&
        (!isManagedRow(row) ||
          target.missing ||
          JSON.stringify(identity(row)) !== JSON.stringify(target))
      )
        throw new AdminClientError(
          'Danh tính client trên panel đã thay đổi. Đã giữ ID để tránh xoá nhầm.',
        );
      await deps.renewAllocationClaim(owner);
      try {
        await xui.deleteClient(target.email);
      } catch (error) {
        if (error.code !== 'NOT_FOUND' || (await getClientOrNull(target.email, xui))) throw error;
      }
      if (await getClientOrNull(target.email, xui))
        throw new AdminClientError('Panel chưa xoá hết client. Hãy tra cứu và thử lại.');
    }
    data = await snapshot(base, xui, deps, owner);
    if (data.clients.length)
      throw new AdminClientError('Vẫn còn client cùng ID trên panel. Chưa mở số này để cấp lại.');
    // Compare values again in Lua: never erase another user's replacement mapping.
    const cleanup = [...data.matched];
    const owners = [...new Set([...journal.owners, ...data.owners])];
    const emails = [...new Set([...journal.emails, ...data.emails])];
    const eventId = `deleted-${journal.operationId}`;
    const finished = await deps.command([
      'EVAL',
      'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0; end; ' +
        'local journal = redis.call("HGET", KEYS[2], ARGV[2]); if not journal or cjson.decode(journal).operationId ~= ARGV[3] then return 0; end; ' +
        'local records = cjson.decode(ARGV[4]); for _, record in ipairs(records) do if redis.call("GET", record[1]) ~= record[2] then return 0; end; end; ' +
        'for _, record in ipairs(records) do redis.call("DEL", record[1]); end; ' +
        'local owners = cjson.decode(ARGV[5]); local head = redis.call("GET", KEYS[3]); ' +
        'for _, tg in ipairs(owners) do ' +
        'if head == tg and redis.call("EXISTS", ARGV[9] .. "pending:" .. tg) == 0 then redis.call("DEL", KEYS[3]); end; ' +
        'local notification = ARGV[9] .. "notification:user:" .. tg; local email = redis.call("HGET", notification, "email"); ' +
        'if email and string.match(email, "^(#%d+)") == ARGV[2] then redis.call("DEL", notification); redis.call("ZREM", KEYS[8], tg); end; end; ' +
        'for _, email in ipairs(cjson.decode(ARGV[6])) do redis.call("SREM", KEYS[4], email); redis.call("SADD", KEYS[5], email); end; ' +
        'redis.call("HSET", KEYS[6], ARGV[2], math.max(tonumber(redis.call("HGET", KEYS[6], ARGV[2]) or "0"), tonumber(ARGV[7]))); ' +
        'if tonumber(ARGV[8]) > tonumber(redis.call("GET", KEYS[7]) or "0") then redis.call("SET", KEYS[7], ARGV[8]); end; ' +
        'redis.call("DEL", KEYS[9], KEYS[10]); ' +
        'if ARGV[10] == "1" then redis.call("HSET", KEYS[11], "type", "deleted", "email", ARGV[11], "label", ARGV[12], "telegramId", ARGV[13], "verifiedAt", ARGV[14]); ' +
        'redis.call("EXPIRE", KEYS[11], 604800); redis.call("ZADD", KEYS[8], ARGV[14], ARGV[15]); redis.call("EXPIRE", KEYS[8], 604800); end; ' +
        'redis.call("HINCRBY", KEYS[12], ARGV[2], 1); redis.call("HDEL", KEYS[2], ARGV[2]); return 1',
      12,
      `${PREFIX}allocation:claim`,
      `${PREFIX}deletions`,
      `${PREFIX}allocation:pending`,
      `${PREFIX}issued-emails`,
      `${PREFIX}revoked-emails`,
      `${PREFIX}generations`,
      `${PREFIX}counter`,
      `${PREFIX}notifications:users`,
      `${PREFIX}ranking:snapshot`,
      `${PREFIX}ranking:refresh`,
      `${PREFIX}notification:user:${eventId}`,
      `${PREFIX}client-revisions`,
      owner,
      base,
      journal.operationId,
      JSON.stringify(cleanup),
      JSON.stringify(owners),
      JSON.stringify(emails),
      journal.generation,
      number,
      PREFIX,
      telegramAdminIds().length ? '1' : '0',
      journal.email,
      journal.label,
      owners.join(', '),
      Date.now(),
      eventId,
    ]);
    if (Number(finished) !== 1)
      throw new AdminClientError('Chưa hoàn tất dọn dữ liệu. Hãy tra cứu và tiếp tục xoá.');
    clearRankingCache();
    clearSubscriptionCache();
    return { deleted: true, base, nextEmail: `${base}-${journal.generation + 1}` };
  });
  await flushNewUserNotifications({ deps });
  return result;
}

module.exports = { AdminClientError, inspectAdminClient, deleteAdminClient };

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_POLICY, validatePolicy, managedFields, subscriptionUrl } = require('../lib/free-policy');
const { provisionForTelegram } = require('../lib/free-provision');
const { syncBatch } = require('../lib/free-sync');

function policy(overrides = {}) {
  return validatePolicy({
    ...DEFAULT_POLICY,
    inboundIds: [7, 8],
    subscriptionBaseUrl: 'https://sub.example/sub/',
    ...overrides,
  });
}

test('policy converts quota and expiry without copying client identity', () => {
  const p = policy({ trafficGB: 1.5, expiryDays: 3 });
  assert.deepEqual(managedFields(p, 1000), {
    totalGB: 1610612736,
    limitHwid: 0,
    expiryTime: 259201000,
    group: 'free-web',
  });
  assert.equal(subscriptionUrl(p, 'a1b2c3d4'), 'https://sub.example/sub/a1b2c3d4');
  assert.throws(() => policy({ inboundIds: [] }), /inbound/);
  assert.throws(() => policy({ subscriptionBaseUrl: 'http://sub.example/sub/' }), /HTTPS/);
});

test('one Telegram ID creates once and receives the same link again', async () => {
  const rows = new Map();
  const issued = new Map();
  let creates = 0;
  const deps = {
    readIssuedEmail: async (id) => issued.get(id) || null,
    claimTelegram: async () => true,
    releaseTelegram: async () => 1,
    nextEmail: async () => '#002',
    recordIssued: async (id, email) => { issued.set(id, email); },
  };
  const xui = {
    getClientsByTelegramId: async (id) => [...rows.values()].filter((r) => String(r.client.tgId) === id),
    getClient: async (email) => {
      if (!rows.has(email)) throw new Error('Not found');
      return rows.get(email);
    },
    createClient: async ({ client, inboundIds }) => {
      creates++;
      rows.set(client.email, { client: { ...client, subId: 'randomsub123' }, inboundIds });
    },
  };
  const first = await provisionForTelegram('123456789', policy(), xui, deps);
  const second = await provisionForTelegram('123456789', policy(), xui, deps);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.email, '#002');
  assert.equal(first.url, second.url);
  assert.equal(creates, 1);
  assert.equal(rows.get('#002').client.tgId, 123456789);
  assert.deepEqual(rows.get('#002').inboundIds, [7, 8]);
});

test('a missing issued client is not silently re-created', async () => {
  const deps = { readIssuedEmail: async () => '#002' };
  const xui = { getClient: async () => { throw new Error('Not found'); } };
  await assert.rejects(provisionForTelegram('123456789', policy(), xui, deps), /missing/);
});

test('sync changes limits and inbounds while preserving credentials and usage', async () => {
  const original = {
    email: '#002', subId: 'randomsub123', id: 42, uuid: 'vless-uuid', tgId: 123456789,
    comment: 'free-web:self-service', totalGB: 1, limitHwid: 0,
    expiryTime: 100, group: 'free-web', allowedIPs: '', enable: true,
  };
  const calls = { updated: null, attach: null, detach: null };
  const xui = {
    getClient: async () => ({ client: original, inboundIds: [7, 9] }),
    updateClient: async (_email, client) => { calls.updated = client; },
    bulkAttach: async (payload) => { calls.attach = payload; return { attached: ['#002'], skipped: null, errors: null }; },
    bulkDetach: async (payload) => { calls.detach = payload; return { detached: ['#002'], skipped: null, errors: null }; },
  };
  const deps = {
    listIssuedEmails: async () => ['#002'],
    readIssuedAt: async () => 1000,
  };
  const result = await syncBatch(policy({ trafficGB: 2, hwidLimit: 1 }), xui, 0, deps);
  assert.equal(result.done, true);
  assert.deepEqual(result.errors, []);
  assert.equal(calls.updated.id, original.uuid);
  assert.equal(calls.updated.subId, original.subId);
  assert.equal(calls.updated.tgId, original.tgId);
  assert.deepEqual(calls.updated.allowedIPs, []);
  assert.equal(calls.updated.enable, true);
  assert.equal(calls.updated.totalGB, 2 * 1024 ** 3);
  assert.deepEqual(calls.attach, { emails: ['#002'], inboundIds: [8] });
  assert.deepEqual(calls.detach, { emails: ['#002'], inboundIds: [9] });
});

test('partial create does not issue a link until all inbounds and HWID limit exist', async () => {
  let row = null;
  let records = 0;
  let canAttach = false;
  const deps = {
    readIssuedEmail: async () => null,
    claimTelegram: async () => true,
    releaseTelegram: async () => 1,
    nextEmail: async () => '#002',
    recordIssued: async () => { records++; },
  };
  const xui = {
    getClientsByTelegramId: async () => row ? [row] : [],
    getClient: async () => row,
    createClient: async ({ client }) => {
      row = { client: { ...client, subId: 'randomsub123', limitHwid: 0 }, inboundIds: [7] };
      throw new Error('inbound 8 failed');
    },
    bulkAttach: async () => {
      if (canAttach) row.inboundIds.push(8);
      return { attached: canAttach ? ['#002'] : null, skipped: null, errors: canAttach ? null : ['inbound 8 failed'] };
    },
    updateClient: async (_email, client) => { row.client = { ...row.client, ...client }; },
  };
  const chosen = policy({ hwidLimit: 2 });
  await assert.rejects(provisionForTelegram('123456789', chosen, xui, deps), /missing required inbounds/);
  assert.equal(records, 0);
  canAttach = true;
  const result = await provisionForTelegram('123456789', chosen, xui, deps);
  assert.equal(result.url, 'https://sub.example/sub/randomsub123');
  assert.equal(row.client.limitHwid, 2);
  assert.equal(records, 1);
});

test('sync reports per-client bulk errors even with a successful API envelope', async () => {
  const row = {
    client: { email: '#002', uuid: 'vless-uuid', subId: 'randomsub123', tgId: 123456789,
      comment: 'free-web:self-service', totalGB: 1024 ** 3, limitHwid: 0,
      expiryTime: 259201000, group: 'free-web', enable: true },
    inboundIds: [7],
  };
  const xui = {
    getClient: async () => row,
    updateClient: async () => {},
    bulkAttach: async () => ({ attached: null, skipped: null, errors: ['inbound 8 failed'] }),
  };
  const deps = {
    listIssuedEmails: async () => ['#002'],
    readIssuedAt: async () => 1000,
  };
  const result = await syncBatch(policy(), xui, 0, deps);
  assert.deepEqual(result.errors, ['#002']);
});

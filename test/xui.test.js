const test = require('node:test');
const assert = require('node:assert/strict');
const { createXuiClient, XuiError } = require('../lib/xui');

function client(fetchImpl, overrides = {}) {
  return createXuiClient({
    accessUrl: 'https://panel.example/xui/',
    apiToken: 'secret-token',
    subscriptionBaseUrl: 'https://sub.example:2096/private/sub/',
    fetchImpl,
    ...overrides,
  });
}

function json(obj, status = 200) {
  return Response.json(obj, { status });
}

test('keeps panel base path and sends the bearer token', async () => {
  const calls = [];
  const xui = client(async (url, options) => {
    calls.push({ url: String(url), options });
    return json({ success: true, obj: [{ id: 3, remark: 'VLESS' }] });
  });

  assert.deepEqual(await xui.listInbounds(), [{ id: 3, remark: 'VLESS' }]);
  assert.equal(calls[0].url, 'https://panel.example/xui/panel/api/inbounds/list');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-token');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.redirect, 'error');
});

test('does not duplicate panel/api in an access URL', async () => {
  const urls = [];
  const xui = client(async (url) => {
    urls.push(String(url));
    return json({ success: true, obj: [] });
  }, { accessUrl: 'https://panel.example/xui/panel/api' });

  await xui.listClients();
  assert.deepEqual(urls, ['https://panel.example/xui/panel/api/clients/list']);
});

test('lists client records and looks up by Telegram ID or email', async () => {
  const urls = [];
  const xui = client(async (url) => {
    urls.push(String(url));
    if (url.pathname.endsWith('/clients/get/user%40example.com')) {
      return json({ success: true, obj: { client: { email: 'user@example.com' }, inboundIds: [3] } });
    }
    return json({ success: true, obj: [{ client: { email: 'user@example.com' }, inboundIds: [3] }] });
  });

  assert.equal((await xui.getClientsByTelegramId('123456'))[0].client.email, 'user@example.com');
  assert.equal((await xui.getClient('user@example.com')).client.email, 'user@example.com');
  assert.match(urls[0], /\/clients\/get\/tgId\/123456$/);
  assert.match(urls[1], /\/clients\/get\/user%40example\.com$/);
});

test('create, update, bulk attach, and bulk detach use current API payloads', async () => {
  const calls = [];
  const xui = client(async (url, options) => {
    calls.push({ path: url.pathname, method: options.method, body: JSON.parse(options.body) });
    return json({ success: true, obj: { changed: 1 } });
  });
  const record = {
    email: 'tg123-002@example.com',
    totalGB: 10 * 1024 ** 3,
    expiryTime: 1_800_000_000_000,
    limitIp: 2,
    limitHwid: 1,
    tgId: 123,
    group: 'customers',
    enable: true,
  };

  await xui.createClient({ client: record, inboundIds: [3] });
  await xui.updateClient(record.email, record);
  await xui.bulkAttach({ emails: [record.email], inboundIds: [4] });
  await xui.bulkDetach({ emails: [record.email], inboundIds: [4] });

  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [
    ['/xui/panel/api/clients/add', 'POST'],
    ['/xui/panel/api/clients/update/tg123-002%40example.com', 'POST'],
    ['/xui/panel/api/clients/bulkAttach', 'POST'],
    ['/xui/panel/api/clients/bulkDetach', 'POST'],
  ]);
  assert.deepEqual(calls[0].body, { client: record, inboundIds: [3] });
  assert.deepEqual(calls[1].body, record);
  assert.deepEqual(calls[2].body, { emails: [record.email], inboundIds: [4] });
});

test('rejects a success:false response even when HTTP status is 200', async () => {
  const xui = client(async () => json({ success: false, msg: 'email already in use' }));
  await assert.rejects(xui.createClient({ client: {}, inboundIds: [3] }), (error) => {
    assert.ok(error instanceof XuiError);
    assert.equal(error.code, 'API_ERROR');
    assert.equal(error.message, 'email already in use');
    return true;
  });
});

test('reports HTTP, malformed JSON, and timeout failures', async () => {
  const unauthorized = client(async () => new Response('denied', { status: 401 }));
  await assert.rejects(unauthorized.listClients(), { code: 'HTTP_ERROR', status: 401 });

  const malformed = client(async () => new Response('not JSON'));
  await assert.rejects(malformed.listClients(), { code: 'INVALID_RESPONSE' });

  const wrongEnvelope = client(async () => json({ obj: [] }));
  await assert.rejects(wrongEnvelope.listClients(), { code: 'INVALID_RESPONSE' });

  const stalled = client((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }), { timeoutMs: 5 });
  await assert.rejects(stalled.listClients(), { code: 'TIMEOUT' });
});

test('requires HTTPS remotely and builds the admin-configured subscription URL', () => {
  assert.throws(() => client(() => {}, { accessUrl: 'http://panel.example:2053/' }), {
    code: 'CONFIG_ERROR',
  });
  assert.throws(() => client(() => {}, { accessUrl: 'https://user:pass@panel.example/' }), {
    code: 'CONFIG_ERROR',
  });

  const local = client(() => {}, { accessUrl: 'http://127.0.0.1:2053/' });
  assert.equal(local.getSubscriptionUrl('abc123'), 'https://sub.example:2096/private/sub/abc123');
  assert.throws(() => local.getSubscriptionUrl('other/id'), { code: 'INVALID_INPUT' });
});

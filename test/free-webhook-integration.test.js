const test = require('node:test');
const assert = require('node:assert/strict');
const adminHandler = require('../api/free/admin');
const webhookHandler = require('../api/free/webhook');
const { sessionCookie } = require('../lib/free-auth');
const { DEFAULT_POLICY } = require('../lib/free-policy');

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = JSON.parse(value); },
  };
}

function apiResponse(obj) {
  return { ok: true, json: async () => ({ success: true, obj }) };
}

test('admin policy issues #002 once and the bot returns its stable subscription', async () => {
  const names = [
    'FREE_ADMIN_SECRET', 'XUI_ACCESS_URL', 'XUI_API_TOKEN', 'TELEGRAM_WEBHOOK_SECRET',
    'TELEGRAM_BOT_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    FREE_ADMIN_SECRET: 'test-secret-with-at-least-thirty-two-characters',
    XUI_ACCESS_URL: 'https://panel.example/private/',
    XUI_API_TOKEN: 'fake-panel-token',
    TELEGRAM_WEBHOOK_SECRET: 'fake-webhook-secret',
    TELEGRAM_BOT_TOKEN: 'fake-bot-token',
    UPSTASH_REDIS_REST_URL: 'https://redis.example',
    UPSTASH_REDIS_REST_TOKEN: 'fake-redis-token',
  });

  const values = new Map();
  const emails = new Set();
  const clients = new Map();
  const messages = [];
  let creates = 0;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === 'redis.example') {
      const [action, ...parts] = JSON.parse(options.body);
      let result = null;
      if (action === 'GET') result = values.get(parts[0]) ?? null;
      if (action === 'SET') {
        const [key, value, mode] = parts;
        if (mode !== 'NX' || !values.has(key)) {
          values.set(key, String(value));
          result = 'OK';
        }
      }
      if (action === 'INCR') {
        result = Number(values.get(parts[0]) || 0) + 1;
        values.set(parts[0], String(result));
      }
      if (action === 'SMEMBERS') result = [...emails];
      if (action === 'EVAL') {
        if (parts[0].startsWith('local current')) {
          const key = parts[2];
          result = Math.max(Number(values.get(key) || 1), Number(parts[3]));
          values.set(key, String(result));
        } else if (parts[0].startsWith('redis.call("SET"')) {
          values.set(parts[2], parts[5]);
          if (!values.has(parts[3])) values.set(parts[3], parts[6]);
          emails.add(parts[5]);
          result = 1;
        } else {
          values.delete(parts[2]);
          result = 1;
        }
      }
      return { ok: true, json: async () => ({ result }) };
    }
    if (url.hostname === 'panel.example') {
      const route = url.pathname.split('/panel/api/')[1];
      if (route === 'inbounds/options') {
        return apiResponse([
          { id: 1, enable: true, protocol: 'vmess', remark: 'Takeshi.dev', port: 12345, settings: 'private' },
          { id: 7, enable: true, protocol: 'vless', remark: 'VLESS', port: 443 },
          { id: 8, enable: false, protocol: 'vless', remark: 'Disabled', port: 444 },
          { id: 9, enable: true, protocol: 'http', remark: 'HTTP', port: 445 },
        ]);
      }
      if (route === 'clients/list') return apiResponse([...clients.values()]);
      if (route.startsWith('clients/get/tgId/')) {
        return apiResponse([...clients.values()].filter((row) =>
          String(row.client.tgId) === route.split('/').at(-1)));
      }
      if (route.startsWith('clients/get/')) {
        const email = decodeURIComponent(route.split('/').at(-1));
        return apiResponse(clients.get(email));
      }
      if (route === 'clients/add') {
        const payload = JSON.parse(options.body);
        creates++;
        clients.set(payload.client.email, {
          client: { ...payload.client, id: 2, uuid: '00000000-0000-4000-8000-000000000002', subId: 'randomsub123' },
          inboundIds: payload.inboundIds,
        });
        return apiResponse({});
      }
      throw new Error(`Unexpected panel route: ${route}`);
    }
    if (url.hostname === 'api.telegram.org') {
      messages.push(JSON.parse(options.body).text);
      return { ok: true, json: async () => ({ ok: true }) };
    }
    throw new Error(`Unexpected request: ${url.hostname}`);
  };

  try {
    const headers = { host: 'site.example', origin: 'https://site.example',
      cookie: sessionCookie({ headers: { host: 'site.example' } }).split(';')[0] };
    const saved = response();
    await adminHandler({ method: 'POST', headers, body: { action: 'save', policy: {
      ...DEFAULT_POLICY,
      inboundIds: [1, 7],
      subscriptionBaseUrl: 'https://sub.example/sub/',
    } } }, saved);
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.body.policy.inboundIds, [1, 7]);

    const admin = response();
    await adminHandler({ method: 'GET', headers }, admin);
    assert.deepEqual(admin.body.inbounds, [
      { id: 1, remark: 'Takeshi.dev', protocol: 'vmess', port: 12345 },
      { id: 7, remark: 'VLESS', protocol: 'vless', port: 443 },
    ]);

    const rejected = response();
    await adminHandler({ method: 'POST', headers, body: { action: 'save', policy: {
      ...DEFAULT_POLICY,
      inboundIds: [8],
      subscriptionBaseUrl: 'https://sub.example/sub/',
    } } }, rejected);
    assert.equal(rejected.statusCode, 400);

    const update = {
      update_id: 1,
      message: { text: '/start free', chat: { id: 123456789, type: 'private' },
        from: { id: 123456789, is_bot: false } },
    };
    const webhookRequest = { method: 'POST', headers: {
      'x-telegram-bot-api-secret-token': 'fake-webhook-secret',
    }, body: update };
    const first = response();
    await webhookHandler(webhookRequest, first);
    const second = response();
    await webhookHandler(webhookRequest, second);

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(creates, 1);
    assert.equal(clients.get('#002').client.group, 'free-web');
    assert.equal(clients.get('#002').client.tgId, 123456789);
    assert.deepEqual(clients.get('#002').inboundIds, [1, 7]);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /#002/);
    assert.match(messages[0], /https:\/\/sub\.example\/sub\/randomsub123/);
    assert.equal(messages[0], messages[1]);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

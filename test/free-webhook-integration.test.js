const test = require('node:test');
const assert = require('node:assert/strict');
const adminHandler = require('../api/free/admin');
const claimHandler = require('../api/free/claim');
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

function redisFetch(values, emails) {
  return (_input, options) => {
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
    if (action === 'SCARD') result = emails.size;
    if (action === 'EVAL') {
      const [script, _keys, key, ...args] = parts;
      if (script.startsWith('local current = tonumber')) {
        result = Math.max(Number(values.get(key) || 1), Number(args[0]));
        values.set(key, String(result));
      } else if (script.startsWith('redis.call("SET", KEYS[1], ARGV[1])')) {
        values.set(key, args[2]);
        if (!values.has(args[0])) values.set(args[0], args[3]);
        emails.add(args[2]);
        result = 1;
      } else if (script.startsWith('local current = redis.call("INCR"')) {
        result = Number(values.get(key) || 0) + 1;
        values.set(key, String(result));
      } else if (script.startsWith('local value = redis.call("GET"')) {
        result = values.get(key) ?? false;
        values.delete(key);
      } else if (script.includes('redis.call("SET", KEYS[1], "done"')) {
        if (values.get(key) === args[0]) {
          values.set(key, 'done');
          result = 1;
        } else result = 0;
      } else if (script.includes('redis.call("DEL", KEYS[1])')) {
        if (values.get(key) === args[0]) {
          values.delete(key);
          result = 1;
        } else result = 0;
      }
    }
    return Promise.resolve({ ok: true, json: async () => ({ result }) });
  };
}

test('only a one-use web claim can provision a client', async () => {
  const names = [
    'FREE_ADMIN_SECRET', 'XUI_ACCESS_URL', 'XUI_API_TOKEN', 'TELEGRAM_WEBHOOK_SECRET',
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'PUBLIC_SITE_URL',
    'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    FREE_ADMIN_SECRET: 'test-secret-with-at-least-thirty-two-characters',
    XUI_ACCESS_URL: 'https://panel.example/private/',
    XUI_API_TOKEN: 'fake-panel-token',
    TELEGRAM_WEBHOOK_SECRET: 'fake-webhook-secret',
    TELEGRAM_BOT_TOKEN: 'fake-bot-token',
    TELEGRAM_BOT_USERNAME: 'test_free_bot',
    PUBLIC_SITE_URL: 'https://site.example',
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
    if (url.hostname === 'redis.example') return redisFetch(values, emails)(input, options);
    if (url.hostname === 'panel.example') {
      const route = url.pathname.split('/panel/api/')[1];
      if (route === 'inbounds/options') return apiResponse([
        { id: 1, enable: true, protocol: 'vmess', remark: 'Takeshi.dev', port: 12345 },
        { id: 7, enable: true, protocol: 'vless', remark: 'VLESS', port: 443 },
      ]);
      if (route === 'clients/list') return apiResponse([...clients.values()]);
      if (route.startsWith('clients/get/tgId/')) return apiResponse([...clients.values()].filter((row) =>
        String(row.client.tgId) === route.split('/').at(-1)));
      if (route.startsWith('clients/get/')) return apiResponse(clients.get(decodeURIComponent(route.split('/').at(-1))));
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

    const normal = response();
    await webhookHandler({ method: 'POST', headers: {
      'x-telegram-bot-api-secret-token': 'fake-webhook-secret',
    }, body: {
      update_id: 1,
      message: { text: '/start', chat: { id: 123456789, type: 'private' },
        from: { id: 123456789, is_bot: false } },
    } }, normal);
    assert.equal(normal.statusCode, 200);
    assert.equal(creates, 0);
    assert.match(messages[0], /https:\/\/site\.example\/free/);

    const claim = response();
    await claimHandler({ method: 'POST', headers }, claim);
    assert.equal(claim.statusCode, 200);
    assert.match(claim.body.token, /^[A-Za-z0-9_-]{24,64}$/);

    const claimedUpdate = {
      update_id: 2,
      message: { text: `/start c_${claim.body.token}`, chat: { id: 123456789, type: 'private' },
        from: { id: 123456789, is_bot: false } },
    };
    const first = response();
    await webhookHandler({ method: 'POST', headers: {
      'x-telegram-bot-api-secret-token': 'fake-webhook-secret',
    }, body: claimedUpdate }, first);
    const repeated = response();
    await webhookHandler({ method: 'POST', headers: {
      'x-telegram-bot-api-secret-token': 'fake-webhook-secret',
    }, body: claimedUpdate }, repeated);

    assert.equal(first.statusCode, 200);
    assert.equal(repeated.statusCode, 200);
    assert.equal(creates, 1);
    assert.equal(clients.get('#002').client.group, 'free-web');
    assert.equal(clients.get('#002').client.tgId, 123456789);
    assert.deepEqual(clients.get('#002').inboundIds, [1, 7]);
    assert.equal(messages.length, 2);
    assert.match(messages[1], /#002/);
    assert.match(messages[1], /https:\/\/sub\.example\/sub\/randomsub123/);

    const reused = response();
    await webhookHandler({ method: 'POST', headers: {
      'x-telegram-bot-api-secret-token': 'fake-webhook-secret',
    }, body: { ...claimedUpdate, update_id: 3 } }, reused);
    assert.equal(reused.statusCode, 200);
    assert.equal(creates, 1);
    assert.equal(messages.length, 3);
    assert.match(messages[2], /https:\/\/site\.example\/free/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

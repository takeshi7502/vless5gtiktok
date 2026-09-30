const test = require('node:test');
const assert = require('node:assert/strict');
const publicHandler = require('../api/free/public');
const webhookHandler = require('../api/free/webhook');
const adminHandler = require('../api/free/admin');
const { command } = require('../lib/free-store');
const auth = require('../lib/free-auth');

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = JSON.parse(value); },
  };
}

test('public endpoint stays disabled without complete server configuration', async () => {
  const res = response();
  await publicHandler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ready, false);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('webhook rejects unauthenticated updates before reading the body', async () => {
  const res = response();
  await webhookHandler({ method: 'POST', headers: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Forbidden' });
});

test('admin endpoint is closed when no high-entropy secret is configured', async () => {
  const previous = process.env.FREE_ADMIN_SECRET;
  delete process.env.FREE_ADMIN_SECRET;
  try {
    const res = response();
    await adminHandler({ method: 'GET' }, res);
    assert.equal(res.statusCode, 503);
  } finally {
    if (previous === undefined) delete process.env.FREE_ADMIN_SECRET;
    else process.env.FREE_ADMIN_SECRET = previous;
  }
});

test('admin cookie is signed, expires, and rejects tampering', () => {
  const previous = process.env.FREE_ADMIN_SECRET;
  process.env.FREE_ADMIN_SECRET = 'test-only-secret-with-at-least-32-bytes';
  try {
    const request = { headers: { host: 'localhost:3000' } };
    const cookie = auth.sessionCookie(request).split(';')[0];
    assert.equal(auth.authenticated({ headers: { cookie } }), true);
    assert.equal(auth.authenticated({ headers: { cookie: `${cookie}x` } }), false);
    assert.equal(auth.validPassword(process.env.FREE_ADMIN_SECRET), true);
    assert.equal(auth.validPassword('wrong'), false);
    assert.equal(auth.sameOrigin({ headers: { host: 'site.example', origin: 'https://site.example' } }), true);
    assert.equal(auth.sameOrigin({ headers: { host: 'site.example', origin: 'http://site.example' } }), false);
    assert.equal(auth.sameOrigin({ headers: { host: 'localhost:3000', origin: 'http://localhost:3000' } }), true);
  } finally {
    if (previous === undefined) delete process.env.FREE_ADMIN_SECRET;
    else process.env.FREE_ADMIN_SECRET = previous;
  }
});

test('Redis REST command sends JSON array and handles provider errors', async () => {
  const oldUrl = process.env.UPSTASH_REDIS_REST_URL;
  const oldToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const oldKvUrl = process.env.KV_REST_API_URL;
  const oldKvToken = process.env.KV_REST_API_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  try {
    let seen;
    const fetchImpl = async (_url, options) => {
      seen = options;
      return { ok: true, json: async () => ({ result: 'OK' }) };
    };
    assert.equal(await command(['SET', 'key', 'value'], fetchImpl), 'OK');
    assert.deepEqual(JSON.parse(seen.body), ['SET', 'key', 'value']);
    assert.equal(seen.headers.authorization, 'Bearer test-token');
    await assert.rejects(command(['GET', 'key'], async () => ({
      ok: true, json: async () => ({ error: 'bad command' }),
    })), /Redis command failed/);

    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.KV_REST_API_URL = 'https://kv.example';
    process.env.KV_REST_API_TOKEN = 'kv-token';
    assert.equal(await command(['GET', 'key'], async (url, options) => {
      assert.equal(url, 'https://kv.example');
      assert.equal(options.headers.authorization, 'Bearer kv-token');
      return { ok: true, json: async () => ({ result: 'value' }) };
    }), 'value');
  } finally {
    if (oldUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = oldUrl;
    if (oldToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = oldToken;
    if (oldKvUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = oldKvUrl;
    if (oldKvToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = oldKvToken;
  }
});

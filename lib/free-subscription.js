const { createCache } = require('./free-cache');
const store = require('./free-store');

const MAX_BODY_BYTES = 512 * 1024;
const cache = createCache({ maxEntries: 32, ttlMs: 15_000 });

async function readBody(upstream) {
  if (Number(upstream.headers.get('content-length')) > MAX_BODY_BYTES) {
    await upstream.body?.cancel().catch(() => {});
    throw new Error('Subscription response is too large');
  }
  const reader = upstream.body?.getReader();
  if (!reader) {
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length > MAX_BODY_BYTES) throw new Error('Subscription response is too large');
    return body;
  }
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error('Subscription response is too large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function sendSubscription(response, url, { publicCache = false } = {}) {
  // The URL includes the personal sub ID; concurrent requests never mix different clients.
  const data = await cache.get(String(url), async () => {
    if (publicCache && store.configured()) {
      const limit = await store.fixedWindowRateLimit('static-sub-fetch', 'all', { limit: 120, windowSeconds: 60 });
      if (!limit.allowed) {
        throw Object.assign(new Error('Try again later'), { statusCode: 429, retryAfter: limit.retryAfter });
      }
    }
    const upstream = await fetch(url, {
      headers: { 'user-agent': 'VLESS-5G-TikTok/1.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (upstream.status !== 200) {
      await upstream.body?.cancel().catch(() => {});
      throw new Error('Subscription is unavailable');
    }
    return {
      body: await readBody(upstream),
      contentType: upstream.headers.get('content-type') || 'text/plain; charset=utf-8',
      subscriptionInfo: upstream.headers.get('subscription-userinfo'),
    };
  });
  response.statusCode = 200;
  response.setHeader('content-type', data.contentType);
  if (data.subscriptionInfo) response.setHeader('subscription-userinfo', data.subscriptionInfo);
  response.setHeader('cache-control', publicCache ? 'public, max-age=0, s-maxage=15' : 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(data.body);
}

module.exports = { sendSubscription, clearSubscriptionCache: () => cache.clear() };

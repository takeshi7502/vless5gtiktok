const store = require('../../lib/free-store');
const { sendJson } = require('../../lib/free-http');
const { validatePolicy, subscriptionUrl } = require('../../lib/free-policy');
const { gatewayEnabled, rewriteWebSocketSubscription, validSubscriptionId } = require('../../lib/free-gateway');
const { requestIp, retryHeaders } = require('../../lib/free-request');

const PER_IP_LIMIT = Object.freeze({ limit: 30, windowSeconds: 10 * 60 });
const MAX_SOURCE_BYTES = 1024 * 1024;

function subIdFrom(request) {
  const value = request.query?.subId;
  return typeof value === 'string' ? value : '';
}

function copyHeader(source, response, name) {
  const value = source.headers.get(name);
  if (value) response.setHeader(name, value);
}

module.exports = async (request, response) => {
  if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' });
  if (!gatewayEnabled() || !store.configured()) return sendJson(response, 404, { error: 'Not found' });
  const subId = subIdFrom(request);
  if (!validSubscriptionId(subId)) return sendJson(response, 404, { error: 'Not found' });

  try {
    const limit = await store.fixedWindowRateLimit('gateway-sub-ip', requestIp(request), PER_IP_LIMIT);
    if (!limit.allowed) return sendJson(response, 429, { error: 'Try again later' }, retryHeaders(limit));
    const token = await store.readGatewayTokenForSubscription(subId);
    if (!token) return sendJson(response, 404, { error: 'Not found' });
    const policy = validatePolicy(await store.readPolicy());
    const upstream = await fetch(subscriptionUrl(policy, subId), {
      headers: { 'user-agent': 'VLESS-5G-TikTok-Gateway/1.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!upstream.ok) throw new Error('Subscription source failed');
    const contentLength = Number(upstream.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES) {
      throw new Error('Subscription source is too large');
    }
    const body = await upstream.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_SOURCE_BYTES) throw new Error('Subscription source is too large');
    const rewritten = rewriteWebSocketSubscription(body, token);
    response.statusCode = 200;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-robots-tag', 'noindex, nofollow');
    copyHeader(upstream, response, 'subscription-userinfo');
    copyHeader(upstream, response, 'profile-title');
    copyHeader(upstream, response, 'profile-update-interval');
    response.end(rewritten);
  } catch (error) {
    console.error('[free-web] gateway subscription failed', error.name || 'Error');
    return sendJson(response, 502, { error: 'Subscription unavailable' });
  }
};

const store = require('../../lib/free-store');

function claimToken(request) {
  const value = request.headers?.['x-free-web-claim'];
  return Array.isArray(value) ? value[0] : value;
}

module.exports = async (request, response) => {
  if (request.method !== 'GET') {
    response.statusCode = 405;
    response.setHeader('allow', 'GET');
    return response.end();
  }

  try {
    const claim = await store.readWebClaim(claimToken(request));
    if (claim.state !== 'ready') {
      response.statusCode = 403;
      response.setHeader('cache-control', 'no-store');
      return response.end();
    }

    const upstream = await fetch(claim.url, {
      headers: { 'user-agent': 'VLESS-5G-TikTok/1.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    response.statusCode = upstream.status;
    const contentType = upstream.headers.get('content-type');
    const subscriptionInfo = upstream.headers.get('subscription-userinfo');
    if (contentType) response.setHeader('content-type', contentType);
    if (subscriptionInfo) response.setHeader('subscription-userinfo', subscriptionInfo);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    response.statusCode = 502;
    response.setHeader('cache-control', 'no-store');
    response.end();
  }
};

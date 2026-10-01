const fs = require('node:fs');
const path = require('node:path');

function staticSubscriptionUrl() {
  const metadataPath = path.join(process.cwd(), 'node-metadata.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const value = metadata?.subscription?.url;
  if (typeof value !== 'string' || !value.trim()) return null;

  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid static subscription URL');
  }
  return url;
}

module.exports = async (request, response) => {
  if (request.method !== 'GET') {
    response.statusCode = 405;
    response.setHeader('allow', 'GET');
    return response.end();
  }

  let url;
  try {
    url = staticSubscriptionUrl();
  } catch {
    response.statusCode = 404;
    response.setHeader('cache-control', 'no-store');
    return response.end();
  }

  if (!url) {
    response.statusCode = 404;
    response.setHeader('cache-control', 'no-store');
    return response.end();
  }

  try {
    const upstream = await fetch(url, {
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

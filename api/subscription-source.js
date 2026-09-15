const fs = require('node:fs');
const path = require('node:path');

function getSubscriptionUrl() {
  const metadataPath = path.join(process.cwd(), 'node-metadata.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const value = metadata?.subscription?.url;

  if (typeof value !== 'string') throw new Error('Missing subscription URL');

  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported subscription URL');

  return url;
}

module.exports = async (request, response) => {
  try {
    const upstream = await fetch(getSubscriptionUrl(), {
      headers: { 'user-agent': 'VLESS-5G-TikTok/1.0' },
    });

    response.statusCode = upstream.status;
    const contentType = upstream.headers.get('content-type');
    const subscriptionInfo = upstream.headers.get('subscription-userinfo');
    if (contentType) response.setHeader('content-type', contentType);
    if (subscriptionInfo) response.setHeader('subscription-userinfo', subscriptionInfo);
    response.setHeader('cache-control', 'no-store');
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    response.statusCode = 502;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: 'Unable to load subscription source' }));
  }
};

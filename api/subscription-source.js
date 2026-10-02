const fs = require('node:fs');
const path = require('node:path');
const { allowRead } = require('../lib/free-read-guard');
const { sendSubscription } = require('../lib/free-subscription');

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
  if (!allowRead(request, response, 'static-subscription')) return;

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
    await sendSubscription(response, url, { publicCache: true });
  } catch (error) {
    response.statusCode = error.statusCode === 429 ? 429 : 502;
    if (error.retryAfter) response.setHeader('retry-after', String(error.retryAfter));
    response.setHeader('cache-control', 'no-store');
    response.end();
  }
};

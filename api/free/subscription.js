const store = require('../../lib/free-store');
const { allowRead } = require('../../lib/free-read-guard');
const { requestIp, retryHeaders } = require('../../lib/free-request');
const { sendJson } = require('../../lib/free-http');
const { sendSubscription } = require('../../lib/free-subscription');

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
  if (!allowRead(request, response, 'subscription', 120)) return;

  try {
    const result = await store.readWebClaimLimited(claimToken(request), requestIp(request), {
      scope: 'subscription-read', ipLimit: 120, tokenLimit: 12,
    });
    if (!result.allowed) return sendJson(response, 429, { error: 'Try again later' }, retryHeaders(result));
    const claim = result.claim;
    if (claim.state !== 'ready') {
      response.statusCode = 403;
      response.setHeader('cache-control', 'no-store');
      return response.end();
    }

    await sendSubscription(response, claim.url);
  } catch {
    response.statusCode = 502;
    response.setHeader('cache-control', 'no-store');
    response.end();
  }
};

const store = require('../../lib/free-store');
const { sendJson } = require('../../lib/free-http');
const { sameOrigin } = require('../../lib/free-auth');
const { serviceStatus } = require('../../lib/free-service');
const { requestIp, retryHeaders } = require('../../lib/free-request');
const { allowRead } = require('../../lib/free-read-guard');

const PER_IP_LIMIT = Object.freeze({ limit: 12, windowSeconds: 10 * 60 });
const GLOBAL_LIMIT = Object.freeze({ limit: 120, windowSeconds: 10 * 60 });

function claimToken(request) {
  const header = request.headers?.['x-free-web-claim'];
  if (typeof header === 'string') return header;
  if (Array.isArray(header) && typeof header[0] === 'string') return header[0];
  return '';
}

module.exports = async (request, response) => {
  if (request.method === 'GET') {
    if (!allowRead(request, response, 'claim-status', 600)) return;
    try {
      const result = await store.readWebClaimLimited(claimToken(request), requestIp(request), {
        scope: 'claim-status', ipLimit: 600, tokenLimit: 90,
      });
      if (!result.allowed) return sendJson(response, 429, { error: 'Try again later' }, retryHeaders(result));
      return sendJson(response, 200, result.claim, { 'referrer-policy': 'no-referrer' });
    } catch {
      return sendJson(response, 503, { error: 'Service is unavailable' });
    }
  }
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' });
  if (!sameOrigin(request)) return sendJson(response, 403, { error: 'Forbidden' });
  if (!allowRead(request, response, 'claim-create', 30)) return;

  try {
    const ipLimit = await store.fixedWindowRateLimit('web-claim-ip', requestIp(request), PER_IP_LIMIT);
    if (!ipLimit.allowed) return sendJson(response, 429, { error: 'Try again later' }, retryHeaders(ipLimit));

    const status = await serviceStatus();
    if (!status.ready) return sendJson(response, 503, { error: 'Service is unavailable' });

    const globalLimit = await store.fixedWindowRateLimit('web-claim-global', 'all', GLOBAL_LIMIT);
    if (!globalLimit.allowed) return sendJson(response, 503, { error: 'Service is busy' }, retryHeaders(globalLimit));

    const token = await store.issueWebClaim();
    return sendJson(response, 200, { token, botUsername: status.botUsername, expiresIn: 5 * 60 }, {
      'referrer-policy': 'no-referrer',
    });
  } catch {
    return sendJson(response, 503, { error: 'Service is unavailable' });
  }
};

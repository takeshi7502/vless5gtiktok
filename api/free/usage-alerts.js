const { createHash, timingSafeEqual } = require('node:crypto');
const store = require('../../lib/free-store');
const { sendJson } = require('../../lib/free-http');
const { validatePolicy } = require('../../lib/free-policy');
const { createXuiClient } = require('../../lib/xui');
const { checkLowDataAlerts } = require('../../lib/free-alerts');

function authorized(request) {
  const expected = process.env.CRON_SECRET;
  const received = request.headers?.authorization;
  if (typeof expected !== 'string' || expected.length < 16 || typeof received !== 'string') return false;
  const expectedHash = createHash('sha256').update(`Bearer ${expected}`).digest();
  const receivedHash = createHash('sha256').update(received).digest();
  return timingSafeEqual(expectedHash, receivedHash);
}

module.exports = async (request, response) => {
  if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' }, { allow: 'GET' });
  if (!authorized(request)) return sendJson(response, 401, { error: 'Unauthorized' });
  if (!store.configured()) return sendJson(response, 503, { error: 'Storage is unavailable' });

  try {
    const policy = validatePolicy(await store.readPolicy());
    const xui = createXuiClient({ subscriptionBaseUrl: policy.subscriptionBaseUrl });
    return sendJson(response, 200, await checkLowDataAlerts(xui));
  } catch (error) {
    console.error('[free-web] low-data alert check failed', error.code || error.name || 'Error');
    return sendJson(response, 503, { error: 'Unable to check client usage' });
  }
};

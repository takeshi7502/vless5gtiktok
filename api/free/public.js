const { sendJson } = require('../../lib/free-http');
const { serviceStatus } = require('../../lib/free-service');
const { allowRead } = require('../../lib/free-read-guard');

module.exports = async (request, response) => {
  if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' });
  if (!allowRead(request, response, 'public')) return;
  const status = await serviceStatus();
  return sendJson(response, 200, status, status.ready ? {
    'cache-control': 'public, max-age=0, s-maxage=15',
  } : {});
};

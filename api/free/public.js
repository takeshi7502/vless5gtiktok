const { sendJson } = require('../../lib/free-http');
const { serviceStatus } = require('../../lib/free-service');

module.exports = async (request, response) => {
  if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' });
  const status = await serviceStatus();
  return sendJson(response, 200, status);
};

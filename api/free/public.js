const store = require('../../lib/free-store');
const { sendJson } = require('../../lib/free-http');
const { validatePolicy } = require('../../lib/free-policy');

module.exports = async (request, response) => {
  if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' });
  const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim();
  let ready = false;
  if (store.configured() && process.env.TELEGRAM_BOT_TOKEN &&
      process.env.TELEGRAM_WEBHOOK_SECRET && process.env.XUI_ACCESS_URL &&
      process.env.XUI_API_TOKEN && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(botUsername)) {
    try {
      validatePolicy(await store.readPolicy());
      ready = true;
    } catch { /* admin setup is incomplete */ }
  }
  return sendJson(response, 200, { ready, botUsername });
};

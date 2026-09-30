const store = require('../../lib/free-store');
const { readJson, sendJson } = require('../../lib/free-http');
const { validatePolicy } = require('../../lib/free-policy');
const { createXuiClient } = require('../../lib/xui');
const { provisionForTelegram } = require('../../lib/free-provision');
const {
  isTelegramWebhookSecretValid,
  parsePrivateStartUpdate,
  sendTelegramMessage,
} = require('../../lib/telegram');

module.exports = async (request, response) => {
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' });
  if (!isTelegramWebhookSecretValid(request.headers['x-telegram-bot-api-secret-token'])) {
    return sendJson(response, 403, { error: 'Forbidden' });
  }

  let update;
  try { update = parsePrivateStartUpdate(await readJson(request)); }
  catch { return sendJson(response, 400, { error: 'Invalid update' }); }
  if (!update) return sendJson(response, 200, { ok: true });

  try {
    if (!store.configured()) throw new Error('Storage is not configured');
    const policy = validatePolicy(await store.readPolicy());
    const xui = createXuiClient({ subscriptionBaseUrl: policy.subscriptionBaseUrl });
    const result = await provisionForTelegram(update.telegramUserId, policy, xui);
    const message = `Link subscription của bạn (${result.email}):\n${result.url}\n\nGửi /start để lấy lại link này.`;
    const sent = await sendTelegramMessage(update.chatId, message);
    if (!sent.sent) throw new Error('Telegram delivery failed');
    return sendJson(response, 200, { ok: true });
  } catch (error) {
    console.error('[free-web] bot request failed', error.code || error.name || 'Error');
    if (error.message === 'Client creation is already in progress') {
      return sendJson(response, 503, { error: 'Retry later' });
    }
    if (error.message === 'Telegram delivery failed') {
      return sendJson(response, 503, { error: 'Retry later' });
    }
    const sent = await sendTelegramMessage(update.chatId, 'Chưa thể tạo hoặc lấy link lúc này. Vui lòng thử lại sau.');
    return sendJson(response, sent.sent ? 200 : 503, { ok: false });
  }
};

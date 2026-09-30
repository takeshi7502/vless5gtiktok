const { randomUUID } = require('node:crypto');
const store = require('../../lib/free-store');
const { readJson, sendJson } = require('../../lib/free-http');
const { validatePolicy } = require('../../lib/free-policy');
const { createXuiClient } = require('../../lib/xui');
const { provisionForTelegram } = require('../../lib/free-provision');
const { testPageUrl } = require('../../lib/free-service');
const {
  isTelegramWebhookSecretValid,
  parsePrivateStartUpdate,
  sendTelegramMessage,
} = require('../../lib/telegram');

const START_LIMIT = Object.freeze({ limit: 4, windowSeconds: 10 * 60 });
const START_GLOBAL_LIMIT = Object.freeze({ limit: 120, windowSeconds: 10 * 60 });
const CLAIM_LIMIT = Object.freeze({ limit: 6, windowSeconds: 10 * 60 });

function startMessage() {
  const url = testPageUrl();
  return url
    ? `Mở trang này để lấy link của bạn:\n${url}`
    : 'Trang cấp link chưa sẵn sàng. Vui lòng thử lại sau.';
}

module.exports = async (request, response) => {
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' });
  if (!isTelegramWebhookSecretValid(request.headers['x-telegram-bot-api-secret-token'])) {
    return sendJson(response, 403, { error: 'Forbidden' });
  }

  let update;
  try { update = parsePrivateStartUpdate(await readJson(request)); }
  catch { return sendJson(response, 400, { error: 'Invalid update' }); }
  if (!update) return sendJson(response, 200, { ok: true });

  let updateClaimId = null;
  try {
    if (!store.configured()) throw new Error('Storage is not configured');
    if (update.updateId) {
      updateClaimId = randomUUID();
      const claimed = await store.claimWebhookUpdate(update.updateId, updateClaimId);
      if (!claimed) return sendJson(response, 200, { ok: true });
    }

    if (update.type !== 'claim') {
      const limit = await store.fixedWindowRateLimit('bot-start-user', update.telegramUserId, START_LIMIT);
      const globalLimit = await store.fixedWindowRateLimit('bot-start-global', 'all', START_GLOBAL_LIMIT);
      if (limit.allowed && globalLimit.allowed) {
        const sent = await sendTelegramMessage(update.chatId, startMessage());
        if (!sent.sent) throw new Error('Telegram delivery failed');
      }
      if (updateClaimId) await store.completeWebhookUpdate(update.updateId, updateClaimId);
      return sendJson(response, 200, { ok: true });
    }

    const limit = await store.fixedWindowRateLimit('bot-claim-user', update.telegramUserId, CLAIM_LIMIT);
    if (!limit.allowed) {
      if (updateClaimId) await store.completeWebhookUpdate(update.updateId, updateClaimId);
      return sendJson(response, 200, { ok: true });
    }
    if (!(await store.consumeWebClaim(update.claimToken))) {
      const sent = await sendTelegramMessage(update.chatId, startMessage());
      if (!sent.sent) throw new Error('Telegram delivery failed');
      if (updateClaimId) await store.completeWebhookUpdate(update.updateId, updateClaimId);
      return sendJson(response, 200, { ok: true });
    }

    const policy = validatePolicy(await store.readPolicy());
    const xui = createXuiClient({ subscriptionBaseUrl: policy.subscriptionBaseUrl });
    const result = await provisionForTelegram(update.telegramUserId, policy, xui);
    const message = `Link subscription của bạn (${result.email}):\n${result.url}\n\nMở /free nếu cần lấy lại link.`;
    const sent = await sendTelegramMessage(update.chatId, message);
    if (!sent.sent) throw new Error('Telegram delivery failed');
    if (updateClaimId) await store.completeWebhookUpdate(update.updateId, updateClaimId);
    return sendJson(response, 200, { ok: true });
  } catch (error) {
    console.error('[free-web] bot request failed', error.code || error.name || 'Error');
    if (updateClaimId) await store.releaseWebhookUpdate(update.updateId, updateClaimId).catch(() => {});
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

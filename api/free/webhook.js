const { randomUUID } = require('node:crypto');
const store = require('../../lib/free-store');
const { readJson, sendJson } = require('../../lib/free-http');
const { subscriptionUrl, validatePolicy } = require('../../lib/free-policy');
const { createXuiClient } = require('../../lib/xui');
const { findIssuedClient, provisionForTelegram } = require('../../lib/free-provision');
const { testPageUrl } = require('../../lib/free-service');
const {
  isTelegramWebhookSecretValid,
  parsePrivateStartUpdate,
  sendTelegramMessage,
} = require('../../lib/telegram');

const START_LIMIT = Object.freeze({ limit: 2, windowSeconds: 5 * 60 });
const START_GLOBAL_LIMIT = Object.freeze({ limit: 120, windowSeconds: 5 * 60 });
const CLAIM_LIMIT = Object.freeze({ limit: 6, windowSeconds: 10 * 60 });

function startMessage() {
  const url = testPageUrl();
  return url
    ? `Bạn chưa xác minh từ trang web. Mở trang này, nhấn “Xác minh Telegram” rồi quay lại để nhận link riêng:\n${url}`
    : 'Trang cấp link chưa sẵn sàng. Vui lòng thử lại sau.';
}

function disabledMessage() {
  return 'Client của bạn hiện đã bị tắt. Vui lòng liên hệ quản trị viên.';
}

function verifiedMessage() {
  return 'Bạn đã xác minh thành công. Quay lại trang web để nhận link subscription riêng. Bạn cũng có thể dùng /start để bot gửi lại link bất cứ lúc nào.';
}

function subscriptionMessage(result) {
  return `Link subscription của bạn (${result.email}):\n${result.url}`;
}

async function existingSubscription(telegramUserId) {
  const policy = validatePolicy(await store.readPolicy());
  const xui = createXuiClient({ subscriptionBaseUrl: policy.subscriptionBaseUrl });
  const { row } = await findIssuedClient(telegramUserId, xui);
  if (!row) return null;
  if (row.client.enable === false) {
    const error = new Error('Client is disabled on the panel');
    error.code = 'CLIENT_DISABLED';
    throw error;
  }
  return {
    email: row.client.email,
    url: subscriptionUrl(policy, row.client.subId),
  };
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
  let webClaimToken = null;
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
        const result = await existingSubscription(update.telegramUserId);
        const sent = await sendTelegramMessage(update.chatId, result ? subscriptionMessage(result) : startMessage());
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
      const result = await existingSubscription(update.telegramUserId);
      const sent = await sendTelegramMessage(update.chatId, result ? subscriptionMessage(result) : startMessage());
      if (!sent.sent) throw new Error('Telegram delivery failed');
      if (updateClaimId) await store.completeWebhookUpdate(update.updateId, updateClaimId);
      return sendJson(response, 200, { ok: true });
    }

    webClaimToken = update.claimToken;
    const policy = validatePolicy(await store.readPolicy());
    const xui = createXuiClient({ subscriptionBaseUrl: policy.subscriptionBaseUrl });
    const result = await provisionForTelegram(update.telegramUserId, policy, xui);
    await store.finishWebClaim(webClaimToken, { state: 'ready', email: result.email, url: result.url });
    const sent = await sendTelegramMessage(update.chatId, verifiedMessage());
    if (!sent.sent) throw new Error('Telegram delivery failed');
    if (updateClaimId) await store.completeWebhookUpdate(update.updateId, updateClaimId);
    return sendJson(response, 200, { ok: true });
  } catch (error) {
    console.error('[free-web] bot request failed', error.code || error.name || 'Error');
    if (webClaimToken) {
      const state = error.code === 'CLIENT_DISABLED' ? 'disabled' : 'failed';
      await store.finishWebClaim(webClaimToken, { state }).catch(() => {});
    }
    if (error.message === 'Client creation is already in progress') {
      if (updateClaimId) await store.releaseWebhookUpdate(update.updateId, updateClaimId).catch(() => {});
      return sendJson(response, 503, { error: 'Retry later' });
    }
    if (error.message === 'Telegram delivery failed') {
      if (updateClaimId) await store.releaseWebhookUpdate(update.updateId, updateClaimId).catch(() => {});
      return sendJson(response, 503, { error: 'Retry later' });
    }
    const message = error.code === 'CLIENT_DISABLED'
      ? disabledMessage()
      : 'Chưa thể tạo hoặc lấy link lúc này. Vui lòng thử lại sau.';
    const sent = await sendTelegramMessage(update.chatId, message);
    if (sent.sent && updateClaimId) await store.completeWebhookUpdate(update.updateId, updateClaimId).catch(() => {});
    if (!sent.sent && updateClaimId) await store.releaseWebhookUpdate(update.updateId, updateClaimId).catch(() => {});
    return sendJson(response, sent.sent ? 200 : 503, { ok: false });
  }
};

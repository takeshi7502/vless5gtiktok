const { createHash, timingSafeEqual } = require('node:crypto');

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const SEND_TIMEOUT_MS = 7_000;

function isTelegramWebhookSecretValid(receivedSecret) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (typeof receivedSecret !== 'string' || !receivedSecret || !expectedSecret) return false;

  // Fixed-size digests let timingSafeEqual compare secrets of any length.
  const receivedHash = createHash('sha256').update(receivedSecret).digest();
  const expectedHash = createHash('sha256').update(expectedSecret).digest();
  return timingSafeEqual(receivedHash, expectedHash);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeTelegramId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)) return value;
  return null;
}

function safeUpdateId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value)) return value;
  return null;
}

function safeTelegramUsername(value) {
  if (typeof value !== 'string') return null;
  const username = value.trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,32}$/.test(username) ? username : null;
}

function safeTelegramDisplayName(firstName, lastName) {
  const name = [firstName, lastName]
    .filter((value) => typeof value === 'string')
    .map((value) => value.replace(/[\x00-\x1f\x7f]/g, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name ? [...name].slice(0, 64).join('') : null;
}

function parsePrivateStartUpdate(payload) {
  if (!isRecord(payload) || !isRecord(payload.message)) return null;
  const { message } = payload;
  if (!isRecord(message.chat) || !isRecord(message.from) || typeof message.text !== 'string') return null;
  if (message.chat.type !== 'private' || message.from.is_bot !== false) return null;
  const match = /^\/start(?:[ \t]+([A-Za-z0-9_-]{1,64}))?$/.exec(message.text.trim());
  if (!match) return null;

  const chatId = safeTelegramId(message.chat.id);
  const telegramUserId = safeTelegramId(message.from.id);
  if (!chatId || !telegramUserId || chatId !== telegramUserId) return null;

  const parameter = match[1] || '';
  const claimMatch = /^c_([A-Za-z0-9_-]{24,64})$/.exec(parameter);
  if (parameter && parameter !== 'free' && !claimMatch) return null;
  return {
    updateId: safeUpdateId(payload.update_id),
    telegramUserId,
    telegramUsername: safeTelegramUsername(message.from.username),
    telegramDisplayName: safeTelegramDisplayName(message.from.first_name, message.from.last_name),
    chatId,
    type: claimMatch ? 'claim' : 'web',
    claimToken: claimMatch ? claimMatch[1] : null,
  };
}

async function sendTelegramMessage(chatId, text, options = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const configured = Boolean(token);
  const safeChatId = safeTelegramId(chatId);
  if (!configured || !safeChatId || typeof text !== 'string' || !text.trim()) {
    return { configured, sent: false };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : SEND_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: safeChatId,
        text: text.slice(0, 4_096),
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { configured: true, sent: false };
    const result = await response.json();
    return { configured: true, sent: result?.ok === true };
  } catch {
    // Bot tokens and private chat data must never appear in logs or responses.
    return { configured: true, sent: false };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  isTelegramWebhookSecretValid,
  parsePrivateStartUpdate,
  sendTelegramMessage,
};

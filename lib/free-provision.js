const { randomBytes, randomUUID } = require('node:crypto');
const store = require('./free-store');
const {
  CLIENT_MARKER,
  LEGACY_CLIENT_MARKER,
  managedFields,
  expirySettings,
  subscriptionUrl,
} = require('./free-policy');
const { updatePayload } = require('./free-client-update');

const SUBSCRIPTION_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const SUBSCRIPTION_ID_LENGTH = 16;

function createSubscriptionId() {
  let value = '';
  while (value.length < SUBSCRIPTION_ID_LENGTH) {
    for (const byte of randomBytes(20)) {
      // The final four byte values would bias a modulo-36 mapping.
      if (byte >= 252) continue;
      value += SUBSCRIPTION_ID_ALPHABET[byte % SUBSCRIPTION_ID_ALPHABET.length];
      if (value.length === SUBSCRIPTION_ID_LENGTH) return value;
    }
  }
  return value;
}

function normalizedTelegramUsername(value) {
  if (typeof value !== 'string') return '';
  const username = value.trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,32}$/.test(username) ? username : '';
}

function managedComment(telegramUsername) {
  const username = normalizedTelegramUsername(telegramUsername);
  return username ? `${CLIENT_MARKER}:@${username}` : CLIENT_MARKER;
}

function isManagedComment(value) {
  return value === LEGACY_CLIENT_MARKER || value === CLIENT_MARKER ||
    /^fw:@[A-Za-z0-9_]{1,32}$/.test(value || '');
}

function isManagedRow(row) {
  return row && row.client && isManagedComment(row.client.comment) &&
    /^#\d{3,}$/.test(row.client.email);
}

async function ensureInbounds(row, policy, xui) {
  const attached = new Set(row.inboundIds || []);
  const missing = policy.inboundIds.filter((id) => !attached.has(id));
  if (missing.length > 0) {
    await xui.bulkAttach({ emails: [row.client.email], inboundIds: missing });
  }
  let updated = missing.length > 0 ? await xui.getClient(row.client.email) : row;
  const current = new Set(updated.inboundIds || []);
  if (policy.inboundIds.some((id) => !current.has(id))) {
    throw new Error('Client is missing required inbounds');
  }
  if (updated.client.limitHwid !== policy.hwidLimit) {
    await xui.updateClient(updated.client.email, updatePayload(updated.client, {
      limitHwid: policy.hwidLimit,
    }));
    updated = await xui.getClient(updated.client.email);
    if (updated.client.limitHwid !== policy.hwidLimit) {
      throw new Error('Client HWID limit was not applied');
    }
  }
  return updated;
}

async function existingClient(telegramId, xui, deps) {
  const email = await deps.readIssuedEmail(telegramId);
  if (!email) return { row: null };
  try {
    const row = await xui.getClient(email);
    if (!isManagedRow(row) || String(row.client.tgId) !== telegramId) {
      throw new Error('Issued client identity does not match');
    }
    return { row };
  } catch (error) {
    if (error.message === 'Issued client identity does not match') throw error;
    if (error?.code !== 'NOT_FOUND') throw error;
    await deps.removeIssuedEmail(email);
    return { row: null };
  }
}

async function findIssuedClient(telegramId, xui, deps = store) {
  if (!/^[1-9]\d{0,15}$/.test(String(telegramId)) ||
      !Number.isSafeInteger(Number(telegramId))) throw new Error('Invalid Telegram ID');
  return existingClient(String(telegramId), xui, deps);
}

async function completePendingClient(existing, telegramId, policy, xui, deps) {
  const row = existing.row;
  if (row.client.enable === false) {
    const disabled = new Error('Client is disabled on the panel');
    disabled.code = 'CLIENT_DISABLED';
    throw disabled;
  }
  return row;
}

async function provisionForTelegram(telegramId, policy, xui, deps = store, telegramUsername = '') {
  if (!/^[1-9]\d{0,15}$/.test(String(telegramId)) ||
      !Number.isSafeInteger(Number(telegramId))) throw new Error('Invalid Telegram ID');
  telegramId = String(telegramId);

  let existing = await existingClient(telegramId, xui, deps);
  let row = existing.row;
  if (row) {
    row = await completePendingClient(existing, telegramId, policy, xui, deps);
    return { created: false, email: row.client.email, url: subscriptionUrl(policy, row.client.subId) };
  }

  const claimId = randomUUID();
  if (!(await deps.claimTelegram(telegramId, claimId))) {
    throw new Error('Client creation is already in progress');
  }

  try {
    existing = await existingClient(telegramId, xui, deps);
    row = existing.row;
    if (row) {
      row = await completePendingClient(existing, telegramId, policy, xui, deps);
      return { created: false, email: row.client.email, url: subscriptionUrl(policy, row.client.subId) };
    }

    const issuedAt = Date.now();
    for (let attempt = 0; attempt < 100; attempt++) {
      const email = await deps.nextEmail();
      const client = {
        email,
        subId: createSubscriptionId(),
        tgId: Number(telegramId),
        comment: managedComment(telegramUsername),
        enable: true,
        ...managedFields(policy, issuedAt),
      };
      try {
        await xui.createClient({ client, inboundIds: policy.inboundIds });
      } catch (error) {
        let occupied = null;
        try { occupied = await xui.getClient(email); } catch { /* creation failed before storage */ }
        if (occupied && isManagedRow(occupied) && String(occupied.client.tgId) === telegramId) {
          row = occupied;
          break;
        }
        if (occupied) continue;
        throw error;
      }
      row = await xui.getClient(email);
      if (!isManagedRow(row) || String(row.client.tgId) !== telegramId) {
        throw new Error('Created client identity does not match');
      }
      break;
    }
    if (!row) throw new Error('Unable to allocate a client email');
    row = await ensureInbounds(row, policy, xui);
    await deps.recordIssued(telegramId, row.client.email, issuedAt);
    await deps.saveExpirySettings?.(row.client.email, expirySettings(policy));
    return { created: true, email: row.client.email, url: subscriptionUrl(policy, row.client.subId) };
  } finally {
    await deps.releaseTelegram(telegramId, claimId).catch(() => {});
  }
}

module.exports = { provisionForTelegram, findIssuedClient, isManagedRow };

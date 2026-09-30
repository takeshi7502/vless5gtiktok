const { randomBytes, randomUUID } = require('node:crypto');
const store = require('./free-store');
const { CLIENT_MARKER, managedFields, subscriptionUrl } = require('./free-policy');
const { updatePayload } = require('./free-client-update');
const { gatewayEnabled, gatewaySubscriptionUrl } = require('./free-gateway');

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

function isManagedRow(row) {
  return row && row.client && row.client.comment === CLIENT_MARKER &&
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
  const fields = { limitHwid: policy.hwidLimit };
  if (gatewayEnabled()) fields.limitIp = 0;
  if (Object.entries(fields).some(([key, value]) => updated.client[key] !== value)) {
    await xui.updateClient(updated.client.email, updatePayload(updated.client, {
      ...fields,
    }));
    updated = await xui.getClient(updated.client.email);
    if (Object.entries(fields).some(([key, value]) => updated.client[key] !== value)) {
      throw new Error('Client limits were not applied');
    }
  }
  return updated;
}

async function existingClient(telegramId, xui, deps) {
  const email = await deps.readIssuedEmail(telegramId);
  let restoreEmail = null;
  if (email) {
    try {
      const row = await xui.getClient(email);
      if (!isManagedRow(row) || String(row.client.tgId) !== telegramId) {
        throw new Error('Issued client identity does not match');
      }
      return { row, restoreEmail };
    } catch (error) {
      if (error.message === 'Issued client identity does not match') throw error;
      if (error?.code !== 'NOT_FOUND') throw error;
      restoreEmail = email;
    }
  }

  const rows = await xui.getClientsByTelegramId(telegramId);
  const match = rows.filter(isManagedRow).sort((a, b) =>
    Number(a.client.email.slice(1)) - Number(b.client.email.slice(1)))[0];
  if (match) {
    await deps.recordIssued(telegramId, match.client.email);
    return { row: match, restoreEmail: null };
  }
  return { row: null, restoreEmail };
}

async function issuedSubscriptionUrl(row, policy, deps, rotateGatewayToken = false) {
  if (!gatewayEnabled()) return subscriptionUrl(policy, row.client.subId);
  if (typeof deps.ensureGatewayToken !== 'function') {
    throw new Error('Gateway storage is unavailable');
  }
  await deps.ensureGatewayToken(row.client.email, row.client.subId, { rotate: rotateGatewayToken });
  const url = gatewaySubscriptionUrl(row.client.subId);
  if (!url) throw new Error('Gateway subscription URL is invalid');
  return url;
}

async function provisionForTelegram(telegramId, policy, xui, deps = store) {
  if (!/^[1-9]\d{0,15}$/.test(String(telegramId)) ||
      !Number.isSafeInteger(Number(telegramId))) throw new Error('Invalid Telegram ID');
  telegramId = String(telegramId);

  let existing = await existingClient(telegramId, xui, deps);
  let row = existing.row;
  if (row) {
    row = await ensureInbounds(row, policy, xui);
    return { created: false, email: row.client.email, url: await issuedSubscriptionUrl(row, policy, deps) };
  }

  const claimId = randomUUID();
  if (!(await deps.claimTelegram(telegramId, claimId))) {
    throw new Error('Client creation is already in progress');
  }

  try {
    existing = await existingClient(telegramId, xui, deps);
    row = existing.row;
    if (row) {
      row = await ensureInbounds(row, policy, xui);
      return { created: false, email: row.client.email, url: await issuedSubscriptionUrl(row, policy, deps) };
    }

    const issuedAt = Date.now();
    const restoreEmail = existing.restoreEmail;
    for (let attempt = 0; attempt < 100; attempt++) {
      const email = restoreEmail && attempt === 0 ? restoreEmail : await deps.nextEmail();
      const client = {
        email,
        subId: createSubscriptionId(),
        tgId: Number(telegramId),
        comment: CLIENT_MARKER,
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
        if (restoreEmail && attempt === 0) {
          throw new Error('Issued client email is no longer available');
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
    if (restoreEmail && row.client.email === restoreEmail && typeof deps.restoreIssued === 'function') {
      await deps.restoreIssued(telegramId, row.client.email, issuedAt);
    } else {
      await deps.recordIssued(telegramId, row.client.email, issuedAt);
    }
    return {
      created: true,
      email: row.client.email,
      url: await issuedSubscriptionUrl(row, policy, deps, Boolean(restoreEmail)),
    };
  } finally {
    await deps.releaseTelegram(telegramId, claimId).catch(() => {});
  }
}

module.exports = { provisionForTelegram, isManagedRow };

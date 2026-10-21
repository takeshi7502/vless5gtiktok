const { randomBytes, randomUUID } = require('node:crypto');
const store = require('./free-store');
const {
  CLIENT_MARKER,
  LEGACY_CLIENT_MARKER,
  managedFields,
  expirySettings,
  subscriptionUrl,
  canIssueClient,
} = require('./free-policy');
const { updatePayload } = require('./free-client-update');
const { telegramAdminIds } = require('./telegram');
const { parseClientEmail } = require('./free-client-id');

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

function normalizedTelegramDisplayName(value) {
  if (typeof value !== 'string') return '';
  const name = value
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  return name ? [...name].slice(0, 64).join('') : '';
}

function managedComment(telegramUsername, telegramDisplayName) {
  const username = normalizedTelegramUsername(telegramUsername);
  const label = username ? `@${username}` : normalizedTelegramDisplayName(telegramDisplayName);
  return label ? `${CLIENT_MARKER}:${label}` : CLIENT_MARKER;
}

function isManagedComment(value) {
  return (
    value === LEGACY_CLIENT_MARKER ||
    value === CLIENT_MARKER ||
    (typeof value === 'string' && value.startsWith(`${CLIENT_MARKER}:`))
  );
}

function isManagedRow(row) {
  return (
    row &&
    row.client &&
    isManagedComment(row.client.comment) &&
    Boolean(parseClientEmail(row.client.email))
  );
}

async function ensureInbounds(row, policy, xui, renew, issuedAt) {
  enabledClient(row);
  const attached = new Set(row.inboundIds || []);
  const missing = policy.inboundIds.filter((id) => !attached.has(id));
  if (missing.length > 0) {
    await renew();
    await xui.bulkAttach({ emails: [row.client.email], inboundIds: missing });
  }
  let updated = missing.length > 0 ? await xui.getClient(row.client.email) : row;
  const current = new Set(updated.inboundIds || []);
  if (policy.inboundIds.some((id) => !current.has(id))) {
    throw new Error('Client is missing required inbounds');
  }
  const fields = managedFields(policy, issuedAt);
  if (policy.startAfterFirstUse && updated.client.expiryTime > 0) {
    fields.expiryTime = updated.client.expiryTime;
  }
  if (Object.entries(fields).some(([name, value]) => updated.client[name] !== value)) {
    await renew();
    await xui.updateClient(updated.client.email, updatePayload(updated.client, fields));
    updated = await xui.getClient(updated.client.email);
    if (updated.client.limitHwid !== policy.hwidLimit) {
      throw new Error('Client HWID limit was not applied');
    }
  }
  return enabledClient(updated);
}

async function existingClient(telegramId, xui, deps) {
  const email = await deps.readIssuedEmail(telegramId);
  if (!email) return { row: null };
  if (await deps.isClientRevoked?.(email)) return { row: null };
  try {
    const row = await xui.getClient(email);
    if (!isManagedRow(row) || String(row.client.tgId) !== telegramId) {
      throw new Error('Issued client identity does not match');
    }
    if (await deps.isClientRevoked?.(email)) return { row: null };
    return { row };
  } catch (error) {
    if (error.message === 'Issued client identity does not match') throw error;
    if (error?.code !== 'NOT_FOUND') throw error;
    await deps.removeIssuedEmail(email);
    return { row: null };
  }
}

async function findIssuedClient(telegramId, xui, deps = store) {
  if (!/^[1-9]\d{0,15}$/.test(String(telegramId)) || !Number.isSafeInteger(Number(telegramId)))
    throw new Error('Invalid Telegram ID');
  return existingClient(String(telegramId), xui, deps);
}

function enabledClient(row) {
  if (row.client.enable === false) {
    const disabled = new Error('Client is disabled on the panel');
    disabled.code = 'CLIENT_DISABLED';
    throw disabled;
  }
  return row;
}

function validatePendingClient(pending, telegramId) {
  if (
    !pending ||
    !/^[1-9]\d{0,15}$/.test(telegramId) ||
    !Number.isSafeInteger(Number(telegramId)) ||
    !Number.isSafeInteger(pending.issuedAt) ||
    !isManagedRow(pending) ||
    String(pending.client.tgId) !== telegramId ||
    !Array.isArray(pending.inboundIds)
  ) {
    throw new Error('Invalid pending client');
  }
  return pending;
}

async function lookupClient(email, xui) {
  try {
    const row = await xui.getClient(email);
    if (row && row.client?.email !== email) throw new Error('Invalid panel client identity');
    return row;
  } catch (error) {
    if (error.code !== 'NOT_FOUND') throw error;
    return null;
  }
}

async function issueForTelegram(
  telegramId,
  policy,
  xui,
  deps = store,
  telegramUsername = '',
  telegramDisplayName = '',
  claimId,
) {
  if (!(await deps.claimTelegram(telegramId, claimId))) {
    throw new Error('Client creation is already in progress');
  }

  try {
    const existing = await existingClient(telegramId, xui, deps);
    let row = existing.row;
    const renew = async () => {
      await deps.renewAllocationClaim(claimId);
      await deps.renewTelegramClaim(telegramId, claimId);
    };
    let pending = await deps.readPendingClient(telegramId);
    if (row && !pending) return { created: false, row };
    if (row && row.client.email !== pending.client.email) {
      throw new Error('Pending client identity does not match issued client');
    }
    let comment = managedComment(telegramUsername, telegramDisplayName);
    if (pending) {
      validatePendingClient(pending, telegramId);
      comment = pending.client.comment;
      await renew();
      // Adopt older per-user reservations into the serialized allocation queue.
      pending = await deps.reservePendingClient(telegramId, pending, claimId, xui);
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      await renew();
      if (!pending) {
        if (!canIssueClient(policy)) {
          const error = new Error('Client issuance has ended');
          error.code = 'CLIENT_ISSUANCE_CLOSED';
          throw error;
        }
        const issuedAt = Date.now();
        pending = await deps.reservePendingClient(
          telegramId,
          {
            issuedAt,
            client: {
              subId: createSubscriptionId(),
              tgId: Number(telegramId),
              comment,
              enable: true,
              ...managedFields(policy, issuedAt),
            },
            inboundIds: policy.inboundIds,
          },
          claimId,
          xui,
        );
      }
      validatePendingClient(pending, telegramId);
      row = await lookupClient(pending.client.email, xui);
      if (
        row &&
        (!isManagedRow(row) ||
          String(row.client.tgId) !== telegramId ||
          ((pending.reused || pending.backfill) && row.client.subId !== pending.client.subId))
      ) {
        await deps.discardPendingClient(telegramId, pending.client.email, claimId);
        pending = null;
        row = null;
        continue;
      }
      if (!row) {
        if (!canIssueClient(policy)) {
          const error = new Error('Client issuance has ended');
          error.code = 'CLIENT_ISSUANCE_CLOSED';
          throw error;
        }
        await renew();
        try {
          await xui.createClient({
            client: { ...pending.client, ...managedFields(policy, pending.issuedAt) },
            inboundIds: policy.inboundIds,
          });
        } catch (error) {
          row = await lookupClient(pending.client.email, xui);
          if (!row) throw error;
        }
        row = row || (await lookupClient(pending.client.email, xui));
      }
      if (
        !isManagedRow(row) ||
        String(row.client.tgId) !== telegramId ||
        ((pending.reused || pending.backfill) && row.client.subId !== pending.client.subId)
      ) {
        throw new Error('Created client identity does not match');
      }
      break;
    }
    if (!row) throw new Error('Unable to allocate a client email');
    // A panel-disabled reservation still owns its number; never re-enable it or block the queue.
    if (row.client.enable !== false) {
      row = await ensureInbounds(row, policy, xui, renew, pending.issuedAt);
    }
    await renew();
    subscriptionUrl(policy, row.client.subId);
    await deps.saveExpirySettings?.(row.client.email, expirySettings(policy));
    await deps.recordIssued(
      telegramId,
      row.client.email,
      pending.issuedAt,
      claimId,
      row.client.enable !== false && telegramAdminIds().length > 0,
    );
    return { created: true, row };
  } finally {
    await deps.releaseTelegram(telegramId, claimId).catch(() => {});
  }
}

async function provisionForTelegram(
  telegramId,
  policy,
  xui,
  deps = store,
  telegramUsername = '',
  telegramDisplayName = '',
) {
  if (!/^[1-9]\d{0,15}$/.test(String(telegramId)) || !Number.isSafeInteger(Number(telegramId))) {
    throw new Error('Invalid Telegram ID');
  }
  telegramId = String(telegramId);
  const result = (created, row) => {
    enabledClient(row);
    return { created, email: row.client.email, url: subscriptionUrl(policy, row.client.subId) };
  };
  const existing = await existingClient(telegramId, xui, deps);
  if (existing.row) return result(false, existing.row);

  const claimId = randomUUID();
  if (!(await deps.claimAllocation(claimId)))
    throw new Error('Client creation is already in progress');
  try {
    await deps.renewAllocationClaim(claimId);
    const head = await deps.readPendingAllocation();
    if (head && head.telegramId !== telegramId) {
      validatePendingClient(head.pending, head.telegramId);
      // Finish the verified request left by a timeout/crash before assigning the next number.
      await issueForTelegram(head.telegramId, policy, xui, deps, '', '', claimId);
    }
    const issued = await issueForTelegram(
      telegramId,
      policy,
      xui,
      deps,
      telegramUsername,
      telegramDisplayName,
      claimId,
    );
    return result(issued.created, issued.row);
  } finally {
    await deps.releaseAllocation(claimId).catch(() => {});
  }
}

module.exports = { provisionForTelegram, findIssuedClient, isManagedRow };

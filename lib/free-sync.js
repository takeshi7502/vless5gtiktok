const store = require('./free-store');
const { isManagedRow } = require('./free-provision');
const { managedFields } = require('./free-policy');
const { updatePayload } = require('./free-client-update');
const { loadIssuedClients } = require('./free-registry');

const BATCH_SIZE = 20;
const MAX_CONCURRENCY = 4;

function bulkFailures(result, members, successField) {
  if (!result || typeof result !== 'object') return members;
  const succeeded = Array.isArray(result[successField]) ? result[successField] : [];
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];
  const completed = new Set([...succeeded, ...skipped]);
  return members.filter((email) => !completed.has(email));
}

async function mapWithConcurrency(items, limit, operation) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function inspectClient(email, policy, xui, deps) {
  try {
    const row = await xui.getClient(email);
    if (!isManagedRow(row)) throw new Error('Client is no longer managed');

    const issuedAt = await deps.readIssuedAt(email);
    const fields = managedFields(policy, issuedAt || Date.now());
    if (!issuedAt && policy.expiryMode === 'days') fields.expiryTime = row.client.expiryTime;
    const changed = Object.entries(fields).some(([key, value]) => row.client[key] !== value);
    if (changed) await xui.updateClient(email, updatePayload(row.client, fields));

    const current = new Set(row.inboundIds || []);
    const desired = new Set(policy.inboundIds);
    return {
      email,
      updated: changed,
      attachIds: [...desired].filter((id) => !current.has(id)),
      detachIds: [...current].filter((id) => !desired.has(id)),
    };
  } catch (error) {
    if (error.code === 'NOT_FOUND') {
      await deps.removeIssuedEmail(email);
      return { email, removed: true };
    }
    return { email, error: true };
  }
}

function addMemberships(target, ids, email) {
  for (const id of ids) {
    if (!target.has(id)) target.set(id, []);
    target.get(id).push(email);
  }
}

async function syncBatch(policy, xui, cursor = 0, deps = store, afterEmail) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid cursor');
  if (afterEmail !== undefined && (typeof afterEmail !== 'string' || !/^#\d{3,}$/.test(afterEmail))) {
    throw new Error('Invalid last email');
  }
  const rows = await loadIssuedClients(xui, deps);
  const emails = rows.map((row) => row.client.email);
  // Continue by identity so a panel deletion between requests cannot skip a client.
  const remaining = afterEmail === undefined
    ? emails.slice(cursor)
    : emails.filter((email) => Number(email.slice(1)) > Number(afterEmail.slice(1)));
  const batch = remaining.slice(0, BATCH_SIZE);
  const inspected = await mapWithConcurrency(batch, MAX_CONCURRENCY,
    (email) => inspectClient(email, policy, xui, deps));
  const attach = new Map();
  const detach = new Map();
  const errors = [];
  let updated = 0;

  for (const item of inspected) {
    if (item.removed) continue;
    if (item.error) {
      errors.push(item.email);
      continue;
    }
    if (item.updated) updated++;
    addMemberships(attach, item.attachIds, item.email);
    addMemberships(detach, item.detachIds, item.email);
  }

  for (const [id, members] of attach) {
    try {
      const result = await xui.bulkAttach({ emails: members, inboundIds: [id] });
      errors.push(...bulkFailures(result, members, 'attached'));
    } catch {
      errors.push(...members);
    }
  }
  for (const [id, members] of detach) {
    try {
      const result = await xui.bulkDetach({ emails: members, inboundIds: [id] });
      errors.push(...bulkFailures(result, members, 'detached'));
    } catch {
      errors.push(...members);
    }
  }

  const nextCursor = cursor + batch.length;
  return {
    done: batch.length >= remaining.length,
    cursor: nextCursor,
    afterEmail: batch.at(-1) || afterEmail,
    processed: Math.min(nextCursor, emails.length),
    updated,
    total: emails.length,
    errors: [...new Set(errors)],
  };
}

module.exports = { BATCH_SIZE, MAX_CONCURRENCY, syncBatch };

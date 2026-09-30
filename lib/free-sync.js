const store = require('./free-store');
const { isManagedRow } = require('./free-provision');
const { managedFields } = require('./free-policy');
const { updatePayload } = require('./free-client-update');

const BATCH_SIZE = 5;

function bulkFailures(result, members, successField) {
  if (!result || typeof result !== 'object') return members;
  const succeeded = Array.isArray(result[successField]) ? result[successField] : [];
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];
  const completed = new Set([...succeeded, ...skipped]);
  return members.filter((email) => !completed.has(email));
}

async function syncBatch(policy, xui, cursor = 0, deps = store) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid cursor');
  const emails = (await deps.listIssuedEmails()).sort((a, b) =>
    Number(a.slice(1)) - Number(b.slice(1)));
  const batch = emails.slice(cursor, cursor + BATCH_SIZE);
  const attach = new Map();
  const detach = new Map();
  const errors = [];
  let updated = 0;

  for (const email of batch) {
    try {
      const row = await xui.getClient(email);
      if (!isManagedRow(row)) throw new Error('Client is no longer managed');
      const issuedAt = await deps.readIssuedAt(email);
      const fields = managedFields(policy, issuedAt || Date.now());
      if (!issuedAt && policy.expiryMode === 'days') fields.expiryTime = row.client.expiryTime;
      const changed = Object.entries(fields).some(([key, value]) => row.client[key] !== value);
      if (changed) {
        await xui.updateClient(email, updatePayload(row.client, fields));
        updated++;
      }

      const current = new Set(row.inboundIds || []);
      const desired = new Set(policy.inboundIds);
      for (const id of desired) {
        if (!current.has(id)) {
          if (!attach.has(id)) attach.set(id, []);
          attach.get(id).push(email);
        }
      }
      for (const id of current) {
        if (!desired.has(id)) {
          if (!detach.has(id)) detach.set(id, []);
          detach.get(id).push(email);
        }
      }
    } catch {
      errors.push(email);
    }
  }

  for (const [id, members] of attach) {
    try {
      const result = await xui.bulkAttach({ emails: members, inboundIds: [id] });
      errors.push(...bulkFailures(result, members, 'attached'));
    }
    catch { errors.push(...members); }
  }
  for (const [id, members] of detach) {
    try {
      const result = await xui.bulkDetach({ emails: members, inboundIds: [id] });
      errors.push(...bulkFailures(result, members, 'detached'));
    }
    catch { errors.push(...members); }
  }

  const nextCursor = cursor + batch.length;
  return {
    done: nextCursor >= emails.length,
    cursor: nextCursor,
    processed: nextCursor,
    updated,
    total: emails.length,
    errors: [...new Set(errors)],
  };
}

module.exports = { syncBatch };

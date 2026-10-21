const store = require('./free-store');
const { isManagedRow } = require('./free-provision');
const { compareClientEmails } = require('./free-client-id');

async function loadIssuedClients(xui, deps = store) {
  const snapshotAt = Date.now();
  const observed = await deps.listIssuedEmails();
  const rows = await xui.listClients();
  const byEmail = new Map();
  for (const item of rows) {
    const row = item?.client ? item : { client: item };
    if (typeof row.client?.email !== 'string' || !row.client.email) {
      throw new Error('Invalid panel client list');
    }
    if (isManagedRow(row)) byEmail.set(row.client.email, row);
  }
  const emails = [...byEmail.keys()].sort(compareClientEmails);
  await deps.reconcileIssuedEmails(emails, observed, snapshotAt);
  return emails.map((email) => byEmail.get(email));
}

module.exports = { loadIssuedClients };

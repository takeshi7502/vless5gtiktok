const store = require('./free-store');
const { loadIssuedClients } = require('./free-registry');
const {
  LOW_DATA_THRESHOLD_BYTES,
  clientUsage,
  isLowData,
  lowDataMessage,
  usageAlertCycle,
} = require('./free-usage');
const { sendTelegramMessage } = require('./telegram');

const MAX_CONCURRENCY = 4;

function telegramUserId(value) {
  const text = String(value ?? '');
  return /^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
}

async function mapWithConcurrency(items, operation, concurrency = MAX_CONCURRENCY) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function checkLowDataAlerts(xui, deps = store, send = sendTelegramMessage) {
  const rows = await loadIssuedClients(xui, deps);
  const results = await mapWithConcurrency(rows, async (row) => {
    const summary = clientUsage(row);
    const email = row.client.email;
    if (summary.trafficAvailable && summary.quotaBytes > 0 &&
        summary.remainingBytes > LOW_DATA_THRESHOLD_BYTES) {
      await deps.clearUsageAlert(email);
      return 'clear';
    }
    if (!isLowData(summary) || row.client.enable === false) return 'skip';

    const chatId = telegramUserId(row.client.tgId);
    if (!chatId) return 'skip';
    const cycle = usageAlertCycle(summary);
    if (!(await deps.claimUsageAlert(email, cycle))) return 'duplicate';

    const sent = await send(chatId, lowDataMessage(summary));
    if (!sent.sent) {
      await deps.releaseUsageAlert(email, cycle);
      return 'failed';
    }
    return 'sent';
  });

  return {
    checked: rows.length,
    notified: results.filter((value) => value === 'sent').length,
    failed: results.filter((value) => value === 'failed').length,
  };
}

module.exports = { checkLowDataAlerts };

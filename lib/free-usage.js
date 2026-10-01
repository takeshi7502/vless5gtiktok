const GIB = 1024 ** 3;
const LOW_DATA_THRESHOLD_BYTES = GIB;

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function trafficFor(row) {
  if (row?.traffic && typeof row.traffic === 'object') return row.traffic;
  if (row?.client?.traffic && typeof row.client.traffic === 'object') return row.client.traffic;
  return {};
}

function clientUsage(row) {
  const client = row?.client && typeof row.client === 'object' ? row.client : {};
  const traffic = trafficFor(row);
  const up = nonNegativeNumber(traffic.up);
  const down = nonNegativeNumber(traffic.down);
  const quotaBytes = nonNegativeNumber(client.totalGB) || 0;
  const usedBytes = (up || 0) + (down || 0);
  const trafficAvailable = up !== null || down !== null;
  const remainingBytes = quotaBytes > 0 ? Math.max(0, quotaBytes - usedBytes) : null;
  return { quotaBytes, usedBytes, remainingBytes, trafficAvailable, resetCount: nonNegativeNumber(traffic.resetCount) };
}

function formatGigabytes(bytes) {
  const value = Math.max(0, bytes) / GIB;
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(decimals))} GB`;
}

function dataMessage(summary) {
  if (!summary.trafficAvailable) {
    return 'Chưa thể đọc lưu lượng hiện tại. Vui lòng thử lại sau.';
  }
  if (summary.quotaBytes === 0) {
    return `Dung lượng của bạn\nĐã dùng: ${formatGigabytes(summary.usedBytes)}\nGiới hạn: Không giới hạn`;
  }
  return `Dung lượng của bạn\nĐã dùng: ${formatGigabytes(summary.usedBytes)} / ${formatGigabytes(summary.quotaBytes)}\nCòn lại: ${formatGigabytes(summary.remainingBytes)}`;
}

function isLowData(summary) {
  return summary.trafficAvailable && summary.quotaBytes > 0 &&
    summary.usedBytes < summary.quotaBytes && summary.remainingBytes <= LOW_DATA_THRESHOLD_BYTES;
}

function lowDataMessage(summary) {
  return `Cảnh báo dung lượng\nBạn đã dùng ${formatGigabytes(summary.usedBytes)} / ${formatGigabytes(summary.quotaBytes)}.\nCòn lại: ${formatGigabytes(summary.remainingBytes)}.\nVui lòng sử dụng tiết kiệm hoặc chờ đến kỳ reset tiếp theo.`;
}

function usageAlertCycle(summary) {
  return `${summary.quotaBytes}:${summary.resetCount === null ? 'none' : summary.resetCount}`;
}

module.exports = {
  LOW_DATA_THRESHOLD_BYTES,
  clientUsage,
  dataMessage,
  isLowData,
  lowDataMessage,
  usageAlertCycle,
};

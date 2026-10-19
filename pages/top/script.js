const status = document.getElementById('ranking-status');
const section = document.getElementById('ranking-section');
const table = document.getElementById('ranking-table');
const rows = document.getElementById('ranking-rows');
const empty = document.getElementById('ranking-empty');
const retry = document.getElementById('retry-ranking');
const number = new Intl.NumberFormat('vi-VN');
const bytes = new Intl.NumberFormat('vi-VN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
let loading = false;
let retryAt = 0;
let timer;
let nextRefreshAt = 0;

function formatBytes(value) {
  const gib = value / 1024 ** 3;
  return gib >= 1024 ? `${bytes.format(gib / 1024)} TB` : `${bytes.format(gib)} GB`;
}

function render(data) {
  if (!Array.isArray(data.users) || !Number.isFinite(data.updatedAt))
    throw new Error('Invalid ranking');
  document.getElementById('total-usage').textContent = formatBytes(data.totalBytes);
  document.getElementById('active-users').textContent = number.format(data.activeCount);
  document.getElementById('total-users').textContent = number.format(data.userCount);
  const maximum = Math.max(1, ...data.users.map((user) => user.usedBytes));
  rows.replaceChildren();
  data.users.forEach((user) => {
    const row = document.createElement('tr');
    const rank = document.createElement('td');
    rank.className = 'ranking-position';
    rank.textContent = String(user.rank).padStart(2, '0');
    const name = document.createElement('td');
    name.className = 'ranking-user';
    name.textContent = user.email;
    const usage = document.createElement('td');
    usage.className = 'ranking-usage';
    const value = document.createElement('span');
    value.className = 'usage-value';
    value.textContent = formatBytes(user.usedBytes);
    const track = document.createElement('span');
    track.className = 'usage-track';
    track.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('span');
    fill.className = 'usage-fill';
    fill.style.width = `${Math.min(100, Math.max(0, (user.usedBytes / maximum) * 100))}%`;
    track.append(fill);
    usage.append(value, track);
    row.append(rank, name, usage);
    rows.append(row);
  });
  table.hidden = data.users.length === 0;
  empty.hidden = data.users.length !== 0;
  status.dataset.error = 'false';
  status.textContent = data.stale
    ? 'Đang hiển thị bản thống kê gần nhất. Dữ liệu mới tạm thời chưa sẵn sàng.'
    : data.incomplete
      ? 'Một số client chưa đọc được lưu lượng.'
      : 'Upload + download · Xếp theo dung lượng đã dùng';
  document.getElementById('ranking-updated').textContent = `Cập nhật: ${new Intl.DateTimeFormat(
    'vi-VN',
    {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'Asia/Ho_Chi_Minh',
    },
  ).format(data.updatedAt)} (giờ Việt Nam)`;
}

async function loadRanking() {
  if (loading || document.hidden || Date.now() < retryAt) return;
  loading = true;
  retry.hidden = true;
  section.setAttribute('aria-busy', 'true');
  let delay = 5 * 60_000;
  try {
    const response = await fetch('/api/free/top', { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      delay = Math.min(300, Math.max(30, Number(response.headers.get('retry-after')) || 30)) * 1000;
      retryAt = Date.now() + delay;
      throw new Error('Ranking unavailable');
    }
    const data = await response.json();
    render(data);
    if (data.stale) delay = 30_000;
  } catch {
    status.dataset.error = 'true';
    status.textContent = rows.children.length
      ? 'Chưa thể cập nhật. Bảng đang giữ số liệu gần nhất.'
      : 'Chưa thể tải thống kê. Vui lòng thử lại sau.';
    retry.hidden = false;
    retry.disabled = Date.now() < retryAt;
    if (retry.disabled)
      window.setTimeout(() => {
        retry.disabled = false;
      }, retryAt - Date.now());
  } finally {
    loading = false;
    section.setAttribute('aria-busy', 'false');
    window.clearTimeout(timer);
    nextRefreshAt = Date.now() + delay;
    timer = window.setTimeout(() => {
      void loadRanking();
    }, delay);
  }
}

retry.addEventListener('click', () => {
  void loadRanking();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() >= nextRefreshAt) void loadRanking();
});
void loadRanking();

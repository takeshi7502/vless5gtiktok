const endpoint = '/api/free/admin';
const pageStatus = document.getElementById('page-status');
const loginSection = document.getElementById('login-section');
const dashboard = document.getElementById('dashboard');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password');
const loginButton = document.getElementById('login-button');
const loginStatus = document.getElementById('login-status');
const logoutButton = document.getElementById('logout');
const policyForm = document.getElementById('policy-form');
const expiryModeInput = document.getElementById('expiry-mode');
const expiryDaysField = document.getElementById('expiry-days-field');
const expiryDaysInput = document.getElementById('expiry-days');
const expiryAtField = document.getElementById('expiry-at-field');
const expiryAtInput = document.getElementById('expiry-at');
const inboundList = document.getElementById('inbound-list');
const inboundCount = document.getElementById('inbound-count');
const saveButton = document.getElementById('save-policy');
const policyStatus = document.getElementById('policy-status');
const syncButton = document.getElementById('sync-clients');
const syncStatus = document.getElementById('sync-status');
const syncProgress = document.getElementById('sync-progress');
const syncProgressBar = document.getElementById('sync-progress-bar');
const syncProgressLabel = document.getElementById('sync-progress-label');
const webhookButton = document.getElementById('register-webhook');
const webhookStatus = document.getElementById('webhook-status');
const configStatus = document.getElementById('config-status');
const issuedCount = document.getElementById('issued-count');
const issuedStatus = document.getElementById('issued-status');

let configured = false;
let dirty = false;
let panelAvailable = true;
let storageAvailable = true;
let syncing = false;
let refreshingClients = false;

function setMessage(element, message, kind = '') {
  element.textContent = message;
  element.dataset.kind = kind;
}

function setSyncProgress(processed, total, visible) {
  syncProgress.hidden = !visible;
  if (!visible) return;
  const safeTotal = Number.isSafeInteger(total) && total > 0 ? total : 1;
  const safeProcessed = Math.max(0, Math.min(Number(processed) || 0, safeTotal));
  syncProgressBar.max = safeTotal;
  syncProgressBar.value = safeProcessed;
  syncProgressLabel.textContent = `${safeProcessed}/${total || 0} client`;
}

function showLogin() {
  pageStatus.hidden = true;
  loginSection.hidden = false;
  dashboard.hidden = true;
  logoutButton.hidden = true;
  webhookButton.hidden = true;
  setMessage(webhookStatus, '');
  configured = false;
  passwordInput.value = '';
}

function showDashboard() {
  pageStatus.hidden = true;
  loginSection.hidden = true;
  dashboard.hidden = false;
  logoutButton.hidden = false;
  webhookButton.hidden = false;
  passwordInput.value = '';
}

function showUnavailable() {
  loginSection.hidden = true;
  dashboard.hidden = true;
  logoutButton.hidden = true;
  webhookButton.hidden = true;
  pageStatus.hidden = false;
  pageStatus.textContent = 'Trang quản trị chưa sẵn sàng. Kiểm tra cấu hình máy chủ rồi tải lại trang.';
}

function updateSyncAvailability() {
  syncButton.disabled = !configured || dirty || !panelAvailable || !storageAvailable || syncing;
}

async function request(method = 'GET', body) {
  const response = await fetch(endpoint, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await response.json(); } catch { /* A non-JSON error has no public detail. */ }

  if (!response.ok) {
    const error = new Error(`Yêu cầu không thành công (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function updateExpiryFields() {
  const mode = expiryModeInput.value;
  expiryDaysField.hidden = mode !== 'days';
  expiryDaysInput.required = mode === 'days';
  expiryDaysInput.disabled = mode !== 'days';
  expiryAtField.hidden = mode !== 'date';
  expiryAtInput.required = mode === 'date';
  expiryAtInput.disabled = mode !== 'date';
}

function toLocalDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);
}

function renderInbounds(inbounds, selectedIds) {
  inboundList.replaceChildren();
  const selected = new Set((Array.isArray(selectedIds) ? selectedIds : []).map(String));
  if (!Array.isArray(inbounds) || inbounds.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-inbounds';
    empty.textContent = 'Không tìm thấy inbound khả dụng.';
    inboundList.append(empty);
    updateInboundCount();
    return;
  }

  const columns = [document.createElement('div'), document.createElement('div')];
  columns.forEach((column) => { column.className = 'inbound-column'; });
  const splitAt = Math.ceil(inbounds.length / 2);
  let index = 0;
  for (const inbound of inbounds) {
    const label = document.createElement('label');
    label.className = 'inbound-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'inboundIds';
    checkbox.value = String(inbound.id);
    checkbox.checked = selected.has(checkbox.value);
    const text = document.createElement('span');
    text.textContent = inbound.remark || `Inbound #${inbound.id}`;
    const details = document.createElement('small');
    details.textContent = `${inbound.protocol || 'unknown'} : ${inbound.port ?? '?'}`;
    text.append(details);
    label.append(checkbox, text);
    columns[index++ < splitAt ? 0 : 1].append(label);
  }
  columns.filter((column) => column.childElementCount > 0).forEach((column) => inboundList.append(column));
  updateInboundCount();
}

function updateInboundCount() {
  const total = inboundList.querySelectorAll('input[type="checkbox"]').length;
  const selected = inboundList.querySelectorAll('input[type="checkbox"]:checked').length;
  inboundCount.textContent = `${selected}/${total} đã chọn`;
}

function updateIssuedCount(value) {
  issuedCount.textContent = Number.isSafeInteger(value) && value >= 0 ? String(value) : '--';
}

async function refreshIssuedClients() {
  if (dashboard.hidden || document.hidden || syncing || refreshingClients || !storageAvailable) return;
  refreshingClients = true;
  try {
    const data = await request('POST', { action: 'clientStatus' });
    updateIssuedCount(data.issuedCount);
    setMessage(issuedStatus, '');
  } catch (error) {
    if (error.status === 401) showLogin();
    else {
      updateIssuedCount(null);
      setMessage(issuedStatus, 'Chưa thể cập nhật số client từ panel.', 'error');
    }
  } finally {
    refreshingClients = false;
  }
}

function renderPolicy(data) {
  const policy = data.policy || {};
  policyForm.elements.trafficGB.value = policy.trafficGB ?? 0;
  policyForm.elements.hwidLimit.value = policy.hwidLimit ?? 0;
  expiryModeInput.value = ['none', 'days', 'date'].includes(policy.expiryMode) ? policy.expiryMode : 'none';
  expiryDaysInput.value = policy.expiryDays ?? '';
  expiryAtInput.value = toLocalDateTime(policy.expiryAt);
  policyForm.elements.group.value = policy.group || 'free-web';
  policyForm.elements.subscriptionBaseUrl.value = policy.subscriptionBaseUrl || '';
  updateExpiryFields();
  renderInbounds(data.inbounds, policy.inboundIds);

  configured = data.configured === true;
  dirty = false;
  panelAvailable = data.panelUnavailable !== true;
  storageAvailable = data.storageUnavailable !== true;
  configStatus.dataset.ready = String(configured);
  configStatus.textContent = configured ? 'Đã lưu cấu hình' : 'Chưa hoàn tất cấu hình';
  updateSyncAvailability();
  saveButton.disabled = !panelAvailable || !storageAvailable;
  webhookButton.disabled = !storageAvailable;
  const setupError = !storageAvailable
    ? 'Chưa cấu hình Redis/KV trong Vercel Environment Variables.'
    : !panelAvailable
      ? 'Không kết nối được 3x-ui. Kiểm tra URL, API token và chứng chỉ TLS.'
      : '';
  setMessage(policyStatus, setupError, setupError ? 'error' : '');
  updateIssuedCount(data.issuedCount);
  setMessage(issuedStatus, panelAvailable ? '' : 'Chưa thể cập nhật số client từ panel.', panelAvailable ? '' : 'error');
}

async function loadAdmin() {
  try {
    const data = await request();
    if (data.authenticated !== true) {
      showLogin();
      return;
    }
    renderPolicy(data);
    showDashboard();
  } catch (error) {
    if (error.status === 401) showLogin();
    else showUnavailable();
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  setMessage(loginStatus, 'Đang đăng nhập...');
  try {
    await request('POST', { action: 'login', password: passwordInput.value });
    passwordInput.value = '';
    setMessage(loginStatus, '');
    await loadAdmin();
  } catch (error) {
    passwordInput.value = '';
    setMessage(loginStatus, error.status === 401 ? 'Mật khẩu không đúng.' : 'Đăng nhập thất bại. Vui lòng thử lại.', 'error');
  } finally {
    loginButton.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try {
    await request('POST', { action: 'logout' });
    showLogin();
    setMessage(loginStatus, 'Đã đăng xuất.', 'success');
  } catch {
    setMessage(policyStatus, 'Không thể đăng xuất. Vui lòng thử lại.', 'error');
  } finally {
    logoutButton.disabled = false;
  }
});

expiryModeInput.addEventListener('change', updateExpiryFields);
function markDirty() {
  dirty = true;
  updateInboundCount();
  updateSyncAvailability();
  if (configured && panelAvailable && storageAvailable) {
    configStatus.dataset.ready = 'false';
    configStatus.textContent = 'Có thay đổi chưa lưu';
    setMessage(policyStatus, 'Có thay đổi chưa lưu.');
  }
}
policyForm.addEventListener('input', markDirty);
policyForm.addEventListener('change', markDirty);

document.getElementById('select-all').addEventListener('click', () => {
  inboundList.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = true; });
  markDirty();
});
document.getElementById('clear-all').addEventListener('click', () => {
  inboundList.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = false; });
  markDirty();
});

policyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!policyForm.reportValidity()) return;

  const inboundIds = [...inboundList.querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => Number(input.value));
  if (inboundIds.length === 0) {
    setMessage(policyStatus, 'Hãy chọn ít nhất một inbound.', 'error');
    return;
  }

  const expiryMode = expiryModeInput.value;
  const expiryAt = expiryMode === 'date' ? new Date(expiryAtInput.value) : null;
  if (expiryAt && (!Number.isFinite(expiryAt.getTime()) || expiryAt <= new Date())) {
    setMessage(policyStatus, 'Ngày hết hạn phải ở trong tương lai.', 'error');
    return;
  }

  const subscriptionBaseUrl = policyForm.elements.subscriptionBaseUrl.value.trim();
  try {
    const url = new URL(subscriptionBaseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        !url.pathname.endsWith('/')) throw new Error('Invalid subscription URL');
  } catch {
    setMessage(policyStatus, 'URL subscription phải dùng HTTPS và kết thúc bằng /.', 'error');
    return;
  }

  const policy = {
    trafficGB: Number(policyForm.elements.trafficGB.value),
    hwidLimit: Number(policyForm.elements.hwidLimit.value),
    expiryMode,
    expiryDays: expiryMode === 'days' ? Number(expiryDaysInput.value) : null,
    expiryAt: expiryAt ? expiryAt.toISOString() : null,
    group: policyForm.elements.group.value.trim(),
    inboundIds,
    subscriptionBaseUrl,
  };

  saveButton.disabled = true;
  policyForm.inert = true;
  setMessage(policyStatus, 'Đang lưu cấu hình...');
  try {
    await request('POST', { action: 'save', policy });
    configured = true;
    dirty = false;
    configStatus.dataset.ready = 'true';
    configStatus.textContent = 'Đã lưu cấu hình';
    updateSyncAvailability();
    setMessage(policyStatus, 'Đã lưu cấu hình.', 'success');
    await syncClients({ automatic: true });
  } catch (error) {
    if (error.status === 401) showLogin();
    else setMessage(policyStatus, 'Không thể lưu cấu hình. Vui lòng kiểm tra dữ liệu và thử lại.', 'error');
  } finally {
    policyForm.inert = false;
    saveButton.disabled = !panelAvailable || !storageAvailable;
  }
});

async function syncClients({ automatic = false } = {}) {
  syncing = true;
  updateSyncAvailability();
  saveButton.disabled = true;
  setMessage(syncStatus, automatic ? 'Đang áp dụng cấu hình mới...' : 'Đang đồng bộ...');
  setSyncProgress(0, 0, true);
  let cursor;
  let afterEmail;
  let batches = 0;
  let processedTotal = 0;
  let totalClients = 0;
  let updatedTotal = 0;
  const failedEmails = new Set();
  try {
    while (true) {
      const result = await request('POST', {
        action: 'sync',
        ...(cursor ? { cursor } : {}),
        ...(afterEmail ? { afterEmail } : {}),
      });
      batches += 1;
      if (Array.isArray(result.errors)) result.errors.forEach((email) => failedEmails.add(email));
      const errorCount = failedEmails.size;
      const processed = Number.isFinite(result.processed) ? result.processed : 0;
      const updated = Number.isFinite(result.updated) ? result.updated : 0;
      processedTotal = processed;
      totalClients = Number.isFinite(result.total) ? result.total : totalClients;
      updatedTotal += updated;
      setSyncProgress(processedTotal, totalClients, true);
      const total = Number.isFinite(result.total) ? `/${result.total}` : '';
      setMessage(syncStatus, `Đợt ${batches}: ${processed}${total} đã kiểm tra, ${updatedTotal} cập nhật${errorCount ? `, ${errorCount} lỗi` : ''}.`);
      if (result.done === true) break;
      if (!result.cursor || result.cursor === cursor) throw new Error('Sync cursor did not advance');
      cursor = result.cursor;
      afterEmail = result.afterEmail;
    }
    const failures = [...failedEmails];
    const failedNames = failures.slice(0, 12).join(', ');
    const more = failures.length > 12 ? ` và ${failures.length - 12} client khác` : '';
    setMessage(syncStatus, `Đồng bộ xong sau ${batches} đợt${failures.length ? `; lỗi: ${failedNames}${more}.` : '.'}`, failures.length ? 'error' : 'success');
  } catch (error) {
    if (error.status === 401) showLogin();
    else setMessage(syncStatus, `Đồng bộ dừng ở đợt ${batches + 1}. Vui lòng thử lại.`, 'error');
  } finally {
    syncing = false;
    updateSyncAvailability();
    saveButton.disabled = !panelAvailable || !storageAvailable;
    await refreshIssuedClients();
  }
}

syncButton.addEventListener('click', () => { void syncClients(); });

webhookButton.addEventListener('click', async () => {
  webhookButton.disabled = true;
  setMessage(webhookStatus, 'Đang đăng ký webhook...');
  try {
    await request('POST', { action: 'registerWebhook' });
    setMessage(webhookStatus, 'Đã đăng ký webhook.', 'success');
  } catch (error) {
    if (error.status === 401) showLogin();
    else setMessage(webhookStatus, 'Không thể đăng ký webhook. Vui lòng thử lại.', 'error');
  } finally {
    webhookButton.disabled = false;
  }
});

loadAdmin();
setInterval(() => { void refreshIssuedClients(); }, 30000);
document.addEventListener('visibilitychange', () => { void refreshIssuedClients(); });

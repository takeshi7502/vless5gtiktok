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
const expiryDaysInput = document.getElementById('expiry-days');
const expiryAtInput = document.getElementById('expiry-at');
const expiryLabel = document.getElementById('expiry-label');
const legacyExpiryModeInput = document.getElementById('legacy-expiry-mode');
const firstUseInput = document.getElementById('first-use');
const trafficResetInput = document.getElementById('traffic-reset');
const monthlyResetDayInput = document.getElementById('monthly-reset-day');
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
const inboundPairs = document.getElementById('inbound-pairs');
const inboundPairStatus = document.getElementById('inbound-pair-status');
const refreshPairsButton = document.getElementById('refresh-inbound-pairs');
const clientSearchForm = document.getElementById('client-search-form');
const clientSearchInput = document.getElementById('client-search-id');
const clientSearchButton = document.getElementById('client-search-button');
const clientDetails = document.getElementById('client-details');
const clientSummary = document.getElementById('client-summary');
const clientRawData = document.getElementById('client-raw-data');
const clientManagerStatus = document.getElementById('client-manager-status');
const deleteClientButton = document.getElementById('delete-client');
const deleteClientDialog = document.getElementById('delete-client-dialog');
const clientManagerLink = document.getElementById('client-manager-link');
let inspectedClient = null;
let clientBusy = false;

let configured = false;
let dirty = false;
let panelAvailable = true;
let storageAvailable = true;
let syncing = false;
let refreshingClients = false;
let legacyExpiryDays = false;
let pairBusy = false;

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
  clientManagerLink.hidden = true;
  clearClientInspection();
  if (deleteClientDialog.open) deleteClientDialog.close('cancel');
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
  clientManagerLink.hidden = false;
  passwordInput.value = '';
}

function showUnavailable() {
  loginSection.hidden = true;
  dashboard.hidden = true;
  logoutButton.hidden = true;
  webhookButton.hidden = true;
  pageStatus.hidden = false;
  pageStatus.textContent =
    'Trang quản trị chưa sẵn sàng. Kiểm tra cấu hình máy chủ rồi tải lại trang.';
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
  try {
    data = await response.json();
  } catch {
    /* A non-JSON error has no public detail. */
  }

  if (!response.ok) {
    const error = new Error(`Yêu cầu không thành công (HTTP ${response.status}).`);
    error.status = response.status;
    if (data.code === 'INBOUND_PAIR') error.pairMessage = data.error;
    if (data.code === 'ADMIN_CLIENT') error.clientMessage = data.error;
    throw error;
  }
  return data;
}

function updateExpiryFields() {
  const duration = firstUseInput.checked || legacyExpiryDays;
  expiryDaysInput.hidden = !duration;
  expiryDaysInput.required = duration;
  expiryDaysInput.disabled = !duration;
  expiryAtInput.hidden = duration;
  expiryAtInput.disabled = duration;
  expiryLabel.textContent = duration ? 'Duration (days)' : 'Expiry';
  expiryLabel.htmlFor = duration ? 'expiry-days' : 'expiry-at';
  expiryLabel.hidden = legacyExpiryDays;
  legacyExpiryModeInput.hidden = !legacyExpiryDays;
  legacyExpiryModeInput.value = 'days';
}

function updateTrafficResetFields() {
  monthlyResetDayInput.disabled = trafficResetInput.value !== 'monthly';
}

function toLocalDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
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
  columns.forEach((column) => {
    column.className = 'inbound-column';
  });
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
  columns
    .filter((column) => column.childElementCount > 0)
    .forEach((column) => inboundList.append(column));
  updateInboundCount();
}

function updateInboundCount() {
  const total = inboundList.querySelectorAll('input[type="checkbox"]').length;
  const selected = inboundList.querySelectorAll('input[type="checkbox"]:checked').length;
  inboundCount.textContent = `${selected}/${total} đã chọn`;
}

function pairButton(label, icon, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary-button pair-button';
  const image = document.createElement('img');
  image.src = `/assets/icons/${icon}.svg`;
  image.alt = '';
  button.append(image, document.createTextNode(label));
  button.addEventListener('click', handler);
  return button;
}

function pairCard(inbound) {
  const card = document.createElement('div');
  card.className = 'inbound-option inbound-pair-card';
  const text = document.createElement('span');
  text.textContent = inbound.remark || `Inbound #${inbound.id}`;
  const details = document.createElement('small');
  details.textContent = inbound.missing
    ? 'Không còn trên panel'
    : `#${inbound.id} · ${inbound.transport} : ${inbound.port} · ${inbound.enabled ? 'Bật' : 'Tắt'}`;
  text.append(details);
  if (inbound.host || inbound.path) {
    const address = document.createElement('small');
    address.textContent = `${inbound.host || ''}${inbound.path || ''}`;
    text.append(address);
  }
  card.append(text);
  return card;
}

function renderInboundPairs(rows) {
  inboundPairs.replaceChildren();
  if (!Array.isArray(rows) || !rows.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-inbounds';
    empty.textContent = 'Không tìm thấy inbound.';
    inboundPairs.append(empty);
    return;
  }
  for (const row of rows) {
    const pair = document.createElement('div');
    pair.className = 'inbound-pair-row';
    pair.dataset.sourceId = row.source.id;
    const left = pairCard(row.source);
    const right = row.ws ? pairCard(row.ws) : document.createElement('div');
    if (!row.ws) right.className = 'inbound-option inbound-pair-card pair-placeholder';
    if (row.ws) {
      const remove = pairButton('Xoá WS', 'trash-2', () => {
        if (
          confirm(
            `Xoá inbound WS “${row.ws.remark}” (#${row.ws.id})? Inbound gốc không bị thay đổi.`,
          )
        ) {
          void mutateInboundPair('deleteWsPair', row.source.id);
        }
      });
      remove.classList.add('danger-button');
      right.append(remove);
    } else if (row.canCreate) {
      const field = document.createElement('div');
      field.className = 'pair-port-field';
      const label = document.createElement('label');
      label.htmlFor = `ws-port-${row.source.id}`;
      label.textContent = 'Cổng WS';
      const port = document.createElement('input');
      port.id = label.htmlFor;
      port.type = 'number';
      port.min = '1';
      port.max = '65535';
      port.step = '1';
      port.required = true;
      port.value = row.suggestedPort || '';
      port.title = 'Cổng gợi ý chưa bị inbound khác dùng trên cùng node';
      field.append(label, port);
      const create = pairButton('Tạo WS', 'plus', () => {
        if (port.reportValidity())
          void mutateInboundPair('createWsPair', row.source.id, Number(port.value));
      });
      right.append(field, create);
    } else {
      const empty = document.createElement('small');
      empty.textContent = row.source.missing ? 'Không có WS' : 'Không phải inbound XHTTP hỗ trợ';
      right.append(empty);
    }
    pair.append(left, right);
    inboundPairs.append(pair);
  }
}

async function loadInboundPairs() {
  if (pairBusy || !panelAvailable || !storageAvailable) return;
  pairBusy = true;
  refreshPairsButton.disabled = true;
  inboundPairs.inert = true;
  inboundPairs.setAttribute('aria-busy', 'true');
  try {
    const data = await request('POST', { action: 'inboundPairs' });
    renderInboundPairs(data.rows);
    setMessage(inboundPairStatus, '');
  } catch (error) {
    if (error.status === 401) showLogin();
    else
      setMessage(
        inboundPairStatus,
        error.pairMessage || 'Không tải được danh sách inbound. Hãy thử lại.',
        'error',
      );
  } finally {
    pairBusy = false;
    refreshPairsButton.disabled = false;
    inboundPairs.inert = false;
    inboundPairs.setAttribute('aria-busy', 'false');
  }
}

async function mutateInboundPair(action, sourceId, port) {
  if (pairBusy) return;
  pairBusy = true;
  refreshPairsButton.disabled = true;
  inboundPairs.inert = true;
  inboundPairs.setAttribute('aria-busy', 'true');
  setMessage(
    inboundPairStatus,
    action === 'createWsPair' ? 'Đang tạo inbound WS...' : 'Đang xoá inbound WS...',
  );
  let completed = false;
  try {
    await request('POST', { action, sourceId, ...(port === undefined ? {} : { port }) });
    completed = true;
  } catch (error) {
    if (error.status === 401) showLogin();
    else
      setMessage(
        inboundPairStatus,
        error.pairMessage || 'Chưa xác nhận được kết quả. Bấm Làm mới trước khi thử lại.',
        'error',
      );
  } finally {
    pairBusy = false;
    refreshPairsButton.disabled = false;
    inboundPairs.inert = false;
    inboundPairs.setAttribute('aria-busy', 'false');
  }
  if (!completed) return;
  await loadInboundPairs();
  try {
    const data = await request();
    if (data.authenticated !== true) return showLogin();
    if (data.panelUnavailable || data.storageUnavailable) throw new Error('Panel unavailable');
    const selected = [...inboundList.querySelectorAll('input:checked')].map((input) =>
      Number(input.value),
    );
    renderInbounds(data.inbounds, selected);
    updateIssuedCount(data.issuedCount);
    setMessage(
      inboundPairStatus,
      action === 'createWsPair' ? 'Đã tạo inbound WS.' : 'Đã xoá inbound WS.',
      'success',
    );
  } catch {
    setMessage(
      inboundPairStatus,
      'Đã thực hiện thao tác; chưa cập nhật được danh sách cấp phát. Hãy tải lại trang.',
      'error',
    );
  }
}

refreshPairsButton.addEventListener('click', () => {
  void loadInboundPairs();
});

function clearClientInspection() {
  inspectedClient = null;
  clientDetails.hidden = true;
  clientSummary.replaceChildren();
  clientRawData.textContent = '';
  deleteClientButton.disabled = true;
}

function clientTrafficBytes(row) {
  const traffic = row && (Object.hasOwn(row, 'traffic') ? row.traffic : row.client?.traffic);
  if (traffic === null) return 0;
  const values = [traffic?.up, traffic?.down].map((value) => {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '')
      return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  });
  const total = values[0] + values[1];
  return values.includes(null) || !Number.isSafeInteger(total) ? null : total;
}

function renderClientInspection(data) {
  inspectedClient = data;
  clientDetails.hidden = false;
  clientSummary.replaceChildren();
  const states = {
    present: 'Có trên panel',
    'redis-only': 'Chỉ còn dữ liệu Redis',
    missing: 'Không còn client trên panel',
    deleting: 'Đang chờ hoàn tất xoá',
  };
  const clients = data.clients || [];
  const latest = clients.at(-1);
  const bytes = clientTrafficBytes(latest);
  const inboundIds = latest?.inboundIds ?? latest?.client.inboundIds;
  const fields = [
    ['ID', clients.map((row) => row.client.email).join(', ') || data.base],
    ['Trạng thái', states[data.status] || data.status],
    ['Telegram ID', data.telegramIds.join(', ') || 'Không còn thông tin'],
    [
      'Tên / Comment',
      latest?.client.comment ||
        data.owners.find((owner) => owner.label)?.label ||
        'Không còn thông tin',
    ],
    ['Dung lượng đã dùng', bytes !== null ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : '—'],
    [
      'Giới hạn dung lượng',
      latest
        ? latest.client.totalGB
          ? `${(latest.client.totalGB / 1024 ** 3).toFixed(2)} GB`
          : 'Không giới hạn'
        : '—',
    ],
    ['Group', latest?.client.group || '—'],
    ['Bật / Tắt', latest ? (latest.client.enable === false ? 'Tắt' : 'Bật') : '—'],
    ['Inbound', inboundIds?.join(', ') || '—'],
    ['Bản ghi Redis liên quan', String(data.redisKeys.length)],
  ];
  for (const [label, value] of fields) {
    const group = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    group.append(term, description);
    clientSummary.append(group);
  }
  clientRawData.textContent = JSON.stringify(
    { clients, owners: data.owners, redisKeys: data.redisKeys },
    null,
    2,
  );
  deleteClientButton.disabled = !data.canDelete;
  deleteClientButton.lastChild.textContent =
    data.status === 'deleting' ? 'Tiếp tục xoá và dọn dữ liệu' : 'Xoá client và dữ liệu';
  setMessage(clientManagerStatus, data.message || '', data.message ? 'error' : '');
}

clientSearchInput.addEventListener('input', clearClientInspection);
clientSearchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (clientBusy) return;
  clearClientInspection();
  clientBusy = true;
  clientSearchButton.disabled = true;
  clientSearchInput.disabled = true;
  setMessage(clientManagerStatus, 'Đang tra cứu panel và Redis...');
  try {
    const data = await request('POST', {
      action: 'inspectClient',
      clientId: clientSearchInput.value,
    });
    if (!dashboard.hidden) renderClientInspection(data);
  } catch (error) {
    if (error.status === 401) showLogin();
    else
      setMessage(
        clientManagerStatus,
        error.clientMessage || 'Không thể tra cứu. Kiểm tra ID và thử lại.',
        'error',
      );
  } finally {
    clientBusy = false;
    clientSearchButton.disabled = false;
    clientSearchInput.disabled = false;
  }
});

deleteClientButton.addEventListener('click', () => {
  if (clientBusy || !inspectedClient?.canDelete) return;
  document.getElementById('delete-client-warning').textContent =
    `Xoá ${inspectedClient.base} cùng các phiên bản cấp lại trên panel và dữ liệu đăng ký trong Redis? Link cũ sẽ mất hiệu lực. Số này sẽ được mở để cấp lại cho người mới.`;
  deleteClientDialog.returnValue = 'cancel';
  deleteClientDialog.showModal();
});

deleteClientDialog.addEventListener('close', async () => {
  if (deleteClientDialog.returnValue !== 'delete' || clientBusy || !inspectedClient?.confirmation)
    return;
  const selected = inspectedClient;
  clientBusy = true;
  clientSearchButton.disabled = true;
  clientSearchInput.disabled = true;
  deleteClientButton.disabled = true;
  setMessage(clientManagerStatus, 'Đang xoá client và dọn dữ liệu...');
  try {
    const result = await request('POST', {
      action: 'deleteClient',
      clientId: selected.base,
      confirmation: selected.confirmation,
    });
    clearClientInspection();
    setMessage(
      clientManagerStatus,
      `Đã xoá ${result.base} và dọn dữ liệu. Lần cấp lại tiếp theo: ${result.nextEmail}.`,
      'success',
    );
    await refreshIssuedClients();
  } catch (error) {
    clearClientInspection();
    if (error.status === 401) showLogin();
    else
      setMessage(
        clientManagerStatus,
        error.clientMessage ||
          'Chưa xác nhận đã xoá xong. Hãy tra cứu lại để tiếp tục; không cần xoá Redis thủ công.',
        'error',
      );
  } finally {
    clientBusy = false;
    clientSearchButton.disabled = false;
    clientSearchInput.disabled = false;
  }
});

function updateIssuedCount(value) {
  issuedCount.textContent = Number.isSafeInteger(value) && value >= 0 ? String(value) : '--';
}

async function refreshIssuedClients() {
  if (dashboard.hidden || document.hidden || syncing || refreshingClients || !storageAvailable)
    return;
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
  policyForm.elements.ipLimit.value = policy.ipLimit ?? 0;
  policyForm.elements.hwidLimit.value = policy.hwidLimit ?? 0;
  firstUseInput.checked = policy.startAfterFirstUse === true;
  // Keep existing creation-relative policies until the operator switches expiry mode.
  legacyExpiryDays = policy.expiryMode === 'days' && !firstUseInput.checked;
  expiryDaysInput.value = policy.expiryDays || 7;
  expiryAtInput.value = toLocalDateTime(policy.expiryAt);
  for (const name of ['autoRenewDays', 'renewOnDay', 'maxRenewals']) {
    policyForm.elements[name].value = policy[name] ?? 0;
  }
  trafficResetInput.value = policy.trafficReset ?? 'never';
  monthlyResetDayInput.value = policy.monthlyResetDay ?? 1;
  policyForm.elements.group.value = policy.group || 'free-web';
  policyForm.elements.subscriptionBaseUrl.value = policy.subscriptionBaseUrl || '';
  updateExpiryFields();
  updateTrafficResetFields();
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
  setMessage(
    issuedStatus,
    panelAvailable ? '' : 'Chưa thể cập nhật số client từ panel.',
    panelAvailable ? '' : 'error',
  );
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
    await loadInboundPairs();
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
    setMessage(
      loginStatus,
      error.status === 401 ? 'Mật khẩu không đúng.' : 'Đăng nhập thất bại. Vui lòng thử lại.',
      'error',
    );
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

firstUseInput.addEventListener('change', () => {
  legacyExpiryDays = false;
  updateExpiryFields();
});
legacyExpiryModeInput.addEventListener('change', () => {
  if (legacyExpiryModeInput.value === 'date') {
    legacyExpiryDays = false;
    updateExpiryFields();
  }
});
trafficResetInput.addEventListener('change', updateTrafficResetFields);
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
  inboundList.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = true;
  });
  markDirty();
});
document.getElementById('clear-all').addEventListener('click', () => {
  inboundList.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = false;
  });
  markDirty();
});

policyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!policyForm.reportValidity()) return;

  const inboundIds = [...inboundList.querySelectorAll('input[type="checkbox"]:checked')].map(
    (input) => Number(input.value),
  );
  if (inboundIds.length === 0) {
    setMessage(policyStatus, 'Hãy chọn ít nhất một inbound.', 'error');
    return;
  }

  const expiryMode =
    firstUseInput.checked || legacyExpiryDays ? 'days' : expiryAtInput.value ? 'date' : 'none';
  const expiryAt = expiryMode === 'date' ? new Date(expiryAtInput.value) : null;
  const renewing =
    Number(policyForm.elements.autoRenewDays.value) > 0 ||
    Number(policyForm.elements.renewOnDay.value) > 0;
  if (expiryAt && (!Number.isFinite(expiryAt.getTime()) || (!renewing && expiryAt <= new Date()))) {
    setMessage(policyStatus, 'Ngày hết hạn phải ở trong tương lai.', 'error');
    return;
  }

  const subscriptionBaseUrl = policyForm.elements.subscriptionBaseUrl.value.trim();
  try {
    const url = new URL(subscriptionBaseUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('/')
    )
      throw new Error('Invalid subscription URL');
  } catch {
    setMessage(policyStatus, 'URL subscription phải dùng HTTPS và kết thúc bằng /.', 'error');
    return;
  }

  const policy = {
    trafficGB: Number(policyForm.elements.trafficGB.value),
    ipLimit: Number(policyForm.elements.ipLimit.value),
    hwidLimit: Number(policyForm.elements.hwidLimit.value),
    startAfterFirstUse: firstUseInput.checked,
    autoRenewDays: Number(policyForm.elements.autoRenewDays.value),
    renewOnDay: Number(policyForm.elements.renewOnDay.value),
    maxRenewals: Number(policyForm.elements.maxRenewals.value),
    trafficReset: trafficResetInput.value,
    monthlyResetDay: Number(monthlyResetDayInput.value),
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
    else
      setMessage(
        policyStatus,
        'Không thể lưu cấu hình. Vui lòng kiểm tra dữ liệu và thử lại.',
        'error',
      );
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
      setMessage(
        syncStatus,
        `Đợt ${batches}: ${processed}${total} đã kiểm tra, ${updatedTotal} cập nhật${errorCount ? `, ${errorCount} lỗi` : ''}.`,
      );
      if (result.done === true) break;
      if (!result.cursor || result.cursor === cursor)
        throw new Error('Sync cursor did not advance');
      cursor = result.cursor;
      afterEmail = result.afterEmail;
    }
    const failures = [...failedEmails];
    const failedNames = failures.slice(0, 12).join(', ');
    const more = failures.length > 12 ? ` và ${failures.length - 12} client khác` : '';
    setMessage(
      syncStatus,
      `Đồng bộ xong sau ${batches} đợt${failures.length ? `; lỗi: ${failedNames}${more}.` : '.'}`,
      failures.length ? 'error' : 'success',
    );
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

syncButton.addEventListener('click', () => {
  void syncClients();
});

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
setInterval(() => {
  void refreshIssuedClients();
}, 30000);
document.addEventListener('visibilitychange', () => {
  void refreshIssuedClients();
});

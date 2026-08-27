const copyButton = document.getElementById('copy-subscription');
const subscriptionUrl = document.getElementById('sub-url');
const statusDot = document.getElementById('server-status-dot');
const statusText = document.getElementById('server-status-text');
const serverLocation = document.getElementById('server-location');
const serverNodes = document.getElementById('server-nodes');
const healthUrl = 'https://5gtiktok-sub.takeshi.dev/health';
const serverInfoUrl = 'https://5gtiktok-sub.takeshi.dev/frp_info.json';
const requestTimeoutMs = 10000;

let isCheckingHealth = false;
let isLoadingServerInfo = false;

async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      // Continue with the legacy clipboard fallback when permission is denied.
    }
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.append(textArea);

  try {
    textArea.select();
    return document.execCommand('copy');
  } catch (error) {
    return false;
  } finally {
    textArea.remove();
  }
}

async function copySubscription() {
  if (!copyButton || !subscriptionUrl) return;

  const didCopy = await copyText(subscriptionUrl.textContent.trim());
  const defaultLabel = 'Copy URL';

  copyButton.textContent = didCopy ? 'Đã copy!' : 'Copy thất bại';
  copyButton.classList.toggle('copied', didCopy);

  window.setTimeout(() => {
    copyButton.textContent = defaultLabel;
    copyButton.classList.remove('copied');
  }, 2000);
}

function setStatus(state, text) {
  if (!statusDot || !statusText) return;

  statusDot.classList.remove('checking', 'online', 'offline', 'pulse-dot');
  statusText.classList.remove('status-text-offline');
  statusDot.classList.add(state);

  if (state === 'online' || state === 'checking') {
    statusDot.classList.add('pulse-dot');
  } else {
    statusText.classList.add('status-text-offline');
  }

  statusText.textContent = text;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    return await fetch(url, { cache: 'no-store', signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function getNodeName(node) {
  const vlessUrl = typeof node === 'string' ? node : node?.url || node?.link || node?.vless || '';

  try {
    const hash = vlessUrl.split('#')[1] || node?.name || 'VLESS Node';
    return decodeURIComponent(hash.replace(/\+/g, ' '));
  } catch (error) {
    return node?.name || 'VLESS Node';
  }
}

function getServerLocation(data) {
  return data.location || data.server_location || data.region || data.country || 'Chưa cập nhật';
}

async function loadServerInfo() {
  if (!serverLocation || !serverNodes || isLoadingServerInfo) return;

  isLoadingServerInfo = true;

  try {
    const response = await fetchWithTimeout(serverInfoUrl);
    if (!response.ok) throw new Error('Server info unavailable');

    const data = await response.json();
    const payloads = Array.isArray(data.payloads)
      ? data.payloads
      : Array.isArray(data.nodes)
        ? data.nodes
        : [];
    const nodeNames = payloads.map(getNodeName).filter(Boolean);

    serverLocation.textContent = getServerLocation(data);
    serverNodes.textContent = nodeNames.length ? nodeNames.join(' • ') : 'Chưa có node';
  } catch (error) {
    serverLocation.textContent = 'Không rõ';
    serverNodes.textContent = 'Không tải được danh sách node';
  } finally {
    isLoadingServerInfo = false;
  }
}

async function checkServerHealth() {
  if (isCheckingHealth) return;

  isCheckingHealth = true;
  setStatus('checking', 'Đang kiểm tra hạ tầng...');

  try {
    const response = await fetchWithTimeout(healthUrl);
    if (!response.ok) throw new Error('Health check failed');

    const data = await response.json();
    setStatus(
      data.online ? 'online' : 'offline',
      data.online ? 'Hạ tầng Cloudflare Anycast đang hoạt động' : 'Hạ tầng tạm thời offline'
    );
  } catch (error) {
    setStatus('offline', 'Không kiểm tra được trạng thái hạ tầng');
  } finally {
    isCheckingHealth = false;
  }
}

if (copyButton && subscriptionUrl) {
  copyButton.addEventListener('click', copySubscription);
}

checkServerHealth();
loadServerInfo();
window.setInterval(checkServerHealth, 60000);
window.setInterval(loadServerInfo, 300000);

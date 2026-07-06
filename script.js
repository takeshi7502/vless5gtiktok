const copyButton = document.getElementById('copy-subscription');
const subscriptionUrl = document.getElementById('sub-url');
const statusDot = document.getElementById('server-status-dot');
const statusText = document.getElementById('server-status-text');
const serverLocation = document.getElementById('server-location');
const serverNodes = document.getElementById('server-nodes');
const healthUrl = 'https://5gtiktok-sub.takeshi.dev/health';
const serverInfoUrl = 'https://5gtiktok-sub.takeshi.dev/frp_info.json';

async function copySubscription() {
  const text = subscriptionUrl.innerText.trim();

  try {
    await navigator.clipboard.writeText(text);
    copyButton.innerText = 'Copied!';
    copyButton.classList.add('copied');
  } catch (error) {
    alert('Không thể sao chép tự động, vui lòng chọn text và copy thủ công.');
    return;
  }

  setTimeout(() => {
    copyButton.innerText = 'Copy URL';
    copyButton.classList.remove('copied');
  }, 2000);
}

function setStatus(state, text) {
  if (!statusDot || !statusText) return;

  statusDot.classList.remove('checking', 'online', 'offline');
  statusText.classList.remove('status-text-offline');

  statusDot.classList.add(state);
  if (state === 'online' || state === 'checking') {
    statusDot.classList.add('pulse-dot');
  } else {
    statusDot.classList.remove('pulse-dot');
    statusText.classList.add('status-text-offline');
  }

  statusText.textContent = text;
}

function getNodeName(vlessUrl) {
  try {
    const hash = vlessUrl.split('#')[1] || 'VLESS Node';
    return decodeURIComponent(hash.replace(/\+/g, ' '));
  } catch (error) {
    return 'VLESS Node';
  }
}

function getServerLocation(data) {
  const location = data.location || data.server_location || data.region || data.country;
  if (location) return location;

  const host = `${data.wshost || ''} ${data.ip || ''}`.toLowerCase();
  if (host.includes('singapore') || host.includes('sin')) return 'Singapore';
  return 'Singapore';
}

async function loadServerInfo() {
  if (!serverLocation || !serverNodes) return;

  try {
    const response = await fetch(serverInfoUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error('Server info unavailable');

    const data = await response.json();
    const payloads = Array.isArray(data.payloads) ? data.payloads : [];
    const nodeNames = payloads.map(getNodeName).filter(Boolean);

    serverLocation.textContent = getServerLocation(data);
    serverNodes.textContent = nodeNames.length ? nodeNames.join(' • ') : 'Chưa có node';
  } catch (error) {
    serverLocation.textContent = 'Không rõ';
    serverNodes.textContent = 'Không tải được danh sách node';
  }
}

async function checkServerHealth() {
  setStatus('checking', 'Đang kiểm tra hạ tầng...');

  try {
    const response = await fetch(healthUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error('Health check failed');

    const data = await response.json();

    if (data.online) {
      setStatus('online', 'Hạ tầng Cloudflare Anycast Active');
    } else {
      setStatus('offline', 'Hạ tầng tạm thời Offline');
    }
  } catch (error) {
    setStatus('offline', 'Không kiểm tra được trạng thái');
  }
}

copyButton.addEventListener('click', copySubscription);
checkServerHealth();
loadServerInfo();
setInterval(checkServerHealth, 60000);
setInterval(loadServerInfo, 300000);

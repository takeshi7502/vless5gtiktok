const copyButton = document.getElementById('copy-subscription');
const subscriptionUrl = document.getElementById('sub-url');
const statusDot = document.getElementById('server-status-dot');
const statusText = document.getElementById('server-status-text');
const healthUrl = 'https://5gtiktok-sub.takeshi.dev/health';

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
setInterval(checkServerHealth, 60000);

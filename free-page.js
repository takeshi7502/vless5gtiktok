const openBotButton = document.getElementById('open-bot');
const retryButton = document.getElementById('retry');
const botStatus = document.getElementById('bot-status');
const statusMessage = document.getElementById('status-message');
const botName = document.getElementById('bot-name');

let botUsername = null;
let ready = false;

function setState(state, message) {
  botStatus.dataset.state = state;
  statusMessage.textContent = message;
  openBotButton.disabled = state !== 'ready';
  retryButton.hidden = state !== 'unavailable';
  botName.hidden = state !== 'ready';
}

async function loadBot() {
  botUsername = null;
  ready = false;
  setState('loading', 'Đang kiểm tra bot...');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch('/api/free/public', {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Bot unavailable');

    const data = await response.json();
    const username = typeof data.botUsername === 'string'
      ? data.botUsername.trim().replace(/^@/, '')
      : '';
    if (data.ready !== true || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) {
      throw new Error('Bot unavailable');
    }

    botUsername = username;
    ready = true;
    botName.textContent = `@${username}`;
    setState('ready', 'Bot đã sẵn sàng. Mở Telegram để tiếp tục.');
  } catch {
    setState('unavailable', 'Chưa thể kết nối bot lúc này. Vui lòng thử lại sau.');
  } finally {
    clearTimeout(timeout);
  }
}

async function openBot() {
  if (!ready || !botUsername) return;
  openBotButton.disabled = true;
  statusMessage.textContent = 'Đang tạo yêu cầu xác minh...';
  try {
    const response = await fetch('/api/free/claim', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.token !== 'string' || !/^[A-Za-z0-9_-]{24,64}$/.test(data.token)) {
      throw new Error(response.status === 429 ? 'rate' : 'unavailable');
    }
    const username = typeof data.botUsername === 'string' ? data.botUsername : botUsername;
    window.location.assign(`https://t.me/${username}?start=c_${data.token}`);
  } catch (error) {
    setState('ready', error.message === 'rate'
      ? 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.'
      : 'Chưa thể tạo yêu cầu lúc này. Vui lòng thử lại sau.');
  }
}

openBotButton.addEventListener('click', () => { void openBot(); });
retryButton.addEventListener('click', loadBot);

loadBot();

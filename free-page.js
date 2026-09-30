const openBotButton = document.getElementById('open-bot');
const retryButton = document.getElementById('retry');
const botStatus = document.getElementById('bot-status');
const statusMessage = document.getElementById('status-message');
const botName = document.getElementById('bot-name');

let botUrl = null;

function setState(state, message) {
  botStatus.dataset.state = state;
  statusMessage.textContent = message;
  openBotButton.disabled = state !== 'ready';
  retryButton.hidden = state !== 'unavailable';
  botName.hidden = state !== 'ready';
}

async function loadBot() {
  botUrl = null;
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

    botUrl = `https://t.me/${username}?start=free`;
    botName.textContent = `@${username}`;
    setState('ready', 'Bot đã sẵn sàng. Mở Telegram để tiếp tục.');
  } catch {
    setState('unavailable', 'Chưa thể kết nối bot lúc này. Vui lòng thử lại sau.');
  } finally {
    clearTimeout(timeout);
  }
}

openBotButton.addEventListener('click', () => {
  if (botUrl) window.location.assign(botUrl);
});
retryButton.addEventListener('click', loadBot);

loadBot();

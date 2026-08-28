const copyButton = document.getElementById('copy-subscription');
const copyLabel = copyButton?.querySelector('[data-copy-label]');
const subscriptionUrl = copyButton?.dataset.subscriptionUrl;
const statusDot = document.getElementById('server-status-dot');
const statusText = document.getElementById('server-status-text');
const serverNodes = document.getElementById('server-nodes');
const serverNodeList = document.getElementById('server-node-list');
const nodePanel = document.querySelector('.node-panel');
const requestTimeoutMs = 10000;
const subscriptionName = 'VLESS 5G TikTok';
const subscriptionDataUrl = '/subscription-source';

let isCheckingServer = false;

async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      // Use the fallback when the browser does not grant Clipboard permission.
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

  const didCopy = await copyText(subscriptionUrl);
  const defaultLabel = 'COPY URL';

  if (copyLabel) {
    copyLabel.textContent = didCopy ? 'ĐÃ COPY' : 'THỬ LẠI';
  }
  copyButton.classList.toggle('copied', didCopy);

  window.setTimeout(() => {
    if (copyLabel) copyLabel.textContent = defaultLabel;
    copyButton.classList.remove('copied');
  }, 2000);
}

function renderNodes(nodeNames) {
  if (!serverNodes) return;

  const names = nodeNames.filter(Boolean);
  serverNodes.textContent = `${names.length} node`;
  serverNodes.title = names.join(' • ');
  serverNodes.setAttribute('aria-label', `${names.length} node: ${names.join(', ')}`);

  if (!serverNodeList) return;

  const nodeItems = names.map((name) => {
    const item = document.createElement('li');
    item.textContent = name;
    return item;
  });

  serverNodeList.replaceChildren(...nodeItems);
  serverNodeList.setAttribute('aria-label', `${names.length} node hiện có`);
}

function renderNodeLoadError() {
  if (serverNodes) {
    serverNodes.textContent = 'Không tải được';
    serverNodes.removeAttribute('title');
  }

  if (serverNodeList) {
    serverNodeList.replaceChildren();
    serverNodeList.removeAttribute('aria-label');
  }
}

function decodeSubscription(text) {
  const content = text.trim();

  if (/^(vless|vmess|trojan|ss|hysteria2?|tuic):\/\//im.test(content)) {
    return content;
  }

  try {
    return atob(content.replace(/-/g, '+').replace(/_/g, '/'));
  } catch (error) {
    return content;
  }
}

function getNodeName(link, index) {
  const hash = link.split('#')[1];

  if (!hash) return `Node ${index + 1}`;

  try {
    return decodeURIComponent(hash.replace(/\+/g, ' '));
  } catch (error) {
    return hash;
  }
}

async function loadSubscriptionNodes() {
  if (!subscriptionUrl) return;

  try {
    const response = await fetch(subscriptionDataUrl, {
      cache: 'no-store',
      credentials: 'omit',
    });

    if (!response.ok) throw new Error(`Subscription returned ${response.status}`);

    const links = decodeSubscription(await response.text())
      .split(/\r?\n/)
      .map((link) => link.trim())
      .filter((link) => /^(vless|vmess|trojan|ss|hysteria2?|tuic):\/\//i.test(link));

    if (!links.length) throw new Error('Subscription has no supported nodes');

    renderNodes(links.map(getNodeName));
  } catch (error) {
    renderNodeLoadError();
  }
}

function getClientImportLink(client, url) {
  const encodedUrl = encodeURIComponent(url);
  const encodedName = encodeURIComponent(subscriptionName);

  switch (client) {
    case 'v2raytun':
    case 'v2rayng':
      return `v2rayng://install-config?url=${encodedUrl}`;
    case 'clash':
    case 'nekobox':
      return `clash://install-config?url=${encodedUrl}&name=${encodedName}`;
    case 'surfboard':
      return `surfboard:///install-config?url=${encodedUrl}`;
    case 'clashmeta':
      return `clashmeta://install-config?url=${encodedUrl}&name=${encodedName}`;
    case 'singbox':
      return `sing-box://import-remote-profile?url=${encodedUrl}#${encodedName}`;
    case 'hiddify':
      return `hiddify://import/${url}#${encodedName}`;
    default:
      return '';
  }
}

function hydrateClientLinks() {
  if (!subscriptionUrl) return;

  document.querySelectorAll('[data-client]').forEach((client) => {
    const link = getClientImportLink(client.dataset.client, subscriptionUrl);
    if (link) client.href = link;
  });
}

function setStatus(state, text) {
  if (!statusDot || !statusText) return;

  statusDot.classList.remove('checking', 'online', 'offline', 'pulse-dot');
  statusText.classList.remove('status-text-offline');
  statusDot.classList.add(state);
  nodePanel?.classList.toggle('is-online', state === 'online');

  if (state === 'online' || state === 'checking') {
    statusDot.classList.add('pulse-dot');
  } else {
    statusText.classList.add('status-text-offline');
  }

  statusText.textContent = text;
}

async function pingSubscriptionUrl() {
  if (!subscriptionUrl || isCheckingServer) return;

  isCheckingServer = true;
  setStatus('checking', 'Đang ping link đăng ký...');

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    // no-cors is intentional: this checks network reachability, not the response payload.
    await fetch(subscriptionUrl, {
      cache: 'no-store',
      credentials: 'omit',
      mode: 'no-cors',
      signal: controller.signal,
    });
    setStatus('online', 'Máy chủ đang trực tuyến');
  } catch (error) {
    setStatus('offline', 'Không kết nối được tới máy chủ');
  } finally {
    window.clearTimeout(timeout);
    isCheckingServer = false;
  }
}

if (copyButton && subscriptionUrl) {
  copyButton.addEventListener('click', copySubscription);
}

hydrateClientLinks();
pingSubscriptionUrl();
loadSubscriptionNodes();
window.setInterval(pingSubscriptionUrl, 60000);
window.setInterval(loadSubscriptionNodes, 300000);

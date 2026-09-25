const copyButton = document.getElementById('copy-subscription');
const copyLabel = copyButton?.querySelector('[data-copy-label]');
const subscriptionUrlElement = document.getElementById('sub-url');
const commandCopyButtons = document.querySelectorAll('[data-copy-command]');
const setupModeButtons = document.querySelectorAll('[data-setup-mode]');
const setupModeGuides = document.querySelectorAll('[data-setup-guide]');
const hostTypeButtons = document.querySelectorAll('[data-host-type]');
const hostGuidePanels = document.querySelectorAll('[data-host-guide]');
const clientPlatformTabs = document.querySelectorAll('[data-client-platform]');
const clientPlatformPanels = document.querySelectorAll('[data-client-platform-panel]');
const clientPlatformStatus = document.getElementById('client-platform-status');
const setupGithubLink = document.querySelector('.setup-github-link');
const statusDot = document.getElementById('server-status-dot');
const statusText = document.getElementById('server-status-text');
const serverNodes = document.getElementById('server-nodes');
const serverNodeList = document.getElementById('server-node-list');
const nodeTable = document.querySelector('.node-table');
const nodeQuotaText = document.getElementById('node-quota-text');
const nodeQuotaProgress = document.getElementById('node-quota-progress');
const nodeExpiry = document.getElementById('node-expiry');
const nodePanel = document.querySelector('.node-panel');
const nodeTooltipTriggers = document.querySelectorAll('.node-tooltip[data-tooltip]');
const nodeTooltipPopover = document.getElementById('node-tooltip-popover');
const requestTimeoutMs = 10000;
const subscriptionName = 'VLESS 5G TikTok';
const subscriptionDataUrl = '/subscription-source';
const nodeMetadataUrl = './node-metadata.json';
const signalUrlFrames = ['▂', '▂▃', '▂▃▄', '▂▃▄▅', '▃▄▅▆', '▄▅▆▇', '▅▆▇█', '▆▇██', '████'];
const defaultDocumentTitle = document.title;
const descriptionMeta = document.querySelector('meta[name="description"]');
const defaultDescription = descriptionMeta?.content;

const localizedElements = [
  { selector: '#page-title', en: 'FREE VLESS SERVER' },
  { selector: '.header-description', en: '4G/5G data for TikTok' },
  { selector: '.connection-panel .panel-kicker', en: 'SUBSCRIPTION LINK (VLESS-WS)' },
  { selector: '#connection-title', en: 'Connection gateway' },
  { selector: '.node-panel', attribute: 'aria-label', en: 'Available node list' },
  { selector: '.node-panel .section-title', en: 'Available nodes' },
  { selector: '#import-title', en: 'Import subscription' },
  { selector: '.client-picker', attribute: 'aria-label', en: 'Clients that support subscription import' },
  { selector: '.connection-panel .import-panel > .import-panel-heading .panel-kicker', en: 'PLATFORM' },
  { selector: '.client-platform-tabs', attribute: 'aria-label', en: 'Choose an app platform' },
  { selector: '.client-platform-tab', en: ['Android', 'iOS', 'Windows', 'MacOS'] },
  { selector: '.client-platform-title', en: ['Android', 'iOS', 'Windows', 'MacOS'] },
  { selector: '.guide-section', attribute: 'aria-label', en: 'Guides' },
  { selector: '#server-setup > details > summary .section-title', en: 'Self-host a private server <span>VLESS-WS</span>' },
  { selector: '#server-setup .host-type-tabs', attribute: 'aria-label', en: 'Choose a self-host method' },
  { selector: '#host-type-no-root strong', en: 'No Root' },
  { selector: '#host-type-no-root small', en: 'VPS, Termux, or Windows' },
  { selector: '#host-type-root strong', en: 'Rooted' },
  { selector: '#host-type-root small', en: 'Android with Xray Server Native' },
  { selector: '#server-setup .setup-summary-copy', en: 'VPS Ubuntu or Termux for Android' },
  { selector: '#server-setup .setup-cta', en: 'OPEN SETUP <span aria-hidden="true">+</span>' },
  { selector: '#server-setup .setup-intro', en: 'Run one command to install git when needed, clone or update the source in <code>~/vless</code>, then open the setup menu.' },
  { selector: '#server-setup .setup-content > h3', en: 'Choose a menu mode' },
  { selector: '#server-setup .setup-mode-grid', attribute: 'aria-label', en: 'Choose a server setup mode' },
  { selector: '#setup-mode-quick .setup-mode-description', en: 'No domain needed, suitable for a quick test. The <code>trycloudflare.com</code> hostname changes after a restart.' },
  { selector: '#setup-mode-named .setup-mode-description', en: 'Fixed domain; requires Cloudflare Zero Trust and a tunnel token.' },
  { selector: '#setup-mode-direct .setup-mode-description', en: 'Fixed domain through Cloudflare DNS proxy; requires an origin on port 80.' },
  { selector: '#setup-guide-quick .setup-guide-heading p', en: 'Quick trial without buying or configuring a domain.' },
  { selector: '#setup-guide-quick .setup-steps li', en: [
    'In the script menu, choose <strong>1 - Quick Tunnel</strong>. Cloudflare provides a temporary <code>*.trycloudflare.com</code> hostname.',
    'The UUID is generated on first setup. Choose Fake SNI: <code>1</code> FreeTiktok, <code>2</code> FreeVina Ko Nen (<code>172.67.168.158</code>), or <code>3</code> both (default).',
    'The path is fixed at <code>/vless</code>; this mode uses WebSocket only. Choose link port <code>1</code> for 80, <code>2</code> for TLS 443 (default), or <code>3</code> for both. Country code is optional.',
    'Linux creates the <code>xray-vless</code> service; VLESS links are saved in <code>frp_info.config</code> with names such as <code>FreeTiktok WS</code>. On Termux, it runs in the foreground; press <code>Ctrl+C</code> to stop it.',
  ] },
  { selector: '#setup-guide-quick .setup-guide-callout', en: '<strong>Note:</strong> the Quick Tunnel hostname changes when the tunnel restarts, so old VLESS links need to be updated.' },
  { selector: '#setup-guide-named .setup-guide-heading p', en: 'Use a fixed domain through Cloudflare Zero Trust.' },
  { selector: '#setup-guide-named .setup-steps li', en: [
    'In Cloudflare Zero Trust, open <strong>Networks -> Tunnels</strong>, create a <strong>Cloudflared</strong> tunnel, then copy its connector token.',
    'Add a <strong>Public Hostname</strong> for the domain and set its service to <code>http://127.0.0.1:8888</code>.',
    'Choose <strong>2 - Named Cloudflare Tunnel</strong> in the script and enter the domain and token. The UUID is generated and the path is fixed at <code>/vless</code>. Choose Fake SNI and WebSocket, xHTTP, or both (default); for xHTTP, choose packet-up (default), stream-up, or stream-one.',
    'Choose link port 80, TLS 443 (default), or both; country code is optional. Cloudflared connects outbound, so no A/AAAA record pointing to the VPS or public Xray port is needed.',
  ] },
  { selector: '#setup-guide-named .setup-guide-callout', en: '<strong>Output:</strong> VLESS links are printed and saved in <code>frp_info.config</code>, with names such as <code>FreeTiktok WS</code> or <code>FreeVina Ko Nen XHTTP</code>. This script does not create a subscription URL.' },
  { selector: '#setup-guide-direct .setup-guide-heading p', en: 'Use a Cloudflare DNS proxy directly to the VPS.' },
  { selector: '#setup-guide-direct .setup-steps li', en: [
    'In Cloudflare DNS, create an <strong>A</strong> record for the domain or subdomain pointing to the VPS IP, and turn on the orange-cloud <strong>Proxied</strong> setting.',
    'In <strong>SSL/TLS</strong>, choose <strong>Flexible</strong> for the script default configuration.',
    'Choose <strong>3 - Direct Cloudflare</strong> and enter the domain. The default origin listens on <code>0.0.0.0:80</code>; the UUID is generated and the path is fixed at <code>/vless</code>. Choose Fake SNI and WebSocket, xHTTP, or both (default); if using xHTTP, select its mode.',
    'Choose link port <code>2</code> for TLS 443 through Cloudflare; Direct mode does not output port-80 links. Country code is optional. Allow TCP <code>80</code> to the origin, preferably only from Cloudflare IP ranges, and confirm that DNS proxying is enabled.',
  ] },
  { selector: '#setup-guide-direct .setup-guide-callout', en: '<strong>Security note:</strong> with Flexible, the Cloudflare-to-VPS leg has no TLS encryption. Use it only on infrastructure you manage and configure origin TLS when needed.' },
  { selector: '#host-guide-root .setup-intro', en: 'Turn a rooted ARM64 Android phone into a private server: 3x-ui and Xray run natively, with a local manager for control.' },
  { selector: '#host-guide-root .root-setup-overview section:nth-child(1) .panel-kicker', en: 'INSTALL MODULE' },
  { selector: '#host-guide-root .root-setup-overview section:nth-child(1) p:last-child', en: 'Download <a href="https://github.com/takeshi7502/Xray_Server_Native/releases/tag/v1.0.0" target="_blank" rel="noopener">Xray Server Native v1.0.0</a>, flash the <code>.zip</code> in Magisk or KernelSU, then restart the phone.' },
  { selector: '#host-guide-root .root-setup-overview section:nth-child(2) .panel-kicker', en: 'LOCAL MANAGER' },
  { selector: '#host-guide-root .root-setup-overview section:nth-child(2) p:last-child', en: 'Open <code>http://127.0.0.1:2036</code> on the phone. From there, open 3x-ui, copy its password, and control the tunnel.' },
  { selector: '#host-guide-root > h3', en: ['Choose the right mode', 'Set up each mode'] },
  { selector: '#host-guide-root .root-mode-card .root-mode-name', en: ['Quick Tunnel', 'Custom domain', '3x-ui Tunnel'] },
  { selector: '#host-guide-root .root-mode-card .root-mode-copy', en: [
    'Creates a temporary <code>trycloudflare.com</code> link for native Xray. Use it to test before you own a domain.',
    'Uses a Cloudflare Named Tunnel and your domain to publish VLESS from native Xray.',
    'Uses 3x-ui to manage clients, traffic, and expiry through a separate Named Tunnel.',
  ] },
  { selector: '#host-guide-root .root-mode-card .root-mode-meta', en: [
    'No domain · WebSocket · hostname changes after restart',
    'Stable domain · native Xray · local route 8888',
    'Stable domain · 3x-ui · quota and subscriptions',
  ] },
  { selector: '#host-guide-root .root-mode-separation', en: 'Modes 1 and 2 share native Xray, so starting Mode 2 replaces Mode 1. Mode 3 has its own 3x-ui tunnel and does not affect the other two modes.' },
  { selector: '#host-guide-root .root-mode-block h4', en: ['Mode 1 · Quick Tunnel', 'Mode 2 · Custom domain', 'Mode 3 · 3x-ui Tunnel'] },
  { selector: '#host-guide-root [data-root-mode="quick"] > p:not(.setup-guide-callout)', en: 'Use this to confirm that the phone and module work before configuring a domain.' },
  { selector: '#host-guide-root [data-root-mode="quick"] .setup-steps li', en: [
    'Open Local Manager at <code>http://127.0.0.1:2036</code> and select <strong>Mode 1</strong>.',
    'Choose Free TikTok, Free Vina Ko Nen, or both as Fake SNI. Keep the default path unless you need a custom one.',
    'Select <strong>Create Mode 1</strong>, then copy the VLESS link returned and import it into a client app.',
  ] },
  { selector: '#host-guide-root [data-root-mode="quick"] .setup-guide-callout', en: '<strong>Testing only:</strong> the <code>trycloudflare.com</code> hostname changes when the tunnel restarts. This mode is WebSocket-only and does not manage quotas through 3x-ui.' },
  { selector: '#host-guide-root [data-root-mode="named"] > p:not(.setup-guide-callout)', en: 'Use this when native Xray needs a stable hostname but you do not need 3x-ui client management.' },
  { selector: '#host-guide-root [data-root-mode="named"] .setup-steps li', en: [
    'In Cloudflare Zero Trust, create a <strong>Named Tunnel</strong> of type Cloudflared and copy its connector token.',
    'On that tunnel, add a <strong>Public Hostname</strong>, such as <code>vpn.example.com</code>, with an HTTP service to <code>127.0.0.1:8888</code>.',
    'In Local Manager, open <strong>Mode 2</strong> and enter the hostname and connector token.',
    'Choose Fake SNI, 80/443 link ports, WebSocket, xHTTP, or both. Choose an xHTTP mode only when using xHTTP.',
    'Select <strong>Create Mode 2</strong> and import the VLESS link below the form.',
  ] },
  { selector: '#host-guide-root [data-root-mode="named"] .setup-guide-callout', en: '<strong>Important route:</strong> Mode 2 uses only <code>http://127.0.0.1:8888</code>. It needs no router port forwarding, A/AAAA record to the phone, or 8080/2096 routes.' },
  { selector: '#host-guide-root [data-root-mode="panel"] > p:not(.setup-guide-callout)', en: 'Use this mode to share subscriptions or manage traffic, quotas, expiry, and clients from 3x-ui.' },
  { selector: '#host-guide-root .root-route-table', attribute: 'aria-label', en: 'Public Hostname routes required for Mode 3' },
  { selector: '#host-guide-root .root-route-table th', en: ['Hostname', 'Cloudflare service', 'Required'] },
  { selector: '#host-guide-root .root-route-table td:nth-child(1)', en: [
    'VPN, for example <code>vpn.example.com</code>',
    'Subscription, for example <code>sub.example.com</code>',
    'Panel, for example <code>panel.example.com</code>',
  ] },
  { selector: '#host-guide-root .root-route-table td:nth-child(3)', en: ['Yes', 'When sharing a subscription', 'Optional'] },
  { selector: '#host-guide-root [data-root-mode="panel"] .setup-steps li', en: [
    'In Cloudflare Zero Trust, create a <strong>Named Tunnel</strong> of type Cloudflared and add the Public Hostnames in the table first.',
    'Open <strong>Mode 3</strong> in Local Manager; enter the VPN and subscription hostnames, an optional panel hostname, then paste the connector token.',
    'Choose Fake SNI, 80/443 link ports, and WS, xHTTP, or both. When choosing xHTTP, also choose an xHTTP mode.',
    'Select <strong>Create Mode 3</strong>. The manager creates the inbound and client in 3x-ui; existing inbounds remain when you create another configuration.',
    'Copy the subscription link into a client app. The manager attaches its extra links to the 3x-ui client; keep managing quotas, expiry, and users in 3x-ui.',
  ] },
  { selector: '#host-guide-root [data-root-mode="panel"] .setup-guide-callout', en: '<strong>Security:</strong> do not enable Cloudflare Access for VPN or subscription hostnames because client apps cannot authenticate to Access. If the panel is public, protect only its hostname with Access and still prefer the local panel.' },
  { selector: '#server-setup .setup-note', en: 'This proof of concept is for learning purposes. It does not guarantee zero-rating, free data, or the ability to bypass carrier limits.' },
  { selector: '#operating-principle .section-title', en: 'How it works <span>(Bandwidth bypass)</span>' },
  { selector: '#operating-principle p', en: '<strong>In simple terms:</strong> When a TikTok plan allows traffic for that app, the server is presented as TikTok traffic. The VPN client wraps your traffic before sending it to the VLESS server, which then connects to the requested destination.' },
  { selector: '#price-comparison .section-title', en: 'Price comparison' },
  { selector: '#price-comparison .summary-hint', en: 'OPEN TABLE' },
  { selector: '#price-comparison .collapsible-content > p', en: 'Conventional data plans often have strict caps and higher costs than TikTok-based options. Plan information is for reference only and can vary by subscriber.' },
  { selector: '#price-comparison .table-container', attribute: 'aria-label', en: 'Carrier plan comparison table' },
  { selector: '#price-comparison thead th', en: [
    'Carrier',
    'Regular 5G plan<br />(price and limit)',
    'TikTok-based plan<br />(price and data)',
  ] },
  { selector: '#price-comparison tbody td:nth-child(2)', en: [
    'Day: ST5K (5k/day, 500MB-1GB)<br />Month: 3MXH100 (160k/month, 1GB/day)<br />Year: 12SD125 (1,500k/year, 5GB/day)',
    'Day: D5 (5k/day, 1GB)<br />Month: BIG90 (90k/month, 7GB high speed then disconnected)',
    'Day: D10 (10k/day, 8GB high speed)<br />Month: HD packages such as 6HD90, about 75k/month for 7GB',
  ] },
  { selector: '#price-comparison tbody td:nth-child(3)', en: [
    '<strong>T50K</strong> (50k -> 50GB/month)<br /><strong>T15KN</strong> (60k -> 100GB/month)<br /><strong>T5K</strong> (150k -> 450GB/month)<br /><strong>MXH100</strong> (100k -> unlimited)',
    '<strong>TK30</strong> (30k/month -> unlimited TikTok data)',
    '<strong>TT1</strong> (3k/day -> unlimited)<br /><strong>DK TIK30</strong> (50k -> 50GB/month)<br /><strong>DK TT80</strong> (80k -> unlimited)',
  ] },
  { selector: '#tiktok-registration .section-title', en: 'Subscribe to a TikTok plan' },
  { selector: '#tiktok-registration .summary-hint', en: 'OPEN GUIDE' },
  { selector: '#tiktok-registration .collapsible-content > p', en: 'To use 5G through the server, subscribe to the TikTok plan that matches your mobile carrier.' },
  { selector: '#tiktok-registration li', en: [
    'Under 50GB/month: text <span class="highlight">T50K</span> to <span class="highlight">191</span> (50k -> 50GB/month).',
    'Under 100GB/month: text <span class="highlight">T15KN</span> to <span class="highlight">191</span> (15k/week -> 25GB/week; 60k/month for 100GB).',
    'Over 100GB/month: text <span class="highlight">T5K</span> to <span class="highlight">191</span> (5k/day -> 15GB/day; 150k/month for 450GB).',
    'Unlimited plan: text <span class="highlight">MXH100</span> to <span class="highlight">191</span> (100k/month -> unlimited TikTok data; availability depends on the subscriber).',
    'Text <span class="highlight">TK30</span> to <span class="highlight">888</span> -> 30k/month for unlimited TikTok data.',
    '<em>Keeping the SIM balance at 0 VND can avoid extra charges:</em> Data 4G/5G -> Data cards -> VinaPhone -> choose the 1.5k/50MB/30-day plan -> Buy now -> Top up.',
    'Text <span class="highlight">DK TIK30</span> to <span class="highlight">9199</span> -> 50k/50GB/month.',
    'Text <span class="highlight">TT1</span> to <span class="highlight">9199</span> -> 3k/day, unlimited TikTok data.',
    'Text <span class="highlight">DK TT80</span> to <span class="highlight">9199</span> -> 80k/month, unlimited TikTok data.',
  ] },
  { selector: '#android-no-root .section-title', en: 'Android <span>No Root</span>' },
  { selector: '#android-no-root li', en: [
    'Install <a href="https://play.google.com/store/apps/details?id=com.v2raytun.android" target="_blank" rel="noopener">v2RayTun from Google Play</a>.',
    'Choose <strong>COPY URL</strong> above.',
    'In v2RayTun, import the configuration from the clipboard and select a node to connect.',
  ] },
  { selector: '#android-root .section-title', en: 'Android <span>Rooted</span>' },
  { selector: '#android-root p', en: '<em>Magic V2Ray is a networking tool for rooted Android devices. It creates a system-wide connection that covers applications on the device.</em>' },
  { selector: '#android-root li', en: [
    'Download the latest <strong>.zip</strong> release from <a href="https://magicv2ray.duckdns.org/" target="_blank" rel="noopener">Magic V2Ray</a>.',
    'Flash the module through Magisk or KernelSU Manager, then restart the device.',
    'Open the local Web UI with the <strong>Action</strong> button in Magisk or KernelSU.',
    'Enter the <strong>Subscription Link</strong>, then choose <strong>Process Connect Link</strong> to load the configuration list.',
  ] },
  { selector: '.footer > div:first-child', en: 'VLESS 5G TikTok <span aria-hidden="true">&bull;</span> Free Gateway <span aria-hidden="true">&bull;</span> Updated by <a href="https://takeshi.dev/" target="_blank" rel="noopener">Takeshi.dev</a>' },
  { selector: '.telegram-float', attribute: 'aria-label', en: 'Join the VLESS 4G TikTok Telegram group' },
  { selector: '.telegram-float-label', en: 'Telegram group' },
];

const localizedText = {
  vi: {
    copySuccess: 'ĐÃ COPY',
    copyRetry: 'THỬ LẠI',
    clientCopied: (name) => `Đã sao chép link cho ${name}`,
    clientCopyRetry: 'Không sao chép được link. Thử lại.',
    nodesLoading: 'Đang tải...',
    nodeLoadError: 'Không tải được',
    nodeCount: (count) => `${count} node`,
    nodeSummary: (count, names) => `${count} node: ${names.join(', ')}`,
    nodeList: (count) => `${count} node hiện có`,
    statusChecking: 'Đang ping link đăng ký...',
    statusOnline: 'Máy chủ đang trực tuyến',
    statusOffline: 'Không kết nối được tới máy chủ',
  },
  en: {
    copySuccess: 'COPIED',
    copyRetry: 'RETRY',
    clientCopied: (name) => `Subscription copied for ${name}`,
    clientCopyRetry: 'Could not copy the subscription. Try again.',
    nodesLoading: 'Loading...',
    nodeLoadError: 'Unable to load',
    nodeCount: (count) => `${count} node${count === 1 ? '' : 's'}`,
    nodeSummary: (count, names) => `${count} node${count === 1 ? '' : 's'}: ${names.join(', ')}`,
    nodeList: (count) => `${count} available node${count === 1 ? '' : 's'}`,
    statusChecking: 'Checking subscription link...',
    statusOnline: 'Server is online',
    statusOffline: 'Cannot reach the server',
  },
};

let isCheckingServer = false;
let currentLanguage = 'vi';
let currentServerStatus = 'checking';
let currentNodeState = 'loading';
let currentNodeNames = [];
let currentSubscriptionInfo = null;
let currentNodeMetadata = new Map();
let subscriptionUrl = '';
let signalUrlStep = 0;
const vietnameseContent = new WeakMap();
const copyFeedbackTimers = new WeakMap();
let clientStatusTimer;

function translate(key, ...args) {
  const value = localizedText[currentLanguage][key];
  return typeof value === 'function' ? value(...args) : value;
}

function updateSignalUrl() {
  const isOnline = currentServerStatus === 'online';
  const status = isOnline ? 'ONLINE' : currentServerStatus.toUpperCase();
  const signal = isOnline
    ? signalUrlFrames[signalUrlStep % signalUrlFrames.length]
    : currentServerStatus === 'checking' ? '...' : '----';
  const ping = 12 + (signalUrlStep % 7) * 3;
  signalUrlStep += 1;

  const currentUrl = new URL(window.location.href);
  currentUrl.search = '';
  currentUrl.searchParams.set('status', status);
  currentUrl.searchParams.set('sig', signal);
  currentUrl.searchParams.set('ping', `${ping}ms`);

  try {
    window.history.replaceState(null, '', `${currentUrl.pathname}?${currentUrl.searchParams}${currentUrl.hash}`);
  } catch (error) {
    // History API can be unavailable in embedded or restricted browsers.
  }
}

function startSignalUrlAnimation() {
  updateSignalUrl();
  window.setInterval(updateSignalUrl, 500);
}

function applyStaticTranslations() {
  localizedElements.forEach(({ selector, attribute, en }) => {
    document.querySelectorAll(selector).forEach((element, index) => {
      if (!vietnameseContent.has(element)) {
        vietnameseContent.set(element, attribute ? element.getAttribute(attribute) : element.innerHTML);
      }

      const translatedValue = Array.isArray(en) ? en[index] : en;
      if (translatedValue == null) return;

      if (attribute) {
        element.setAttribute(attribute, currentLanguage === 'en' ? translatedValue : vietnameseContent.get(element));
      } else {
        element.innerHTML = currentLanguage === 'en' ? translatedValue : vietnameseContent.get(element);
      }
    });
  });
}

function updateClientAriaLabels() {
  document.querySelectorAll('[data-client]').forEach((client) => {
    const clientName = client.querySelector('span')?.textContent || 'client';
    client.setAttribute('aria-label', currentLanguage === 'en' ? `Import into ${clientName}` : `Nhập vào ${clientName}`);
  });

  document.querySelectorAll('[data-copy-client]').forEach((client) => {
    const clientName = client.dataset.copyClient || 'client';
    const label = currentLanguage === 'en'
      ? `Copy subscription for ${clientName}`
      : `Sao chép link để nhập vào ${clientName}`;
    client.setAttribute('aria-label', label);
    client.title = label;
  });
}

function applyLanguage(language) {
  currentLanguage = language === 'en' ? 'en' : 'vi';
  document.documentElement.lang = currentLanguage;
  document.title = currentLanguage === 'en' ? 'VLESS 5G TikTok | Gateway' : defaultDocumentTitle;

  if (descriptionMeta) {
    descriptionMeta.content = currentLanguage === 'en'
      ? 'VLESS trial server information for TikTok-based 4G/5G data, infrastructure status, and Android configuration guides.'
      : defaultDescription;
  }

  applyStaticTranslations();
  updateClientAriaLabels();
  updateNodePresentation();
  setStatus(currentServerStatus);
}

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
    copyLabel.textContent = didCopy ? translate('copySuccess') : translate('copyRetry');
  }
  copyButton.classList.toggle('copied', didCopy);
  copyButton.classList.add('is-feedback');
  window.clearTimeout(copyFeedbackTimers.get(copyButton));

  copyFeedbackTimers.set(copyButton, window.setTimeout(() => {
    if (copyLabel) copyLabel.textContent = defaultLabel;
    copyButton.classList.remove('copied', 'is-feedback');
  }, 2000));
}

async function copySetupCommand(button) {
  const command = button.dataset.copyCommand;
  const label = button.querySelector('[data-command-copy-label]');

  if (!command) return;

  const didCopy = await copyText(command);
  if (label) label.textContent = didCopy ? translate('copySuccess') : translate('copyRetry');
  button.classList.toggle('copied', didCopy);
  button.classList.add('is-feedback');
  window.clearTimeout(copyFeedbackTimers.get(button));

  copyFeedbackTimers.set(button, window.setTimeout(() => {
    if (label) label.textContent = 'COPY';
    button.classList.remove('copied', 'is-feedback');
  }, 2000));
}

async function copyClientSubscription(button) {
  if (!subscriptionUrl) return;

  const didCopy = await copyText(subscriptionUrl);
  const clientName = button.dataset.copyClient || 'client';
  if (clientPlatformStatus) {
    clientPlatformStatus.textContent = didCopy
      ? translate('clientCopied', clientName)
      : translate('clientCopyRetry');
  }

  button.classList.toggle('is-feedback', didCopy);
  window.clearTimeout(copyFeedbackTimers.get(button));
  copyFeedbackTimers.set(button, window.setTimeout(() => {
    button.classList.remove('is-feedback');
  }, 900));

  window.clearTimeout(clientStatusTimer);
  clientStatusTimer = window.setTimeout(() => {
    if (clientPlatformStatus) clientPlatformStatus.textContent = '';
  }, 2500);
}

function selectSetupMode(mode) {
  setupModeButtons.forEach((button) => {
    const isSelected = button.dataset.setupMode === mode;
    button.classList.toggle('is-selected', isSelected);
    button.setAttribute('aria-selected', String(isSelected));
    button.tabIndex = isSelected ? 0 : -1;
  });

  setupModeGuides.forEach((guide) => {
    guide.hidden = guide.dataset.setupGuide !== mode;
  });
}

function selectHostGuide(hostType) {
  hostTypeButtons.forEach((button) => {
    const isSelected = button.dataset.hostType === hostType;
    button.classList.toggle('is-selected', isSelected);
    button.setAttribute('aria-selected', String(isSelected));
    button.tabIndex = isSelected ? 0 : -1;

    if (isSelected && setupGithubLink) {
      setupGithubLink.href = button.dataset.hostRepository;
      setupGithubLink.setAttribute('aria-label', currentLanguage === 'en' ? 'Open repository on GitHub' : 'Mở repository trên GitHub');
    }
  });

  hostGuidePanels.forEach((panel) => {
    panel.hidden = panel.dataset.hostGuide !== hostType;
  });
}

function selectClientPlatform(platform) {
  clientPlatformTabs.forEach((button) => {
    const isSelected = button.dataset.clientPlatform === platform;
    button.classList.toggle('is-selected', isSelected);
    button.setAttribute('aria-selected', String(isSelected));
    button.tabIndex = isSelected ? 0 : -1;
  });

  clientPlatformPanels.forEach((panel) => {
    panel.hidden = panel.dataset.clientPlatformPanel !== platform;
  });

  if (clientPlatformStatus) clientPlatformStatus.textContent = '';
}

function showNodeTooltip(trigger) {
  if (!nodeTooltipPopover) return;

  const message = trigger.dataset.tooltip;
  if (!message) return;

  nodeTooltipPopover.textContent = message;
  nodeTooltipPopover.hidden = false;
  nodeTooltipPopover.style.left = '0px';
  nodeTooltipPopover.style.top = '0px';

  const anchorRect = trigger.getBoundingClientRect();
  const headerRect = trigger.closest('th')?.getBoundingClientRect();
  const tooltipRect = nodeTooltipPopover.getBoundingClientRect();
  const viewportPadding = 12;
  const minCenter = (tooltipRect.width / 2) + viewportPadding;
  const maxCenter = window.innerWidth - (tooltipRect.width / 2) - viewportPadding;
  const center = Math.min(maxCenter, Math.max(minCenter, anchorRect.left + (anchorRect.width / 2)));
  const top = Math.max(viewportPadding, (headerRect?.top ?? anchorRect.top) - tooltipRect.height - 8);

  nodeTooltipPopover.style.left = `${center}px`;
  nodeTooltipPopover.style.top = `${top}px`;
}

function hideNodeTooltip() {
  if (nodeTooltipPopover) nodeTooltipPopover.hidden = true;
}

function setupNodeTooltips() {
  nodeTooltipTriggers.forEach((trigger) => {
    trigger.addEventListener('mouseenter', () => showNodeTooltip(trigger));
    trigger.addEventListener('mouseleave', hideNodeTooltip);
    trigger.addEventListener('focus', () => showNodeTooltip(trigger));
    trigger.addEventListener('blur', hideNodeTooltip);
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hideNodeTooltip();
    });
  });

  window.addEventListener('resize', hideNodeTooltip);
  window.addEventListener('scroll', hideNodeTooltip, true);
}

function setupModeNavigation() {
  setupModeButtons.forEach((button, index) => {
    button.addEventListener('click', () => selectSetupMode(button.dataset.setupMode));

    button.addEventListener('keydown', (event) => {
      const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;

      if (!direction) return;

      event.preventDefault();
      const nextIndex = (index + direction + setupModeButtons.length) % setupModeButtons.length;
      const nextButton = setupModeButtons[nextIndex];
      selectSetupMode(nextButton.dataset.setupMode);
      nextButton.focus();
    });
  });
}

function setupHostGuideNavigation() {
  hostTypeButtons.forEach((button, index) => {
    button.addEventListener('click', () => selectHostGuide(button.dataset.hostType));

    button.addEventListener('keydown', (event) => {
      if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;

      event.preventDefault();
      const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = (index + direction + hostTypeButtons.length) % hostTypeButtons.length;
      const nextButton = hostTypeButtons[nextIndex];
      selectHostGuide(nextButton.dataset.hostType);
      nextButton.focus();
    });
  });
}

function setupClientPlatformNavigation() {
  clientPlatformTabs.forEach((button, index) => {
    button.addEventListener('click', () => selectClientPlatform(button.dataset.clientPlatform));

    button.addEventListener('keydown', (event) => {
      if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;

      event.preventDefault();
      const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = (index + direction + clientPlatformTabs.length) % clientPlatformTabs.length;
      const nextButton = clientPlatformTabs[nextIndex];
      selectClientPlatform(nextButton.dataset.clientPlatform);
      nextButton.focus();
    });
  });

  document.querySelectorAll('[data-copy-client]').forEach((button) => {
    button.addEventListener('click', () => copyClientSubscription(button));
  });
}

function formatDataInGb(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '--';

  const value = bytes / (1024 ** 3);
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} GB`;
}

function parseSubscriptionInfo(header) {
  if (!header) return null;

  const values = Object.fromEntries(
    header.split(';').map((entry) => {
      const [key, value] = entry.trim().split('=', 2);
      return [key, Number(value)];
    }),
  );

  if (!Object.values(values).some(Number.isFinite)) return null;

  return {
    upload: Number.isFinite(values.upload) ? values.upload : 0,
    download: Number.isFinite(values.download) ? values.download : 0,
    total: Number.isFinite(values.total) ? values.total : null,
    expire: Number.isFinite(values.expire) ? values.expire : null,
  };
}

function updateNodeSubscriptionInfo() {
  if (!nodeQuotaText || !nodeQuotaProgress || !nodeExpiry) return;

  if (currentNodeState === 'loading') {
    nodeQuotaText.textContent = 'Data: đang tải...';
    nodeExpiry.textContent = 'Hạn: đang tải...';
    nodeQuotaProgress.style.width = '0%';
    return;
  }

  if (!currentSubscriptionInfo) {
    nodeQuotaText.textContent = 'Data: --';
    nodeExpiry.textContent = 'Hạn: --';
    nodeQuotaProgress.style.width = '0%';
    return;
  }

  const { upload, download, total, expire } = currentSubscriptionInfo;
  const used = upload + download;

  if (total == null || total <= 0) {
    nodeQuotaText.textContent = 'Data: không giới hạn';
    nodeQuotaProgress.style.width = '0%';
  } else {
    const percentage = Math.min(100, Math.round((used / total) * 100));
    nodeQuotaText.textContent = `Data: ${formatDataInGb(used)} / ${formatDataInGb(total)}`;
    nodeQuotaProgress.style.width = `${percentage}%`;
  }

  if (expire == null || expire <= 0) {
    nodeExpiry.textContent = 'Hạn: không giới hạn';
    return;
  }

  const date = new Date(expire > 1e11 ? expire : expire * 1000);
  nodeExpiry.textContent = Number.isNaN(date.getTime())
    ? 'Hạn: --'
    : `Hạn: ${new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date)}`;
}

function updateNodePresentation() {
  if (!serverNodes) return;

  updateNodeSubscriptionInfo();

  if (currentNodeState === 'loading') {
    serverNodes.textContent = translate('nodesLoading');
    serverNodes.removeAttribute('title');
    serverNodes.removeAttribute('aria-label');
  } else if (currentNodeState === 'error') {
    serverNodes.textContent = translate('nodeLoadError');
    serverNodes.removeAttribute('title');
    serverNodes.removeAttribute('aria-label');
  } else {
    const names = currentNodeNames;
    serverNodes.textContent = translate('nodeCount', names.length);
    serverNodes.title = names.join(' • ');
    serverNodes.setAttribute('aria-label', translate('nodeSummary', names.length, names));
  }

  if (!serverNodeList) return;

  if (currentNodeState !== 'ready') {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'node-empty';
    cell.colSpan = 5;
    cell.textContent = translate(currentNodeState === 'loading' ? 'nodesLoading' : 'nodeLoadError');
    row.append(cell);
    serverNodeList.replaceChildren(row);
    nodeTable?.removeAttribute('aria-label');
    return;
  }

  const nodeItems = currentNodeNames.map((name, index) => {
    const row = document.createElement('tr');
    const metadata = currentNodeMetadata.get(index + 1) ?? null;

    const indexCell = document.createElement('td');
    indexCell.className = 'node-index';
    indexCell.textContent = String(index + 1);
    const nameCell = document.createElement('td');
    nameCell.className = 'node-name';
    nameCell.textContent = name;

    const warpCell = document.createElement('td');
    const warpCheckbox = document.createElement('input');
    warpCheckbox.className = 'node-capability';
    warpCheckbox.type = 'checkbox';
    warpCheckbox.tabIndex = -1;
    warpCheckbox.setAttribute('aria-readonly', 'true');
    warpCheckbox.title = 'Chưa cập nhật trạng thái WARP';
    warpCheckbox.setAttribute('aria-label', `WARP chưa cập nhật cho ${name}`);
    applyCapabilityMetadata(warpCheckbox, metadata?.warp, 'WARP', name);
    warpCell.append(warpCheckbox);

    const adblockCell = document.createElement('td');
    const adblockCheckbox = document.createElement('input');
    adblockCheckbox.className = 'node-capability';
    adblockCheckbox.type = 'checkbox';
    adblockCheckbox.tabIndex = -1;
    adblockCheckbox.setAttribute('aria-readonly', 'true');
    adblockCheckbox.title = 'Chưa cập nhật trạng thái Adblock';
    adblockCheckbox.setAttribute('aria-label', `Adblock chưa cập nhật cho ${name}`);
    applyCapabilityMetadata(adblockCheckbox, metadata?.adblock, 'Adblock', name);
    adblockCell.append(adblockCheckbox);

    const noteCell = document.createElement('td');
    noteCell.className = 'node-note';
    noteCell.textContent = '—';

    noteCell.textContent = metadata?.note || noteCell.textContent;
    row.append(indexCell, nameCell, warpCell, adblockCell, noteCell);
    return row;
  });

  serverNodeList.replaceChildren(...nodeItems);
  nodeTable?.setAttribute('aria-label', translate('nodeList', currentNodeNames.length));
}

function readCapability(value) {
  if (value === 1 || value === '1' || value === true) return true;
  if (value === 0 || value === '0' || value === false) return false;
  return null;
}

function applyCapabilityMetadata(checkbox, value, label, nodeName) {
  const capability = readCapability(value);
  checkbox.checked = capability === true;
  checkbox.indeterminate = capability == null;
  checkbox.classList.toggle('is-unknown', capability == null);

  if (capability == null) {
    checkbox.title = `Chưa điền trạng thái ${label}`;
    checkbox.setAttribute('aria-label', `${label} chưa điền cho ${nodeName}`);
    return;
  }

  checkbox.title = `${label}: ${capability ? 'Bật' : 'Tắt'}`;
  checkbox.setAttribute('aria-label', `${label} ${capability ? 'bật' : 'tắt'} cho ${nodeName}`);
}

function parseNodeMetadata(payload) {
  if (!Array.isArray(payload?.servers)) return new Map();

  return payload.servers.reduce((metadataBySst, server) => {
    if (!server || typeof server !== 'object') return metadataBySst;

    const sst = Number(server.sst);
    if (!Number.isSafeInteger(sst) || sst < 1) return metadataBySst;

    metadataBySst.set(sst, {
      warp: readCapability(server.warp),
      adblock: readCapability(server.adblock),
      note: typeof server.note === 'string' ? server.note.trim() : '',
    });
    return metadataBySst;
  }, new Map());
}

function configureSubscriptionUrl(payload) {
  const value = typeof payload?.subscription?.url === 'string'
    ? payload.subscription.url.trim()
    : '';

  try {
    const parsedUrl = new URL(value);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Unsupported protocol');
    subscriptionUrl = parsedUrl.href;
  } catch (error) {
    subscriptionUrl = '';
  }

  if (subscriptionUrlElement) {
    subscriptionUrlElement.textContent = subscriptionUrl || '--';
  }

  if (copyButton) {
    copyButton.disabled = !subscriptionUrl;
    copyButton.dataset.subscriptionUrl = subscriptionUrl;
  }
}

async function loadNodeMetadata() {
  try {
    const response = await fetch(nodeMetadataUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Metadata request failed: ${response.status}`);

    const metadata = await response.json();
    configureSubscriptionUrl(metadata);
    currentNodeMetadata = parseNodeMetadata(metadata);
  } catch (error) {
    configureSubscriptionUrl(null);
    currentNodeMetadata = new Map();
  }
}

function renderNodes(nodeNames, subscriptionInfo) {
  currentNodeNames = nodeNames.filter(Boolean);
  currentSubscriptionInfo = subscriptionInfo;
  currentNodeState = 'ready';
  updateNodePresentation();
}

function renderNodeLoadError() {
  currentNodeNames = [];
  currentSubscriptionInfo = null;
  currentNodeState = 'error';
  updateNodePresentation();
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

    const subscriptionInfo = parseSubscriptionInfo(response.headers.get('subscription-userinfo'));
    const links = decodeSubscription(await response.text())
      .split(/\r?\n/)
      .map((link) => link.trim())
      .filter((link) => /^(vless|vmess|trojan|ss|hysteria2?|tuic):\/\//i.test(link));

    if (!links.length) throw new Error('Subscription has no supported nodes');

    renderNodes(links.map(getNodeName), subscriptionInfo);
  } catch (error) {
    renderNodeLoadError();
  }
}

function getClientImportLink(client, url) {
  const encodedUrl = encodeURIComponent(url);
  const encodedName = encodeURIComponent(subscriptionName);

  switch (client) {
    case 'v2raytun':
      return `v2raytun://import/${url}`;
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

function setStatus(state) {
  if (!statusDot || !statusText) return;

  currentServerStatus = state;
  statusDot.classList.remove('checking', 'online', 'offline', 'pulse-dot');
  statusText.classList.remove('status-text-offline');
  statusDot.classList.add(state);
  nodePanel?.classList.toggle('is-online', state === 'online');

  if (state === 'online' || state === 'checking') {
    statusDot.classList.add('pulse-dot');
  } else {
    statusText.classList.add('status-text-offline');
  }

  statusText.textContent = translate(`status${state.charAt(0).toUpperCase()}${state.slice(1)}`);
  updateSignalUrl();
}

async function pingSubscriptionUrl() {
  if (!subscriptionUrl || isCheckingServer) return;

  isCheckingServer = true;
  setStatus('checking');

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
    setStatus('online');
  } catch (error) {
    setStatus('offline');
  } finally {
    window.clearTimeout(timeout);
    isCheckingServer = false;
  }
}

copyButton?.addEventListener('click', copySubscription);

commandCopyButtons.forEach((button) => {
  button.addEventListener('click', () => copySetupCommand(button));
});

setupGithubLink?.addEventListener('click', (event) => event.stopPropagation());
setupGithubLink?.addEventListener('keydown', (event) => event.stopPropagation());

applyLanguage(currentLanguage);
setupNodeTooltips();
setupModeNavigation();
setupHostGuideNavigation();
setupClientPlatformNavigation();
startSignalUrlAnimation();
loadNodeMetadata().then(() => {
  hydrateClientLinks();
  pingSubscriptionUrl();
  return loadSubscriptionNodes();
});
window.setInterval(pingSubscriptionUrl, 60000);
window.setInterval(loadSubscriptionNodes, 300000);

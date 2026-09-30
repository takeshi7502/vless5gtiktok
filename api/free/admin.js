const store = require('../../lib/free-store');
const { readJson, sendJson } = require('../../lib/free-http');
const { authenticated, validPassword, sessionCookie, clearSessionCookie, sameOrigin } = require('../../lib/free-auth');
const { DEFAULT_POLICY, validatePolicy } = require('../../lib/free-policy');
const { syncBatch } = require('../../lib/free-sync');
const { createXuiClient } = require('../../lib/xui');

function adminReady() {
  return Boolean(process.env.FREE_ADMIN_SECRET && process.env.FREE_ADMIN_SECRET.length >= 32);
}

async function registerWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const site = process.env.PUBLIC_SITE_URL;
  if (!token || !secret || !site || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    throw new Error('Telegram webhook configuration is incomplete');
  }
  const url = new URL(site);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('PUBLIC_SITE_URL must be HTTPS');
  }
  url.pathname = '/api/free/webhook';
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: url.toString(),
      secret_token: secret,
      allowed_updates: ['message'],
      max_connections: 1,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error('Telegram rejected the webhook');
}

async function adminData() {
  const data = {
    authenticated: true,
    configured: false,
    policy: DEFAULT_POLICY,
    inbounds: [],
    issuedCount: 0,
    storageUnavailable: false,
  };
  if (!store.configured()) {
    data.storageUnavailable = true;
    return data;
  }
  const savedPolicy = await store.readPolicy();
  data.policy = savedPolicy || DEFAULT_POLICY;
  try { validatePolicy(savedPolicy); data.configured = true; }
  catch { /* policy must be completed before self-service is enabled */ }
  data.issuedCount = (await store.listIssuedEmails()).length;
  try { data.inbounds = await availableInbounds(createXuiClient()); }
  catch { data.panelUnavailable = true; }
  return data;
}

async function availableInbounds(xui) {
  return (await xui.listInboundChoices())
    .filter((inbound) => inbound.enable === true &&
      (inbound.protocol === 'vless' || inbound.protocol === 'vmess'))
    .map(({ id, remark, protocol, port }) => ({ id, remark, protocol, port }));
}

module.exports = async (request, response) => {
  if (!adminReady()) return sendJson(response, 503, { error: 'Admin is not configured' });
  if (request.method === 'GET') {
    if (!authenticated(request)) return sendJson(response, 200, { authenticated: false });
    try { return sendJson(response, 200, await adminData()); }
    catch { return sendJson(response, 503, { error: 'Unable to load admin data' }); }
  }
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' });
  if (!sameOrigin(request)) return sendJson(response, 403, { error: 'Forbidden' });

  let body;
  try { body = await readJson(request); }
  catch { return sendJson(response, 400, { error: 'Invalid request' }); }
  if (body.action === 'login') {
    if (!validPassword(body.password)) return sendJson(response, 401, { error: 'Invalid credentials' });
    return sendJson(response, 200, { authenticated: true }, { 'set-cookie': sessionCookie(request) });
  }
  if (body.action === 'logout') {
    return sendJson(response, 200, { authenticated: false }, { 'set-cookie': clearSessionCookie(request) });
  }
  if (!authenticated(request)) return sendJson(response, 401, { error: 'Unauthorized' });
  if (!store.configured()) return sendJson(response, 503, { error: 'Storage is not configured' });

  try {
    if (body.action === 'save') {
      const policy = validatePolicy(body.policy);
      const xui = createXuiClient();
      const inbounds = await availableInbounds(xui);
      const available = new Set(inbounds.map((inbound) => inbound.id));
      if (policy.inboundIds.some((id) => !available.has(id))) {
        return sendJson(response, 400, { error: 'One or more inbounds are unavailable' });
      }
      const clients = await xui.listClients();
      const maxEmail = clients.reduce((max, row) => {
        const email = row.client?.email || row.email;
        const match = /^#(\d{3,})$/.exec(email || '');
        return match ? Math.max(max, Number(match[1])) : max;
      }, 1);
      await store.seedCounter(maxEmail);
      await store.savePolicy(policy);
      return sendJson(response, 200, { saved: true, policy });
    }
    if (body.action === 'sync') {
      const policy = validatePolicy(await store.readPolicy());
      const cursor = body.cursor === undefined ? 0 : Number(body.cursor);
      return sendJson(response, 200, await syncBatch(policy, createXuiClient(), cursor));
    }
    if (body.action === 'registerWebhook') {
      await registerWebhook();
      return sendJson(response, 200, { registered: true });
    }
    return sendJson(response, 400, { error: 'Unknown action' });
  } catch (error) {
    console.error('[free-web] admin action failed', error.code || error.name || 'Error');
    const validation = error.message?.startsWith('Invalid ') ||
      error.message?.startsWith('Select ') || error.message?.startsWith('Traffic ') ||
      error.message?.startsWith('Expiry ') || error.message?.startsWith('Subscription ');
    return sendJson(response, validation ? 400 : 502, {
      error: validation ? error.message : 'Admin action failed',
    });
  }
};

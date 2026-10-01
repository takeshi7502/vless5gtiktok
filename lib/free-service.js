const store = require('./free-store');
const { validatePolicy } = require('./free-policy');

function botUsername() {
  const value = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim();
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value) ? value : '';
}

function publicSiteUrl() {
  const value = process.env.PUBLIC_SITE_URL;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function testPageUrl() {
  const url = publicSiteUrl();
  if (!url) return null;
  return url.toString();
}

async function serviceStatus() {
  const username = botUsername();
  const configured = store.configured() && Boolean(process.env.TELEGRAM_BOT_TOKEN) &&
    Boolean(process.env.TELEGRAM_WEBHOOK_SECRET) && Boolean(process.env.XUI_ACCESS_URL) &&
    Boolean(process.env.XUI_API_TOKEN) && Boolean(username) && Boolean(publicSiteUrl());
  if (!configured) return { ready: false, botUsername: username };
  try {
    validatePolicy(await store.readPolicy());
    return { ready: true, botUsername: username };
  } catch {
    return { ready: false, botUsername: username };
  }
}

module.exports = { serviceStatus, testPageUrl };

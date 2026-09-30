const { randomBytes } = require('node:crypto');

const SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const GATEWAY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function gatewaySubscriptionBaseUrl() {
  const value = process.env.FREE_GATEWAY_SUBSCRIPTION_BASE_URL;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        !url.pathname.endsWith('/')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function gatewayEnabled() {
  return gatewaySubscriptionBaseUrl() !== null;
}

function validSubscriptionId(value) {
  return typeof value === 'string' && SUBSCRIPTION_ID_PATTERN.test(value);
}

function validGatewayToken(value) {
  return typeof value === 'string' && GATEWAY_TOKEN_PATTERN.test(value);
}

function tokenPathPrefix() {
  const value = String(process.env.FREE_GATEWAY_TOKEN_PATH_PREFIX || '/f/').trim();
  if (!value.startsWith('/') || !value.endsWith('/') || value.includes('//')) {
    throw new Error('Invalid gateway token path prefix');
  }
  return value;
}

function gatewayPublicPort() {
  const value = String(process.env.FREE_GATEWAY_PUBLIC_PORT || '443').trim();
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) {
    throw new Error('Invalid gateway public port');
  }
  return value;
}

function gatewayPublicHost() {
  const value = String(process.env.FREE_GATEWAY_PUBLIC_HOST || '').trim();
  if (!value) return '';
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(value) || value.startsWith('.') || value.endsWith('.')) {
    throw new Error('Invalid gateway public host');
  }
  return value;
}

function gatewayPublicSecurity() {
  const value = String(process.env.FREE_GATEWAY_PUBLIC_SECURITY || '').trim().toLowerCase();
  if (value !== 'none' && value !== 'tls') {
    throw new Error('FREE_GATEWAY_PUBLIC_SECURITY must be tls or none');
  }
  return value;
}

function gatewayPublicSni() {
  const value = String(process.env.FREE_GATEWAY_PUBLIC_SNI || '').trim();
  if (!value) return '';
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(value) || value.startsWith('.') || value.endsWith('.')) {
    throw new Error('Invalid gateway public SNI');
  }
  return value;
}

function createGatewayToken() {
  return randomBytes(24).toString('base64url');
}

function gatewaySubscriptionUrl(subId) {
  if (!validSubscriptionId(subId)) throw new Error('Invalid subscription ID');
  const base = gatewaySubscriptionBaseUrl();
  if (!base) return null;
  // Validate the route configuration before the bot sends a subscription URL.
  gatewayPublicPort();
  gatewayPublicHost();
  gatewayPublicSecurity();
  gatewayPublicSni();
  return `${base}${encodeURIComponent(subId)}`;
}

function subscriptionLines(body) {
  const original = String(body || '').replace(/^\uFEFF/, '').trim();
  if (!original) throw new Error('Subscription is empty');
  if (/^(vless|vmess|trojan|ss|hysteria2?|tuic):\/\//im.test(original)) {
    return original.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  const normalized = original.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) throw new Error('Subscription is not supported');
  const decoded = Buffer.from(normalized, 'base64').toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!/^(vless|vmess|trojan|ss|hysteria2?|tuic):\/\//im.test(decoded)) {
    throw new Error('Subscription is not supported');
  }
  return decoded.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function rewriteWebSocketSubscription(body, token) {
  if (!validGatewayToken(token)) throw new Error('Invalid gateway token');
	const protectedPath = `${tokenPathPrefix()}${token}`;
	const publicPort = gatewayPublicPort();
	const publicHost = gatewayPublicHost();
	const publicSecurity = gatewayPublicSecurity();
	const publicSni = gatewayPublicSni();
  const rewritten = [];
  for (const line of subscriptionLines(body)) {
    let link;
    try { link = new URL(line); } catch { continue; }
    if (link.protocol !== 'vless:' || link.searchParams.get('type')?.toLowerCase() !== 'ws') continue;
    link.searchParams.set('path', protectedPath);
		link.port = publicPort;
		if (publicHost) link.hostname = publicHost;
		link.searchParams.set('security', publicSecurity);
		if (publicSecurity === 'tls') {
			link.searchParams.set('sni', publicSni || link.hostname);
		} else {
			link.searchParams.delete('sni');
			link.searchParams.delete('fp');
			link.searchParams.delete('alpn');
		}
    rewritten.push(link.toString());
  }
  if (rewritten.length === 0) throw new Error('No WebSocket VLESS links are available');
  return Buffer.from(rewritten.join('\n'), 'utf8').toString('base64');
}

module.exports = {
  createGatewayToken,
  gatewayEnabled,
  gatewaySubscriptionUrl,
  gatewayPublicPort,
  gatewayPublicSecurity,
  rewriteWebSocketSubscription,
  validGatewayToken,
  validSubscriptionId,
};

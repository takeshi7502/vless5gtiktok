const GIB = 1024 ** 3;
const CLIENT_MARKER = 'free-web:self-service';
const { gatewayEnabled } = require('./free-gateway');

const DEFAULT_POLICY = Object.freeze({
  trafficGB: 1,
  hwidLimit: 0,
  expiryMode: 'days',
  expiryDays: 7,
  expiryAt: '',
  group: 'free-web',
  inboundIds: [],
  subscriptionBaseUrl: '',
});

function validatePolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid policy');
  }
  const trafficGB = Number(input.trafficGB);
  const hwidLimit = Number(input.hwidLimit);
  const expiryDays = Number(input.expiryDays || 0);
  const expiryMode = input.expiryMode;
  const group = String(input.group || '').trim();
  const inboundIds = input.inboundIds;

  if (!Number.isFinite(trafficGB) || trafficGB < 0 || trafficGB > 100000 ||
      !Number.isSafeInteger(Math.round(trafficGB * GIB))) {
    throw new Error('Traffic limit must be between 0 and 100000 GB');
  }
  if (!Number.isSafeInteger(hwidLimit) || hwidLimit < 0 || hwidLimit > 100) {
    throw new Error('Invalid HWID limit');
  }
  if (!['none', 'days', 'date'].includes(expiryMode)) throw new Error('Invalid expiry mode');
  if (expiryMode === 'days' && (!Number.isSafeInteger(expiryDays) || expiryDays < 1 || expiryDays > 3650)) {
    throw new Error('Expiry days must be between 1 and 3650');
  }
  const expiryAt = expiryMode === 'date' ? String(input.expiryAt || '') : '';
  if (expiryMode === 'date' && (!Number.isFinite(Date.parse(expiryAt)) || Date.parse(expiryAt) <= Date.now())) {
    throw new Error('Expiry date must be in the future');
  }
  if (!/^[\p{L}\p{N} ._-]{1,64}$/u.test(group)) throw new Error('Invalid group');
  if (!Array.isArray(inboundIds) || inboundIds.length === 0 || inboundIds.length > 100 ||
      inboundIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error('Select at least one inbound');
  }

  let subscriptionBaseUrl;
  try {
    const url = new URL(String(input.subscriptionBaseUrl || ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        !url.pathname.endsWith('/')) throw new Error('Invalid URL');
    subscriptionBaseUrl = url.toString();
  } catch {
    throw new Error('Subscription base URL must be HTTPS and end with /');
  }

  return {
    trafficGB,
    hwidLimit,
    expiryMode,
    expiryDays: expiryMode === 'days' ? expiryDays : 0,
    expiryAt,
    group,
    inboundIds: [...new Set(inboundIds)],
    subscriptionBaseUrl,
  };
}

function expiryTime(policy, issuedAt = Date.now()) {
  if (policy.expiryMode === 'none') return 0;
  if (policy.expiryMode === 'date') return Date.parse(policy.expiryAt);
  return issuedAt + policy.expiryDays * 86400000;
}

function managedFields(policy, issuedAt) {
  const fields = {
    totalGB: Math.round(policy.trafficGB * GIB),
    limitHwid: policy.hwidLimit,
    expiryTime: expiryTime(policy, issuedAt),
    group: policy.group,
  };
  // 3x-ui's Fail2ban limit has different last-IP-wins behavior. The gateway
  // owns this rule whenever its subscription endpoint is enabled.
  if (gatewayEnabled()) fields.limitIp = 0;
  return fields;
}

function subscriptionUrl(policy, subId) {
  if (typeof subId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(subId)) {
    throw new Error('Invalid subscription ID');
  }
  return `${policy.subscriptionBaseUrl}${encodeURIComponent(subId)}`;
}

module.exports = {
  CLIENT_MARKER,
  DEFAULT_POLICY,
  validatePolicy,
  expiryTime,
  managedFields,
  subscriptionUrl,
};

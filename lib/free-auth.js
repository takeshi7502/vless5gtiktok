const { createHmac, timingSafeEqual } = require('node:crypto');

const COOKIE_NAME = 'free_web_admin';
const SESSION_SECONDS = 12 * 60 * 60;

function secret() {
  const value = process.env.FREE_ADMIN_SECRET;
  if (!value || value.length < 32) throw new Error('Admin secret is not configured');
  return value;
}

function equal(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function validPassword(password) {
  return typeof password === 'string' && equal(password, secret());
}

function signature(value) {
  return createHmac('sha256', secret()).update(`admin-session:${value}`).digest('base64url');
}

function secureAttribute(request) {
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(request?.headers?.host || '') ? '' : '; Secure';
}

function sessionCookie(request) {
  const expires = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
  const value = `${expires}.${signature(expires)}`;
  return `${COOKIE_NAME}=${value}; Path=/api/free/admin; Max-Age=${SESSION_SECONDS}; HttpOnly${secureAttribute(request)}; SameSite=Strict`;
}

function clearSessionCookie(request) {
  return `${COOKIE_NAME}=; Path=/api/free/admin; Max-Age=0; HttpOnly${secureAttribute(request)}; SameSite=Strict`;
}

function authenticated(request) {
  const cookie = String(request.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!cookie) return false;
  const value = cookie.slice(COOKIE_NAME.length + 1);
  const [expires, mac, extra] = value.split('.');
  if (extra !== undefined || !/^\d{10}$/.test(expires) || !mac) return false;
  if (Number(expires) <= Math.floor(Date.now() / 1000)) return false;
  return equal(mac, signature(expires));
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const host = request.headers.host;
    const loopback = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host || '');
    return url.host === host && (url.protocol === 'https:' || (loopback && url.protocol === 'http:'));
  } catch {
    return false;
  }
}

module.exports = {
  validPassword,
  sessionCookie,
  clearSessionCookie,
  authenticated,
  sameOrigin,
};

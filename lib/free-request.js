function header(request, name) {
  const value = request?.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function requestIp(request) {
  const value = header(request, 'x-vercel-forwarded-for') || header(request, 'x-forwarded-for') ||
    request?.socket?.remoteAddress || 'unknown';
  return String(value).split(',')[0].trim().slice(0, 128) || 'unknown';
}

function retryHeaders(result) {
  return result?.retryAfter ? { 'retry-after': String(result.retryAfter) } : {};
}

module.exports = { requestIp, retryHeaders };

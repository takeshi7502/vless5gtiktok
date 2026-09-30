const DEFAULT_TIMEOUT_MS = 10_000;

class XuiError extends Error {
  constructor(message, { code = 'XUI_ERROR', status } = {}) {
    super(message);
    this.name = 'XuiError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function configuredUrl(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new XuiError(`${name} is required`, { code: 'CONFIG_ERROR' });
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new XuiError(`${name} must be an absolute URL`, { code: 'CONFIG_ERROR' });
  }

  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new XuiError(`${name} must use HTTPS except on loopback`, {
      code: 'CONFIG_ERROR',
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new XuiError(`${name} must not include credentials, a query, or a fragment`, {
      code: 'CONFIG_ERROR',
    });
  }
  return url;
}

function pathSegment(value, name) {
  const text = String(value ?? '');
  if (!text || /[\/\\\s\x00-\x1f\x7f]/.test(text)) {
    throw new XuiError(`${name} contains invalid characters`, { code: 'INVALID_INPUT' });
  }
  return encodeURIComponent(text);
}

function requireArray(value, operation) {
  if (!Array.isArray(value)) {
    throw new XuiError(`Invalid ${operation} response from 3x-ui`, {
      code: 'INVALID_RESPONSE',
    });
  }
  return value;
}

function isMissingClientError(error) {
  return error instanceof XuiError && (
    (error.code === 'HTTP_ERROR' && error.status === 404) ||
    (error.code === 'API_ERROR' && /\b(?:not found|not exist|does not exist)\b/i.test(error.message))
  );
}

function createXuiClient({
  accessUrl = process.env.XUI_ACCESS_URL,
  apiToken = process.env.XUI_API_TOKEN,
  subscriptionBaseUrl = process.env.XUI_SUBSCRIPTION_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const access = configuredUrl(accessUrl, 'XUI_ACCESS_URL');
  if (typeof apiToken !== 'string' || !apiToken.trim()) {
    throw new XuiError('XUI_API_TOKEN is required', { code: 'CONFIG_ERROR' });
  }
  if (typeof fetchImpl !== 'function') {
    throw new XuiError('fetch is unavailable', { code: 'CONFIG_ERROR' });
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new XuiError('timeoutMs must be a positive integer', {
      code: 'CONFIG_ERROR',
    });
  }

  const basePath = access.pathname.replace(/\/+$/, '');
  access.pathname = `${basePath.endsWith('/panel/api') ? basePath : `${basePath}/panel/api`}/`;
  const token = apiToken.trim();

  async function request(method, route, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let data;
    try {
      response = await fetchImpl(new URL(route, access), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: 'error',
      });
      try {
        data = await response.json();
      } catch {
        if (controller.signal.aborted) {
          throw new XuiError('3x-ui request timed out', { code: 'TIMEOUT' });
        }
        throw new XuiError(
          response.ok ? 'Invalid JSON response from 3x-ui' : `3x-ui returned HTTP ${response.status}`,
          { code: response.ok ? 'INVALID_RESPONSE' : 'HTTP_ERROR', status: response.status },
        );
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new XuiError('3x-ui request timed out', { code: 'TIMEOUT' });
      }
      if (error instanceof XuiError) throw error;
      throw new XuiError('Unable to reach 3x-ui', { code: 'NETWORK_ERROR' });
    } finally {
      clearTimeout(timer);
    }

    if (!data || typeof data !== 'object' || typeof data.success !== 'boolean') {
      throw new XuiError('Invalid response envelope from 3x-ui', {
        code: 'INVALID_RESPONSE', status: response.status,
      });
    }
    if (!response.ok || !data.success) {
      const message = typeof data?.msg === 'string' && data.msg.trim()
        ? data.msg.trim()
        : response.ok ? '3x-ui request failed' : `3x-ui returned HTTP ${response.status}`;
      throw new XuiError(message, {
        code: response.ok ? 'API_ERROR' : 'HTTP_ERROR',
        status: response.status,
      });
    }
    return data.obj;
  }

  return {
    async listClients() {
      return requireArray(await request('GET', 'clients/list'), 'clients/list');
    },

    async getClientsByTelegramId(tgId) {
      if ((typeof tgId === 'number' && !Number.isSafeInteger(tgId)) ||
          !/^[1-9]\d*$/.test(String(tgId))) {
        throw new XuiError('tgId must be a positive decimal ID', { code: 'INVALID_INPUT' });
      }
      const id = pathSegment(tgId, 'tgId');
      return requireArray(await request('GET', `clients/get/tgId/${id}`), 'clients/get/tgId');
    },

    async listInboundChoices() {
      return requireArray(await request('GET', 'inbounds/options'), 'inbounds/options');
    },

    async createClient(payload) {
      if (!payload || !payload.client || typeof payload.client !== 'object' ||
          Array.isArray(payload.client) || !Array.isArray(payload.inboundIds)) {
        throw new XuiError('createClient requires { client, inboundIds }', {
          code: 'INVALID_INPUT',
        });
      }
      return request('POST', 'clients/add', payload);
    },

    async getClient(email) {
      let result;
      try {
        result = await request('GET', `clients/get/${pathSegment(email, 'email')}`);
      } catch (error) {
        if (isMissingClientError(error)) {
          throw new XuiError('Client not found', { code: 'NOT_FOUND', status: 404 });
        }
        throw error;
      }
      if (result === null) {
        throw new XuiError('Client not found', { code: 'NOT_FOUND', status: 404 });
      }
      if (!result || typeof result !== 'object' || !result.client) {
        throw new XuiError('Invalid clients/get response from 3x-ui', {
          code: 'INVALID_RESPONSE',
        });
      }
      return result;
    },

    async updateClient(email, client) {
      if (!client || typeof client !== 'object' || Array.isArray(client)) {
        throw new XuiError('updateClient requires a full client object', {
          code: 'INVALID_INPUT',
        });
      }
      return request('POST', `clients/update/${pathSegment(email, 'email')}`, client);
    },

    bulkAttach({ emails, inboundIds } = {}) {
      if (!Array.isArray(emails) || !Array.isArray(inboundIds)) {
        throw new XuiError('bulkAttach requires emails and inboundIds arrays', {
          code: 'INVALID_INPUT',
        });
      }
      return request('POST', 'clients/bulkAttach', { emails, inboundIds });
    },

    bulkDetach({ emails, inboundIds } = {}) {
      if (!Array.isArray(emails) || !Array.isArray(inboundIds)) {
        throw new XuiError('bulkDetach requires emails and inboundIds arrays', {
          code: 'INVALID_INPUT',
        });
      }
      return request('POST', 'clients/bulkDetach', { emails, inboundIds });
    },

    getSubscriptionUrl(subId) {
      const id = pathSegment(subId, 'subId');
      const base = configuredUrl(subscriptionBaseUrl, 'XUI_SUBSCRIPTION_BASE_URL');
      base.pathname = `${base.pathname.replace(/\/+$/, '')}/${id}`;
      return base.toString();
    },
  };
}

module.exports = { createXuiClient, XuiError };

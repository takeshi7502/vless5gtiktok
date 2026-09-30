const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isTelegramWebhookSecretValid,
  parsePrivateStartUpdate,
  sendTelegramMessage,
} = require('../lib/telegram');

function startUpdate(overrides = {}) {
  return {
    update_id: 123,
    message: {
      text: '/start free',
      chat: { type: 'private', id: 456 },
      from: { id: 456, is_bot: false },
    },
    ...overrides,
  };
}

test('webhook secret is required and compared exactly', () => {
  const previous = process.env.TELEGRAM_WEBHOOK_SECRET;
  try {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-value';
    assert.equal(isTelegramWebhookSecretValid('secret-value'), true);
    assert.equal(isTelegramWebhookSecretValid('secret'), false);
    assert.equal(isTelegramWebhookSecretValid('secret-value-extra'), false);
    assert.equal(isTelegramWebhookSecretValid(null), false);
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    assert.equal(isTelegramWebhookSecretValid('secret-value'), false);
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
    else process.env.TELEGRAM_WEBHOOK_SECRET = previous;
  }
});

test('parses private start commands and the numeric Telegram identity', () => {
  assert.deepEqual(parsePrivateStartUpdate(startUpdate()), {
    updateId: '123', telegramUserId: '456', chatId: '456', type: 'web', claimToken: null,
  });
  assert.deepEqual(parsePrivateStartUpdate(startUpdate({
    update_id: '124',
    message: {
      text: ' /start ',
      chat: { type: 'private', id: '456' },
      from: { id: 456, is_bot: false },
    },
  })), { updateId: '124', telegramUserId: '456', chatId: '456', type: 'web', claimToken: null });

  const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz12';
  assert.deepEqual(parsePrivateStartUpdate(startUpdate({ message: {
    text: `/start c_${token}`,
    chat: { type: 'private', id: 456 },
    from: { id: 456, is_bot: false },
  } })), {
    updateId: '123', telegramUserId: '456', chatId: '456', type: 'claim', claimToken: token,
  });
});

test('rejects nonprivate, malformed, and unrelated updates', () => {
  assert.equal(parsePrivateStartUpdate(startUpdate({ message: {
    text: '/start free', chat: { type: 'group', id: 456 }, from: { id: 456, is_bot: false },
  } })), null);
  assert.equal(parsePrivateStartUpdate(startUpdate({ message: {
    text: '/start free', chat: { type: 'private', id: 456 }, from: { id: 789, is_bot: false },
  } })), null);
  assert.equal(parsePrivateStartUpdate(startUpdate({ message: {
    text: '/start free', chat: { type: 'private', id: 456 }, from: { id: 456, is_bot: true },
  } })), null);
  for (const text of ['/start other', '/start free extra', '/help', '/starting']) {
    assert.equal(parsePrivateStartUpdate(startUpdate({ message: {
      text, chat: { type: 'private', id: 456 }, from: { id: 456, is_bot: false },
    } })), null);
  }
  assert.equal(parsePrivateStartUpdate(startUpdate({ message: {
    text: '/start', chat: { type: 'private', id: Number.MAX_SAFE_INTEGER + 1 },
    from: { id: Number.MAX_SAFE_INTEGER + 1, is_bot: false },
  } })), null);
  assert.equal(parsePrivateStartUpdate({ callback_query: {} }), null);
});

test('sends plain text through the Bot API without a live request', async () => {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  try {
    let request;
    const result = await sendTelegramMessage('456', 'Your link: https://example.com/sub', {
      fetchImpl: async (url, init) => {
        request = { url, init };
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
    assert.deepEqual(result, { configured: true, sent: true });
    assert.equal(request.url, 'https://api.telegram.org/bottest-token/sendMessage');
    assert.equal(request.init.method, 'POST');
    assert.deepEqual(JSON.parse(request.init.body), {
      chat_id: '456',
      text: 'Your link: https://example.com/sub',
      disable_web_page_preview: true,
    });
    assert.equal(request.init.signal.aborted, false);
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
  }
});

test('send failures and missing configuration return safe results', async () => {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    assert.deepEqual(await sendTelegramMessage('456', 'hi', {
      fetchImpl: () => { throw new Error('must not fetch'); },
    }), { configured: false, sent: false });

    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    assert.deepEqual(await sendTelegramMessage('bad-id', 'hi', {
      fetchImpl: () => { throw new Error('must not fetch'); },
    }), { configured: true, sent: false });
    assert.deepEqual(await sendTelegramMessage('456', 'hi', {
      fetchImpl: async () => { throw new Error('network with private data'); },
    }), { configured: true, sent: false });
    assert.deepEqual(await sendTelegramMessage('456', 'hi', {
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }), { configured: true, sent: false });
    assert.deepEqual(await sendTelegramMessage('456', 'hi', {
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false }) }),
    }), { configured: true, sent: false });
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
  }
});

test('aborts a stalled Bot API request', async () => {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  try {
    const result = await sendTelegramMessage('456', 'hi', {
      timeoutMs: 5,
      fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    });
    assert.deepEqual(result, { configured: true, sent: false });
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
  }
});

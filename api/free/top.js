const store = require('../../lib/free-store');
const { createXuiClient } = require('../../lib/xui');
const { sendJson } = require('../../lib/free-http');
const { allowRead } = require('../../lib/free-read-guard');
const { cachedRanking } = require('../../lib/free-ranking');

module.exports = async (request, response) => {
  if (request.method !== 'GET')
    return sendJson(response, 405, { error: 'Method not allowed' }, { allow: 'GET' });
  if (!allowRead(request, response, 'ranking', 60)) return;
  if (!store.configured()) return sendJson(response, 503, { error: 'Ranking is unavailable' });
  try {
    const ranking = await cachedRanking(createXuiClient());
    if (!ranking)
      return sendJson(response, 503, { error: 'Ranking is unavailable' }, { 'retry-after': '30' });
    return sendJson(response, 200, ranking, {
      'cache-control': 'public, max-age=0, s-maxage=15',
      'x-robots-tag': 'noindex, nofollow',
    });
  } catch {
    return sendJson(response, 503, { error: 'Ranking is unavailable' }, { 'retry-after': '30' });
  }
};

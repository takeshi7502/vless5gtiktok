const { createHash, randomUUID } = require('node:crypto');
const store = require('./free-store');

class InboundPairError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

function keys() {
  const panel = new URL(process.env.XUI_ACCESS_URL);
  const scope = createHash('sha256')
    .update(`${panel.origin}${panel.pathname.replace(/\/+$/, '')}`)
    .digest('hex')
    .slice(0, 24);
  const pairs = `free-web:v1:inbound-pairs:${scope}`;
  return { pairs, lock: `${pairs}:lock` };
}

function object(value) {
  const result = typeof value === 'string' ? JSON.parse(value) : structuredClone(value);
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Invalid inbound configuration');
  }
  return result;
}

function nodeId(inbound) {
  return inbound.nodeId || null;
}

function portAvailable(inbounds, source, port) {
  // Reserve disabled inbound ports too: enabling them later must remain safe.
  return !inbounds.some((row) => nodeId(row) === nodeId(source) && row.port === port);
}

function suggestedPort(inbounds, source) {
  const tls = object(source.streamSettings).security === 'tls';
  const preferred = tls ? [8443, 2083, 2096, 2087, 2053, 443] : [8080, 8880, 2082, 2086, 2095, 80];
  return preferred.find((port) => portAvailable(inbounds, source, port)) || null;
}

function describe(inbound) {
  const stream = object(inbound.streamSettings);
  const transport = stream.network || 'tcp';
  const settings = stream[`${transport}Settings`] || {};
  return {
    id: inbound.id,
    remark: inbound.remark,
    protocol: inbound.protocol,
    port: inbound.port,
    nodeId: nodeId(inbound),
    enabled: inbound.enable === true,
    transport,
    path: settings.path || '',
    host: settings.host || settings.headers?.Host || '',
  };
}

function eligible(inbound) {
  const stream = object(inbound.streamSettings);
  return (
    ['vless', 'vmess'].includes(inbound.protocol) &&
    stream.network === 'xhttp' &&
    ['tls', 'none', undefined, ''].includes(stream.security) &&
    !inbound.fallbackParent
  );
}

async function records(deps) {
  const values = await deps.command(['HGETALL', keys().pairs]);
  if (!Array.isArray(values) || values.length % 2) throw new Error('Invalid inbound pair records');
  const result = new Map();
  for (let i = 0; i < values.length; i += 2) {
    const record = JSON.parse(values[i + 1]);
    if (
      !Number.isSafeInteger(record.sourceId) ||
      record.sourceId < 1 ||
      String(record.sourceId) !== values[i] ||
      !record.tag?.startsWith(`fw-ws-${record.sourceId}-`) ||
      !/^fw-ws-\d+-[a-f0-9-]{36}$/.test(record.tag)
    ) {
      throw new Error('Invalid inbound pair record');
    }
    result.set(record.sourceId, record);
  }
  return result;
}

function findTarget(inbounds, record) {
  if (!record) return null;
  const matches = inbounds.filter((row) => row.tag === record.tag);
  if (matches.length > 1) throw new InboundPairError('Trùng định danh inbound WS trên panel.');
  const target = matches[0];
  if (!target) return null;
  if (
    nodeId(target) !== record.nodeId ||
    object(target.streamSettings).network !== 'ws' ||
    (record.targetId && record.targetId !== target.id)
  ) {
    throw new InboundPairError(
      'Inbound WS đã thay đổi trên panel. Hãy kiểm tra trực tiếp trên panel.',
    );
  }
  return target;
}

async function saveRecord(record, deps) {
  await deps.command(['HSET', keys().pairs, record.sourceId, JSON.stringify(record)]);
}

async function locked(deps, operation) {
  const owner = randomUUID();
  const { lock } = keys();
  if ((await deps.command(['SET', lock, owner, 'NX', 'EX', 120])) !== 'OK') {
    throw new InboundPairError('Một thao tác inbound đang chạy. Vui lòng thử lại sau.');
  }
  const renew = async () => {
    const renewed = await deps.command([
      'EVAL',
      'if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("EXPIRE", KEYS[1], 120); return 1; end; return 0',
      1,
      lock,
      owner,
    ]);
    if (Number(renewed) !== 1)
      throw new InboundPairError('Phiên thao tác đã hết hạn. Hãy làm mới danh sách inbound.');
  };
  try {
    return await operation(renew);
  } finally {
    await deps
      .command([
        'EVAL',
        'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
        1,
        lock,
        owner,
      ])
      .catch(() => {});
  }
}

function wsPayload(source, port, tag) {
  if (!eligible(source))
    throw new InboundPairError(
      'Inbound nguồn phải là VLESS/VMess XHTTP, không dùng REALITY hoặc fallback.',
      400,
    );
  const stream = object(source.streamSettings);
  const xhttp = stream.xhttpSettings || {};
  if (
    typeof xhttp.path !== 'string' ||
    !xhttp.path.startsWith('/') ||
    /[?#\x00-\x20]/.test(xhttp.path)
  ) {
    throw new InboundPairError(
      'Path XHTTP phải bắt đầu bằng / và không chứa query hoặc khoảng trắng.',
      400,
    );
  }
  stream.network = 'ws';
  stream.wsSettings = { path: `${xhttp.path}ws`, host: xhttp.host || '', headers: {} };
  delete stream.xhttpSettings;
  // WebSocket upgrade needs HTTP/1.1, not XHTTP's possible h2-only ALPN.
  if (stream.security === 'tls' && stream.tlsSettings) stream.tlsSettings.alpn = ['http/1.1'];
  const settings = object(source.settings);
  settings.clients = [];
  const payload = {};
  for (const field of [
    'remark',
    'enable',
    'listen',
    'protocol',
    'total',
    'expiryTime',
    'trafficReset',
    'trafficResetDay',
    'subSortIndex',
    'excludeFromSub',
    'shareAddrStrategy',
    'shareAddr',
    'disableFlow',
  ]) {
    if (source[field] !== undefined) payload[field] = source[field];
  }
  return {
    ...payload,
    remark: `${source.remark || `Inbound #${source.id}`} [WS]`,
    nodeId: nodeId(source),
    port,
    tag,
    settings: JSON.stringify(settings),
    streamSettings: JSON.stringify(stream),
    sniffing: JSON.stringify(object(source.sniffing)),
  };
}

async function listInboundPairs(xui, deps = store) {
  const [inbounds, saved] = await Promise.all([xui.listInbounds(), records(deps)]);
  const generated = new Set([...saved.values()].map((record) => record.tag));
  const rows = inbounds
    .filter((row) => !generated.has(row.tag))
    .map((source) => {
      const record = saved.get(source.id);
      const target = findTarget(inbounds, record);
      return {
        source: describe(source),
        ws: target ? describe(target) : null,
        canCreate: eligible(source),
        suggestedPort: record && !record.targetId ? record.port : suggestedPort(inbounds, source),
      };
    });
  // Keep generated WS visible/deletable even if its source was deleted on the panel.
  for (const record of saved.values()) {
    if (inbounds.some((row) => row.id === record.sourceId)) continue;
    const target = findTarget(inbounds, record);
    if (target)
      rows.push({
        source: {
          id: record.sourceId,
          remark: `Inbound #${record.sourceId} đã xoá`,
          transport: 'xhttp',
          missing: true,
        },
        ws: describe(target),
        canCreate: false,
      });
  }
  return rows.sort((a, b) => a.source.id - b.source.id);
}

async function createWsPair(sourceId, port, xui, deps = store) {
  if (
    !Number.isSafeInteger(sourceId) ||
    sourceId < 1 ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new InboundPairError('ID inbound hoặc cổng WS không hợp lệ.', 400);
  }
  return locked(deps, async (renew) => {
    const inbounds = await xui.listInbounds();
    const source = await xui.getInbound(sourceId);
    if (!source || source.id !== sourceId)
      throw new InboundPairError('Không tìm thấy inbound nguồn.', 404);
    const saved = await records(deps);
    let record = saved.get(sourceId);
    let target = findTarget(inbounds, record);
    if (target) {
      if (!record.targetId) {
        record.targetId = target.id;
        await renew();
        await saveRecord(record, deps);
      }
      return { created: false, ws: describe(target) };
    }
    if (record && !record.targetId && record.nodeId !== nodeId(source)) {
      throw new InboundPairError(
        'Node triển khai đã thay đổi trong lúc tạo WS. Hãy kiểm tra trên panel.',
      );
    }
    if (!portAvailable(inbounds, source, port))
      throw new InboundPairError('Cổng WS đã được inbound khác sử dụng trên cùng node.');
    record =
      record && !record.targetId
        ? record
        : {
            sourceId,
            port,
            nodeId: nodeId(source),
            tag: `fw-ws-${sourceId}-${randomUUID()}`,
            targetId: null,
          };
    record.port = port;
    const payload = wsPayload(source, port, record.tag);
    // Reserve the tag before the panel write so timeouts/retries cannot duplicate an inbound.
    await renew();
    await saveRecord(record, deps);
    await renew();
    try {
      await xui.createInbound(payload);
    } catch (error) {
      target = findTarget(await xui.listInbounds(), record);
      if (!target) throw error;
    }
    target = target || findTarget(await xui.listInbounds(), record);
    if (!target) throw new Error('Created WS inbound is not visible');
    record.targetId = target.id;
    await renew();
    await saveRecord(record, deps);
    return { created: true, ws: describe(target) };
  });
}

async function deleteWsPair(sourceId, xui, deps = store) {
  if (!Number.isSafeInteger(sourceId) || sourceId < 1)
    throw new InboundPairError('ID inbound không hợp lệ.', 400);
  return locked(deps, async (renew) => {
    const saved = await records(deps);
    const record = saved.get(sourceId);
    if (!record) throw new InboundPairError('Không có inbound WS do web tạo cho inbound này.', 404);
    const target = findTarget(await xui.listInbounds(), record);
    if (target) {
      const [policy, clients, full] = await Promise.all([
        deps.readPolicy(),
        xui.listClients(),
        xui.getInbound(target.id),
      ]);
      if (!findTarget([full], record))
        throw new InboundPairError('Định danh inbound WS đã thay đổi trên panel.');
      const attached = object(full.settings).clients;
      if (!Array.isArray(attached) || clients.some((row) => !Array.isArray(row.inboundIds))) {
        throw new Error('Invalid inbound client membership');
      }
      if (
        policy?.inboundIds?.includes(target.id) ||
        clients.some((row) => row.inboundIds?.includes(target.id)) ||
        attached.length > 0
      ) {
        throw new InboundPairError(
          'Inbound WS đang được sử dụng. Bỏ chọn, đồng bộ hoặc gỡ client khỏi inbound trên panel trước khi xoá.',
        );
      }
      await renew();
      await xui.deleteInbound(target.id);
      if (findTarget(await xui.listInbounds(), record))
        throw new Error('WS inbound deletion not confirmed');
    }
    await renew();
    await deps.command(['HDEL', keys().pairs, sourceId]);
    return { deleted: true };
  });
}

module.exports = { InboundPairError, listInboundPairs, createWsPair, deleteWsPair, wsPayload };

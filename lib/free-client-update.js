function updatePayload(record, fields = {}) {
  const payload = {
    email: record.email,
    subId: record.subId,
    security: record.security,
    password: record.password,
    flow: record.flow,
    reverse: record.reverse,
    auth: record.auth,
    privateKey: record.privateKey,
    publicKey: record.publicKey,
    allowedIPs: typeof record.allowedIPs === 'string'
      ? record.allowedIPs.split(',').map((part) => part.trim()).filter(Boolean)
      : record.allowedIPs,
    preSharedKey: record.preSharedKey,
    keepAlive: record.keepAlive || undefined,
    forwardedPorts: record.forwardedPorts,
    secret: record.secret,
    adTag: record.adTag,
    limitIp: record.limitIp,
    totalGB: record.totalGB,
    expiryTime: record.expiryTime,
    limitHwid: record.limitHwid,
    enable: record.enable,
    tgId: record.tgId,
    group: record.group,
    comment: record.comment,
    reset: record.reset,
    resetDay: record.resetDay,
    resetWeekday: record.resetWeekday,
    resetMax: record.resetMax,
    trafficReset: record.trafficReset,
    trafficResetDay: record.trafficResetDay,
    ...fields,
  };
  if (record.uuid) payload.id = record.uuid;
  return payload;
}

module.exports = { updatePayload };

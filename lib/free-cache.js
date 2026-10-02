function createCache({ maxEntries, ttlMs }) {
  const entries = new Map();
  return {
    clear() { entries.clear(); },
    async get(key, load) {
      const current = entries.get(key);
      if (current && (current.pending || current.expiresAt > Date.now())) return current.value;
      entries.delete(key);
      while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      const entry = { pending: true };
      entry.value = Promise.resolve().then(load).then((value) => {
        entry.pending = false;
        entry.expiresAt = Date.now() + ttlMs;
        return value;
      }).catch((error) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      entries.set(key, entry);
      return entry.value;
    },
  };
}

module.exports = { createCache };

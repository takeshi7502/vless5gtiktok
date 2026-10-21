const MAX_CLIENT_NUMBER = 999999999;

function parseClientEmail(value) {
  const match = /^#(\d{3,9})(?:-([1-9]\d{0,8}))?$/.exec(value || '');
  if (!match) return null;
  const number = Number(match[1]);
  const generation = Number(match[2] || 0);
  if (number < 1 || number > MAX_CLIENT_NUMBER) return null;
  return { number, generation, base: `#${String(number).padStart(3, '0')}` };
}

function normalizeClientId(value) {
  const input = typeof value === 'string' ? value.trim().replace(/^#/, '') : '';
  if (!/^\d{1,9}(?:-[1-9]\d{0,8})?$/.test(input)) throw new Error('Invalid client ID');
  const [number, generation] = input.split('-');
  const parsed = parseClientEmail(
    `#${number.padStart(3, '0')}${generation ? `-${generation}` : ''}`,
  );
  if (!parsed) throw new Error('Invalid client ID');
  return parsed;
}

function compareClientEmails(a, b) {
  const left = parseClientEmail(a);
  const right = parseClientEmail(b);
  if (!left || !right) throw new Error('Invalid client ID');
  return left.number - right.number || left.generation - right.generation;
}

module.exports = { MAX_CLIENT_NUMBER, parseClientEmail, normalizeClientId, compareClientEmails };

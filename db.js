const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'data.sqlite');
const db = new Database(dbPath);

function ensureColumn(table, column, definition) {
  const row = db.prepare(`PRAGMA table_info(${table})`).all().find(r => r.name === column);
  if (!row) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

function generateMarriageCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[crypto.randomInt(alphabet.length)];
  }
  return code;
}

function createUniqueMarriageCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = generateMarriageCode();
    const existing = db.prepare('SELECT id FROM users WHERE marriage_code = ?').get(code);
    if (!existing) return code;
  }
  throw new Error('could not create unique marriage code');
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function init() {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      geld INTEGER DEFAULT 50,
      sauerstoff INTEGER DEFAULT 50,
      created_at TEXT
    )`
  ).run();

  ensureColumn('users', 'oxygen_end', 'TEXT');
  ensureColumn('users', 'is_admin', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'marriage_code', 'TEXT');
  ensureColumn('users', 'spouse_id', 'TEXT');

  const usersWithoutMarriageCode = db.prepare('SELECT id FROM users WHERE marriage_code IS NULL OR marriage_code = ?').all('');
  const setMarriageCode = db.prepare('UPDATE users SET marriage_code = ? WHERE id = ?');
  const fillMarriageCodes = db.transaction((rows) => {
    for (const row of rows) {
      setMarriageCode.run(createUniqueMarriageCode(), row.id);
    }
  });
  fillMarriageCodes(usersWithoutMarriageCode);
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_marriage_code ON users(marriage_code) WHERE marriage_code IS NOT NULL').run();

  db.prepare(
    `CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    )`
  ).run();

  // Stable identifier for this DB instance. If the sqlite file gets deleted,
  // a fresh DB will get a new id so clients can safely auto re-register.
  if (!getConfig('db_instance_id')) {
    setConfig('db_instance_id', crypto.randomUUID());
  }

  setConfig('admin_password', 'admin123');
  setConfig('announcement_text', getConfig('announcement_text') || '');
  setConfig('announcement_pause_since', getConfig('announcement_pause_since') || '');
  setConfig('announcement_last_changed_at', getConfig('announcement_last_changed_at') || '');
}

function createUser(id, startingMoney = 0, startingOxygenMinutes = 0, nowOverride = null) {
  const now = nowOverride instanceof Date ? nowOverride : new Date();
  const oxygenEnd = new Date(now.getTime() + startingOxygenMinutes * 60000).toISOString();
  db.prepare(
    'INSERT INTO users (id, geld, sauerstoff, oxygen_end, is_admin, marriage_code, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)'
  ).run(id, startingMoney, startingOxygenMinutes, oxygenEnd, createUniqueMarriageCode(), now.toISOString());
  return getUser(id);
}

function getUser(id) {
  const user = db.prepare(
    `SELECT
      u.id,
      u.geld,
      u.sauerstoff,
      u.oxygen_end,
      u.is_admin,
      u.marriage_code,
      u.spouse_id,
      s.marriage_code AS spouse_marriage_code,
      u.created_at
    FROM users u
    LEFT JOIN users s ON s.id = u.spouse_id
    WHERE u.id = ?`
  ).get(id);
  return user || null;
}

function getUserByMarriageCode(code) {
  if (typeof code !== 'string') return null;
  const normalized = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!normalized) return null;
  const row = db.prepare('SELECT id FROM users WHERE marriage_code = ?').get(normalized);
  return row ? getUser(row.id) : null;
}

function getMoneyParticipantIds(user) {
  if (!user || !user.id) return [];
  if (!user.spouse_id) return [user.id];
  const spouse = db.prepare('SELECT id FROM users WHERE id = ? AND spouse_id = ?').get(user.spouse_id, user.id);
  return spouse ? [user.id, user.spouse_id] : [user.id];
}

function setMoneyForParticipants(ids, amount) {
  const rounded = Math.round(amount);
  const update = db.prepare('UPDATE users SET geld = ? WHERE id = ?');
  for (const id of ids) {
    update.run(rounded, id);
  }
}

function addMoney(id, amount) {
  if (!Number.isFinite(amount)) throw new Error('invalid amount');
  const tx = db.transaction(() => {
    const user = getUser(id);
    if (!user) return null;
    const ids = getMoneyParticipantIds(user);
    setMoneyForParticipants(ids, user.geld + Math.round(amount));
    return getUser(id);
  });
  return tx();
}

function addOxygen(id, minutes = 10, nowOverride = null) {
  const user = getUser(id);
  if (!user) return null;
  const now = nowOverride instanceof Date ? nowOverride : new Date();
  const currentEnd = user.oxygen_end ? new Date(user.oxygen_end) : now;
  const baseline = currentEnd > now ? currentEnd : now;
  const newEnd = new Date(baseline.getTime() + minutes * 60000).toISOString();
  db.prepare('UPDATE users SET oxygen_end = ? WHERE id = ?').run(newEnd, id);
  return getUser(id);
}

function canBuyOxygen(id, cost) {
  const user = getUser(id);
  return user && user.geld >= cost;
}

function buyOxygen(id, minutes = 10, cost = 30, nowOverride = null) {
  const user = getUser(id);
  if (!user) return null;
  if (user.geld < cost) return null;
  const now = nowOverride instanceof Date ? nowOverride : new Date();
  const currentEnd = user.oxygen_end ? new Date(user.oxygen_end) : now;
  const baseline = currentEnd > now ? currentEnd : now;
  const newEnd = new Date(baseline.getTime() + minutes * 60000).toISOString();
  const tx = db.transaction(() => {
    const ids = getMoneyParticipantIds(user);
    setMoneyForParticipants(ids, user.geld - cost);
    db.prepare('UPDATE users SET oxygen_end = ? WHERE id = ?').run(newEnd, id);
  });
  tx();
  return getUser(id);
}

function marryUsers(id, partnerCode) {
  const tx = db.transaction(() => {
    const user = getUser(id);
    const partner = getUserByMarriageCode(partnerCode);
    if (!user) return { error: 'user not found' };
    if (!partner) return { error: 'partner not found' };
    if (user.id === partner.id) return { error: 'cannot marry self' };
    if (user.spouse_id || partner.spouse_id) return { error: 'already married' };

    const sharedMoney = Math.round(user.geld) + Math.round(partner.geld);
    db.prepare('UPDATE users SET spouse_id = ?, geld = ? WHERE id = ?').run(partner.id, sharedMoney, user.id);
    db.prepare('UPDATE users SET spouse_id = ?, geld = ? WHERE id = ?').run(user.id, sharedMoney, partner.id);
    return { user: getUser(id), affectedIds: [user.id, partner.id] };
  });
  return tx();
}

function divorceUser(id) {
  const tx = db.transaction(() => {
    const user = getUser(id);
    if (!user) return { error: 'user not found' };
    if (!user.spouse_id) return { error: 'not married' };

    const partner = getUser(user.spouse_id);
    const sharedMoney = Math.max(0, Math.round(user.geld));
    const userMoney = Math.ceil(sharedMoney / 2);
    const partnerMoney = Math.floor(sharedMoney / 2);

    db.prepare('UPDATE users SET spouse_id = NULL, geld = ? WHERE id = ?').run(userMoney, user.id);
    if (partner) {
      db.prepare('UPDATE users SET spouse_id = NULL, geld = ? WHERE id = ?').run(partnerMoney, partner.id);
    }
    return { user: getUser(id), affectedIds: partner ? [user.id, partner.id] : [user.id] };
  });
  return tx();
}

function shiftAllOxygenEnds(deltaMs) {
  if (!Number.isFinite(deltaMs)) throw new Error('invalid deltaMs');
  const roundedDeltaMs = Math.round(deltaMs);
  if (roundedDeltaMs === 0) return 0;

  const rows = db.prepare('SELECT id, oxygen_end FROM users WHERE oxygen_end IS NOT NULL').all();
  const update = db.prepare('UPDATE users SET oxygen_end = ? WHERE id = ?');

  const tx = db.transaction(() => {
    let changes = 0;
    for (const row of rows) {
      if (!row.oxygen_end) continue;
      const parsed = new Date(row.oxygen_end);
      const time = parsed.getTime();
      if (!Number.isFinite(time)) continue;
      const shifted = new Date(time + roundedDeltaMs).toISOString();
      update.run(shifted, row.id);
      changes += 1;
    }
    return changes;
  });

  return tx();
}

function setAdmin(id) {
  const info = db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(id);
  if (info.changes === 0) return null;
  return getUser(id);
}

function adminPasswordMatches(password) {
  if (typeof password !== 'string') return false;
  const stored = getConfig('admin_password');
  return stored === password;
}

init();

module.exports = {
  db,
  init,
  createUser,
  getUser,
  getUserByMarriageCode,
  addMoney,
  addOxygen,
  canBuyOxygen,
  buyOxygen,
  marryUsers,
  divorceUser,
  shiftAllOxygenEnds,
  setAdmin,
  adminPasswordMatches,
  getConfig,
  setConfig,
};

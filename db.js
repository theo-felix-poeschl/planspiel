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

  db.prepare(
    `CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    )`
  ).run();

  setConfig('admin_password', 'admin123');
  setConfig('announcement_text', getConfig('announcement_text') || '');
}

function createUser(id, startingMoney = 0, startingOxygenMinutes = 0) {
  const now = new Date();
  const oxygenEnd = new Date(now.getTime() + startingOxygenMinutes * 60000).toISOString();
  db.prepare(
    'INSERT INTO users (id, geld, sauerstoff, oxygen_end, is_admin, created_at) VALUES (?, ?, ?, ?, 0, ?)'
  ).run(id, startingMoney, startingOxygenMinutes, oxygenEnd, now.toISOString());
  return getUser(id);
}

function getUser(id) {
  const user = db.prepare('SELECT id, geld, sauerstoff, oxygen_end, is_admin, created_at FROM users WHERE id = ?').get(id);
  return user || null;
}

function addMoney(id, amount) {
  if (!Number.isFinite(amount)) throw new Error('invalid amount');
  const info = db.prepare('UPDATE users SET geld = geld + ? WHERE id = ?').run(Math.round(amount), id);
  if (info.changes === 0) return null;
  return getUser(id);
}

function addOxygen(id, minutes = 10) {
  const user = getUser(id);
  if (!user) return null;
  const now = new Date();
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

function buyOxygen(id, minutes = 10, cost = 30) {
  const user = getUser(id);
  if (!user) return null;
  if (user.geld < cost) return null;
  const now = new Date();
  const currentEnd = user.oxygen_end ? new Date(user.oxygen_end) : now;
  const baseline = currentEnd > now ? currentEnd : now;
  const newEnd = new Date(baseline.getTime() + minutes * 60000).toISOString();
  db.prepare('UPDATE users SET geld = geld - ?, oxygen_end = ? WHERE id = ?').run(cost, newEnd, id);
  return getUser(id);
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
  addMoney,
  addOxygen,
  canBuyOxygen,
  buyOxygen,
  setAdmin,
  adminPasswordMatches,
  getConfig,
  setConfig,
};

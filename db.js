const path = require('path');
const Database = require('better-sqlite3');
const dbPath = path.join(__dirname, 'data.sqlite');
const db = new Database(dbPath);

function init() {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      job TEXT,
      geld INTEGER DEFAULT 0,
      sauerstoff INTEGER DEFAULT 0,
      created_at TEXT
    )`
  ).run();

  db.prepare(
    `CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE
    )`
  ).run();

  const jobs = ['Farmer', 'Engineer', 'Scientist', 'Miner', 'Pilot'];
  const insert = db.prepare('INSERT OR IGNORE INTO jobs (name) VALUES (?)');
  db.transaction(() => {
    for (const j of jobs) insert.run(j);
  })();
}

function createUser(id, job) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users (id, job, geld, sauerstoff, created_at) VALUES (?, ?, 0, 0, ?)').run(id, job, now);
  return getUser(id);
}

function getUser(id) {
  return db.prepare('SELECT id, job, geld, sauerstoff, created_at FROM users WHERE id = ?').get(id);
}

function listJobs() {
  return db.prepare('SELECT name FROM jobs').all().map(r => r.name);
}

function addAmount(id, field, amount) {
  if (!['geld', 'sauerstoff'].includes(field)) throw new Error('invalid field');
  const stmt = db.prepare(`UPDATE users SET ${field} = ${field} + ? WHERE id = ?`);
  const info = stmt.run(amount, id);
  if (info.changes === 0) return null;
  return getUser(id);
}

init();

module.exports = { db, init, createUser, getUser, listJobs, addAmount };

const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const config = require('./config.json');
const os = require('os');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function enrichUser(user) {
  if (!user) return null;
  const now = new Date();
  const end = user.oxygen_end ? new Date(user.oxygen_end) : now;
  const remainingMs = Math.max(0, end.getTime() - now.getTime());
  const remainingMinutes = remainingMs / 60000;
  return {
    ...user,
    remaining_ms: remainingMs,
    remaining_minutes: remainingMinutes,
    expired: remainingMs <= 0,
  };
}

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post('/api/register', (req, res) => {
  const id = req.body && req.body.id ? req.body.id : uuidv4();
  let user = db.getUser(id);
  if (!user) {
    user = db.createUser(id, config.startingMoney, config.startingOxygenMinutes);
  }
  res.json({ user: enrichUser(user) });
});

app.get('/api/user/:id', (req, res) => {
  const user = db.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json({ user: enrichUser(user) });
});

app.post('/api/buy-oxygen', (req, res) => {
  const { user: userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'missing user id' });
  const existing = db.getUser(userId);
  if (!existing) return res.status(404).json({ error: 'user not found' });
  if (existing.oxygen_end && new Date(existing.oxygen_end).getTime() <= Date.now()) {
    return res.status(400).json({ error: 'timer expired' });
  }
  const updated = db.buyOxygen(userId, config.oxygenPurchaseMinutes, config.oxygenPurchaseCost);
  if (!updated) return res.status(400).json({ error: 'not enough money' });
  res.json({ user: enrichUser(updated) });
});

function parseQrPayload(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^heilung$/i.test(trimmed)) {
      return { type: 'heal', minutes: config.healCodeMinutes };
    }
    if (/^-?\d+$/.test(trimmed)) {
      return { type: 'money', amount: Number.parseInt(trimmed, 10) };
    }
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return { type: 'money', amount: value };
  }
  return null;
}

app.post('/api/qr-scan', (req, res) => {
  const { user: userId, code } = req.body || {};
  if (!userId || typeof code === 'undefined') return res.status(400).json({ error: 'missing params' });
  const payload = parseQrPayload(code);
  if (!payload) return res.status(400).json({ error: 'invalid qr code' });

  const user = db.getUser(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });

  let updated;
  let message;
  if (payload.type === 'money') {
    updated = db.addMoney(userId, payload.amount);
    message = `€${payload.amount} hinzugefügt.`;
  } else if (payload.type === 'heal') {
    updated = db.addOxygen(userId, payload.minutes);
    message = `${payload.minutes} Minuten Sauerstoff hinzugefügt.`;
  }
  if (!updated) return res.status(400).json({ error: 'operation failed' });
  res.json({ user: enrichUser(updated), message });
});

app.post('/api/admin/login', (req, res) => {
  const { user: userId, password } = req.body || {};
  if (!userId || !password) return res.status(400).json({ error: 'missing user or password' });
  const user = db.getUser(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (!db.adminPasswordMatches(password)) return res.status(401).json({ error: 'invalid password' });
  const updated = db.setAdmin(userId);
  if (!updated) return res.status(500).json({ error: 'could not set admin' });
  res.json({ user: enrichUser(updated) });
});

app.get('/api/announcement', (req, res) => {
  res.json({ announcement: db.getConfig('announcement_text') || '' });
});

app.post('/api/announcement', (req, res) => {
  const { user: userId, text } = req.body || {};
  if (!userId || typeof text !== 'string') return res.status(400).json({ error: 'missing params' });
  const user = db.getUser(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (!user.is_admin) return res.status(403).json({ error: 'admin only' });
  db.setConfig('announcement_text', text);
  res.json({ announcement: text });
});

app.get('/scan', (req, res) => {
  const { user: userId, code } = req.query;
  if (!userId || typeof code === 'undefined') return res.status(400).send('missing params');
  const payload = parseQrPayload(String(code));
  if (!payload) return res.status(400).send('invalid code');

  const user = db.getUser(userId);
  if (!user) return res.status(404).send('user not found');

  let updated;
  if (payload.type === 'money') {
    updated = db.addMoney(userId, payload.amount);
  } else if (payload.type === 'heal') {
    updated = db.addOxygen(userId, payload.minutes);
  }
  if (!updated) return res.status(400).send('operation failed');
  const origin = `${req.protocol}://${req.get('host')}`;
  res.redirect(`${origin}/?user=${encodeURIComponent(userId)}&status=ok`);
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`Accessible at: http://${iface.address}:${PORT}`);
      }
    }
  }});

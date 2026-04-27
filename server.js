const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const config = require('./config.json');
const os = require('os');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Announcement realtime (Server-Sent Events) ---
const announcementClients = new Set();

function getPauseState() {
  const sinceRaw = db.getConfig('announcement_pause_since') || '';
  if (typeof sinceRaw !== 'string' || sinceRaw.trim().length === 0) {
    const announcement = db.getConfig('announcement_text') || '';
    if (announcement.trim().length === 0) return { paused: false, since: null };

    // Backfill for existing announcements: prefer "last changed" timestamp if available.
    const lastChangedRaw = db.getConfig('announcement_last_changed_at') || '';
    let sinceCandidate = null;
    if (typeof lastChangedRaw === 'string' && lastChangedRaw.trim().length > 0) {
      const parsed = new Date(lastChangedRaw);
      if (Number.isFinite(parsed.getTime())) sinceCandidate = parsed;
    }

    const fallback = new Date();
    const since = sinceCandidate || fallback;
    db.setConfig('announcement_pause_since', since.toISOString());
    return { paused: true, since };
  }
  const since = new Date(sinceRaw);
  if (!Number.isFinite(since.getTime())) return { paused: false, since: null };
  return { paused: true, since };
}

function getEffectiveNow(pauseState) {
  return pauseState && pauseState.paused ? pauseState.since : new Date();
}

function formatSseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcastAnnouncement(payload) {
  const formatted = formatSseEvent('announcement', payload);
  for (const client of announcementClients) {
    try {
      client.res.write(formatted);
    } catch {
      announcementClients.delete(client);
      try { client.res.end(); } catch {}
      if (client.keepAlive) clearInterval(client.keepAlive);
    }
  }
}

function enrichUser(user, pauseState) {
  if (!user) return null;
  const now = getEffectiveNow(pauseState);
  const end = user.oxygen_end ? new Date(user.oxygen_end) : now;
  const remainingMs = Math.max(0, end.getTime() - now.getTime());
  const remainingMinutes = remainingMs / 60000;
  return {
    ...user,
    remaining_ms: remainingMs,
    remaining_minutes: remainingMinutes,
    expired: remainingMs <= 0,
    paused: Boolean(pauseState && pauseState.paused),
  };
}

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), db_instance_id: db.getConfig('db_instance_id') || '' });
});

app.get('/api/config', (req, res) => {
  res.json({
    oxygenPurchaseMinutes: config.oxygenPurchaseMinutes,
    oxygenPurchaseCost: config.oxygenPurchaseCost,
    healCodeMinutes: config.healCodeMinutes,
    startingMoney: config.startingMoney,
    startingOxygenMinutes: config.startingOxygenMinutes,
  });
});

app.post('/api/register', (req, res) => {
  const pauseState = getPauseState();
  const effectiveNow = getEffectiveNow(pauseState);
  const id = req.body && req.body.id ? req.body.id : uuidv4();
  let user = db.getUser(id);
  if (!user) {
    user = db.createUser(id, config.startingMoney, config.startingOxygenMinutes, effectiveNow);
  }
  res.json({ user: enrichUser(user, pauseState), db_instance_id: db.getConfig('db_instance_id') || '' });
});

app.get('/api/user/:id', (req, res) => {
  const pauseState = getPauseState();
  const user = db.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json({ user: enrichUser(user, pauseState) });
});

app.post('/api/buy-oxygen', (req, res) => {
  const pauseState = getPauseState();
  const effectiveNow = getEffectiveNow(pauseState);
  const { user: userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'missing user id' });
  const existing = db.getUser(userId);
  if (!existing) return res.status(404).json({ error: 'user not found' });
  if (existing.oxygen_end && new Date(existing.oxygen_end).getTime() <= effectiveNow.getTime()) {
    return res.status(400).json({ error: 'timer expired' });
  }
  const updated = db.buyOxygen(userId, config.oxygenPurchaseMinutes, config.oxygenPurchaseCost, effectiveNow);
  if (!updated) return res.status(400).json({ error: 'not enough money' });
  res.json({ user: enrichUser(updated, pauseState) });
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
  const pauseState = getPauseState();
  const effectiveNow = getEffectiveNow(pauseState);
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
    updated = db.addOxygen(userId, payload.minutes, effectiveNow);
    message = `${payload.minutes} Minuten Sauerstoff hinzugefügt.`;
  }
  if (!updated) return res.status(400).json({ error: 'operation failed' });
  res.json({ user: enrichUser(updated, pauseState), message });
});

app.post('/api/admin/login', (req, res) => {
  const pauseState = getPauseState();
  const { user: userId, password } = req.body || {};
  if (!userId || !password) return res.status(400).json({ error: 'missing user or password' });
  const user = db.getUser(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (!db.adminPasswordMatches(password)) return res.status(401).json({ error: 'invalid password' });
  const updated = db.setAdmin(userId);
  if (!updated) return res.status(500).json({ error: 'could not set admin' });
  res.json({ user: enrichUser(updated, pauseState) });
});

app.get('/api/announcement', (req, res) => {
  const announcement = db.getConfig('announcement_text') || '';
  const pauseState = getPauseState();
  res.json({
    announcement,
    paused: announcement.trim().length > 0,
    pause_since: pauseState.paused && pauseState.since ? pauseState.since.toISOString() : '',
  });
});

app.get('/api/announcement/stream', (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Prevent proxy buffering where supported (e.g. nginx).
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const client = { res, keepAlive: null };
  announcementClients.add(client);

  // Send current value immediately so reconnects have state.
  const current = db.getConfig('announcement_text') || '';
  const pauseState = getPauseState();
  res.write(formatSseEvent('announcement', {
    announcement: current,
    paused: current.trim().length > 0,
    pause_since: pauseState.paused && pauseState.since ? pauseState.since.toISOString() : '',
    resume_shift_ms: 0,
  }));

  // Keep-alive comments help avoid idle timeouts on some proxies.
  client.keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      // Socket likely closed.
      announcementClients.delete(client);
      if (client.keepAlive) clearInterval(client.keepAlive);
    }
  }, 20000);

  req.on('close', () => {
    announcementClients.delete(client);
    if (client.keepAlive) clearInterval(client.keepAlive);
  });
});

app.post('/api/announcement', (req, res) => {
  const { user: userId, text } = req.body || {};
  if (!userId || typeof text !== 'string') return res.status(400).json({ error: 'missing params' });
  const user = db.getUser(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (!user.is_admin) return res.status(403).json({ error: 'admin only' });
  const trimmed = text.trim();
  const hasAnnouncement = trimmed.length > 0;

  const pauseState = getPauseState();
  let resumeShiftMs = 0;
  const nowIso = new Date().toISOString();

  if (hasAnnouncement) {
    if (!pauseState.paused) {
      db.setConfig('announcement_pause_since', nowIso);
    }
    db.setConfig('announcement_last_changed_at', nowIso);
  } else if (pauseState.paused && pauseState.since) {
    resumeShiftMs = Math.max(0, Date.now() - pauseState.since.getTime());
    if (resumeShiftMs > 0) {
      db.shiftAllOxygenEnds(resumeShiftMs);
    }
    db.setConfig('announcement_pause_since', '');
    db.setConfig('announcement_last_changed_at', nowIso);
  }

  db.setConfig('announcement_text', text);

  const updatedPauseState = getPauseState();
  broadcastAnnouncement({
    announcement: text,
    paused: hasAnnouncement,
    pause_since: updatedPauseState.paused && updatedPauseState.since ? updatedPauseState.since.toISOString() : '',
    resume_shift_ms: resumeShiftMs,
  });

  res.json({ announcement: text });
});

app.get('/scan', (req, res) => {
  const pauseState = getPauseState();
  const effectiveNow = getEffectiveNow(pauseState);
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
    updated = db.addOxygen(userId, payload.minutes, effectiveNow);
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

const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const config = require('./config.json');
const os = require('os');
let webPush = null;

try {
  webPush = require('web-push');
} catch {
  webPush = null;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/pictures', express.static(path.join(__dirname, 'pictures')));

// --- Announcement realtime (Server-Sent Events) ---
const announcementClients = new Set();
const userClients = new Map();

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

function getLocalDayRange(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function formatSseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function getClientConfig() {
  const dynamicOxygenPurchaseCost = Number.parseInt(db.getConfig('oxygen_purchase_cost') || '', 10);
  return {
    oxygenPurchaseMinutes: config.oxygenPurchaseMinutes,
    oxygenPurchaseCost: Number.isFinite(dynamicOxygenPurchaseCost) ? dynamicOxygenPurchaseCost : config.oxygenPurchaseCost,
    healCodeMinutes: config.healCodeMinutes,
    startingMoney: config.startingMoney,
    startingOxygenMinutes: config.startingOxygenMinutes,
  };
}

function ensureVapidKeys() {
  if (!webPush) return null;

  let publicKey = db.getConfig('push_vapid_public_key') || '';
  let privateKey = db.getConfig('push_vapid_private_key') || '';

  if (!publicKey || !privateKey) {
    const keys = webPush.generateVAPIDKeys();
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    db.setConfig('push_vapid_public_key', publicKey);
    db.setConfig('push_vapid_private_key', privateKey);
  }

  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@planspiel.local',
    publicKey,
    privateKey
  );

  return { publicKey, privateKey };
}

const vapidKeys = ensureVapidKeys();

async function sendAnnouncementPush(text) {
  if (!webPush || !vapidKeys) {
    console.warn('Web push is not available. Install dependencies with npm install.');
    return;
  }

  const body = String(text || '').trim();
  if (!body) return;

  const payload = JSON.stringify({
    type: 'announcement',
    title: 'Planspiel-Ankündigung',
    body,
    url: '/',
  });

  const subscriptions = db.listPushSubscriptions();
  await Promise.all(subscriptions.map(async ({ endpoint, subscription }) => {
    try {
      await webPush.sendNotification(subscription, payload);
    } catch (error) {
      const statusCode = error && error.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        db.deletePushSubscription(endpoint);
        return;
      }
      console.error('Push notification failed', statusCode || '', error && error.message ? error.message : error);
    }
  }));
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

function broadcastConfig(payload = getClientConfig()) {
  const formatted = formatSseEvent('config', payload);
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

function addUserClient(userId, client) {
  if (!userClients.has(userId)) userClients.set(userId, new Set());
  userClients.get(userId).add(client);
}

function removeUserClient(userId, client) {
  const clients = userClients.get(userId);
  if (!clients) return;
  clients.delete(client);
  if (clients.size === 0) userClients.delete(userId);
}

function broadcastUser(userId, pauseState = getPauseState()) {
  const clients = userClients.get(userId);
  if (!clients || clients.size === 0) return;

  const user = db.getUser(userId);
  if (!user) return;
  const formatted = formatSseEvent('user', { user: enrichUser(user, pauseState) });

  for (const client of clients) {
    try {
      client.res.write(formatted);
    } catch {
      removeUserClient(userId, client);
      try { client.res.end(); } catch {}
      if (client.keepAlive) clearInterval(client.keepAlive);
    }
  }
}

function broadcastUsers(userIds, pauseState = getPauseState()) {
  const uniqueIds = [...new Set((userIds || []).filter(Boolean))];
  for (const userId of uniqueIds) {
    broadcastUser(userId, pauseState);
  }
}

function getAffectedUserIds(user) {
  if (!user) return [];
  return user.spouse_id ? [user.id, user.spouse_id] : [user.id];
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
  res.json(getClientConfig());
});

app.get('/api/push/public-key', (req, res) => {
  res.json({
    supported: Boolean(webPush && vapidKeys && vapidKeys.publicKey),
    publicKey: vapidKeys ? vapidKeys.publicKey : '',
  });
});

app.post('/api/push/subscribe', (req, res) => {
  const { user: userId, subscription } = req.body || {};
  if (!userId || !subscription || typeof subscription.endpoint !== 'string') {
    return res.status(400).json({ error: 'missing params' });
  }
  if (!webPush || !vapidKeys) {
    return res.status(503).json({ error: 'push unavailable' });
  }

  const user = db.getUser(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (user.is_admin) return res.json({ ok: true, skipped: 'admin' });

  db.savePushSubscription(userId, subscription);
  res.json({ ok: true });
});

app.post('/api/config/oxygen-cost', (req, res) => {
  const { user: userId, cost } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'missing user id' });
  const user = db.getUser(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (!user.is_admin) return res.status(403).json({ error: 'admin only' });

  const parsedCost = Number(cost);
  if (!Number.isInteger(parsedCost) || parsedCost < 0 || parsedCost > 100000) {
    return res.status(400).json({ error: 'invalid cost' });
  }

  db.setConfig('oxygen_purchase_cost', String(parsedCost));
  broadcastConfig(getClientConfig());
  res.json({ oxygenPurchaseCost: parsedCost });
});

app.get('/api/admin/money-overview', (req, res) => {
  const userId = req.query.user;
  if (!userId) return res.status(400).json({ error: 'missing user id' });
  const user = db.getUser(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (!user.is_admin) return res.status(403).json({ error: 'admin only' });

  const scope = req.query.scope === 'all' ? 'all' : 'today';
  const range = scope === 'today' ? getLocalDayRange() : { start: null, end: null };
  const overview = db.getMoneyOverview({ since: range.start, until: range.end });
  res.json({
    ...overview,
    scope,
    since: range.start ? range.start.toISOString() : '',
    until: range.end ? range.end.toISOString() : '',
    generated_at: new Date().toISOString(),
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

app.get('/api/user/:id/stream', (req, res) => {
  const userId = req.params.id;
  const user = db.getUser(userId);
  if (!user) return res.status(404).end();

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const client = { res, keepAlive: null };
  addUserClient(userId, client);

  res.write(formatSseEvent('user', { user: enrichUser(user, getPauseState()) }));

  client.keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      removeUserClient(userId, client);
      if (client.keepAlive) clearInterval(client.keepAlive);
    }
  }, 20000);

  req.on('close', () => {
    removeUserClient(userId, client);
    if (client.keepAlive) clearInterval(client.keepAlive);
  });
});

app.post('/api/buy-oxygen', (req, res) => {
  const pauseState = getPauseState();
  const effectiveNow = getEffectiveNow(pauseState);
  const dynamicOxygenPurchaseCost = Number.parseInt(db.getConfig('oxygen_purchase_cost') || '', 10);
  const oxygenPurchaseCost = Number.isFinite(dynamicOxygenPurchaseCost) ? dynamicOxygenPurchaseCost : config.oxygenPurchaseCost;
  const { user: userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'missing user id' });
  const existing = db.getUser(userId);
  if (!existing) return res.status(404).json({ error: 'user not found' });
  if (existing.oxygen_end && new Date(existing.oxygen_end).getTime() <= effectiveNow.getTime()) {
    return res.status(400).json({ error: 'timer expired' });
  }
  const updated = db.buyOxygen(userId, config.oxygenPurchaseMinutes, oxygenPurchaseCost, effectiveNow);
  if (!updated) return res.status(400).json({ error: 'not enough money' });
  broadcastUsers(getAffectedUserIds(updated), pauseState);
  res.json({ user: enrichUser(updated, pauseState) });
});

app.post('/api/marriage/marry', (req, res) => {
  const pauseState = getPauseState();
  const { user: userId, partnerCode } = req.body || {};
  if (!userId || !partnerCode) return res.status(400).json({ error: 'missing params' });

  const result = db.marryUsers(userId, partnerCode);
  if (!result || result.error) {
    const status = result && result.error === 'partner not found' ? 404 : 400;
    return res.status(status).json({ error: result ? result.error : 'operation failed' });
  }
  broadcastUsers(result.affectedIds, pauseState);
  res.json({ user: enrichUser(result.user, pauseState) });
});

app.post('/api/marriage/divorce', (req, res) => {
  const pauseState = getPauseState();
  const { user: userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'missing user id' });

  const result = db.divorceUser(userId);
  if (!result || result.error) {
    const status = result && result.error === 'user not found' ? 404 : 400;
    return res.status(status).json({ error: result ? result.error : 'operation failed' });
  }
  broadcastUsers(result.affectedIds, pauseState);
  res.json({ user: enrichUser(result.user, pauseState) });
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
    const creditedAmount = db.getMoneyCreditAmount(user, payload.amount);
    updated = db.addMoney(userId, payload.amount);
    message = creditedAmount !== payload.amount
      ? `€${creditedAmount} hinzugefügt. Ehebonus: +15%.`
      : `€${payload.amount} hinzugefügt.`;
  } else if (payload.type === 'heal') {
    updated = db.addOxygen(userId, payload.minutes, effectiveNow);
    message = `${payload.minutes} Minuten Sauerstoff hinzugefügt.`;
  }
  if (!updated) return res.status(400).json({ error: 'operation failed' });
  broadcastUsers(getAffectedUserIds(updated), pauseState);
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
  broadcastUser(userId, pauseState);
  res.json({ user: enrichUser(updated, pauseState) });
});

app.get('/api/announcement', (req, res) => {
  const announcement = db.getConfig('announcement_text') || '';
  const changedAt = db.getConfig('announcement_last_changed_at') || '';
  const pauseState = getPauseState();
  res.json({
    announcement,
    paused: announcement.trim().length > 0,
    pause_since: pauseState.paused && pauseState.since ? pauseState.since.toISOString() : '',
    changed_at: changedAt,
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
  const changedAt = db.getConfig('announcement_last_changed_at') || '';
  const pauseState = getPauseState();
  res.write(formatSseEvent('announcement', {
    announcement: current,
    paused: current.trim().length > 0,
    pause_since: pauseState.paused && pauseState.since ? pauseState.since.toISOString() : '',
    changed_at: changedAt,
    resume_shift_ms: 0,
  }));
  res.write(formatSseEvent('config', getClientConfig()));

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
    changed_at: nowIso,
    resume_shift_ms: resumeShiftMs,
  });
  if (hasAnnouncement) {
    sendAnnouncementPush(text).catch(error => {
      console.error('Announcement push broadcast failed', error);
    });
  }

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
  broadcastUsers(getAffectedUserIds(updated), pauseState);
  const origin = `${req.protocol}://${req.get('host')}`;
  res.redirect(`${origin}/?user=${encodeURIComponent(userId)}&status=ok`);
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`Accessible at: http://${iface.address}:${PORT}`);
      }
    }
  }
});

function closeSseClientSet(clients) {
  for (const client of clients) {
    if (client.keepAlive) clearInterval(client.keepAlive);
    try {
      client.res.write(formatSseEvent('shutdown', { reconnect: true }));
      client.res.end();
    } catch {}
  }
  clients.clear();
}

function closeUserClientMap() {
  for (const clients of userClients.values()) {
    closeSseClientSet(clients);
  }
  userClients.clear();
}

function shutdown(signal) {
  console.log(`${signal} received, closing HTTP and SSE connections.`);
  closeSseClientSet(announcementClients);
  closeUserClientMap();

  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Graceful shutdown timed out.');
    process.exit(1);
  }, 55000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

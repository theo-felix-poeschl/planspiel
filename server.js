const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/jobs', (req, res) => {
  res.json({ jobs: db.listJobs() });
});

// Create a new user for a device
app.post('/api/register', (req, res) => {
  const id = (req.body && req.body.id) || uuidv4();
  const jobs = db.listJobs();
  // assign a random job
  const job = jobs[Math.floor(Math.random() * jobs.length)];
  const user = db.createUser(id, job);
  res.json({ user });
});

app.get('/api/user/:id', (req, res) => {
  const user = db.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json({ user });
});

// Add amount via POST JSON { user, type, amount }
app.post('/api/scan', (req, res) => {
  const { user, type, amount } = req.body || {};
  if (!user || !type || typeof amount === 'undefined') return res.status(400).json({ error: 'missing params' });
  const field = (type.toLowerCase() === 'geld') ? 'geld' : (type.toLowerCase() === 'sauerstoff' ? 'sauerstoff' : null);
  if (!field) return res.status(400).json({ error: 'invalid type' });
  const updated = db.addAmount(user, field, parseInt(amount, 10));
  if (!updated) return res.status(404).json({ error: 'user not found' });
  res.json({ user: updated });
});

// GET /scan used by QR links: /scan?user=...&type=Geld&amount=50
app.get('/scan', (req, res) => {
  const { user, type, amount } = req.query;
  if (!user || !type || typeof amount === 'undefined') return res.status(400).send('missing params');
  const field = (type.toLowerCase() === 'geld') ? 'geld' : (type.toLowerCase() === 'sauerstoff' ? 'sauerstoff' : null);
  if (!field) return res.status(400).send('invalid type');
  const updated = db.addAmount(user, field, parseInt(amount, 10));
  if (!updated) return res.status(404).send('user not found');
  // If accessed from browser, redirect to front-end showing user
  const origin = `${req.protocol}://${req.get('host')}`;
  return res.redirect(`${origin}/?user=${encodeURIComponent(user)}&status=ok`);
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});

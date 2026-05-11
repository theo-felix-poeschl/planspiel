const http = require('http');
const https = require('https');

const baseUrl = new URL(process.env.BASE_URL || process.argv[2] || 'http://127.0.0.1:3000');
const usersCount = Number.parseInt(process.env.USERS || '80', 10);
const durationSec = Number.parseInt(process.env.DURATION_SEC || '120', 10);
const actionsPerSec = Number.parseInt(process.env.ACTIONS_PER_SEC || '4', 10);
const adminPassword = process.env.ADMIN_PASSWORD || 'LKlisAufDie1';
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const streams = [];
const stats = {
  registered: 0,
  streamOpen: 0,
  streamErrors: 0,
  streamBytes: 0,
  actionsOk: 0,
  actionsFailed: 0,
  adminOk: 0,
  adminFailed: 0,
  latencies: [],
};

function requestJson(method, pathname, body) {
  const url = new URL(pathname, baseUrl);
  const started = Date.now();
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    stats.latencies.push(Date.now() - started);
    if (!res.ok) {
      const error = new Error(`${method} ${pathname} failed with ${res.status}`);
      error.response = json;
      throw error;
    }
    return json;
  });
}

function openStream(pathname) {
  const url = new URL(pathname, baseUrl);
  const client = url.protocol === 'https:' ? https : http;
  const req = client.request(url, {
    method: 'GET',
    headers: { Accept: 'text/event-stream' },
  }, (res) => {
    if (res.statusCode !== 200) {
      stats.streamErrors += 1;
      res.resume();
      return;
    }
    stats.streamOpen += 1;
    res.on('data', (chunk) => {
      stats.streamBytes += chunk.length;
    });
  });
  req.on('error', () => {
    stats.streamErrors += 1;
  });
  req.end();
  streams.push(req);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`Load test target: ${baseUrl.origin}`);
  console.log(`Users: ${usersCount}, duration: ${durationSec}s, actions/sec: ${actionsPerSec}`);

  const adminId = `load-admin-${runId}`;
  const adminRegister = await requestJson('POST', '/api/register', { id: adminId });
  await requestJson('POST', '/api/admin/login', { user: adminRegister.user.id, password: adminPassword });
  stats.adminOk += 1;

  const users = [];
  for (let i = 0; i < usersCount; i += 1) {
    const id = `load-user-${runId}-${i}`;
    const json = await requestJson('POST', '/api/register', { id });
    users.push(json.user.id);
    stats.registered += 1;
  }

  openStream('/api/announcement/stream');
  for (const userId of users) {
    openStream('/api/announcement/stream');
    openStream(`/api/user/${encodeURIComponent(userId)}/stream`);
  }

  await sleep(3000);

  await requestJson('POST', '/api/announcement', {
    user: adminId,
    text: `Lasttest ${new Date().toLocaleTimeString('de-DE')}`,
  });
  await requestJson('POST', '/api/config/oxygen-cost', { user: adminId, cost: 10 });
  await requestJson('GET', `/api/admin/money-overview?user=${encodeURIComponent(adminId)}&scope=today`);
  stats.adminOk += 3;

  const actionCodes = [5, 10, 20, 'heilung'];
  const stopAt = Date.now() + durationSec * 1000;
  const intervalMs = Math.max(1, Math.floor(1000 / actionsPerSec));

  while (Date.now() < stopAt) {
    const userId = users[Math.floor(Math.random() * users.length)];
    const code = actionCodes[Math.floor(Math.random() * actionCodes.length)];
    requestJson('POST', '/api/qr-scan', { user: userId, code })
      .then(() => { stats.actionsOk += 1; })
      .catch(() => { stats.actionsFailed += 1; });
    await sleep(intervalMs);
  }

  await sleep(3000);
  await requestJson('POST', '/api/announcement', { user: adminId, text: '' })
    .then(() => { stats.adminOk += 1; })
    .catch(() => { stats.adminFailed += 1; });

  for (const req of streams) {
    req.destroy();
  }

  const totalActions = stats.actionsOk + stats.actionsFailed;
  console.log('\nResult');
  console.log(`Registered users: ${stats.registered}`);
  console.log(`SSE streams opened: ${stats.streamOpen}/${usersCount * 2 + 1}`);
  console.log(`SSE stream errors: ${stats.streamErrors}`);
  console.log(`SSE bytes received: ${stats.streamBytes}`);
  console.log(`QR/heal actions: ${stats.actionsOk}/${totalActions} ok`);
  console.log(`Admin requests ok/failed: ${stats.adminOk}/${stats.adminFailed}`);
  console.log(`Latency p50/p95/max: ${percentile(stats.latencies, 50)}ms / ${percentile(stats.latencies, 95)}ms / ${Math.max(0, ...stats.latencies)}ms`);

  if (stats.streamOpen < usersCount * 2 || stats.actionsFailed > 0 || stats.adminFailed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  if (error.response) console.error(error.response);
  process.exit(1);
});

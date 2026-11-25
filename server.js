// LooREADY CFO — small chat server for the iPhone web app (PWA).
// No dependencies: Node 18+ only. It serves the app, handles logins,
// stores chat threads on disk, and relays messages to the OpenClaw
// gateway (the "Looready CFO" agent). The gateway token never reaches the phone.

'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const users = require('./scripts/users-lib');

// Read the gateway token straight from OpenClaw's own .env (mounted read-only), so it is never copied anywhere.
function tokenFromEnvFile(f) {
  if (!f) return '';
  try {
    const line = fs.readFileSync(f, 'utf8').split(/\r?\n/).find((l) => /^\s*OPENCLAW_GATEWAY_TOKEN\s*=/.test(l));
    return line ? line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '') : '';
  } catch (e) { console.warn(`Could not read ${f}: ${e.code || e.message}`); return ''; }
}

const CFG = {
  port: Number(process.env.PORT || 3000),
  gatewayUrl: (process.env.OPENCLAW_URL || 'http://127.0.0.1:18789').replace(/\/+$/, ''),
  gatewayToken: process.env.OPENCLAW_TOKEN || tokenFromEnvFile(process.env.OPENCLAW_ENV_FILE),
  agentId: process.env.OPENCLAW_AGENT || 'default',
  sendHistory: Number(process.env.OPENCLAW_SEND_HISTORY || 0), // 0 = gateway keeps the session memory
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  secret: process.env.SESSION_SECRET || '',
  sessionDays: Number(process.env.SESSION_DAYS || 30),
  cookieSecure: process.env.COOKIE_SECURE !== 'false',
};

if (!CFG.secret || CFG.secret.length < 32) {
  console.error('SESSION_SECRET must be set (32+ random characters). Try: openssl rand -hex 32');
  process.exit(1);
}
if (!CFG.gatewayToken) console.warn('Warning: OPENCLAW_TOKEN is empty — the gateway will likely refuse requests.');

const PUBLIC_DIR = path.join(__dirname, 'public');
const THREAD_DIR = path.join(CFG.dataDir, 'threads');
fs.mkdirSync(THREAD_DIR, { recursive: true });

// ---------- helpers ----------
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

const readBody = (req, limit = 64 * 1024) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { reject(Object.assign(new Error('Message too long'), { status: 413 })); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
    catch { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); }
  });
  req.on('error', reject);
});

const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

// ---------- sessions (signed cookie, no server state) ----------
const sign = (v) => crypto.createHmac('sha256', CFG.secret).update(v).digest('base64url');

function makeSession(username, version) {
  const exp = Date.now() + CFG.sessionDays * 86400e3;
  const payload = Buffer.from(JSON.stringify({ u: username, v: version, exp })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSession(req) {
  const m = /(?:^|;\s*)lrcfo=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const expect = sign(payload);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!s.exp || s.exp < Date.now()) return null;
    const user = users.find(CFG.dataDir, s.u);
    if (!user || user.disabled || (user.version || 1) !== s.v) return null; // password change / disable logs out everywhere
    return user;
  } catch { return null; }
}

const cookie = (value, maxAgeSec) =>
  `lrcfo=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${CFG.cookieSecure ? '; Secure' : ''}`;

// ---------- login rate limit ----------
const attempts = new Map(); // ip -> [timestamps]
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  attempts.set(ip, list);
  return list.length >= 10;
}
const noteFailure = (ip) => attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]);

// ---------- thread storage (one JSON file per user) ----------
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}
const threadFile = (u) => path.join(THREAD_DIR, `${u.replace(/[^a-z0-9_.-]/gi, '_')}.json`);
async function loadThreads(u) {
  try { return JSON.parse(await fsp.readFile(threadFile(u), 'utf8')); } catch { return []; }
}
async function saveThreads(u, list) {
  const f = threadFile(u); const tmp = `${f}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(list));
  await fsp.rename(tmp, f);
}
const updateThreads = (u, fn) => withLock(u, async () => { const list = await loadThreads(u); const r = await fn(list); await saveThreads(u, list); return r; });
const newId = () => crypto.randomBytes(9).toString('base64url');
const newPassword = () => crypto.randomBytes(9).toString('base64url');
const summary = (t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt });

// ---------- OpenClaw relay ----------
async function relayToAgent({ user, thread, text, onDelta, signal }) {
  const messages = [];
  if (CFG.sendHistory > 0) {
    for (const m of thread.messages.slice(-CFG.sendHistory - 1, -1)) messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: 'user', content: text });

  const r = await fetch(`${CFG.gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CFG.gatewayToken}`,
      'x-openclaw-agent-id': CFG.agentId,
    },
    body: JSON.stringify({
      model: `openclaw/${CFG.agentId}`,
      stream: true,
      user: `lrcfo:${user.username}:${thread.id}`, // stable per thread → gateway keeps the conversation
      messages,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Gateway ${r.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }

  const ctype = r.headers.get('content-type') || '';
  if (!ctype.includes('event-stream')) { // non-streaming fallback
    const data = await r.json();
    const t = data?.choices?.[0]?.message?.content || '';
    onDelta(t); return t;
  }

  let full = ''; let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return full;
      let evt; try { evt = JSON.parse(data); } catch { continue; }
      if (evt.error) throw new Error(evt.error.message || 'Fia hit an error');
      const d = evt?.choices?.[0]?.delta?.content;
      if (d) { full += d; onDelta(d); }
    }
  }
  return full;
}

// ---------- routes ----------
async function api(req, res, url) {
  const p = url.pathname;

  if (p === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (tooManyAttempts(ip)) return json(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    const { username = '', password = '' } = await readBody(req);
    const user = users.verify(CFG.dataDir, String(username).trim().toLowerCase(), String(password));
    if (!user) { noteFailure(ip); return json(res, 401, { error: 'Wrong username or password.' }); }
    return json(res, 200, { username: user.username, name: user.name, admin: !!user.admin },
      { 'Set-Cookie': cookie(makeSession(user.username, user.version || 1), CFG.sessionDays * 86400) });
  }

  if (p === '/api/logout' && req.method === 'POST') return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });

  const user = readSession(req);
  if (!user) return json(res, 401, { error: 'Please sign in.' });
  const u = user.username;

  if (p === '/api/me') return json(res, 200, { username: u, name: user.name, admin: !!user.admin });

  if (p === '/api/threads' && req.method === 'GET') {
    const list = await loadThreads(u);
    return json(res, 200, list.map(summary).sort((a, b) => b.updatedAt - a.updatedAt));
  }

  const tm = /^\/api\/threads\/([\w-]+)$/.exec(p);
  if (tm && req.method === 'GET') {
    const t = (await loadThreads(u)).find((x) => x.id === tm[1]);
    return t ? json(res, 200, t) : json(res, 404, { error: 'Not found' });
  }
  if (tm && req.method === 'DELETE') {
    await updateThreads(u, (list) => { const i = list.findIndex((x) => x.id === tm[1]); if (i >= 0) list.splice(i, 1); });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/password' && req.method === 'POST') {
    const { current = '', next = '' } = await readBody(req);
    if (!users.verify(CFG.dataDir, u, String(current))) return json(res, 400, { error: 'Current password is wrong.' });
    if (String(next).length < 10) return json(res, 400, { error: 'Use at least 10 characters.' });
    const list = users.load(CFG.dataDir).slice(); const me = list.find((x) => x.username === u);
    me.hash = users.hash(String(next)); me.version = (me.version || 1) + 1; users.save(CFG.dataDir, list);
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(makeSession(u, me.version), CFG.sessionDays * 86400) });
  }

  if (p.startsWith('/api/admin/')) {
    if (!user.admin) return json(res, 403, { error: 'Admins only.' });
    const list = users.load(CFG.dataDir).slice();
    if (p === '/api/admin/users' && req.method === 'GET') {
      return json(res, 200, list.map((x) => ({ username: x.username, name: x.name, admin: !!x.admin, disabled: !!x.disabled })));
    }
    if (p === '/api/admin/users' && req.method === 'POST') {
      const b = await readBody(req);
      const name = String(b.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{2,32}$/.test(name)) return json(res, 400, { error: 'Username: 2–32 letters, numbers, dot, dash or underscore.' });
      if (list.some((x) => x.username === name)) return json(res, 400, { error: 'That username already exists.' });
      const pw = newPassword();
      list.push({ username: name, name: String(b.name || name).slice(0, 60), hash: users.hash(pw), version: 1, admin: !!b.admin, createdAt: new Date().toISOString() });
      users.save(CFG.dataDir, list);
      return json(res, 200, { username: name, password: pw });
    }
    const am = /^\/api\/admin\/users\/([a-z0-9._-]+)\/(reset|disable|enable|remove)$/.exec(p);
    if (am && req.method === 'POST') {
      const target = list.find((x) => x.username === am[1]);
      if (!target) return json(res, 404, { error: 'No such user.' });
      if (target.username === u && am[2] !== 'reset') return json(res, 400, { error: "You can't do that to your own account." });
      let pw = null;
      if (am[2] === 'reset') { pw = newPassword(); target.hash = users.hash(pw); }
      if (am[2] === 'disable') target.disabled = true;
      if (am[2] === 'enable') target.disabled = false;
      if (am[2] === 'remove') list.splice(list.indexOf(target), 1);
      else target.version = (target.version || 1) + 1;
      users.save(CFG.dataDir, list);
      return json(res, 200, { ok: true, password: pw });
    }
    return json(res, 404, { error: 'Not found' });
  }

  if (p === '/api/chat' && req.method === 'POST') {
    const body = await readBody(req);
    const text = String(body.message || '').trim();
    if (!text) return json(res, 400, { error: 'Empty message' });
    if (text.length > 8000) return json(res, 413, { error: 'Message too long' });

    const thread = await updateThreads(u, (list) => {
      let t = body.threadId && list.find((x) => x.id === body.threadId);
      if (!t) {
        t = { id: newId(), title: text.replace(/\s+/g, ' ').slice(0, 60), createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
        list.push(t);
      }
      t.messages.push({ role: 'user', content: text, ts: Date.now() });
      t.updatedAt = Date.now();
      return JSON.parse(JSON.stringify(t));
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    let open = true;
    res.on('close', () => { open = false; });
    const send = (event, data) => { if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    send('thread', { id: thread.id, title: thread.title });
    const beat = setInterval(() => open && res.write(': ping\n\n'), 15000);

    // The agent keeps running even if the phone locks or loses signal; the answer is saved either way.
    let answer = ''; let failed = null;
    try {
      answer = await relayToAgent({ user, thread, text, onDelta: (d) => send('delta', { t: d }) });
    } catch (e) {
      failed = e; console.error(`[chat] ${u}: ${e.message}`);
    }
    clearInterval(beat);

    const content = answer || (failed ? '⚠️ Fia could not answer right now. Please try again in a moment.' : '(No answer returned)');
    await updateThreads(u, (list) => {
      const t = list.find((x) => x.id === thread.id);
      if (t) { t.messages.push({ role: 'assistant', content, ts: Date.now(), error: !!failed && !answer }); t.updatedAt = Date.now(); }
    });
    if (failed && !answer) send('error', { message: content });
    send('done', { ok: !failed });
    if (open) res.end();
    return;
  }

  return json(res, 404, { error: 'Not found' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

async function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  try {
    const data = await fsp.readFile(file);
    const ext = path.extname(file);
    const noCache = ['.html', '.webmanifest'].includes(ext) || p === '/sw.js';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=86400',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return await serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    else res.end();
  }
});
server.requestTimeout = 0; // agent answers can take a while
// First start: create the admin account from ADMIN_USERNAME and print its one-time password to the log.
if (!users.load(CFG.dataDir).length && process.env.ADMIN_USERNAME) {
  const pw = newPassword(); const name = process.env.ADMIN_USERNAME.trim().toLowerCase();
  users.save(CFG.dataDir, [{ username: name, name: process.env.ADMIN_NAME || name, hash: users.hash(pw), version: 1, admin: true, createdAt: new Date().toISOString() }]);
  console.log(`[setup] Admin account created. Username: ${name}  Password: ${pw}  (change it in the app: menu > Change password)`);
}

// Startup check so problems show up in the container log.
async function probeGateway() {
  if (!CFG.gatewayToken) return console.log('[gateway] No token found. Set OPENCLAW_TOKEN or OPENCLAW_ENV_FILE.');
  try {
    const r = await fetch(`${CFG.gatewayUrl}/v1/models`, { headers: { Authorization: `Bearer ${CFG.gatewayToken}` } });
    if (r.ok) {
      const ids = ((await r.json()).data || []).map((m) => m.id);
      console.log(`[gateway] OK. Agents: ${ids.join(', ')}`);
      if (!ids.some((id) => id === `openclaw/${CFG.agentId}` || id.endsWith(`/${CFG.agentId}`))) console.log(`[gateway] Agent "${CFG.agentId}" not in that list. Set OPENCLAW_AGENT.`);
    } else console.log(`[gateway] ${r.status} from /v1/models${r.status === 404 ? ' (chatCompletions endpoint is not enabled in the OpenClaw config)' : ''}`);
  } catch (e) { console.log(`[gateway] Cannot reach ${CFG.gatewayUrl}: ${e.cause?.code || e.message}`); }
}

server.listen(CFG.port, () => { console.log(`Fia on :${CFG.port} → agent "${CFG.agentId}" at ${CFG.gatewayUrl}`); probeGateway(); });

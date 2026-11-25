'use strict';
const $ = (id) => document.getElementById(id);
const state = { me: null, threadId: null, busy: false, threads: [] };

// ---------- tiny, safe markdown (escape first, then format) ----------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
function md(src) {
  const lines = esc(src.replace(/\r/g, '')).split('\n');
  let out = ''; let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; out += `<pre><code>${buf.join('\n')}</code></pre>`; continue;
    }
    if (/^\s*$/.test(l)) { i++; continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { const n = Math.min(3, m[1].length); out += `<h${n}>${inline(m[2])}</h${n}>`; i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out += '<hr>'; i++; continue; }
    if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(l);
      const align = lines[i + 1].trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
        .map((a) => { a = a.trim(); return a.endsWith(':') ? (a.startsWith(':') ? ' class="c"' : ' class="r"') : ''; });
      i += 2; let rows = '';
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) rows += `<tr>${cells(lines[i++]).map((c, j) => `<td${align[j] || ''}>${c}</td>`).join('')}</tr>`;
      out += `<div class="table-wrap"><table><thead><tr>${head.map((c, j) => `<th${align[j] || ''}>${c}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
      continue;
    }
    if (/^&gt;\s?/.test(l)) {
      const buf = []; while (i < lines.length && /^&gt;\s?/.test(lines[i])) buf.push(lines[i++].replace(/^&gt;\s?/, ''));
      out += `<blockquote>${inline(buf.join('<br>'))}</blockquote>`; continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d+[.)]\s+/.test(l); const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out += ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`; continue;
    }
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|&gt;|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) buf.push(lines[i++]);
    out += `<p>${inline(buf.join('<br>'))}</p>`;
  }
  return out;
}

// ---------- api ----------
async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
  if (r.status === 401 && path !== '/api/login') { showLogin(); throw new Error('signed out'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
  return data;
}

// ---------- screens ----------
function showLogin() {
  $('app').hidden = true; closeDrawer(); $('login').hidden = false;
  setTimeout(() => $('lu').focus(), 50);
}
async function showApp() {
  $('login').hidden = true; $('app').hidden = false;
  $('who').textContent = state.me.name;
  $('usersBtn').hidden = !state.me.admin;
  requestAnimationFrame(grow);
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let dismissed = false; try { dismissed = localStorage.getItem('lrcfo-tip') === '1'; } catch {}
  $('installTip').hidden = !(ios && !standalone && !dismissed);
  await refreshThreads();
}

$('tipClose').onclick = () => { $('installTip').hidden = true; try { localStorage.setItem('lrcfo-tip', '1'); } catch {} };

$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button'); btn.disabled = true; $('loginErr').textContent = '';
  try {
    state.me = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('lu').value, password: $('lp').value }) });
    $('lp').value = ''; newChat(); await showApp();
  } catch (err) { $('loginErr').textContent = err.message; }
  btn.disabled = false;
};

// ---------- threads ----------
async function refreshThreads() {
  try { state.threads = await api('/api/threads'); } catch { return; }
  const nav = $('threadList'); nav.innerHTML = '';
  if (!state.threads.length) { nav.innerHTML = '<p class="thread-empty">No chats yet.</p>'; return; }
  for (const t of state.threads) {
    const row = document.createElement('div'); row.className = `thread${t.id === state.threadId ? ' active' : ''}`;
    const open = document.createElement('button'); open.className = 'open'; open.textContent = t.title || 'Chat';
    open.onclick = () => { closeDrawer(); openThread(t.id); };
    const del = document.createElement('button'); del.className = 'del'; del.textContent = 'Delete'; del.setAttribute('aria-label', `Delete ${t.title}`);
    del.onclick = async () => {
      if (!confirm('Delete this chat?')) return;
      await api(`/api/threads/${t.id}`, { method: 'DELETE' }).catch(() => {});
      if (t.id === state.threadId) newChat();
      refreshThreads();
    };
    row.append(open, del); nav.append(row);
  }
}

function clearMessages() { $('messages').querySelectorAll('.msg').forEach((n) => n.remove()); }

function newChat() {
  if (state.busy) return;
  state.threadId = null; clearMessages(); $('empty').hidden = false; $('threadTitle').textContent = 'Fia';
  try { sessionStorage.removeItem('lrcfo-thread'); } catch {}
}

async function openThread(id) {
  if (state.busy) return;
  let t; try { t = await api(`/api/threads/${id}`); } catch { return; }
  state.threadId = t.id; clearMessages(); $('empty').hidden = true; $('threadTitle').textContent = t.title || 'Chat';
  try { sessionStorage.setItem('lrcfo-thread', t.id); } catch {}
  for (const m of t.messages) addMsg(m.role, m.content, m.error);
  scrollEnd(true);
}

// ---------- messages ----------
function addMsg(role, text, error) {
  const row = document.createElement('div'); row.className = `msg ${role}${error ? ' error' : ''}`;
  const b = document.createElement('div'); b.className = 'bubble';
  if (role === 'user') b.textContent = text;
  else { b.innerHTML = '<div class="who-label">Fia</div><div class="md"></div>'; b.querySelector('.md').innerHTML = md(text || ''); }
  row.append(b); $('messages').append(row);
  return b;
}
function scrollEnd(force) {
  const el = $('messages');
  if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
}

async function send(text) {
  text = text.trim(); if (!text || state.busy) return;
  state.busy = true; $('sendBtn').disabled = true;
  $('empty').hidden = true; addMsg('user', text); scrollEnd(true);
  const bubble = addMsg('assistant', ''); const box = bubble.querySelector('.md');
  box.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  let answer = ''; let pending = false;
  const paint = () => { pending = false; box.innerHTML = md(answer); scrollEnd(); };

  try {
    const r = await fetch('/api/chat', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: state.threadId, message: text }),
    });
    if (r.status === 401) { showLogin(); throw new Error('Please sign in again.'); }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Error ${r.status}`);
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k); buf = buf.slice(k + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!ev || !data) continue;
        const d = JSON.parse(data);
        if (ev === 'thread') {
          state.threadId = d.id; $('threadTitle').textContent = d.title;
          try { sessionStorage.setItem('lrcfo-thread', d.id); } catch {}
        } else if (ev === 'delta') {
          answer += d.t; if (!pending) { pending = true; requestAnimationFrame(paint); }
        } else if (ev === 'error') {
          bubble.parentElement.classList.add('error'); answer = d.message; paint();
        }
      }
    }
    paint();
    if (!answer) box.innerHTML = '<p class="status-line">(No answer returned)</p>';
  } catch (err) {
    // Connection dropped (e.g. phone locked). The server keeps going and saves the answer.
    if (state.threadId) {
      box.innerHTML = '<p class="status-line">Connection lost. The answer is still being saved. Reopen this chat in a moment.</p>';
    } else {
      bubble.parentElement.classList.add('error'); box.textContent = err.message || 'Something went wrong.';
    }
  }
  state.busy = false; $('sendBtn').disabled = !$('input').value.trim();
  refreshThreads();
}

// ---------- composer ----------
const input = $('input');
const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; $('sendBtn').disabled = state.busy || !input.value.trim(); };
input.addEventListener('input', grow);
input.addEventListener('keydown', (e) => {
  // On desktop, Enter sends; on iPhone the return key adds a line and the arrow button sends.
  if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); $('composer').requestSubmit(); }
});
$('composer').onsubmit = (e) => { e.preventDefault(); const v = input.value; input.value = ''; grow(); send(v); };
document.querySelectorAll('.chip').forEach((c) => { c.onclick = () => send(c.textContent); });
grow();

// ---------- drawer ----------
function openDrawer() { $('drawer').hidden = false; $('scrim').hidden = false; refreshThreads(); }
function closeDrawer() { $('drawer').hidden = true; $('scrim').hidden = true; }
$('menuBtn').onclick = openDrawer; $('scrim').onclick = closeDrawer;
$('newBtn').onclick = () => { newChat(); input.focus(); };
$('drawerNew').onclick = () => { closeDrawer(); newChat(); };
$('logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); state.me = null; newChat(); showLogin(); };

// Coming back to the app (e.g. after locking the phone): reload the open chat so saved answers appear.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.me && state.threadId && !state.busy) openThread(state.threadId);
});

// ---------- settings sheet ----------
function openSheet(title, html) {
  closeDrawer(); $('sheetTitle').textContent = title; $('sheetBody').innerHTML = html;
  $('sheet').hidden = false; $('sheetScrim').hidden = false;
}
function closeSheet() { $('sheet').hidden = true; $('sheetScrim').hidden = true; }
$('sheetClose').onclick = closeSheet; $('sheetScrim').onclick = closeSheet;
const pwBox = (user, pw) => `<div class="newpw">Password for <b>${esc(user)}</b>:<br><code>${esc(pw)}</code><br><small>Shown once. Send it to them privately.</small></div>`;

$('pwBtn').onclick = () => {
  openSheet('Change password', `<form id="pwForm">
    <label>Current password<input type="password" id="pwCur" autocomplete="current-password" required></label>
    <label>New password (10+ characters)<input type="password" id="pwNew" autocomplete="new-password" minlength="10" required></label>
    <p id="pwMsg" class="err"></p><button class="btn-primary">Save</button></form>`);
  $('pwForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/password', { method: 'POST', body: JSON.stringify({ current: $('pwCur').value, next: $('pwNew').value }) });
      $('sheetBody').innerHTML = '<p class="ok">Password changed. Other devices are signed out.</p>';
    } catch (err) { $('pwMsg').textContent = err.message; }
  };
};

async function renderUsers(note = '') {
  let list; try { list = await api('/api/admin/users'); } catch (e) { $('sheetBody').innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const rows = list.map((x) => `<div class="urow"><div class="uname">${esc(x.name)}${x.admin ? ' · admin' : ''}<small>${esc(x.username)}${x.disabled ? ' · disabled' : ''}</small></div>
    ${x.username === state.me.username ? '' : `<button data-a="reset" data-u="${esc(x.username)}">Reset</button>
    <button data-a="${x.disabled ? 'enable' : 'disable'}" data-u="${esc(x.username)}">${x.disabled ? 'Enable' : 'Disable'}</button>
    <button data-a="remove" data-u="${esc(x.username)}">Remove</button>`}</div>`).join('');
  $('sheetBody').innerHTML = `${note}${rows}
    <p class="section-label">Add someone</p>
    <form id="addForm">
      <label>Name<input type="text" id="auName" placeholder="Hamesh Shahani" required></label>
      <label>Username<input type="text" id="auUser" placeholder="hamesh" autocapitalize="none" autocorrect="off" required></label>
      <label class="check"><input type="checkbox" id="auAdmin"> Can manage users</label>
      <p id="auMsg" class="err"></p><button class="btn-primary">Add user</button>
    </form>`;
  $('addForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ name: $('auName').value, username: $('auUser').value, admin: $('auAdmin').checked }) });
      renderUsers(pwBox(r.username, r.password));
    } catch (err) { $('auMsg').textContent = err.message; }
  };
  $('sheetBody').querySelectorAll('.urow button').forEach((b) => {
    b.onclick = async () => {
      const { a, u } = b.dataset;
      if (a === 'remove' && !confirm(`Remove ${u}? Their chats stay on the server.`)) return;
      try {
        const r = await api(`/api/admin/users/${u}/${a}`, { method: 'POST' });
        renderUsers(r.password ? pwBox(u, r.password) : '');
      } catch (err) { alert(err.message); }
    };
  });
}
$('usersBtn').onclick = () => { openSheet('Users', '<p class="muted">Loading…</p>'); renderUsers(); };

// ---------- start ----------
(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    state.me = await api('/api/me');
    await showApp();
    let last = null; try { last = sessionStorage.getItem('lrcfo-thread'); } catch {}
    if (last) openThread(last);
  } catch { if (!state.me) showLogin(); }
})();

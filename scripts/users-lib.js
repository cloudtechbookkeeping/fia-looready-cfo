// Users live in DATA_DIR/users.json. Passwords are stored as scrypt hashes, never in plain text.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const file = (dir) => path.join(dir, 'users.json');

let cache = { mtime: 0, list: [] };
function load(dir) {
  try {
    const st = fs.statSync(file(dir));
    if (st.mtimeMs !== cache.mtime) cache = { mtime: st.mtimeMs, list: JSON.parse(fs.readFileSync(file(dir), 'utf8')) };
  } catch { cache = { mtime: 0, list: [] }; }
  return cache.list;
}
function save(dir, list) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file(dir), JSON.stringify(list, null, 2));
  cache = { mtime: 0, list: [] };
}

function hash(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function check(password, stored) {
  const [, s, k] = String(stored).split('$');
  if (!s || !k) return false;
  const key = crypto.scryptSync(password, Buffer.from(s, 'base64'), 64);
  const want = Buffer.from(k, 'base64');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

const find = (dir, username) => load(dir).find((u) => u.username === username) || null;

function verify(dir, username, password) {
  const u = find(dir, username);
  if (!u || u.disabled) { check(password, hash('x')); return null; } // same timing either way
  return check(password, u.hash) ? u : null;
}

module.exports = { load, save, hash, find, verify };

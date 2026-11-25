#!/usr/bin/env node
// Manage who can sign in.
//   node scripts/users.js add jude "Jude Gomes"        (asks for a password, or makes one)
//   node scripts/users.js password jude                 (reset password; signs them out everywhere)
//   node scripts/users.js disable hamesh | enable hamesh | remove hamesh
//   node scripts/users.js list
// In Docker: docker compose exec cfo node scripts/users.js add jude "Jude Gomes"
'use strict';
const crypto = require('crypto');
const readline = require('readline');
const lib = require('./users-lib');

const DIR = process.env.DATA_DIR || require('path').join(__dirname, '..', 'data');
const [cmd, rawName, ...rest] = process.argv.slice(2);
const username = (rawName || '').trim().toLowerCase();

function ask(q) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a); }));
}
async function getPassword() {
  if (process.env.NEW_PASSWORD) return { pw: process.env.NEW_PASSWORD, made: false };
  const typed = await ask('Password (leave empty to generate one): ');
  if (typed) {
    if (typed.length < 10) { console.error('Use at least 10 characters.'); process.exit(1); }
    return { pw: typed, made: false };
  }
  return { pw: crypto.randomBytes(9).toString('base64url'), made: true };
}

(async () => {
  const list = lib.load(DIR).slice();
  const idx = list.findIndex((u) => u.username === username);
  const need = () => { if (idx < 0) { console.error(`No user "${username}".`); process.exit(1); } };

  switch (cmd) {
    case 'add': {
      if (!/^[a-z0-9._-]{2,32}$/.test(username)) { console.error('Username: 2–32 chars, letters/numbers/._-'); process.exit(1); }
      if (idx >= 0) { console.error(`"${username}" already exists. Use "password" to reset.`); process.exit(1); }
      const { pw, made } = await getPassword();
      list.push({ username, name: rest.join(' ') || username, hash: lib.hash(pw), version: 1, createdAt: new Date().toISOString() });
      lib.save(DIR, list);
      console.log(`Added ${username}.${made ? `  Password: ${pw}  (share it privately)` : ''}`);
      break;
    }
    case 'password': {
      need();
      const { pw, made } = await getPassword();
      list[idx].hash = lib.hash(pw); list[idx].version = (list[idx].version || 1) + 1;
      lib.save(DIR, list);
      console.log(`Password changed for ${username}; old sessions signed out.${made ? `  New password: ${pw}` : ''}`);
      break;
    }
    case 'disable': case 'enable': {
      need();
      list[idx].disabled = cmd === 'disable';
      list[idx].version = (list[idx].version || 1) + 1;
      lib.save(DIR, list); console.log(`${username} ${cmd}d.`); break;
    }
    case 'remove': need(); list.splice(idx, 1); lib.save(DIR, list); console.log(`Removed ${username}.`); break;
    case 'list':
      if (!list.length) console.log('No users yet.');
      for (const u of list) console.log(`${u.username.padEnd(16)} ${u.name}${u.disabled ? '  (disabled)' : ''}`);
      break;
    default:
      console.log('Usage: node scripts/users.js add|password|disable|enable|remove|list <username> [Full name]');
  }
})();

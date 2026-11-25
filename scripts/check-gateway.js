#!/usr/bin/env node
// Checks the app can reach the OpenClaw gateway and lists the agent ids it offers.
//   docker compose exec fia node scripts/check-gateway.js
'use strict';
const url = (process.env.OPENCLAW_URL || 'http://127.0.0.1:18789').replace(/\/+$/, '');
(async () => {
  try {
    const r = await fetch(`${url}/v1/models`, { headers: { Authorization: `Bearer ${process.env.OPENCLAW_TOKEN || ''}` } });
    const text = await r.text();
    if (r.status === 404) return console.log(`Reached ${url}, but /v1/models is off. Enable gateway.http.endpoints.chatCompletions in the OpenClaw config.`);
    if (r.status === 401 || r.status === 403) return console.log(`Reached ${url}, but the token was refused. Check OPENCLAW_TOKEN.`);
    if (!r.ok) return console.log(`Gateway answered ${r.status}: ${text.slice(0, 300)}`);
    const ids = (JSON.parse(text).data || []).map((m) => m.id);
    console.log(`OK, connected to ${url}. Agents:\n  ${ids.join('\n  ')}`);
    console.log(`\nSet OPENCLAW_AGENT to the part after "openclaw/" (now: "${process.env.OPENCLAW_AGENT || 'default'}").`);
  } catch (e) {
    console.log(`Could not reach ${url}: ${e.cause?.code || e.message}. See "Connecting to OpenClaw" in SETUP.md.`);
  }
})();

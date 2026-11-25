# Fia: LooREADY CFO app for iPhone

Fia is a web app you add to the iPhone home screen. It opens full-screen like a normal app and needs no App Store and no Apple fees. It runs on your Hostinger VPS (76.13.209.167) next to CloudTask, and it talks to your existing **Looready CFO** agent on the OpenClaw gateway.

```
iPhone (Fia) ──HTTPS──> Fia server (Docker, VPS) ──private──> OpenClaw gateway ──> Looready CFO agent
```

The gateway token stays on the server. Phones only get a login cookie.

---

## 1. DNS (one time)
Add an **A record** for `fia` pointing to `76.13.209.167` on cloudtechbookkeeping.com. That gives you `fia.cloudtechbookkeeping.com`.

## 2. Turn on OpenClaw's chat endpoint (one time)
In the OpenClaw config (usually `~/.openclaw/openclaw.json`), add:

```json5
{
  gateway: {
    http: { endpoints: { chatCompletions: { enabled: true } } },
  },
}
```

Then restart the gateway. Copy `gateway.auth.token` from the same config. Fia needs it.

> OpenClaw treats this token as full operator access. Keep it only in Fia's `.env`, and **never open port 18789 to the internet**.

## 3. Copy the app to the VPS and start it
From your Mac, in the folder that contains `looready-cfo`:

```bash
scp -r looready-cfo root@76.13.209.167:/opt/fia
ssh root@76.13.209.167
cd /opt/fia
cp .env.example .env
nano .env        # fill in SESSION_SECRET (openssl rand -hex 32), OPENCLAW_TOKEN, check the Traefik names
docker compose up -d --build
```

**Traefik names:** open CloudTask's `docker-compose.yml` and copy its network name, entrypoint and certresolver into `.env` (`TRAEFIK_NETWORK`, `TRAEFIK_ENTRYPOINT`, `TRAEFIK_CERTRESOLVER`).

## 4. Check the connection to the agent
```bash
docker compose exec fia node scripts/check-gateway.js
```
It lists the agent ids. Put the Looready CFO one in `OPENCLAW_AGENT`, then run `docker compose up -d`.

### Connecting to OpenClaw (if the check fails)
- **OpenClaw runs in Docker:** set `OPENCLAW_URL=http://<openclaw-container-name>:18789`, and add Fia to the same Docker network as OpenClaw.
- **OpenClaw runs directly on the VPS and only listens on 127.0.0.1:** a container can't reach that address. Either make the gateway also listen on the Docker bridge, with port 18789 blocked in the firewall (`ufw deny 18789`), or run OpenClaw in Docker.

## 5. Add who can sign in
```bash
docker compose exec fia node scripts/users.js add jude "Jude Gomes"
docker compose exec fia node scripts/users.js add hamesh "Hamesh Shahani"
```
Leave the password empty and it makes a strong one for you. Share it privately.
Other commands: `password <user>` (reset and sign them out everywhere), `disable <user>`, `enable <user>`, `remove <user>`, `list`.

## 6. Install on iPhone
1. Open **https://fia.cloudtechbookkeeping.com** in **Safari**.
2. Sign in.
3. Tap **Share**, then **Add to Home Screen**, then **Add**.

The Fia icon appears on the home screen and opens full-screen. Updates arrive automatically. There's nothing to reinstall.

---

## Good to know
- **Memory:** each chat thread is its own OpenClaw session, so Fia remembers earlier messages in that thread. A new chat starts fresh.
- **Locked phone:** if the phone locks mid-answer, the server finishes and saves the answer. Reopen the chat to see it.
- **Data:** users and chat history are stored in the Docker volume `fia-data`. Back it up with the rest of the VPS.
- **Updates:** copy the changed files over and run `docker compose up -d --build`.
- **What Fia can do:** Fia can do exactly what the Looready CFO agent is allowed to do in OpenClaw. Keep that agent read-only for the books (no posting to Xero), because anyone you add here can ask it things.
- **Fonts:** headings use Jaldi. Body text falls back to the iPhone system font because Sofia Pro is a licensed font that isn't bundled. To use it, add the licensed web font files to `public/` and reference them in `styles.css`.
- **Icon:** the icon is a simple chart-bubble in the LooREADY colours, not the LooREADY logo. Replace the files in `public/icons/` (180, 192 and 512 px PNGs) if you want an approved logo icon.

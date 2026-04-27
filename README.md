# Planspiel — Minimal Webapp Skeleton

This repository contains a minimal Node.js + Express webapp skeleton intended to be reachable by multiple mobile devices on the same network or when deployed to a cloud server.

Quick start (locally):

1. Install dependencies:

```bash
cd /home/ptheo/Documents/projects/planspiel
npm install
```

2. Run the server:

```bash
npm start
```

3. From another device on the same network, open:

http://YOUR_COMPUTER_IP:3000

Find your IP with `ip addr` or `hostname -I`.

Notes on hosting for multiple mobile devices:
- Local network: run the app on a machine on the same Wi‑Fi and point devices at that machine's LAN IP (server binds to 0.0.0.0 by default).
- Cloud: deploy to platforms like Fly.io, Render, DigitalOcean App Platform, or a VPS. Alternatively, containerize with Docker and deploy to any cloud provider.

Firewall: ensure port 3000 (or chosen PORT) is open on the host/firewall.

Device registration:
- Each device gets an id stored in `localStorage` under `planspiel_user`.
- The server exposes a `db_instance_id`; if the sqlite DB file is deleted/reset, clients auto re-register once (same `planspiel_user`) and store the new `planspiel_db_instance_id`.

Announcements:
- Clients subscribe to `/api/announcement/stream` via Server-Sent Events (SSE) so admin updates are pushed to all devices immediately.
- If SSE is unavailable, the UI falls back to polling `/api/announcement` every 10 seconds.

If you want, I can:
- containerize this into a Dockerfile and provide deploy steps,
- or set up a simple GitHub→Render deployment example.

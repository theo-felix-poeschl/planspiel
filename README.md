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

If you want, I can:
- containerize this into a Dockerfile and provide deploy steps,
- or set up a simple GitHub→Render deployment example.

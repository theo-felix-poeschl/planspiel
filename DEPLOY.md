# Deployment Guide — Planspiel

This guide gives step-by-step, copy-paste commands to make your app publicly reachable from any device. Pick one path below: (A) Render (easiest, managed), (B) Docker on any host or (C) Ubuntu VPS with systemd + Nginx.

Prerequisites (locally):
- A working repository with the code in this folder.
- `git`, `node` and `npm` installed locally for pushing to remote.

General: bind to 0.0.0.0 (already done in `server.js`) and set a `PORT` env var if host expects it.

A — Deploy to Render (recommended for beginners)
1. Create a GitHub repository and push your project.

```bash
git init
git add .
git commit -m "Initial commit"
# replace URL below with your GitHub repo URL
git remote add origin git@github.com:USERNAME/REPO.git
git branch -M main
git push -u origin main
```

2. Sign up at https://render.com and connect your GitHub account.
3. Click "New" → "Web Service" → select your repository and branch `main`.
4. Use these settings when prompted:
- Environment: `Node`
- Build Command: `npm install`
- Start Command: `npm start`
- Port: `3000` (or set env var `PORT` to match Render's assigned port)

5. Render will build and deploy; after deploy it gives you a public URL with HTTPS.
6. Open that URL on any device — it works anywhere on the internet.

B — Docker (build once, run anywhere)
Files added in this repo: `Dockerfile` and `docker-compose.yml` (example below).

Build and run locally:

```bash
# build image
docker build -t planspiel:latest .
# run container and publish port 3000
docker run -d -p 3000:3000 --name planspiel planspiel:latest
```

If you have a VPS or cloud VM, run the same `docker run` there and use the VM's public IP.

Docker Compose quick run:

```bash
docker compose up -d --build
```

C — Ubuntu VPS (systemd + Nginx + Let's Encrypt)
This is for when you control a server (e.g., DigitalOcean droplet, AWS EC2). Replace `example.com` and `USER` below.

1. SSH to your server and install essentials:

```bash
sudo apt update
sudo apt install -y git nginx certbot python3-certbot-nginx build-essential
```

2. Clone and run the app (example using Node directly):

```bash
cd /home/USER
git clone https://github.com/USERNAME/REPO.git planspiel
cd planspiel
npm install
# test run
PORT=3000 node server.js
```

3. Create a `systemd` service so the app restarts on reboot. Create `/etc/systemd/system/planspiel.service` with:

```
[Unit]
Description=Planspiel Node App
After=network.target

[Service]
Type=simple
User=USER
WorkingDirectory=/home/USER/planspiel
Environment=PORT=3000
ExecStart=/usr/bin/node /home/USER/planspiel/server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now planspiel.service
```

4. Configure Nginx as a reverse proxy (replace `example.com`): create `/etc/nginx/sites-available/planspiel`:

```
server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable it and test:

```bash
sudo ln -s /etc/nginx/sites-available/planspiel /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

5. Obtain HTTPS with Certbot:

```bash
sudo certbot --nginx -d example.com
```

6. Visit `https://example.com` from any device.

Troubleshooting & tips
- If external requests fail, check `sudo ufw status` and open ports 80/443 (and 3000 if not using Nginx): `sudo ufw allow 80,443`.
- If using a cloud provider, ensure their security group / firewall allows HTTP/HTTPS.
- Use the domain name (A record) pointing to the server IP; DNS propagation can take minutes.
- Verify the app's health: `curl -I http://localhost:3000` or `curl https://example.com/api/ping`.

If you want, I can perform one of these for you step-by-step (e.g., create Docker image and test locally, or prepare files for Render). Tell me which option you want and I will continue.

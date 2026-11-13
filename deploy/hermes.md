# Deploy auf Hermes-VPS (Debian 13) — Doku + Beispiele

Hermes ist KEIN PaaS: kein Service-Dialog, keine Env-Verwaltung, kein Redeploy-Button.
Deploy ist klassisch: `git clone` → systemd-Unit → Caddy davor. Root-Schritte macht
Sebastian per Copy-paste (Caddy-Site, systemd-`enable`), alles im Home kann Hermes.

## 1. Voraussetzungen (einmalig, Root)

- Node ≥ 22.5 via NodeSource (`src/db.js` nutzt `node:sqlite` — Debian 13 liefert nur 20.x):
  ```
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt install -y nodejs
  node -v   # ≥ v22.5 erwartet
  ```
- Caddy läuft (TLS automatisch). Keine Dependencies — `npm install` entfällt im Release-Flow.

## 2. Erstanlage (Hermes als User `seb`, kein sudo)

Vorher Root (einmalig — `/home/seb` gehört `seb`, Hermes schreibt als anderer User):

```bash
sudo install -d -o seb -g seb-share -m 2775 /home/seb/aiquarium
```

Danach Hermes als `seb`:

```bash
cd /home/seb/aiquarium
git clone https://github.com/jenerseb/aiquarium.git .
# Repo-Wurzel = App-Root (AGENTS.md, package.json, src/, public/ … liegen direkt hier,
# `.git` auch). `aiquarium-app/` ist nur der lokale Ordnername im Dev-Container.
cp .env.example .env   # OPENROUTER_API_KEY eintragen — nie committen
node --version         # ≥ 22.5
npm run check && npm test   # check grün, 80/85 (5 rot = Paket R, bekannt)
PORT=3077 node src/server.js   # Probe: curl http://127.0.0.1:3077/api/health → {"ok":true}
```

DB-Standard `~/.local/share/aiquarium/world.sqlite` liegt außerhalb des Repos — passt,
nichts zu tun.

## 3. systemd-Unit (Beispiel, Root legt an: `/etc/systemd/system/aiquarium.service`)

```ini
[Unit]
Description=AIquarium (Bruchpilot OS)
After=network.target

[Service]
User=seb
WorkingDirectory=/home/seb/aiquarium
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
# Hardening (DB im Home — deshalb KEIN ProtectHome=read-only):
ProtectSystem=full
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now aiquarium
systemctl status aiquarium --no-pager | head -n 8
curl -s http://127.0.0.1:3077/api/health   # {"ok":true}
```

`/api/health` antwortet nur, wenn der Event-Loop lebt (`lastBeat` pro Runde) —
systemd-`active` allein reicht nicht (hängender Loop).

## 4. Caddy (Beispiel-Site, Root legt an — SSE braucht `flush_interval -1`)

```
aiquarium.sebschuster.de {
    reverse_proxy 127.0.0.1:3077 {
        flush_interval -1
    }
}
```

Ohne `flush_interval -1` puffert Caddy den SSE-Strom und der Feed steht.
Danach: `caddy reload` (oder `systemctl reload caddy`), TLS kommt automatisch.
`/api/dev/*` ist im Code proxy-sicher: `istLokal()` prüft TCP-Herkunft + `X-Real-IP`
(Caddy überschreibt den Header) — direkter Port-Zugriff ohne Proxy bleibt per
`HOST=127.0.0.1`-Bind (Default in `server.js`) zu.
`/api/stream` (SSE) ist gedeckelt: `AIQUARIUM_MAX_CLIENTS` (Default 100, per Env),
Überlauf antwortet 503 — ein Client kann den Server nicht mit tausend
Verbindungen fluten.

## 5. Release-Flow (jedes Mal gleich)

```bash
cd /home/seb/aiquarium
git pull --ff-only
npm run check && npm test   # bei Rot: Abbruch, kein Restart (80/85 erwartet, 5 rot = Paket R)
systemctl restart aiquarium   # Root — oder Hermes ruft Sebastian
curl -s https://aiquarium.sebschuster.de/api/health   # {"ok":true}
```

Rollback: `git log --oneline -5` → `git reset --hard <alter Commit>` → Restart.
DB wird nie mitdeployed (`AIQUARIUM_DB` zeigt daneben), Backup per Hermes-Snapshot.

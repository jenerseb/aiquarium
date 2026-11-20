# Deployment auf dem VPS

Das AIquarium läuft auch als öffentliche Website auf einem VPS. Es gibt
**keine npm-Abhängigkeiten** – es gibt dort also kein `npm install`.
Einzige Voraussetzung: **Node.js ≥ 22.5**.

## Was NICHT mit `git pull` kommt (und warum)

| Was | Status | Lösung |
|---|---|---|
| Neue Commits aus diesem Repo | tracked → kommt mit | `git pull` (siehe Update unten) |
| **`.env`** (API-Keys) | steht nie im Git (bewusst, `.gitignore`) | einmalig manuell anlegen bzw. rüberschieben |
| **Welt-DB** `~/.local/share/aiquarium/world.sqlite` | liegt bewusst außerhalb des Repos | entsteht beim ersten `npm start` automatisch – nichts tun |
| `data/hamburg_lod2_test.json` etc. | ignoriert (Test-Dateien) | wird nicht gebraucht |

**Wichtig:** `public/kiez-aerial.jpg` (Luftbild) und die Geodaten
(`data/kiez_map.json`, `data/hamburg_geodata.json`, `data/hamburg_lod2.json`)
**sind im Git getrackt** und kommen mit jedem Pull automatisch mit.

## Einmalige Ersteinrichtung

```bash
# 1. Node ≥ 22.5 prüfen (einzige Voraussetzung)
node -v    # muss >= 22.5 sein, sonst Node updaten

# 2. Repo holen
git clone https://github.com/jenerseb/aiquarium.git
cd aiquarium/aiquarium-app

# 3. .env anlegen – kommt NICHT mit dem Git! Am einfachsten vom
#    lokalen Rechner rüberschieben (Datei existiert dort schon):
#    scp /workspaces/seb-dev/aiquarium/aiquarium-app/.env USER@VPS:~/aiquarium/aiquarium-app/.env
#    oder von Hand anlegen:
#      OPENROUTER_API_KEY=…
#      GEMINI_API_KEY=…
#      optional: TELEGRAM_BOT_TOKEN=… / TELEGRAM_CHAT_ID=…
#      optional: PORT=3077

# 4. Prüfen & starten
npm run check          # Syntax aller Module
npm test               # optional: alle Test-Suiten (nutzen Wegwerf-DBs)
npm start              # Server auf http://localhost:3077, legt die Welt-DB an
```

## Update (jedes Mal, wenn ein neuer Commit gepusht wird)

```bash
cd ~/aiquarium/aiquarium-app
git pull
npm run check
sudo systemctl restart aiquarium     # oder wie dein Server läuft (siehe unten)
# Danach im Browser: Strg+Shift+R (hart neu laden) – der Dateiname
# kiez-aerial.jpg bleibt gleich, sonst zeigt der Cache das alte Bild.
```

## Luftbild (kiez-aerial.jpg) auf dem VPS

**Bewusst KEIN Fetch nötig.** Die Datei ist im Git getrackt und reist mit
jedem Commit. Nur wenn es zwingend auf dem VPS neu geholt werden soll:

```bash
node scripts/fetch-luftbild.js
```

Das braucht ausgehendes Netz zu `geodienste.hamburg.de` (Hamburger DOP-WMS).
**Fallstrick:** Der DB-Pfad ist dort hardcodiert auf
`/home/node/.local/share/aiquarium/world.sqlite`. Läuft der VPS als anderer
User, fällt das Skript ersatzweise auf die SEED_POIs zurück – die
Bild-Geometrie könnte dann vom Live-Diorama abweichen. Deshalb besser die
Repo-Datei nutzen.

## Server dauerhaft laufen lassen (systemd)

```ini
# /etc/systemd/system/aiquarium.service
[Unit]
Description=AIquarium Hamburg St. Pauli
After=network.target

[Service]
WorkingDirectory=/home/DEINUSER/aiquarium/aiquarium-app
ExecStart=/usr/bin/node src/server.js
Restart=always
User=DEINUSER

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now aiquarium
sudo systemctl status aiquarium      # läuft er?
```

## Als Website hinter nginx/Caddy (wichtig wegen SSE!)

Der Live-Feed (`/api/stream`) ist Server-Sent Events – Proxy-Buffering muss aus.

```nginx
server {
    server_name aquarium.example.de;
    location / {
        proxy_pass http://127.0.0.1:3077;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;          # sonst hängt der Live-Feed (SSE)
        proxy_read_timeout 1h;
    }
}
```

## Troubleshooting

- **Luftbild erscheint nicht / ist veraltet:** hart neu laden (Strg+Shift+R).
  Ein 404 auf `/kiez-aerial.jpg` ist unkritisch (Fallback: prozeduraler Boden).
- **Port ändern:** `PORT=…` in die `.env` oder `Environment=PORT=…` in der
  systemd-Unit.
- **Welt neu starten:** `npm run reset` (Backup + DB löschen), dann `npm start`.
- **Logs:** `journalctl -u aiquarium -f` (systemd) bzw. Server-Konsolen-Output
  (`[model]`/`[luftbild]`/`[lod2]`-Zeilen sind die wichtigsten Hinweise).

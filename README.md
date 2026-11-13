# AIquarium — v0.1-Kern

Ein kleiner Mond, ein Piloten-Charakter, der ohne Publikum weiterlebt.
Die Engine rechnet die Wahrheit, das Modell bekommt nur Körpergefühle und entscheidet,
was der Charakter tut und denkt.

Stand 2026-11-14: Kugel begehbar, Vorhaben + Weg, Tag/Nacht als rotierende Sonne
(kein globales Dimmen), Finsternis in 4 Stufen, 2-Schichten-Werte (Körper/Psyche +
Hunger/Thermo/Drang/Halt). Tests: 84, davon 5 rot → Paket R in
`notes-for-creator-and-agents/01 Umsetzung.md`.

Fachlicher Plan: `notes-for-creator-and-agents/` (00 Stand = Einstieg,
01 Umsetzung = einzige Arbeitsdatei, 03 Nice to Haves = Wünsche).

## Start

```bash
cd /workspaces/seb-dev/aiquarium/aiquarium-app
cp .env.example .env     # OPENROUTER_API_KEY eintragen (wird beim Start geladen)
npm start                # http://127.0.0.1:3077
```

Node ≥ 22.5 (nutzt das eingebaute `node:sqlite`), keine npm-Abhängigkeiten.
Repo-Root ist `aiquarium-app/` (Rename 2026-11-14, `.git` liegt darin).
Bedienung (Stoppen, Debug-Log, Dev-Werkzeuge, Problemlösung): siehe [BEDIENUNG.md](BEDIENUNG.md).

## Aufbau

| Datei | Aufgabe |
|---|---|
| `src/config.js` | alle Zahlen an einer Stelle: Verbrauch, Aktionsdauern, Schwellen, Orte, Tag/Nacht, Finsternis |
| `src/db.js` | Schema, Seed, Abfragen, Pruning |
| `src/engine.js` | Tick, Werte, Bewegung, Tod, Neustart, Stupor/Wahn, Catch-up, Vorhaben, Tag/Nacht |
| `src/prompt.js` | Whitelist/AVAIL, Körpersprache, Forscher-Baukasten (spec'd), Tag/Nacht-Zeilen |
| `src/belief.js` | Glaubenssätze: die Figur formuliert selbst, Messung kommt aus der Engine |
| `src/brain.js` | Modellaufruf mit Timeout, Retry, Validierung, Musterbremse |
| `src/checks.js` | Post-Checks (JSON, Whitelist, Länge, Sprache, Novelty, Ausruf, Bedürfnis-Sätze) |
| `src/env.js` | Mini-`.env`-Leser (kein Paket nötig) |
| `src/names.js` | Piloten-Namen (Komposit, Dopplung römisch) |
| `src/server.js` | HTTP, SSE, sequenzielle Schleife, `/api/state|feed|dev/*`, statische Dateien |
| `public/index.html` | HUD: Zustand, Werte, Treiber, Feed, Kamera-Umschalter |
| `public/scene.js` | 3D: Kugel, Cluster-Orte, Figur, 2 Kameras, Sonne/Erde/Finsternis, Deko, Dev-Grid |
| `public/engine/three.module.js` | Three.js, lokal (kein CDN, kein Build) |

## Tests

```bash
npm test          # 84 Tests (5 rot = Paket R, siehe 01 Umsetzung)
npm run check     # Syntaxprüfung aller Module
```

## Release (Hermes-VPS)

- Repo: `github.com/jenerseb/aiquarium`, Root = `aiquarium-app/`
- Service: `node src/server.js`, Port 3077 (bindet localhost, Hermes hängt Subdomain + TLS davor)
- Env nur auf dem Server: `OPENROUTER_API_KEY` (+ ggf. `PORT`, `AIQUARIUM_DB`) — nie im Repo (`.gitignore`: `.env`, `*.sqlite*`, `node_modules/`)
- DB extern: `AIQUARIUM_DB` auf persistentes Verzeichnis (nicht im Checkout), Deploy berührt sie nie
- Flow: lokal → `npm test` + `npm run check` grün → `git push` → Hermes-Redeploy → live. Rollback = alter Commit redeployen.

## Prinzipien, die im Code stecken

- **Die Whitelist steuert, nicht der Prompt.** Wertschwellen und Zustand entscheiden, welche
  Aktionen überhaupt wählbar sind; das Modell formuliert nur.
- **Nie stillstehen.** Fällt das Modell aus, läuft eine deterministische Ersatzaktion und der
  Zustand wird als `stale` gemeldet.
- **Sterben ist Konsequenz, kein Würfel.** Der Tod folgt aus Futter und Kraft.
- **Offline-Zeit wird nachgerechnet, nicht erfunden.** Max. 12 h, danach ein Ereignis.

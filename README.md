# AIquarium — v0.1-Kern

Ein kleiner Mond, ein Piloten-Charakter, der ohne Publikum weiterlebt.
Die Engine rechnet die Wahrheit, das Modell bekommt nur Körpergefühle und entscheidet,
was der Charakter tut und denkt.

Fachlicher Plan: `vault-privat/Seb Privat Stuff/ai-terrarium/master_implementation_roadmap.md`

## Bedienung

Starten, Stoppen, Debug-Log und Problemlösung: siehe [BEDIENUNG.md](BEDIENUNG.md).

## Start

```bash
cp .env.example .env     # OPENROUTER_API_KEY eintragen (wird beim Start geladen)
npm start                # http://127.0.0.1:3077
```

Node ≥ 22.5 (nutzt das eingebaute `node:sqlite`), keine npm-Abhängigkeiten.

## Aufbau

| Datei | Aufgabe |
|---|---|
| `src/config.js` | alle Zahlen an einer Stelle: Verbrauch, Aktionsdauern, Schwellen, Orte |
| `src/db.js` | Schema, Seed, Abfragen |
| `src/engine.js` | Tick, Werte, Bewegung, Tod, Neustart, Stupor/Wahn, Catch-up |
| `src/prompt.js` | Wesen als Gewichte, Körpersprache, Whitelist |
| `src/belief.js` | Glaubenssätze: die Figur formuliert selbst, Messung kommt aus der Engine |
| `src/brain.js` | Modellaufruf mit Timeout, Retry, Validierung |
| `src/checks.js` | Post-Checks (JSON, Whitelist, Länge, Sprache, Novelty, Ausruf) |
| `src/server.js` | HTTP, SSE, sequenzielle Schleife |
| `public/index.html` | HUD: Zustand, Werte, Feed, Kamera-Umschalter |
| `public/scene.js` | 3D-Mockup: Planet, Orte, Figur, drei Kameras, Sprechblase |
| `public/engine/three.module.js` | Three.js r169, lokal (kein CDN) |

## Tests

```bash
npm test
```

## Prinzipien, die im Code stecken

- **Die Whitelist steuert, nicht der Prompt.** Wertschwellen und Zustand entscheiden, welche
  Aktionen überhaupt wählbar sind; das Modell formuliert nur.
- **Nie stillstehen.** Fällt das Modell aus, läuft eine deterministische Ersatzaktion und der
  Zustand wird als `stale` gemeldet.
- **Sterben ist Konsequenz, kein Würfel.** Der Tod folgt aus Futter und Kraft.
- **Offline-Zeit wird nachgerechnet, nicht erfunden.** Max. 12 h, danach ein Ereignis.

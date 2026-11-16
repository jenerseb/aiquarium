# AIquarium Hamburg · St. Pauli

Ein kleines „digitales Aquarium" in einem echten Stück Hamburg-St. Pauli.
Ein KI-Charakter wacht in einer Einzimmerwohnung in der Lerchenstraße auf –
mit 18 Euro, einem Notizbuch und null Wissen über die Stadt.
Du schaust zu, wie er den Kiez erkundet, Pfand sammelt, sich Jobs sucht,
Zettel hinterlässt und nachts im Schlaf seinen Tag sortiert.

Die Welt läuft in echter Hamburger Zeit (`Europe/Berlin`), die Aktionen
im komprimierten Aquarium-Tempo (z. B. 20 Minuten pro Arbeitsschicht,
35 Minuten Schlaf).

---

## Schnellstart

Voraussetzung: **Node.js ≥ 22.5**, sonst nichts.
Es gibt bewusst **keine npm-Abhängigkeiten** (`node:sqlite`, `node:http` und
`fetch` aus Node reichen). Ein `npm install` ist nicht nötig.

```bash
cd aiquarium-app

# 1. Prüfen: Syntax aller Module
npm run check

# 2. Testen: Datenbank + Route (M1) und Komplettablauf mit Mock (M2)
npm test

# 3. Starten: Server auf http://localhost:3077
npm start
```

Beim ersten Start wird die Welt-Datenbank automatisch angelegt und mit der
Startwelt befüllt (Wohnung, 8 Orte, Stadtlexikon, Notizbuch).
Standardpfad: `~/.local/share/aiquarium/world.sqlite` – absichtlich
außerhalb des syncenden Ordners. Per `AIQUARIUM_DB=/pfad/zu/world.sqlite`
in der `.env` änderbar.

## Geodaten-Quellen

- **Gebäude:** Echte ALKIS-Einzelhäuser vom Hamburger INSPIRE-WFS
  (`HH_WFS_INSPIRE_Gebaeude_2D_ALKIS`, `bu-core2d:Building`: Footprint,
  Innenhöfe als `holes`, Höhe aus Geschosszahl `× 3,2 m`), frisch per
  `node scripts/fetch-hamburg-geodata.js` nach `data/hamburg_geodata.json`
  (862 Häuser in unserer Box, 6 mit Innenhof), Lizenz **Datenlizenz
  Deutschland – Namensnennung – 2.0** (Quelle: Freie und Hansestadt
  Hamburg, LGV). Fallback bei WFS-Ausfall: OSM-Blöcke aus `kiez_map.json`.
- **Bäume:** Hamburger Straßenbaumkataster (`HH_WFS_Strassenbaumkataster`,
  `de.hh.up:strassenbaumkataster`), frisch per
  `node scripts/fetch-hamburg-geodata.js` nach `data/hamburg_geodata.json`
  (1126 Bäume in unserer Box), Lizenz **Datenlizenz Deutschland –
  Namensnennung – 2.0** (Quelle: Freie und Hansestadt Hamburg, BUKA).
- Routing (`navGraph`) bleibt immer OSM aus `data/kiez_map.json`.
- **LoD2-3D:** Echte Wand- + Dach-Dreiecke aus dem 3D-Stadtmodell LoD2-DE
  (3D-Tiles/b3dm, `data/hamburg_lod2.json`, 1288 Häuser, ~61k Dreiecke),
  gemergt in 2 Draw Calls, Lizenz **dl-de/by-2.0** (FHH, LGV).

## Was kann er gerade? (Stand: Meilenstein 2)

- **Loslaufen & entdecken:** Er läuft auf echten Bürgersteigen (A*-Wegfindung
  über OpenStreetMap-Daten, 550 Gebäude, 1307 Wegknoten) und entdeckt Orte
  erst, wenn er nah genug dran ist (22 m).
- **Essen & ausgeben:** Wünsche wie „Pommes mit Ketchup" prüft ein
  Welt-Arbiter auf Plausibilität und Preis, klammert sie in feste Grenzen
  und merkt sie sich dauerhaft – so entsteht organisch eine Speisekarte.
- **Arbeiten:** Per Zettel (`leave_note`) bewerben, Zusage vom (autonomen)
  Ladenbesitzer oder per Telegram, Schichten für 8–18 € arbeiten.
  Wer krank zur Schicht kommt, kassiert einen Strike – beim zweiten ist
  der Job weg.
- **Schlafen & träumen:** Schläft er daheim, fasst einmal pro Tag ein
  Nacht-Call den Tag in einer Schlagzeile zusammen, lernt eine Gewohnheit
  und räumt sein Gedächtnis auf (25 Kurz- + 25 Langzeit-Slots).
- **Sterben & neu anfangen:** Fällt seine Gesundheit auf null, landet er in
  der Hall of Fame – und ein neuer Stadterkunder beginnt bei null.

Wichtigste Regel der Welt: **Die Engine rechnet, das Modell spürt nur.**
Geld, Zeit und Prozentwerte sieht die KI nie – sie bekommt Sätze wie
*„Der Magen knurrt, du wirst unkonzentriert"* und antwortet mit einem
kleinen Plan aus 2–4 Schritten.

## Mit ihm reden (optional)

Ohne Telegram läuft alles autonom – der Ladenbesitzer antwortet von selbst.
Mit Telegram wird es interaktiv:

1. Bot beim `@BotFather` anlegen, Token und Chat-ID besorgen.
2. In die `.env` eintragen (liegt nie im Git!):
   `TELEGRAM_BOT_TOKEN=…` und `TELEGRAM_CHAT_ID=…`
3. Server starten. Zettel, SMS und E-Mails landen dann in deinem Chat,
   und du antwortest z. B. mit `JA Kiezling Spülhilfe 12` –
   schon hat er den Job.

Ohne Keys passiert nichts Schlimmes: Nachrichten landen als
`[telegram:aus]` im Server-Log.

## API für Neugierige

| Aufruf | Was kommt zurück |
|---|---|
| `GET /api/state` | Werte, Position, Feed, Weltuhr |
| `GET /api/brain` | „Gehirn": Sheet, Memories, Loops, Fame |
| `GET /api/stream` | Live-Ticks als SSE |
| `POST /api/dev/tick` | Schritt von Hand (nur localhost) |
| `POST /api/dev/nightly` | Nacht-Call von Hand (nur localhost) |

## Projektstruktur

```
aiquarium-app/
├── masterplan_aiquarium_hamburg_mvp.md  # die verbindliche Spezifikation
├── data/kiez_map.json                   # echte OSM-Karte (wird ignoriert, s. .gitignore)
├── scripts/
│   ├── fetch-osm.js                     # Karte neu von Overpass laden
│   ├── test-m1.js                       # DB + Route prüfen
│   └── test-m2.js                       # Komplettablauf mit Mock prüfen
├── src/
│   ├── config.js      # alle Zahlen: Orte, Werte, Preise, Modell-Routing
│   ├── db.js          # Schema + Startwelt (8 Orte, Sheet, Bücher)
│   ├── pathfinding.js # A* über Bürgersteige
│   ├── memory.js      # Gedächtnis-Mathe (worth, Verdrängung)
│   ├── prompt.js      # Wahrnehmung in Gefühlssätzen, Plan-Format
│   ├── arbiter.js     # Angebote, Jobs, Bewerbungen, Nacht-Call
│   ├── engine.js      # Tick-Loop, Aktionen, Tod & Respawn
│   ├── brain.js       # einziger Ort mit Modell-Calls (mit Retry)
│   ├── checks.js      # Antwort- und Plan-Validierung
│   ├── telegram.js    # Außenwelt-Bridge (mit Log-Fallback)
│   ├── server.js      # HTTP/SSE-API + Tick alle 20 s
│   └── env.js         # Mini-.env-Leser (ohne Paket)
└── public/engine/     # Three.js (nur ausgeliehen, kein Build)
```

## Nützliche Befehle

```bash
npm start        # Server starten (Port 3077, per PORT=… änderbar)
npm test         # alle drei Test-Suiten (Temp-DBs, echte DB bleibt sauber)
npm run test:m1  # nur DB + Route
npm run test:m2  # nur Komplettablauf mit Mock
npm run test:m3  # nur 3D-Szene + API-Endpunkte (startet eigenen Server)
node scripts/fetch-osm.js  # Karte frisch von OpenStreetMap laden
```

Danach im Browser öffnen:

- `http://localhost:3077/` – die 3D-Stadt (Charakter-Kamera, HUD, Feed)
- `http://localhost:3077/?dev` bzw. `?mode=dev` – zusätzlich Dev-Buttons für
  1 Tick und 1 Nightly-Call
- `Gehirn`-Button oben rechts – 4 Tabs: Kopf, Character Sheet, Gedächtnis,
  Chronik
- Kamera: ziehen = drehen, Rad = zoomen, weit raus = Kiez-Blick von oben

## Neue POIs vorschlagen & übernehmen

`node scripts/poi-vorschlag.js [N] [--kategorie=...]` schlägt die nächsten N
benannten OSM-Amenities vor, die noch kein POI sind (Default 10, lesend,
ohne Netz). Filter: nur innerhalb LoD2-Gebäude-BBOX, östlich der
Max-Brauer-Allee (`x >= -260`), innerhalb Diorama-Radius (`R-4`), mind.
40 m vom nächsten POI entfernt. Ranking: Gastro/Kultur vor Denkmal, dann
nah am Apartment. Beispiel: `node scripts/poi-vorschlag.js 10` oder
`node scripts/poi-vorschlag.js 5 --kategorie=cafe,restaurant`.

1. Block aus der Ausgabe in `src/db.js` ans `SEED_POIS`-Ende kopieren
   (`discovered: 0`, `public_desc` mit 1 Satz Atmosphäre füllen).
2. `node scripts/test-poi-snap.js` – erzwingt OSM-Match (`< 1 m`),
   Straßennähe (`≤ 60 m`) und Route `< 2000 m`.
3. `node scripts/reseed-pois.js [db]` für Live-DBs, dann
   `npm run check && npm test` (Counts sind dynamisch via
   `SEED_POIS.length`, kein Hochzählen nötig).


## Gut zu wissen

- **Kosten:** Tagsüber laufen günstige/Free-Modelle
  (`gemma-4-26b`, `glm-5.3-flash`, `nemotron Free`), nur der eine
  Nacht-Call nutzt `mimo-v2.6-pro`. Mit `AIQUARIUM_MODEL=…` in der `.env`
  lässt sich das Tagesmodell tauschen.
- **Ohne Key geht's auch:** Fehlt `OPENROUTER_API_KEY`, läuft die Welt mit
  deterministischen Fallbacks weiter – gut zum Entwickeln und Testen.
- **3D kommt später:** `public/` enthält vorerst nur Three.js als
  Platzhalter; Szene, Kamera und Gehirn-Overlay sind der nächste Schritt.
- **Daten:** Die echte Welt-DB liegt außerhalb des Repos und wird nie
  committet (siehe `.gitignore`). Tests nutzen immer Wegwerf-DBs in `$TMPDIR`.

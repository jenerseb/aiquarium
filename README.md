# AIquarium Hamburg · St. Pauli

Ein kleines „digitales Aquarium" in einem echten Stück Hamburg-St. Pauli.
Ein KI-Charakter wacht in einer Einzimmerwohnung in der Lerchenstraße auf –
mit 18 Euro, einem Notizbuch und null Wissen über die Stadt.
Du schaust zu, wie er den Kiez erkundet, Pfand sammelt, sich Jobs sucht,
Zettel hinterlässt und nachts im Schlaf seinen Tag sortiert.

Die Welt läuft in echter Hamburger Zeit (`Europe/Berlin`), viele Aktionen
laufen im Echtzeit-Timer (z. B. `15 Min` Ausruhen, `2–10 h` Nachtschlaf),
Wege und andere Schritte im komprimierten Aquarium-Tempo. Details zu allen
Raten und Regeln stehen in [`gehirn_und_welt_logik.md`](gehirn_und_welt_logik.md).

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

## Was kann er gerade?

- **Loslaufen, joggen & entdecken:** Er läuft auf echten Bürgersteigen (A*-Wegfindung
  über OpenStreetMap-Daten, `walk_to` / `explore_street`, Innenpunkte in Parks und
  Gebäuden) oder dreht einen `jog`-Rundlauf (`+75 %` Tempo) und entdeckt Orte
  erst, wenn er nah genug dran ist (`22 m`).
- **Essen & ausgeben:** Wünsche wie „Pommes mit Ketchup" prüft ein
  Welt-Arbiter auf Plausibilität und Preis, klammert sie in feste Grenzen
  und merkt sie sich dauerhaft – so entsteht organisch eine Speisekarte.
- **Arbeiten & Projekte:** Per Zettel (`leave_note`) bewerben, Zusage vom (autonomen)
  Ladenbesitzer oder per Telegram, Schichten für 8–18 € arbeiten.
  Wer krank zur Schicht kommt, kassiert einen Strike – beim zweiten ist
  der Job weg. Daneben arbeitet er an Projekten (`work_on_project`), liest
  Bücher/`stadtlexikon` (max. 1×/Tag) oder nutzt `web_search` (max. 1×/Tag).
- **Ausruhen, schlafen & träumen:** `rest` (`15 Min` Echtzeit) erholt nur leicht;
  `sleep` (`2–10 h` Echtzeit je nach Müdigkeit, abgestimmt auf das Aufwachfenster
  `06:00–11:00 Uhr`) regeneriert laufend während des Timers (`-18/h` Müdigkeit,
  `+1,5/h` Hunger, `-1/h` Froh, `+4/h` Gesundheit bis zum Chunk-Cap). Schläft er
  daheim, fasst einmal pro Tag ein Nacht-Call den Tag in einer Schlagzeile
  zusammen und räumt sein Gedächtnis auf (25 Kurz- + 25 Langzeit-Slots).
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

## Welches Modell wird wann gerufen? → `model.json`

Das komplette Modell-Routing steht in **einer Datei: `model.json`** (Projekt-Root, mit
`_lies_mich`-Erklärung direkt in der Datei). `src/config.js` ist nur der Loader.

| Rolle | Wofür | Kette (Reihenfolge = Fallback) |
|---|---|---|
| `alltag` | Tages-Pläne (alle ~20 s, 150–250 Calls/Tag) | google gemma → gemma `:free` → nemotron `:free` |
| `arbiter` | Welt-Checks („Pommes“: plausibel? Preis?) | google gemma → `glm-5.3-flash` → `mistral-nemo` |
| `nightly` | Nacht-Call (1×/Tag beim Schlafen) | google gemma → `mimo-v2.6-pro` |
| `dev` | Experimente (separat vom Alltag) | google gemma → gemma `:free` → nemotron `:free` |

- **Eintrag 1 wird probiert; bei Fehler (429/Timeout/kaputtes JSON) kommt Eintrag 2, dann 3.**
- `google`-Einträge brauchen `GEMINI_API_KEY` in der `.env` — fehlt der Key, werden sie beim
  Start übersprungen (mit Log-Zeile) und die Kette startet beim nächsten OpenRouter-Modell.
- **Modell tauschen:** in `model.json` den Slug ändern / Zeile löschen / Reihenfolge tauschen →
  `npm start` neu. Beispiel „nachts zwingend mimo“: google-Eintrag in `rollen.nightly` löschen.
- **Env-Overrides für Modelle gibt es nicht mehr** (`AIQUARIUM_MODEL` & Co. sind entfernt) —
  eine Quelle, eine Wahrheit. Keys (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`) bleiben in der `.env`.
- Was wirklich gerufen wurde: Feed-Badges (`[gemma] [free] [148 tok]` / `[fallback]`), der
  LLM-Input/Debug-Aufklapper im Gehirn → Chronik-Tab, und beim Start druckt der Server die
  effektive Tabelle (`[model]`/Routing-Zeilen im Terminal).

## API für Neugierige

| Aufruf | Was kommt zurück |
|---|---|
| `GET /api/state` | Werte, Position, Feed, Weltuhr, Aktivitätstimer |
| `GET /api/map` | Statische Kiez-Geometrie (Gebäude, Bäume, Straßen, Parks, POIs) |
| `GET /api/poi/:id` | POI-Details (`?dev=1` für alle POIs + Dev-Metadaten; sonst nur entdeckte POIs mit abgespeckten Infos) |
| `GET /api/brain` | „Gehirn": Sheet, Memories, Loops, Fame, LLM-Input/Fehler-Debug |
| `GET /api/stream` | Live-Ticks als SSE |
| `GET /api/dev/llm-log` | Letzte erfolgreiche LLM-Calls (Dev) |
| `POST /api/dev/tick` | Schritt von Hand (nur localhost) |
| `POST /api/dev/nightly` | Nacht-Call von Hand (nur localhost) |

## Welt neu starten (Simulation von 0)

```bash
npm run reset       # Backup der alten Welt + DB löschen
npm start           # Welt neu anlegen + simulieren
```

Ohne Backup direkt: `npm run reset:hard`. Anderer Pfad: `node scripts/reset-world.js --pfad=/pfad/zu/world.sqlite`.
Kopierbarer Einzeiler (ohne npm): `cd aiquarium-app && rm -f ~/.local/share/aiquarium/world.sqlite* && npm start`

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

- `http://localhost:3077/` – die 3D-Stadt (Charakter-Kamera, HUD, Aktivitätspille, Feed)
- **URL-Parameter (frei kombinierbar):**
  - `?dev` bzw. `?mode=dev` – Dev-Modus (Buttons für `1 Tick` / `Nightly`, `LLM-Log`, unentdeckte POI-Namen + volle POI-Modal-Details, Park-/Baum-Grün, Routenlinie & Dev-Strecken)
  - `?map=clay` – Clay-/Modell-Kartenstil (ohne Luftbild, mit Grünzeug)
  - `?photo=<0..100>` – Luftbild-Deckkraft auf dem Boden in Prozent (Standard: `0` bei `?map=clay`, sonst `100`)
  - `?roof=<0..100>` – Luftbild-Deckkraft auf den 3D-Dächern in Prozent (Standard: `0` bei `?map=clay`, sonst `100`; bei `roof > 0` sind die 3D-Dächer darunter grau statt ziegelrot)
  - `?ax=<m>&az=<m>&ascale=<f>` – Luftbild-Kalibrierung (Boden + Dächer gemeinsam; Standard: `ax=0, az=9.2, ascale=0.988`)
  - `?round=<0..100>` – Abrundungs-Faktor der 3D-Gebäudekanten in Prozent (Standard: `45`)
  - `?fx=<liste>` – Stilisierungsfilter, kommagetrennt kombinierbar: `warm,pixel,sobel,paint,tilt,crt,noir`
- **Interaktion in der 3D-Szene:**
  - Klick/Tap auf POI-Marker oder -Namen öffnet das POI-Info-Modal (Beschreibung, Adresse, mögliche Aktivitäten, Angebote, Besuche; im Normal-Modus nur entdeckte POIs, im Dev-Modus alle)
  - Klick auf ein Gebäude schaltet die Indoor-Transparenz um
  - `Gehirn`-Button oben rechts – 4 Tabs: Kopf, Character Sheet, Gedächtnis, Chronik
  - Kamera: ziehen = drehen, Rad/Pinch = zoomen; die Gedankenblase wird nur in der Nah-Kamera (`Nah (Charakter)`) angezeigt

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


## Deployment (VPS)

Das AIquarium läuft auch als Website auf einem VPS – ohne `npm install`
(keine Abhängigkeiten), nur Node ≥ 22.5. Kurzfassung:

```bash
git pull && npm run check && sudo systemctl restart aiquarium
```

Wichtig: Die `.env` (API-Keys) kommt **nie** mit dem Git und muss einmalig
auf dem VPS angelegt werden; die Welt-DB entsteht beim ersten Start
automatisch. `public/kiez-aerial.jpg` und die Geodaten sind getrackt und
kommen mit jedem Pull mit. Komplett-Anleitung inkl. systemd-Unit,
nginx-SSE-Config und Troubleshooting: **[deploy-vps.md](deploy-vps.md)**.

## Gut zu wissen

- **Kosten & Routing:** Modell-Ketten und Rollen werden zentral in `model.json`
  konfiguriert; API-Keys (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`) liegen in der `.env`.
- **Ohne Key geht's auch:** Fehlen die API-Keys, läuft die Welt mit
  deterministischen Fallbacks weiter – gut zum Entwickeln und Testen.
- **3D-Szene & Doku:** Die Three.js-Szene lebt in `public/scene.js`; die
  aktuellen Simulations- und KI-Regeln sind in [`gehirn_und_welt_logik.md`](gehirn_und_welt_logik.md) dokumentiert.
- **Daten:** Die echte Welt-DB liegt außerhalb des Repos und wird nie
  committet (siehe `.gitignore`). Tests nutzen immer Wegwerf-DBs in `$TMPDIR`.

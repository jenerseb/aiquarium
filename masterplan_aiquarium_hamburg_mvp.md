# AIquarium · Hamburg St. Pauli MVP — Architektur- & Umsetzungsplan

Dieses Dokument ist die verbindliche Spezifikation für die lokale Coding-KI zum Aufbau des neuen `main`-Branches. Ziel ist ein schlankes, erweiterbares „Digitales Aquarium“ in einem realen Ausschnitt von Hamburg-St. Pauli, in dem ein KI-Charakter mit null Vorwissen über die Stadt startet, Orte erkundet, sich emergent Jobs sucht, eigene Charakterzüge und Langzeit-Projekte entwickelt und über eine Telegram-Bridge mit dem Schöpfer (als Außenwelt) interagiert.

---

## 1. Kern-Prinzipien (Nicht verhandelbar)

1. **Zero-Build & Low-Budget Stack:**
   * **Backend:** Node.js ($\ge 22.5$), eingebautes `node:sqlite`, nativer HTTP-Server + Server-Sent Events (`/api/stream`), keine Laufzeit-Abhängigkeiten (`node_modules` frei halten).
   * **Frontend:** Statisches HTML/CSS + Vanilla ES-Modules (`public/scene.js`, `public/engine/three.module.js`) ohne Astro, Webpack oder Vite. Neben dem `Feed` gibt es ein `Gehirn`-Overlay (Inspiriert von *pino's brain*), das live sein Character Sheet, seine Erinnerungen und offene Gedankenfäden zeigt.
2. **Die Engine rechnet die Wahrheit, das Modell spürt nur Konsequenzen:**
   * Kleine Sprachmodelle im Tagesbetrieb rechnen niemals selbst mit Geld, Uhrzeiten oder Prozentwerten.
   * Die Engine prüft Kontostände, klammert alle Effekte hart ein, zählt Übungsfortschritt (`practised`) und übersetzt Zahlen in natürliche Wahrnehmungssätze für den Prompt.
3. **Gezieltes Modell-Routing (`model.json`):**
   * **`dev` / `primary` (Tages-Entscheidungen, ca. 150–250 Calls/Tag):** Schnelle, günstige Modelle wie `nvidia/nemotron-3.5-super-vl:free`, `google/gemma-4-26b` oder `z-ai/glm-5.3-flash`.
   * **`arbiter` (Kurze Welt-Checks bei neuen Ideen/Preisen):** Kleines, schnelles Modell wie `mistralai/mistral-nemo` oder `z-ai/glm-5.3-flash`.
   * **`nightly` (1× pro Echtzeit-Tag beim Schlafen):** Starkes Modell wie `xiaomi/mimo-v2.6-pro` für die nächtliche Gesamtkonsolidierung (Tages-Schlagzeile, Gewohnheitserkennung fürs Character Sheet, Gedächtnis-Ausmisten und Offene-Fäden-Pflege in einem einzigen Call).
4. **Open Intent + Bounded World Arbiter:**
   * Keine hartcodierten Speisekarten. Der Charakter darf sich in jedem Laden frei ausdenken, was er konsumieren (`consume`) oder tun (`do_activity`) möchte.
   * Ein günstiger „Welt-Arbiter“-Check prüft einmalig Plausibilität und Preis innerhalb harter Engine-Grenzen und cached das Ergebnis dauerhaft in SQLite (`poi_offers`).
5. **Fluff vs. Hard State:**
   * Der Charakter darf Smalltalk mit Barkeepern oder Passanten im Freitext beschreiben (Fluff).
   * Harte Zustandsänderungen (Jobzusage, Gehalt, Außenwelt-Kontakt) entstehen **niemals** durch Halluzination des Charakters, sondern ausschließlich über schriftliche Aktionen (`leave_note`, später `send_sms`/`send_email`) und die Entscheidung von Telegram-Bridge oder Welt-Arbiter.
6. **Echtzeit-Uhr + Komprimierte Aktionsdauer:**
   * Die Weltuhr läuft in echter Hamburger Zeit (`Europe/Berlin`, CET/CEST).
   * Aktionen laufen in „Aquarium-Zeit“ (z. B. $20\text{ min}$ Echtzeit für eine Arbeitsschicht, $35\text{ min}$ für Schlaf), damit Beobachter zu jeder Tageszeit ein lebendiges Geschehen sehen.

---

## 2. Git-Migration: Weltraum-Version archivieren & Neustart

Vor Beginn der Code-Arbeiten wird der bisherige Weltraum-Stand gesichert und `main` sauber geleert:

```bash
# 1. Aktuellen Stand auf Archiv-Branch + Tag sichern
git checkout -b archive/space-v0.1
git tag v0.1-space-archive
git push origin archive/space-v0.1 --tags

# 2. Aus dem alten Stand nur die wiederverwendbaren Basis-Module merken:
#    src/env.js, src/checks.js (Grundstruktur), src/brain.js (Slot-Routing), public/engine/three.module.js

# 3. Zurück auf main und Ballast entfernen
git checkout main
# Alte Kugel-/Weltraum-Dateien bereinigen und neue Struktur anlegen
```

### Was aus dem alten Code übernommen wird (ca. 25 %)
* `src/env.js`: Minimaler `.env`-Loader ohne Änderungen.
* `src/brain.js`: OpenRouter-Aufruf mit Multi-Slot-Routing (`dev`, `primary`, `fallback`, erweitert um `arbiter` und `nightly` mit `xiaomi/mimo-v2.6-pro`).
* `src/checks.js`: Wortzähler, CJK-/Englisch-Filter, Jaccard-Ähnlichkeit, JSON-Validierung (angepasst auf Multi-Step-Pläne und Retrospektiven).
* `src/server.js`: Grundgerüst aus HTTP-Server, `/api/state`, `/api/stream` (SSE), `/api/health` und sequenziellem Loop.
* `public/engine/three.module.js`: Lokale Three.js-Datei.

### Was komplett gelöscht wird (75 % Ballast)
* Komplette 3D-Kugel-Geometrie (`WORLD_RADIUS`, `vec3`, `schritt3`, `tangentialRahmen`, Polflaggen, Saturnringe, Finsternis).
* Alte Weltraum-Mechaniken (`stupor`, `wahn`, `mania`, `knock`, `call_bake`, `tend_dome`).

---

## 3. Ziel-Ordnerstruktur

```text
aiquarium-app/
├── .env.example
├── model.json                  # Modell-Slots: primary, fallback, dev, arbiter, nightly (mimo-v2.6-pro)
├── package.json
├── data/
│   ├── kiez_map.json           # Statische OSM-Gebäude & Gehweg-Graph (St. Pauli Dreieck)
│   ├── seed_pois.json          # Initiale POIs (Name, Koordinaten, Atmosphäre-Text, Typ)
│   ├── seed_sheet.json         # Vom Schöpfer geschriebenes Start-Character-Sheet
│   └── seed_books.json         # Bücher im Wohnungs-Regal (Inhaltsverzeichnis + Kapiteltexte)
├── scripts/
│   └── fetch-osm.js            # Einmal-Skript: Zieht OSM-Gebäude & Wege via Overpass API
├── src/
│   ├── env.js                  # .env Loader
│   ├── config.js               # Globale Konstanten, Wirtschafts-Grenzen, Zeitdauern, Slot-Limits
│   ├── db.js                   # SQLite-Schema, Migrationen, Queries
│   ├── pathfinding.js          # A*-Wegfindung auf dem OSM-Fußweg-Graphen
│   ├── memory.js               # Slot-Management (Short/Long Term), Worth-Berechnung, First-to-go
│   ├── arbiter.js              # Welt-KI & Nacht-Call: POI-Init, Open-Intent, Job-Eval, Sleep-Consolidation
│   ├── telegram.js             # Telegram-Bot-Bridge (Long-Polling, Reply-Zuordnung, Commands)
│   ├── engine.js               # Tick-Loop, Plan-Queue, Interrupts, Werte, Jobs/Strikes, Projekte
│   ├── prompt.js               # System-Prompt, Körpergefühl, Sheet, Gedächtnis, Offene Fäden, Bücher
│   ├── brain.js                # LLM-Client mit Slot-Auswahl
│   ├── checks.js               # Validierung der Modell-Antworten (Plan-JSON, Wortlimit, Novelty)
│   └── server.js               # HTTP + SSE + API-Endpunkte (/api/state, /api/brain, /api/hall-of-fame)
└── public/
    ├── index.html              # HUD, Werte-Balken (20%-Chunks), Feed + "Gehirn"-Drawer (Brain/Memories/Days)
    ├── scene.js                # Flache 3D-Kiez-Szene, OSM-Extrusion, Indoor-Transparenz, Kamera
    └── engine/
        └── three.module.js
```

---

## 4. Datenbank-Schema (`src/db.js`)

Nutze `node:sqlite` (`DatabaseSync`). Alle Koordinaten sind flache Meter-Koordinaten $(x, z)$ relativ zum Ursprung $(0, 0)$ an der Kreuzung **Lerchenstraße / Otzenstraße**.

```sql
CREATE TABLE IF NOT EXISTS world_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tick INTEGER DEFAULT 0,
  last_tick_at TEXT,
  last_nightly_date TEXT,                -- YYYY-MM-DD in Europe/Berlin (verhindert doppelte Nacht-Calls)
  weather TEXT DEFAULT 'clear',
  temperature_c REAL DEFAULT 14.0,
  stats_24h_json TEXT DEFAULT '{}'       -- Zähler: big_model, small_model, queued, autopilot
);

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'alive',           -- 'alive' | 'dead'
  gesund REAL DEFAULT 100.0,             -- 0..100 (in 20%-Chunks gedeckelt)
  gesund_chunk_cap REAL DEFAULT 100.0,   -- Aktuelles Schlaf-Maximum (20, 40, 60, 80, 100)
  froh REAL DEFAULT 20.0,                -- -100..+100
  hunger REAL DEFAULT 20.0,              -- 0..100 (niedrig = satt)
  erschoepfung REAL DEFAULT 15.0,        -- 0..100 (niedrig = wach)
  geld REAL DEFAULT 18.00,               -- Euro-Betrag
  pos_x REAL DEFAULT 0.0,
  pos_z REAL DEFAULT 0.0,
  heading_rad REAL DEFAULT 0.0,          -- Blickrichtung in Radiant in der XZ-Ebene
  inside_poi TEXT,                       -- NULL wenn draußen, sonst pois.id
  current_action TEXT DEFAULT 'idle',
  action_started_tick INTEGER,
  action_duration_s INTEGER DEFAULT 0,
  action_target_poi TEXT,
  action_meta_json TEXT,                 -- z.B. {"item": "Cola"} oder Wegpunkte für walk_to
  why_here TEXT,                         -- Kurzer Grund aus dem Plan ("Warum er gerade dort ist")
  plan_queue_json TEXT DEFAULT '[]',     -- Verbleibende Schritte des aktuellen Multi-Step-Plans
  plan_start_snapshot_json TEXT,         -- {froh, gesund, geld, summary} bei Plan-Start für Retrospektive
  created_at TEXT DEFAULT (datetime('now')),
  died_at TEXT,
  cause_of_death TEXT
);

-- Zweigeteiltes Character Sheet (Geschrieben vom Schöpfer vs. Im Schlaf selbst gelernt)
CREATE TABLE IF NOT EXISTS character_sheet (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES characters(id),
  category TEXT NOT NULL,                -- 'like' | 'cares' | 'fears' | 'small_things'
  text TEXT NOT NULL,
  written_by TEXT NOT NULL,              -- 'creator' (unveränderlich) | 'self' (im Schlaf ergänzt)
  source_reason TEXT,                    -- z.B. 'Abends an 5 Tagen bei der Kleinen Pause gewesen'
  times_confirmed INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  last_confirmed_at TEXT DEFAULT (datetime('now')),
  active INTEGER DEFAULT 1               -- 0 = 'let go' (verblasst nach 21 Tagen ohne Bestätigung)
);

-- Begrenztes Gedächtnis mit Verdrängung (z.B. max. 25 Short-Term & 25 Long-Term Slots)
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES characters(id),
  tier TEXT NOT NULL,                    -- 'short' | 'long'
  kind TEXT NOT NULL,                    -- 'fact' | 'moment' | 'person' | 'promise' | 'read' | 'work' | 'belief'
  text TEXT NOT NULL,
  retrospective TEXT,                    -- Optional: "Looking at it again later: ..."
  initial_weight REAL DEFAULT 3.0,       -- 1.0..7.0
  come_back_count INTEGER DEFAULT 1,     -- Steigt jedes Mal, wenn die Erinnerung im Prompt/Alltag berührt wird
  worth REAL DEFAULT 3.0,                -- Berechneter aktueller Wert (entscheidet über 'First to go')
  created_at TEXT DEFAULT (datetime('now')),
  last_recalled_at TEXT DEFAULT (datetime('now'))
);

-- "On his mind": Offene Fäden, Fragen, Wünsche, Versprechen
CREATE TABLE IF NOT EXISTS open_loops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES characters(id),
  kind TEXT NOT NULL,                    -- 'question' | 'want' | 'promise' | 'person'
  text TEXT NOT NULL,                    -- z.B. 'Warum antwortet das B-Movie nicht auf meinen Zettel?'
  urgency REAL DEFAULT 0.5,              -- 0.0..1.0 ("Pulling at him hardest")
  related_poi TEXT,
  status TEXT DEFAULT 'open',            -- 'open' | 'done' | 'faded'
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- "Piece of Work": Echte Langzeit-Projekte an einem Ort (bereit für späteren Subdomain-HTML-Export)
CREATE TABLE IF NOT EXISTS work_pieces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES characters(id),
  title TEXT NOT NULL,                   -- Vom Charakter vergebener Titel
  kind TEXT DEFAULT 'zines',             -- 'zine' | 'guide' | 'sketchbook' | 'collection'
  poi_id TEXT REFERENCES pois(id),       -- Ort, an dem er daran arbeitet (meist 'apartment' oder 'park_bank')
  progress INTEGER DEFAULT 0,            -- 0..100 %
  fragments_json TEXT DEFAULT '[]',      -- Array aus {added_at, text, source}
  status TEXT DEFAULT 'in_progress',     -- 'in_progress' | 'completed' | 'published'
  published_url TEXT,                    -- Später für v0.2 Subdomain-Export
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Externes Welt-Gedächtnis: Bücher im Regal & eigenes Notizbuch in der Wohnung
CREATE TABLE IF NOT EXISTS home_library (
  id TEXT PRIMARY KEY,                   -- z.B. 'stadtlexikon', 'notizbuch', 'pinnwand'
  title TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- 'book' (statisch/gescraped) | 'notebook' (vom Charakter beschrieben)
  entries_json TEXT NOT NULL             -- Array aus {topic, title, content, created_at}
);

-- Übungs-Tracking ("What he practises")
CREATE TABLE IF NOT EXISTS practised (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES characters(id),
  skill_key TEXT NOT NULL,               -- z.B. 'work:otzentreff', 'project:writing', 'pfand_hunting'
  label TEXT NOT NULL,
  goes INTEGER DEFAULT 0,
  level REAL DEFAULT 0.0,                -- 0.00..1.00 (steigt asymptotisch mit goes)
  UNIQUE(character_id, skill_key)
);

-- Tages-Archiv ("Days")
CREATE TABLE IF NOT EXISTS day_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES characters(id),
  date_str TEXT NOT NULL,                -- YYYY-MM-DD
  headline TEXT NOT NULL,                -- Ein-Satz-Zusammenfassung aus dem Nacht-Call
  sheet_changes_json TEXT DEFAULT '[]',  -- Was in dieser Nacht gelernt oder losgelassen wurde
  moves_count INTEGER DEFAULT 0,
  UNIQUE(character_id, date_str)
);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES characters(id),
  item_key TEXT NOT NULL,                -- 'notizblock', 'schluessel', 'pfandflasche', 'smartphone'
  label TEXT NOT NULL,
  count INTEGER DEFAULT 1,
  UNIQUE(character_id, item_key)
);

CREATE TABLE IF NOT EXISTS pois (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,                -- 'home', 'kneipe', 'imbiss', 'club', 'kino', 'spaeti', 'park', 'arzt'
  pos_x REAL NOT NULL,
  pos_z REAL NOT NULL,
  footprint_json TEXT,                   -- Polygon-Punkte für 3D-Haus und Transparenz-Umschaltung
  public_desc TEXT NOT NULL,             -- Atmosphärische Beschreibung für den Charakter-Prompt
  world_meta_json TEXT,                  -- Versteckte Welt-Wahrheit (durch AI-on-Ingestion gesetzt)
  discovered INTEGER DEFAULT 0           -- 0 = unbekannt, 1 = vom aktuellen Charakter entdeckt
);

CREATE TABLE IF NOT EXISTS poi_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poi_id TEXT REFERENCES pois(id),
  kind TEXT NOT NULL,                    -- 'consume' | 'activity'
  intent_key TEXT NOT NULL,              -- normalisiert, z.B. 'cola', 'kicker spielen'
  label TEXT NOT NULL,
  price REAL DEFAULT 0.0,
  hunger_delta REAL DEFAULT 0.0,
  erschoepfung_delta REAL DEFAULT 0.0,
  froh_delta REAL DEFAULT 0.0,
  narrative TEXT,
  UNIQUE(poi_id, kind, intent_key)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES characters(id),
  poi_id TEXT REFERENCES pois(id),
  role_title TEXT NOT NULL,
  wage_per_shift REAL NOT NULL,          -- € pro 20-Min-Schicht
  strikes INTEGER DEFAULT 0,             -- Bei 2 Strikes -> Kündigung
  shifts_completed INTEGER DEFAULT 0,
  last_worked_at TEXT,
  status TEXT DEFAULT 'active'           -- 'active' | 'fired'
);

CREATE TABLE IF NOT EXISTS messages_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES characters(id),
  channel TEXT NOT NULL,                 -- 'note' | 'sms' | 'email'
  target_poi TEXT,
  recipient TEXT,
  content TEXT NOT NULL,
  telegram_msg_id INTEGER,               -- Für Reply-Zuordnung aus Telegram
  status TEXT DEFAULT 'pending',         -- 'pending' | 'replied' | 'auto_resolved'
  created_at TEXT DEFAULT (datetime('now')),
  resolve_after_at TEXT                  -- Zeitpunkt, ab dem der Welt-Arbiter einspringt
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER,
  tick INTEGER NOT NULL,
  type TEXT NOT NULL,                    -- 'thought', 'action', 'discovery', 'job', 'telegram_in', 'sheet', 'death'
  payload_json TEXT,
  in_feed INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hall_of_fame (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER,
  name TEXT NOT NULL,
  days_lived REAL,
  summary_text TEXT,
  sheet_json TEXT,
  work_pieces_json TEXT,
  discovered_pois_json TEXT,
  cause_of_death TEXT,
  died_at TEXT DEFAULT (datetime('now'))
);
```

---

## 5. Welt, Karte & OSM-Pipeline (St. Pauli Dreieck)

### 5.1 Koordinatensystem & Bounding Box
* **Ursprung $(0, 0)$:** Kreuzung Lerchenstraße / Otzenstraße ($\text{lat } 53.5588, \text{lon } 9.9612$).
* **Umrechnung GPS $\rightarrow$ Meter:**
  $$x = (\text{lon} - \text{lon}_0) \cdot 111320 \cdot \cos\left(\text{lat}_0 \cdot \frac{\pi}{180}\right)$$
  $$z = -(\text{lat} - \text{lat}_0) \cdot 111320$$
  *(Damit zeigt $-z$ nach Norden und $+x$ nach Osten, passend zu Three.js).*
* **Skript `scripts/fetch-osm.js`:** Zieht über die Overpass API alle Gebäude-Umrisse, Straßenlinien und ein zusammenhängendes Fußweg-Netz (`navGraph`) für das Gebiet zwischen Stresemannstraße, Beim Grünen Jäger, Brigittenstraße und Lerchenstraße und speichert es in `data/kiez_map.json`.

### 5.2 Start-POIs (`data/seed_pois.json`)
Nur `apartment` ist zu Beginn `discovered = 1`. Alle anderen starten mit `discovered = 0` und werden erst freigeschaltet, wenn der Charakter sich ihnen auf $\le 22\text{ m}$ nähert:
1. **`apartment` (Kleine Einzimmerwohnung, Lerchenstraße):**
   * `category`: `'home'`, `discovered`: `1`.
   * `public_desc`: `"Deine kleine Einzimmerwohnung. Ein schmales Bett, ein Schreibtisch für Projekte, und ein Bücherregal mit deinem Notizbuch und alten Hamburg-Büchern."`
   * Besitzt drei interne Ankerpunkte (`door`, `bed`, `desk`) als Vorbereitung für eine spätere Puppenhaus-Detailansicht.
2. **`otzentreff` (Otzentreff, Otzenstraße):**
   * `category`: `'kneipe'`, `discovered`: `0`.
   * `public_desc`: `"Eine urige Eckkneipe mit warmem Licht hinter den Scheiben. Am Tresen stehen Gläser, abends wird gelacht und geredet."`
3. **`kleine_pause` (Kleine Pause):**
   * `category`: `'imbiss'`, `discovered`: `0`.
   * `public_desc`: `"Ein heller Kiez-Imbiss. Es riecht nach frischen Pommes, Burgern und heißem Fett."`
4. **`gruener_jaeger` (Beim Grünen Jäger):**
   * `category`: `'club'`, `discovered`: `0`.
   * `public_desc`: `"Ein Kulturhaus und Musikclub an der Ecke. Draußen hängen Konzertplakate, drinnen stehen Kisten und eine Bar."`
5. **`b_movie` (B-Movie, Brigittenstraße):**
   * `category`: `'kino'`, `discovered`: `0`.
   * `public_desc`: `"Ein kleines, unabhängiges Programmkino im Erdgeschoss. Ein Schaukasten zeigt seltene Filme."`
6. **`spaeti` (Eck-Kiosk / Späti):**
   * `category`: `'spaeti'`, `discovered`: `0`.
   * `public_desc`: `"Ein kleiner Kiosk mit Getränkekisten, Kaffee, Snacks und einem Schild: Pfandannahme & Gebraucht-Elektronik."`
7. **`park_bank` (Grünfläche & Bank am Durchgang):**
   * `category`: `'park'`, `discovered`: `0`.
   * `public_desc`: `"Ein paar Bäume und eine Holzbank abseits der großen Straße. Manchmal liegen hier leere Flaschen im Gras."`
8. **`praxis` (Kiez-Arztpraxis / Apotheke, Stresemannstraße):**
   * `category`: `'arzt'`, `discovered`: `0`.
   * `public_desc`: `"Eine kleine Hausarztpraxis mit grünem Apotheken-Kreuz nebenan."`

---

## 6. Gedächtnis, Character Sheet, Bücher & der Nacht-Call (`mimo-v2.6-pro`)

### 6.1 Das zweigeteilte Character Sheet (`character_sheet`)
* **Geschriebener Kern (`written_by = 'creator'`):** Beim Spawn aus `data/seed_sheet.json` geladen (ca. 12–15 prägnante Zeilen in den 4 Kategorien `like`, `cares`, `fears`, `small_things` – wer er ist, nicht was er tun soll). Diese Zeilen sind gesperrt (`locked`).
* **Selbst gelernte Zeilen (`written_by = 'self'`):** Entstehen ausschließlich nachts im Schlaf-Call, wenn dem Modell wiederkehrende Muster aus den Tages-Logs auffallen.
* **Automatisches Loslassen („Let go“):** Zeilen mit `written_by = 'self'`, deren `last_confirmed_at` länger als $21\text{ Tage}$ zurückliegt, werden auf `active = 0` gesetzt und im Changelog als *„Losgelassen nach 21 Tagen ohne Anzeichen“* vermerkt.

### 6.2 Begrenztes Gedächtnis mit „First to go“-Verdrängung (`src/memory.js`)
* **Kapazität:** `MAX_SHORT_TERM = 25`, `MAX_LONG_TERM = 25`.
* **Wert-Berechnung (`worth`):** Jeden Tag (und bei Abruf) aktualisiert die Engine rein mathematisch:
  $$\text{worth} = \text{initial\_weight} + \ln(1 + \text{come\_back\_count}) \cdot 1.5 - \text{age\_days} \cdot \text{decay\_rate}$$
  *(wobei $\text{decay\_rate} = 0.25$ für `short` und $0.03$ für `long` ist).*
* **First to go:** Die Erinnerung mit dem niedrigsten `worth` in einem vollen Speicherbereich wird im UI als **„First to go“** markiert. Kommt eine neue Erinnerung hinzu, ersetzt sie diesen Slot nur, wenn ihr Startgewicht höher ist als das `worth` des schwächsten Eintrags.

### 6.3 Externes Welt-Gedächtnis: Bücher & Notizbuch in der Wohnung (`home_library`)
* **Prinzip:** Der Charakter trägt den Inhalt von Büchern und alten Notizen **nicht** im Prompt mit sich herum. Im Prompt sieht er nur die Titel in seinem Wohnungs-Regal:
  1. `stadtlexikon`: *„Kleines Hamburger Stadt- & Hafenlexikon“* (Themen: `st_pauli`, `hafen_faehren`, `museen`, `wetter_flut`, `kiez_geschichte`).
  2. `notizbuch`: *„Dein eigenes Notizbuch ($N$ Einträge)“* – Liste der Überschriften, die er selbst notiert hat.
* **Aktionen vor Ort in `apartment`:**
  * `read_book(book_id, topic)`: Dauert $8\text{ min}$. Lädt den Text des Kapitels/Eintrags als `read`-Erinnerung in sein Kurzzeitgedächtnis und in den nächsten Prompt.
  * `write_notebook(title, text)`: Dauert $5\text{ min}$. Schreibt eine Erkenntnis (z. B. Preise, Namen, Ideen für sein Projekt) dauerhaft in sein Notizbuch daheim.

### 6.4 „Piece of Work“ (Langzeit-Projekte mit Subdomain-Vorbereitung)
* Mit `work_on_project(title, fragment)` kann der Charakter in seiner Wohnung (`desk`) oder auf der Parkbank an einem eigenen Werk arbeiten (z. B. *„Kiez-Beobachtungen“*, *„Sammlung seltsamer Zettel“*, *„Entwurf für eine eigene kleine Webseite“*).
* Jeder Durchgang ($15\text{ min}$) fügt ein echtes Text-Fragment zu `fragments_json` hinzu und erhöht `progress` um $+10\text{ bis }+20\%$.
* Bei `progress >= 100` wird das Werk auf `completed` gesetzt (und kann in v0.2 direkt als statische HTML-Datei auf eine eigene Subdomain exportiert werden).

### 6.5 Der nächtliche Konsolidierungs-Call (`arbiter.runNightlyConsolidation`)
Wird **einmal pro Kalendertag** ausgelöst, sobald der Charakter in `apartment` die Aktion `sleep` ausführt (Modell-Slot: **`nightly` $\rightarrow$ `xiaomi/mimo-v2.6-pro`**).
* **Input an `mimo-v2.6-pro`:**
  * Komprimiertes Log aller Aktionen, Gedanken, Erfolge und Fehlschläge der letzten 24h.
  * Aktuelles Character Sheet + aktuelle `open_loops` + aktuelle `short`-Memories.
* **Output (1 strukturierter JSON-Call):**
  ```json
  {
    "headline": "Zwei Schichten im Otzentreff geschrubbt, im Regen drei Pfandflaschen gefunden und am Schreibtisch die erste Seite des Kiez-Hefts geschrieben.",
    "sheet_add": {
      "category": "small_things",
      "text": "holt sich nach anstrengenden Schichten fast immer Pommes bei der Kleinen Pause",
      "reason": "An 4 Abenden direkt nach der Arbeit beobachtet"
    },
    "sheet_confirm_ids": [3, 7],
    "promote_memory_ids": [14, 19],
    "drop_memory_ids": [11, 12],
    "open_loops_update": {
      "close_ids": [2],
      "new_loops": [
        { "kind": "question", "text": "Was fährt eigentlich von den Landungsbrücken ab, von denen im Stadtlexikon die Rede war?", "urgency": 0.65 }
      ]
    }
  }
  ```

---

## 7. Werte-System, 20%-Health-Chunks & Aktionen

### 7.1 Grundwerte & Sekundärwerte (`src/config.js`)
* **`gesund` ($0\text{–}100$) & die 20%-Chunk-Regel:**
  * 5 Chunks: $[0\text{–}20], (20\text{–}40], (40\text{–}60], (60\text{–}80], (80\text{–}100]$.
  * Wenn `hunger > 85` oder `erschoepfung > 90`, sinkt `gesund` langsam.
  * Fällt `gesund` unter eine 20er-Schwelle (z. B. auf $59.4$), sinkt `gesund_chunk_cap` auf $60$.
  * **Schlaf (`sleep`)** heilt `gesund` **nur bis `gesund_chunk_cap`**.
  * **Arztbesuch (`visit_doctor` bei `praxis`):** Kostet $15.00\text{ €}$ und $15\text{ min}$. Erhöht `gesund_chunk_cap` um $+20$ (max. $100$) und heilt `gesund` auf diesen Wert.
* **`froh` ($-100\text{ bis }+100$):**
  * Steigt durch Entdeckungen (`+10`), gutes Essen, Kultur/Kino, Fortschritt am eigenen `work_piece` oder Ausruhen im Park.
  * Sinkt durch Geldsorgen (`geld < 5 €`), Monotonie oder hohe Erschöpfung.
* **Sekundärwerte:**
  * `hunger` ($0\text{–}100$): $+3.5$ pro Echtzeit-Stunde und bei körperlicher Arbeit.
  * `erschoepfung` ($0\text{–}100$): $+3.0$ pro Echtzeit-Stunde, $+22$ pro 20-Min-Arbeitsschicht (reduziert sich bis zu $-30\%$, wenn `practised.level` für diesen Job hoch ist!).
  * `geld` (€): Startet bei $18.00\text{ €}$.

### 7.2 Aktions-Katalog (Aquarium-Zeit)

| Aktion | Dauer | Voraussetzung | Effekt |
| :--- | :--- | :--- | :--- |
| `walk_to` | $1.3\text{ m/s}$ | Ziel-POI bekannt | Läuft auf OSM-Wegenetz, entdeckt neue POIs im Umkreis von $22\text{ m}$ |
| `explore_street` | $3\text{ min}$ | Überall | Läuft zu einem unentdeckten Straßenknoten im Kiez |
| `consume` | $6\text{ min}$ | Vor Ort + `geld >= price` | Offener Wunsch (`item`), geprüft/gecacht durch Arbiter |
| `do_activity` | $10\text{ min}$ | Vor Ort | Offene Tätigkeit (`activity`), geprüft/gecacht durch Arbiter |
| `work_on_project`| $15\text{ min}$ | `apartment` oder `park_bank` | Fügt Fragment zu `work_pieces` hinzu (`progress +15%`, `froh +6`) |
| `read_book` | $8\text{ min}$ | In `apartment` | Liest Kapitel aus `home_library`, erzeugt `read`-Memory |
| `write_notebook` | $5\text{ min}$ | In `apartment` + `notizblock`| Speichert Eintrag dauerhaft im Wohnungs-Notizbuch |
| `leave_note` | $3\text{ min}$ | Item `notizblock` + vor Ort | Erzeugt Eintrag in `messages_outbox` + Telegram-Push |
| `work_shift` | $20\text{ min}$ | Aktiver Job am POI | `geld` $+$ Lohn, `erschoepfung` $+22$, `hunger` $+15$, `practised` $+$ |
| `collect_pfand` | $8\text{ min}$ | Im Park / auf Straßen | Findet mit $65\%$ Chance 1–2 Pfandflaschen |
| `return_pfand` | $2\text{ min}$ | Am `spaeti` + Pfand | Pro Flasche $+0.50\text{ €}$ |
| `buy_item` | $3\text{ min}$ | Am `spaeti` + `geld` reicht | Z. B. `Gebrauchtes Smartphone` für $50.00\text{ €}$ |
| `rest` | $10\text{ min}$ | `park_bank` oder `apartment` | `erschoepfung` $-15$, `froh` $+3$ |
| `sleep` | $35\text{ min}$ | In `apartment` | `erschoepfung` $\rightarrow 0$, `gesund` $\rightarrow$ `gesund_chunk_cap`, triggert 1× täglich Nacht-Call |
| `visit_doctor` | $15\text{ min}$ | An `praxis` + `geld >= 15 €` | `gesund_chunk_cap` $+20$, `gesund` $+20$, `geld` $-15\text{ €}$ |

---

## 8. Wirtschaft, Open-Intent-Arbiter & Telegram-Bridge

### 8.1 Globale Leitplanken (`ECONOMY` in `src/config.js`)
```js
const ECONOMY = {
  shiftDurationS: 20 * 60,
  wageBounds: [8.0, 18.0],        // Min/Max Lohn pro 20-Min-Schicht
  priceBounds: {
    spaeti: [1.0, 6.0],
    imbiss: [3.5, 10.0],
    kneipe: [2.5, 12.0],
    club: [4.0, 15.0],
    kino: [7.0, 13.0],
  },
  deltaBounds: {
    consumeHunger: [-50, -5],
    consumeFroh: [-2, 14],
    activityFroh: [-8, 16],
    activityErschoepfung: [2, 15] // Freie Aktivitäten geben NIEMALS Geld
  }
};
```

### 8.2 AI-on-Ingestion & Open-Intent-Cache
* Hat ein POI noch kein `world_meta_json`, initialisiert `arbiter.initPoi(poi)` einmalig Lohn-Niveau, typische Aushilfsrolle und Einstellungs-Wahrscheinlichkeit (`hiring_demand`) innerhalb von `ECONOMY`.
* Bei `consume` und `do_activity` prüft `arbiter.resolveIntent()` zuerst die Tabelle `poi_offers`. Nur wenn das gewünschte Item/Vorhaben dort noch unbekannt ist, bewertet der `arbiter`-Slot Plausibilität, Preis und Wirkung (hart geklammert durch `ECONOMY`) und speichert es in `poi_offers`.

### 8.3 Telegram-Bridge & Kündigungs-Logik (`src/telegram.js`)
* Jedes `leave_note` (und später `send_sms` / `send_email` mit Smartphone) sendet eine Nachricht an `TELEGRAM_CHAT_ID` und legt einen offenen `promise`/`question`-Loop in `open_loops` an.
* Antwortest du innerhalb von $30\text{ min}$ per Telegram-Reply, wertet der Arbiter deine Antwort aus (z. B. Job-Zusage mit Stundenlohn) und speist sie als Erlebnis ins Kurzzeitgedächtnis ein.
* Antwortest du nicht innerhalb von $30\text{ min}$, entscheidet `arbiter.evaluateApplication()` autonom anhand von `world_meta_json`.
* **Kündigung:** 2 Übermüdungs-Patzer (`strikes >= 2`), $72\text{ h}$ Inaktivität beim Job (`Ghosting`) oder der Telegram-Befehl `/fire <poi_id>` beenden das Arbeitsverhältnis.

---

## 9. Multi-Step-Planung & Retrospektive (`src/prompt.js` & `src/engine.js`)

Wenn `plan_queue_json` leer ist und `current_action === 'idle'`, fragt `engine.decide()` das Modell nach den nächsten **2 bis 4 Schritten** sowie einer kurzen Rückschau (`retrospective`) auf den gerade abgeschlossenen Plan:

```json
{
  "thought": "Konto fast leer, aber die Pommes eben haben gutgetan. Ich lege jetzt im Otzentreff einen Zettel hin und schreibe danach daheim am Kiez-Heft weiter.",
  "why_here": "Auf dem Weg zum Otzentreff, um nach einer Schicht hinterm Tresen zu fragen.",
  "retrospective": "Die Pause beim Imbiss hat den Kopf wieder klar gemacht.",
  "plan": [
    { "action": "walk_to", "target": "otzentreff" },
    { "action": "leave_note", "target": "otzentreff", "text": "Moin, wohne gleich nebenan in der Lerchenstraße und suche Arbeit am Tresen oder beim Spülen." },
    { "action": "walk_to", "target": "apartment" },
    { "action": "work_on_project", "target": "apartment", "title": "Notizen aus St. Pauli", "fragment": "In der Otzenstraße riecht es abends nach Regen, altem Bier und frittierten Kartoffeln." }
  ]
}
```

* Das Feld `retrospective` wird automatisch an die letzte Erinnerung in `memories` angehängt (*„Looking at it again later: ...“*).
* Solange kein Interrupt (Telegram-Antwort, neuer POI entdeckt, Health-Chunk-Verlust, Geld reicht nicht) auftritt, arbeitet die Engine die `plan_queue_json` ohne weitere Modell-Calls ab und zählt in `stats_24h_json` die Kategorien `big_model`, `small_model`, `queued` und `autopilot` hoch.

---

## 10. 3D-Szene, Kamera & „Gehirn“-Overlay (`public/scene.js` & `public/index.html`)

### 10.1 Flache St.-Pauli-Bühne & Indoor-Transparenz
* **OSM-Gebäude & Straßen:** `public/scene.js` lädt `/data/kiez_map.json`, zeichnet die Straßenbänder und extrudiert alle Gebäudepolygone per `THREE.ExtrudeGeometry`.
* **Halbtransparente POI-Häuser:** Betritt der Charakter ein POI-Gebäude (`inside_poi === poi.id`), blendet die Fassade weich auf `opacity: 0.22` ab und ein warmes `PointLight` im Erdgeschoss zeigt die Figur im Inneren.

### 10.2 Kamera-Spezifikation (Pilot-Modus $\leftrightarrow$ Stadt-Modus)
1. **Start (`snapPilotCam`):** Startet im `pilot`-Modus, Fokus auf Kopfhöhe der Figur, Augenhöhe (`pitch = 0.12`), exakt $+40^\circ$ **rechts** vom Blickwinkel `heading_rad` (mit Code-Kommentar für späteren Gebäude-Kollisionscheck beim Initial-Load).
2. **Rauszoomen (`pilot` $\rightarrow$ `city` bei `dist >= 80`):** Fährt ohne Bilddrehung (`endUp` = horizontaler Kamera-Blickvektor) senkrecht über die Figur (`(figur.x, 260, figur.z)`), sodass der Charakter beim Erreichen der Stadt-Ansicht exakt in der Bildschirmmitte liegt. Danach ist der Drehpunkt in der XZ-Ebene frei dreh- und verschiebbar.
3. **Reinzoomen (`city` $\rightarrow$ `pilot` bei `dist <= 110`):** Wählt im Korridor $[-40^\circ, +40^\circ]$ um die Blickrichtung der Figur den freien Winkel mit der geringsten Drehung, interpoliert über `Smootherstep` ($6t^5 - 15t^4 + 10t^3$), führt `_figDelta` mit und übernimmt am Ende (`t >= BLEND_DAUER`) nahtlos die Winkel ohne Snapping.

### 10.3 Das „Gehirn“-Overlay im UI (`public/index.html`)
Neben dem `Feed`-Button öffnet ein Button `Gehirn` ein übersichtliches Panel mit 4 Reitern (gespeist aus `/api/brain`):
1. **Jetzt im Kopf (`On his mind`):** Aktueller Gedanke, `why_here`, aktive `open_loops` (sortiert nach `urgency`) und sein aktuelles `work_piece` inkl. Fortschrittsbalken und Text-Fragmenten.
2. **Wer er ist (`Character Sheet`):** Zweispaltige Ansicht pro Kategorie – links die festen Start-Zeilen, rechts grün hervorgehoben die im Schlaf gelernten Zeilen samt Quelle (*„Auslöser: ...“*) und Änderungs-Historie.
3. **Gedächtnis (`Memories`):** Visuelles Block-Raster für Kurzzeit ($25$) und Langzeit ($25$), Hervorhebung der **„First to go“**-Erinnerung sowie Liste seiner Bücher/Notizbucheinträge in der Wohnung.
4. **Tage & Übung (`Days & Practised`):** Die Ein-Satz-Schlagzeilen der vergangenen Tage (`day_summaries`), seine geübten Fähigkeiten (`goes` & `level`) sowie die 24h-Entscheidungsstatistik.

---

## 11. Schritt-für-Schritt Umsetzungsplan für die Coding-KI

* [ ] **Phase 1: Git-Archiv, Modell-Slots & Datenbank**
  * Aktuellen Stand in `archive/space-v0.1` sichern.
  * `model.json` um `arbiter` und `nightly` (`xiaomi/mimo-v2.6-pro`) erweitern.
  * `src/db.js` mit dem kompletten neuen Schema inkl. `character_sheet`, `memories`, `open_loops`, `work_pieces`, `home_library`, `practised` und `day_summaries` aufsetzen.
* [ ] **Phase 2: OSM-Kiez-Karte & A\*-Pathfinding**
  * `node scripts/fetch-osm.js` ausführen, um `data/kiez_map.json` für das St.-Pauli-Dreieck zu erzeugen.
  * `data/seed_pois.json`, `data/seed_sheet.json` und `data/seed_books.json` anlegen.
  * `src/pathfinding.js` (A\* auf `navGraph`) implementieren und testen.
* [ ] **Phase 3: Engine, 20%-Health-Chunks, Gedächtnis-Mathe & Plan-Queue**
  * `src/memory.js` (Slot-Limits, `worth`-Formel, `First to go`-Ermittlung) bauen.
  * `src/engine.js` mit Echtzeit-Uhr, 20%-Health-Chunks, Multi-Step-Plan-Queue, Interrupts, `practised`-Zähler und Bücher-/Projekt-Aktionen implementieren.
* [ ] **Phase 4: Arbiter, Nacht-Konsolidierung (`mimo-v2.6-pro`) & Telegram-Bridge**
  * `src/arbiter.js` mit `initPoi`, `resolveIntent` (Open-Intent + `poi_offers`-Cache) und `runNightlyConsolidation` (über `nightly`-Slot beim Schlafen) erstellen.
  * `src/telegram.js` für Zettel/SMS/E-Mail-Weiterleitung und Reply-Auswertung anbinden.
* [ ] **Phase 5: Prompt & Checks**
  * `src/prompt.js` (Character Sheet, Top-Memories, Offene Fäden, Wohnungs-Bücherliste, Budget-Satz) und `src/checks.js` (Plan-JSON + `retrospective`) bauen.
* [ ] **Phase 6: 3D-Kiez-Szene, Kamera & „Gehirn“-UI**
  * `public/scene.js` (flache OSM-Stadt, halbtransparente POI-Häuser, 2-Modus-Kamera ohne Snapping) und `public/index.html` (HUD + „Gehirn“-Overlay) fertigstellen.
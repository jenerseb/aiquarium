'use strict';
// Datenbank-Kern (Meilenstein 1): Schema + Seed aus data/kiez_map.json.
// Nutzt ausschließlich node:sqlite (DatabaseSync), keine npm-Abhängigkeiten.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SEKUNDAER } = require('./config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS world_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tick INTEGER DEFAULT 0,
  last_tick_at TEXT,
  last_nightly_date TEXT,
  weather TEXT DEFAULT 'clear',
  temperature_c REAL DEFAULT 14.0,
  stats_24h_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS character (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'alive',
  gesund REAL DEFAULT 100.0,
  gesund_chunk_cap REAL DEFAULT 100.0,
  froh REAL DEFAULT 25.0,
  hunger REAL DEFAULT 20.0,
  erschoepfung REAL DEFAULT 15.0,
  geld REAL DEFAULT 18.00,
  pos_x REAL DEFAULT 0.0,
  pos_z REAL DEFAULT 0.0,
  heading_rad REAL DEFAULT 0.0,
  inside_poi TEXT,
  current_action TEXT DEFAULT 'idle',
  action_started_tick INTEGER,
  action_duration_s INTEGER DEFAULT 0,
  action_target_poi TEXT,
  action_meta_json TEXT,
  why_here TEXT,
  plan_queue_json TEXT DEFAULT '[]',
  plan_start_snapshot_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  died_at TEXT,
  cause_of_death TEXT
);

CREATE TABLE IF NOT EXISTS character_sheet (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES character(id),
  category TEXT NOT NULL,
  text TEXT NOT NULL,
  written_by TEXT NOT NULL,
  source_reason TEXT,
  times_confirmed INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  last_confirmed_at TEXT DEFAULT (datetime('now')),
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES character(id),
  tier TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  retrospective TEXT,
  initial_weight REAL DEFAULT 3.0,
  come_back_count INTEGER DEFAULT 1,
  worth REAL DEFAULT 3.0,
  created_at TEXT DEFAULT (datetime('now')),
  last_recalled_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS open_loops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES character(id),
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  urgency REAL DEFAULT 0.5,
  related_poi TEXT,
  status TEXT DEFAULT 'open',
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS work_pieces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES character(id),
  title TEXT NOT NULL,
  kind TEXT DEFAULT 'zines',
  poi_id TEXT REFERENCES pois(id),
  progress INTEGER DEFAULT 0,
  fragments_json TEXT DEFAULT '[]',
  status TEXT DEFAULT 'in_progress',
  published_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pois (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  pos_x REAL NOT NULL,
  pos_z REAL NOT NULL,
  footprint_json TEXT,
  public_desc TEXT NOT NULL,
  world_meta_json TEXT,
  discovered INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poi_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poi_id TEXT REFERENCES pois(id),
  kind TEXT NOT NULL,
  intent_key TEXT NOT NULL,
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
  character_id INTEGER REFERENCES character(id),
  poi_id TEXT REFERENCES pois(id),
  role_title TEXT NOT NULL,
  wage_per_shift REAL NOT NULL,
  strikes INTEGER DEFAULT 0,
  shifts_completed INTEGER DEFAULT 0,
  last_worked_at TEXT,
  status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS messages_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES character(id),
  channel TEXT NOT NULL,
  target_poi TEXT,
  recipient TEXT,
  content TEXT NOT NULL,
  telegram_msg_id INTEGER,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  resolve_after_at TEXT
);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES character(id),
  item_key TEXT NOT NULL,
  label TEXT NOT NULL,
  count INTEGER DEFAULT 1,
  UNIQUE(character_id, item_key)
);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  entries_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS home_library (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  entries_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS practised (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES character(id),
  skill_key TEXT NOT NULL,
  label TEXT NOT NULL,
  goes INTEGER DEFAULT 0,
  level REAL DEFAULT 0.0,
  UNIQUE(character_id, skill_key)
);

CREATE TABLE IF NOT EXISTS day_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES character(id),
  date_str TEXT NOT NULL,
  headline TEXT NOT NULL,
  sheet_changes_json TEXT DEFAULT '[]',
  moves_count INTEGER DEFAULT 0,
  UNIQUE(character_id, date_str)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER,
  tick INTEGER NOT NULL,
  type TEXT NOT NULL,
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
`;

// Start-POIs aus dem Plan (§5.2). Nur apartment ist entdeckt.
// Koordinaten: flache Meter relativ zu (0,0) Lerchenstr./Otzenstr.
// Alle Anker auf echte OSM-Strassenpunkte gesnappt (Dez 2026, verifiziert):
// max. 7,3 m zum naechsten Strassenpunkt – kein Marker schwebt mehr im Nichts.
const SEED_POIS = [
  { id: 'apartment', name: 'Kleine Einzimmerwohnung (Beckstrasse)', category: 'home',
    match: { building: 'b_51281656' }, pos_x: 260, pos_z: -4, discovered: 1,
    public_desc: 'Deine kleine Einzimmerwohnung an der Beckstrasse. Ein schmales Bett, ein Schreibtisch fuer Projekte, und ein Buecherregal mit deinem Notizbuch und alten Hamburg-Buechern.' },
  { id: 'otzentreff', name: 'Otzentreff (Otzenstrasse)', category: 'kneipe',
    match: { osm: 'n_2070259277' }, pos_x: 46, pos_z: 399.7, discovered: 0,
    public_desc: 'Eine urige Eckkneipe mit warmem Licht hinter den Scheiben. Am Tresen stehen Glaeser, abends wird gelacht und geredet.' },
  { id: 'kleine_pause', name: 'Kleine Pause (Wohlwillstrasse)', category: 'imbiss',
    match: { osm: 'n_394086462' }, pos_x: 76.2, pos_z: 443.8, discovered: 0,
    public_desc: 'Ein heller Kiez-Imbiss. Es riecht nach frischen Pommes, Burgern und heissem Fett.' },
  { id: 'gruener_jaeger', name: 'Gruener Jaeger', category: 'club',
    match: { building: 'b_23320572' }, pos_x: 163, pos_z: 232, discovered: 0,
    public_desc: 'Ein Kulturhaus und Musikclub an der Ecke. Draussen haengen Konzertplakate, drinnen stehen Kisten und eine Bar.' },
  { id: 'b_movie', name: 'B-Movie (Brigittenstrasse)', category: 'kino',
    match: { osm: 'n_1356135344' }, pos_x: 4, pos_z: 492.1, discovered: 0,
    public_desc: 'Ein kleines, unabhaengiges Programmkino. Ein Schaukasten zeigt seltene Filme – direkt an der Brigittenstrasse.' },
  { id: 'feldstrassenbunker', name: 'Feldstrassenbunker', category: 'denkmal',
    match: { building: 'b_264581795' }, pos_x: 581.5, pos_z: 263, discovered: 0,
    public_desc: 'Ein gewaltiger gruen bewachsener Flakbunker aus dem Krieg. Heute Kultur, Clubs und ein Dachgarten obendrauf.' },
  { id: 'rote_flora', name: 'Rote Flora (Schulterblatt)', category: 'club',
    match: { building: 'b_10413828' }, pos_x: 22.1, pos_z: -360.6, discovered: 0,
    public_desc: 'Ein besetztes Kulturzentrum mit roter Fassade. Plakate, Konzerte, politischer Kiez-Treff seit Jahrzehnten.' },
  { id: 'haus73', name: 'Haus 73 (Schanze)', category: 'kneipe',
    match: { osm: 'n_278943489' }, pos_x: 1.3, pos_z: -400.5, discovered: 0,
    public_desc: 'Kulturhaus und Kellerkneipe am Schulterblatt 73: Konzerte, Comedy, Poetry Slam, Lesungen und Veranstaltungen.' },
  { id: 'knust', name: 'Knust (Neuer Kamp)', category: 'club',
    match: { osm: 'n_1525291987' }, pos_x: 445.2, pos_z: 73.6, discovered: 0,
    public_desc: 'Ein legendaerer Musikclub am Neuen Kamp. Eng, laut, direkt.' },
  { id: 'rindermarkthalle', name: 'Rindermarkthalle St. Pauli', category: 'markt',
    match: { building: 'b_142954635' }, pos_x: 325.2, pos_z: 262.5, discovered: 0,
    public_desc: 'Eine alte Markthalle voller Essensstaende aus aller Welt.' },
  { id: 'florapark', name: 'Florapark (Schanze)', category: 'park',
    match: null, pos_x: -42, pos_z: -348, discovered: 0,
    public_desc: 'Eine gruene Wiese direkt hinter der Roten Flora. Baeume, Plaetze zum Sitzen, im Sommer voll mit Leuten.' },
  { id: 'millerntor', name: 'Millerntor-Stadion', category: 'stadion',
    match: null, pos_x: 380, pos_z: 490, discovered: 0,
    public_desc: 'Das Stadion von St. Pauli am Harald-Stender-Platz. An Spieltagen braun-weisse Wand aus Gesaengen. (Sued-Eingang, direkt am Weg.)' },
  { id: 'ume_no_hana', name: 'Ume no Hana (Thadenstrasse)', category: 'restaurant',
    match: { osm: 'n_2070264168' }, pos_x: 30.9, pos_z: 271.3, discovered: 0,
    public_desc: 'Eine kleine Ramen-Bar in der Thadenstrasse. Pho und Ramen, eng und laut.' },
  { id: 'hanseplatte', name: 'Hanseplatte (Neuer Kamp)', category: 'markt',
    match: null, pos_x: 462.9, pos_z: 122.5, discovered: 0,
    public_desc: 'Legendärer Platten- und Hamburg-Laden am Neuen Kamp 32. Vinyl, Bücher, lokale Musik und Kiez-Kultur.' },
  { id: 'nachladen', name: 'nachladen. (Sternstrasse)', category: 'markt',
    match: null, pos_x: 363.7, pos_z: -133.6, discovered: 0,
    public_desc: 'Unabhängiger Plattenladen, Lo-Fi-Verlag und Kunstraum in der Sternstrasse 17. Vinyl, Zines, Comics und Drucke.' },
  { id: 'baba_azeitona', name: 'Baba Azeitona', category: 'restaurant',
    match: { osm: 'n_4053511799' }, pos_x: 145.7, pos_z: 27.1, discovered: 0,
    public_desc: 'Libanesisches Lokal am Schulterblatt/Beckstrasse: frische Falafel, Hummus, Meze und warmes Fladenbrot.' },
  { id: 'katze', name: 'Katze (Schulterblatt)', category: 'kneipe',
    match: { osm: 'n_2495419425' }, pos_x: 32.3, pos_z: -418.9, discovered: 0,
    public_desc: 'Bekannte Eckbar am Schulterblatt gegenüber der Roten Flora. Drinks, Musik und buntes Schanzen-Publikum.' },
  { id: 'creperie', name: "L'autre Creperie (Neuer Kamp)", category: 'cafe',
    match: { osm: 'n_11254668228' }, pos_x: 595.8, pos_z: 98.5, discovered: 0,
    public_desc: 'Eine bretonische Creperie am Neuen Kamp. Suess und herzhaft, duenner Teig, warmer Kaffee.' },
  { id: 'fanladen', name: 'Fanladen St. Pauli', category: 'club',
    match: { osm: 'n_5207383888' }, pos_x: 499.5, pos_z: 507.4, discovered: 0,
    public_desc: 'Anlaufstelle der St.-Pauli-Fanszene. Schals, Aufkleber, Choreo-Planung – braun-weiss ueberall.' },
  { id: 'mutter', name: 'Mutter (Stresemannstrasse)', category: 'kneipe',
    match: { osm: 'n_799205100' }, pos_x: 95.6, pos_z: -19.8, discovered: 0,
    public_desc: 'Eine kleine Eckkneipe an der Stresemannstrasse. Stammpublikum, leise Musik, kaltes Bier.' },
  { id: 'tutti_di_napoli', name: 'Tutti Di Napoli', category: 'restaurant',
    match: { osm: 'n_12872015631' }, pos_x: 143.8, pos_z: -119.4, discovered: 0,
    public_desc: 'Neapolitanische Pizza, duenner Boden, heisser Ofen. Abends voll, mittags schnell.' },
  { id: 'berliner_betruger', name: 'Berliner Betrueger', category: 'kneipe',
    match: { osm: 'n_267626214' }, pos_x: -38.5, pos_z: -248.2, discovered: 0,
    public_desc: 'Eine Kellerbar mit Berliner Schnauze mitten in der Schanze. Dunkel, laut, ehrlich.' },
  { id: 'mam_eat_greek', name: 'mam - eat greek', category: 'restaurant',
    match: { osm: 'n_4003190605' }, pos_x: 175.3, pos_z: -115.3, discovered: 0,
    public_desc: 'Griechischer Imbiss: Gyros, Halloumi, frische Zitrone. Schnell und satt.' },
  { id: 'studio_kino', name: 'Studio-Kino', category: 'kino',
    match: { osm: 'n_2070279511' }, pos_x: -189, pos_z: 165.6, discovered: 0,
    public_desc: 'Ein kleines Programmkino westlich der Schanze. Alte Sessel, leise Filme, grosser Vorhang.' },
  { id: 'spaeti', name: 'Eck-Kiosk / Spaeti', category: 'spaeti',
    match: null, pos_x: 14.2, pos_z: 60.9, discovered: 0,
    public_desc: 'Ein kleiner Kiosk mit Getraenkekisten, Kaffee, Snacks und einem Schild: Pfandannahme & Gebraucht-Elektronik.' },
  { id: 'praxis', name: 'Kiez-Arztpraxis (Lippmannstrasse)', category: 'arzt',
    match: null, pos_x: 18.2, pos_z: -172, discovered: 0,
    public_desc: 'Eine kleine Hausarztpraxis mit gruenem Apotheken-Kreuz nebenan.' },
];

const SEED_SHEET = [
  { category: 'like', text: 'mag Parks, Pommesgeruch und leise Musik aus Fenstern' },
  { category: 'cares', text: 'haelt Wort und teilt seine wenigen Euro lieber als zu horten' },
  { category: 'cares', text: 'will in St. Pauli ankommen, ohne jemandem zur Last zu fallen' },
  { category: 'fears', text: 'fuerchtet Obdachlosigkeit nachts und allein krank zu werden' },
  { category: 'small_things', text: 'sammelt Zettel und gruesst fremde Katzen unterwegs' },
];

const SEED_BOOKS = [
  { id: 'stadtlexikon', title: 'Kleines Hamburger Stadt- & Hafenlexikon', kind: 'book',
    entries: [] },
  { id: 'notizbuch', title: 'Dein eigenes Notizbuch', kind: 'notebook',
    entries: [
      { topic: 'ankunft', title: 'Erste Nacht', content: 'In der Beckstrasse angekommen. 18 Euro in der Tasche.' },
    ] },
];

function openDb(pfad) {
  const dir = path.dirname(pfad);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(pfad);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function migrate(db) {
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO world_state (id, tick, stats_24h_json) VALUES (1, 0, '{}')").run();
}

function zaehle(db, tabelle) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM ' + tabelle).get();
  return row ? row.n : 0;
}

// Seed: POI-Footprints aus echten OSM-Gebaeuden nahe der Seed-Koordinaten.
// Hamburg-Geodaten (data/hamburg_geodata.json): echte Einzelhäuser + Bäume.
// Fällt sauber auf data/kiez_map.json zurück (Routing bleibt immer OSM).
function ladeHamburgGeodata(pfad) {
  const p = pfad || path.join(__dirname, '..', 'data', 'hamburg_geodata.json');
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (d && Array.isArray(d.buildings)) return d;
    return null;
  } catch {
    return null;
  }
}

// Nächstes Einzelhaus zu (x, z) + exakte Gebäude-ID (für POI-Highlighting).
function naechstesGebaeude(geodata, x, z, maxD) {
  const liste = (geodata && geodata.buildings) || [];
  let best = null;
  let bestD = maxD == null ? 60 : maxD;
  for (const b of liste) {
    if (!Array.isArray(b.footprint) || b.footprint.length < 3) continue;
    let sx = 0;
    let sz = 0;
    for (const q of b.footprint) { sx += q[0]; sz += q[1]; }
    const d = Math.hypot(sx / b.footprint.length - x, sz / b.footprint.length - z);
    if (d < bestD) { bestD = d; best = b; }
  }
  return best ? { gebaeude: best, distanz: bestD } : null;
}

function footprintAusKarte(kiezMap, x, z) {
  if (!kiezMap || !Array.isArray(kiezMap.buildings)) return null;
  let best = null;
  let bestD = Infinity;
  for (const b of kiezMap.buildings) {
    if (!Array.isArray(b.footprint) || b.footprint.length < 3) continue;
    let sx = 0;
    let sz = 0;
    for (const p of b.footprint) { sx += p[0]; sz += p[1]; }
    const cx = sx / b.footprint.length;
    const cz = sz / b.footprint.length;
    const d = Math.hypot(cx - x, cz - z);
    if (d < bestD) { bestD = d; best = b; }
  }
  if (best && bestD < 60) return best.footprint;
  return null;
}


// OSM-POI-Matching: Seed.match (osm-ID / building-ID) -> Position aus dem
// Karten-Layer (osmPois / buildings). Fallback: Hand-Koordinaten aus dem Seed.
function poiPositionAusKarte(kiezMap, seed) {
  if (!kiezMap || !seed.match) return [seed.pos_x, seed.pos_z];
  if (seed.match.osm && Array.isArray(kiezMap.osmPois)) {
    const o = kiezMap.osmPois.find((q) => q.osm === seed.match.osm);
    if (o && Array.isArray(o.pos)) return o.pos;
  }
  if (seed.match.building && Array.isArray(kiezMap.buildings)) {
    const b = kiezMap.buildings.find((q) => q.id === seed.match.building);
    if (b && Array.isArray(b.footprint) && b.footprint.length) {
      let sx = 0;
      let sz = 0;
      for (const q of b.footprint) { sx += q[0]; sz += q[1]; }
      return [Math.round((sx / b.footprint.length) * 10) / 10, Math.round((sz / b.footprint.length) * 10) / 10];
    }
  }
  return [seed.pos_x, seed.pos_z];
}
function seed(db, kiezMap) {
  migrate(db);
  const geodata = ladeHamburgGeodata();
  if (zaehle(db, 'pois') === 0) {
    const ins = db.prepare('INSERT INTO pois (id, name, category, pos_x, pos_z, footprint_json, public_desc, world_meta_json, discovered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const p of SEED_POIS) {
      const [mx, mz] = poiPositionAusKarte(kiezMap, p);
      const fp = footprintAusKarte(kiezMap, mx, mz);
      const zu = poiGebaeudeZuordnung(geodata || kiezMap, p, mx, mz);
      ins.run(p.id, p.name, p.category, mx, mz,
        fp ? JSON.stringify(fp) : null, p.public_desc, zu ? JSON.stringify(zu) : null, p.discovered);
    }
  } else {
    // NW/S-Erweiterung 2026-11-17: park_bank raus, 5 neue POIs rein, Flora-Koordinaten korrigiert.
    try { db.prepare("DELETE FROM pois WHERE id = 'park_bank'").run(); } catch { /* ok */ }
    const vorhanden = new Set(db.prepare('SELECT id FROM pois').all().map((r) => r.id));
    const ins = db.prepare('INSERT OR IGNORE INTO pois (id, name, category, pos_x, pos_z, footprint_json, public_desc, world_meta_json, discovered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const p of SEED_POIS) {
      if (vorhanden.has(p.id)) {
        // Koordinaten-Korrektur für Flora/Haus73 in bestehenden DBs
        if (p.id === 'rote_flora' || p.id === 'haus73') {
          const [mx, mz] = poiPositionAusKarte(kiezMap, p);
          db.prepare('UPDATE pois SET pos_x = ?, pos_z = ? WHERE id = ?').run(mx, mz, p.id);
        }
        // Wohnungs-Umzug 2026-11-17: apartment -> Beckstrasse (b_51281656).
        // Bestehende DBs: Position + Name + Beschreibung + Footprint mitziehen,
        // und jede Figur, die noch in der alten Wohnung "drin" ist, umziehen.
        if (p.id === 'apartment') {
          const [mx, mz] = poiPositionAusKarte(kiezMap, p);
          const fp = footprintAusKarte(kiezMap, mx, mz);
          db.prepare('UPDATE pois SET pos_x = ?, pos_z = ?, name = ?, public_desc = ?, footprint_json = COALESCE(?, footprint_json) WHERE id = ?')
            .run(mx, mz, p.name, p.public_desc, fp ? JSON.stringify(fp) : null, p.id);
          db.prepare("UPDATE character SET pos_x = ?, pos_z = ? WHERE inside_poi = 'apartment'").run(mx, mz);
        }
        continue;
      }
      const [mx, mz] = poiPositionAusKarte(kiezMap, p);
      const fp = footprintAusKarte(kiezMap, mx, mz);
      const zu = poiGebaeudeZuordnung(geodata || kiezMap, p, mx, mz);
      ins.run(p.id, p.name, p.category, mx, mz,
        fp ? JSON.stringify(fp) : null, p.public_desc, zu ? JSON.stringify(zu) : null, p.discovered);
    }
  }
  let charId;
  if (zaehle(db, 'character') === 0) {
    const apt = SEED_POIS.find((p) => p.id === 'apartment');
    const r = db.prepare('INSERT INTO character (name, status, gesund, gesund_chunk_cap, froh, hunger, erschoepfung, geld, pos_x, pos_z, inside_poi, current_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'Kiezling', 'alive', 100, 100, 20,
      SEKUNDAER.hunger.start, SEKUNDAER.erschoepfung.start,
      SEKUNDAER.geld.start, apt.pos_x, apt.pos_z, 'apartment', 'idle');
    charId = Number(r.lastInsertRowid);
    const sh = db.prepare('INSERT INTO character_sheet (character_id, category, text, written_by) VALUES (?, ?, ?, ?)');
    for (const s of SEED_SHEET) sh.run(charId, s.category, s.text, 'creator');
    const inv = db.prepare('INSERT INTO inventory (character_id, item_key, label, count) VALUES (?, ?, ?, ?)');
    inv.run(charId, 'notizblock', 'Notizblock', 1);
    inv.run(charId, 'schluessel', 'Wohnungsschluessel', 1);
    // NUR ZU DEV-ZWECKEN: Smartphone standardmäßig im Start-Inventar (eigentlich erst am Späti kaufbar).
    inv.run(charId, 'handy', 'Gebrauchtes Smartphone', 1);
    db.prepare("INSERT INTO memories (character_id, tier, kind, text, initial_weight, worth) VALUES (?, 'short', 'moment', ?, 4.0, 4.0)").run(
      charId, 'Ankunft in der Beckstrasse mit 18 Euro. Die Wohnung riecht nach frischer Farbe.');
  } else {
    charId = db.prepare('SELECT id FROM character ORDER BY id LIMIT 1').get().id;
  }
  if (zaehle(db, 'books') === 0) {
    const ins = db.prepare('INSERT INTO books (id, title, kind, entries_json) VALUES (?, ?, ?, ?)');
    for (const b of SEED_BOOKS) ins.run(b.id, b.title, b.kind, JSON.stringify(b.entries));
  }
  if (zaehle(db, 'home_library') === 0) {
    const ins = db.prepare('INSERT INTO home_library (id, title, kind, entries_json) VALUES (?, ?, ?, ?)');
    for (const b of SEED_BOOKS) ins.run(b.id, b.title, b.kind, JSON.stringify(b.entries));
  }
  return charId;
}

function ladeKiezKarte(kartenPfad) {
  const p = kartenPfad || path.join(__dirname, '..', 'data', 'kiez_map.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// POI -> exakt passendes Einzelhaus (ALKIS/OSM-Fallback): gibt die
// Gebäude-ID + Distanz zurück, speichert sie in world_meta_json
// ({alkis_id}), damit die Szene NUR dieses eine Haus highlightet.
function poiGebaeudeZuordnung(geodata, seed, mx, mz) {
  if (!geodata || !Array.isArray(geodata.buildings)) return null;
  const treffer = naechstesGebaeude(geodata, mx, mz, 60);
  if (!treffer) return null;
  return { alkis_id: treffer.gebaeude.id, distanz_m: Math.round(treffer.distanz * 10) / 10 };
}

function init(pfad, kiezMap) {
  const cfg = require('./config');
  const dbPfad = pfad || cfg.DB.defaultPfad;
  const db = openDb(dbPfad);
  const karte = kiezMap || ladeKiezKarte();
  const characterId = seed(db, karte);
  return { db, dbPfad, characterId };
}

module.exports = {
  SCHEMA, SEED_POIS, SEED_SHEET, SEED_BOOKS, poiPositionAusKarte,
  openDb, migrate, seed, init, ladeKiezKarte, ladeHamburgGeodata,
  naechstesGebaeude, poiGebaeudeZuordnung, zaehle,
};


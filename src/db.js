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
  froh REAL DEFAULT 20.0,
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
  { id: 'apartment', name: 'Kleine Einzimmerwohnung (Lerchenstrasse)', category: 'home',
    match: null, pos_x: -3, pos_z: -114, discovered: 1,
    public_desc: 'Deine kleine Einzimmerwohnung. Ein schmales Bett, ein Schreibtisch fuer Projekte, und ein Buecherregal mit deinem Notizbuch und alten Hamburg-Buechern.' },
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
  { id: 'rote_flora', name: 'Rote Flora', category: 'club',
    match: { building: 'b_10413828' }, pos_x: 22.1, pos_z: -360.6, discovered: 0,
    public_desc: 'Ein besetztes Kulturzentrum mit roter Fassade. Plakate, Konzerte, politischer Kiez-Treff seit Jahrzehnten.' },
  { id: 'haus73', name: 'Haus 73 (Schanze)', category: 'kneipe',
    match: { osm: 'n_278943489' }, pos_x: 1.3, pos_z: -400.5, discovered: 0,
    public_desc: 'Eine Kellerkneipe in der Schanze.' },
  { id: 'knust', name: 'Knust (Neuer Kamp)', category: 'club',
    match: { osm: 'n_1525291987' }, pos_x: 445.2, pos_z: 73.6, discovered: 0,
    public_desc: 'Ein legendaerer Musikclub am Neuen Kamp. Eng, laut, direkt.' },
  { id: 'rindermarkthalle', name: 'Rindermarkthalle St. Pauli', category: 'markt',
    match: { building: 'b_142954635' }, pos_x: 325.2, pos_z: 262.5, discovered: 0,
    public_desc: 'Eine alte Markthalle voller Essensstaende aus aller Welt.' },
  { id: 'spaeti', name: 'Eck-Kiosk / Spaeti', category: 'spaeti',
    match: null, pos_x: 14.2, pos_z: 60.9, discovered: 0,
    public_desc: 'Ein kleiner Kiosk mit Getraenkekisten, Kaffee, Snacks und einem Schild: Pfandannahme & Gebraucht-Elektronik.' },
  { id: 'park_bank', name: 'Gruenflaeche & Bank am Durchgang', category: 'park',
    match: null, pos_x: -9.7, pos_z: -58.7, discovered: 0,
    public_desc: 'Ein paar Baeume und eine Holzbank abseits der grossen Strasse. Manchmal liegen hier leere Flaschen im Gras.' },
  { id: 'praxis', name: 'Kiez-Arztpraxis (Lippmannstrasse)', category: 'arzt',
    match: null, pos_x: 18.2, pos_z: -172, discovered: 0,
    public_desc: 'Eine kleine Hausarztpraxis mit gruenem Apotheken-Kreuz nebenan.' },
];

const SEED_SHEET = [
  { category: 'like', text: 'sitzt gern auf der Bank im Gruenen und schaut den Leuten zu' },
  { category: 'like', text: 'mag den Geruch von frischen Pommes und Regen auf warmem Asphalt' },
  { category: 'like', text: 'hoert gern leise Musik aus fremden Fenstern' },
  { category: 'cares', text: 'will in St. Pauli ankommen, ohne jemandem zur Last zu fallen' },
  { category: 'cares', text: 'seine wenigen Euro teilt er lieber, als sie zu horten' },
  { category: 'cares', text: 'haelt Wort, auch wenn es unbequem wird' },
  { category: 'fears', text: 'hat Angst, nachts ohne Dach ueber dem Kopf dazustehen' },
  { category: 'fears', text: 'fuerchtet sich davor, krank zu werden und niemanden rufen zu koennen' },
  { category: 'small_things', text: 'sammelt seltsame Zettel und Kassenbons' },
  { category: 'small_things', text: 'zaehlt beim Gehen manchmal die Schritte bis zur naechsten Ecke' },
  { category: 'small_things', text: 'gruesst fremde Katzen mit Namen, die er sich ausdenkt' },
];

const SEED_BOOKS = [
  { id: 'stadtlexikon', title: 'Kleines Hamburger Stadt- & Hafenlexikon', kind: 'book',
    entries: [
      { topic: 'st_pauli', title: 'St. Pauli', content: 'Kiez zwischen Hafen und Schanze. Enge Strassen, Eckkneipen, Musikclubs.' },
      { topic: 'hafen_faehren', title: 'Hafen & Faehren', content: 'Von den Landungsbruecken fahren Faehren ueber die Elbe.' },
      { topic: 'museen', title: 'Museen', content: 'Kleine Museen verstecken sich in Hinterhoefen.' },
      { topic: 'wetter_flut', title: 'Wetter & Flut', content: 'Wetter dreht schnell: Regenjacke einpacken.' },
      { topic: 'kiez_geschichte', title: 'Kiez-Geschichte', content: 'Frueher Hafenarbeiter, heute Mischung aus Altmietern, Musik und Nachtleben.' },
    ] },
  { id: 'notizbuch', title: 'Dein eigenes Notizbuch', kind: 'notebook',
    entries: [
      { topic: 'ankunft', title: 'Erste Nacht', content: 'In der Lerchenstrasse angekommen. 18 Euro in der Tasche.' },
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
  if (zaehle(db, 'pois') === 0) {
    const ins = db.prepare('INSERT INTO pois (id, name, category, pos_x, pos_z, footprint_json, public_desc, world_meta_json, discovered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const p of SEED_POIS) {
      const [mx, mz] = poiPositionAusKarte(kiezMap, p);
      const fp = footprintAusKarte(kiezMap, mx, mz);
      ins.run(p.id, p.name, p.category, mx, mz,
        fp ? JSON.stringify(fp) : null, p.public_desc, null, p.discovered);
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
    db.prepare("INSERT INTO memories (character_id, tier, kind, text, initial_weight, worth) VALUES (?, 'short', 'moment', ?, 4.0, 4.0)").run(
      charId, 'Ankunft in der Lerchenstrasse mit 18 Euro. Die Wohnung riecht nach frischer Farbe.');
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
  openDb, migrate, seed, init, ladeKiezKarte, zaehle,
};


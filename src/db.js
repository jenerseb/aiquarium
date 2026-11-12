'use strict';
// Datenbank: node:sqlite (in Node 22+ eingebaut), keine nativen Abhängigkeiten.
// Werte sind "hoch = schlecht": hunger, exhaustion, stress.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { ENTITIES, START } = require('./config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS world_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cycle INTEGER DEFAULT 1,
  world_tick INTEGER DEFAULT 0,
  sun_angle REAL DEFAULT 0.0,
  weather TEXT DEFAULT 'clear',
  last_tick_at TEXT,
  last_novelty_tick INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pilots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_num INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'alive',
  mind_state TEXT DEFAULT 'klar',
  hunger REAL DEFAULT 30.0,
  exhaustion REAL DEFAULT 20.0,
  stress REAL DEFAULT 25.0,
  pos_x REAL DEFAULT 0.0,
  pos_z REAL DEFAULT 0.0,
  accent_hue INTEGER DEFAULT 200,
  current_action TEXT DEFAULT 'idle',
  action_started_tick INTEGER DEFAULT 0,
  action_duration_s INTEGER DEFAULT 0,
  target_entity TEXT,
  mind_state_since_tick INTEGER DEFAULT 0,
  cause_of_death TEXT,
  epitaph TEXT,
  created_tick INTEGER DEFAULT 0,
  died_tick INTEGER,
  stress_at_start REAL
);

CREATE TABLE IF NOT EXISTS pilot_mind (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pilot_id INTEGER REFERENCES pilots(id),
  layer TEXT NOT NULL,
  action_key TEXT,
  times_borne_out INTEGER DEFAULT 1,
  avg_stress_delta REAL DEFAULT 0.0,
  belief_text TEXT NOT NULL,
  is_locked INTEGER DEFAULT 0,
  needs_text INTEGER DEFAULT 0,
  text_attempts INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS world_entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  pos_x REAL, pos_z REAL,
  physics_traits_json TEXT,
  visual_kit_preset TEXT,
  unfinished_thought TEXT,
  unfinished_by_pilot INTEGER,
  discovered INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT,
  in_feed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_tick ON events(tick);
CREATE INDEX IF NOT EXISTS idx_events_feed ON events(in_feed, id DESC);

CREATE TABLE IF NOT EXISTS nerve_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pilot_id INTEGER REFERENCES pilots(id),
  tick INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source TEXT,
  weight REAL DEFAULT 1.0
);

CREATE TABLE IF NOT EXISTS thoughts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pilot_id INTEGER,
  tick INTEGER NOT NULL,
  text TEXT NOT NULL
);

-- Was ein Pilot schon gesehen/getan hat: Grundlage für die Neugier-Belohnung
CREATE TABLE IF NOT EXISTS novelty (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pilot_id INTEGER,
  key TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  last_tick INTEGER DEFAULT 0,
  UNIQUE (pilot_id, key)
);

CREATE TABLE IF NOT EXISTS names_used (
  name TEXT PRIMARY KEY,
  count INTEGER DEFAULT 1
);
`;

function open(file) {
  const dir = path.dirname(file);
  if (file !== ':memory:' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrateAlteWerte(db);      // muss vor dem Schema laufen: alte Spalten umbenennen
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  return db;
}

// Alte Datenbank (food/energy/sanity) auf die neuen Werte umstellen:
// Spalten umbenennen und Werte invertieren, denn vorher galt "hoch = gut".
function migrateAlteWerte(db) {
  const tabellen = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pilots'").all();
  if (!tabellen.length) return;
  const haben = new Set(db.prepare('PRAGMA table_info(pilots)').all().map((r) => r.name));
  const paare = [['food', 'hunger'], ['energy', 'exhaustion'], ['sanity', 'stress'],
    ['sanity_at_start', 'stress_at_start']];
  const alt = paare.some(([a]) => haben.has(a));
  if (!alt) return;

  for (const [a, n] of paare) {
    if (haben.has(a) && !haben.has(n)) db.exec(`ALTER TABLE pilots RENAME COLUMN ${a} TO ${n}`);
  }
  // Werte drehen: 100 - alt. Startzustand entsprechend neu setzen.
  db.exec(`UPDATE pilots SET
    hunger = ${100} - hunger,
    exhaustion = ${100} - exhaustion,
    stress = ${100} - stress`);
  if (haben.has('stress_at_start')) {
    db.exec('UPDATE pilots SET stress_at_start = 100 - stress_at_start WHERE stress_at_start IS NOT NULL');
  }

  // Beliefs sind inhaltlich falsch geworden (Stress war Nerven) — neu lernen lassen
  const mindTab = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pilot_mind'").all();
  if (mindTab.length) {
    const mind = db.prepare('PRAGMA table_info(pilot_mind)').all().map((r) => r.name);
    if (mind.includes('avg_sanity_delta') && !mind.includes('avg_stress_delta')) {
      db.exec('ALTER TABLE pilot_mind RENAME COLUMN avg_sanity_delta TO avg_stress_delta');
    }
    db.exec("DELETE FROM pilot_mind WHERE layer = 'somatic_theory'");
  }
}

// Spalten nachziehen, wenn eine ältere Datenbank weiterläuft
function migrate(db) {
  const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name));

  // Welche Orte er gerade berührt: muss den Tick überleben, sonst zählt jeder Tick als Ankunft
  if (!cols('pilots').has('near_json')) db.exec("ALTER TABLE pilots ADD COLUMN near_json TEXT DEFAULT ''");

  const w = cols('world_state');
  if (!w.has('last_novelty_tick')) db.exec('ALTER TABLE world_state ADD COLUMN last_novelty_tick INTEGER DEFAULT 0');

  const p = cols('pilots');
  if (!p.has('stress_at_start')) db.exec('ALTER TABLE pilots ADD COLUMN stress_at_start REAL');
  if (!p.has('heading')) db.exec('ALTER TABLE pilots ADD COLUMN heading REAL');

  // Erkanntheitsgrad je Ort: wächst nur (0 ungesehen … 3 klar), nie zurück
  const we = cols('world_entities');
  if (!we.has('sicht')) db.exec('ALTER TABLE world_entities ADD COLUMN sicht INTEGER DEFAULT 0');

  const m = cols('pilot_mind');
  if (!m.has('needs_text')) db.exec('ALTER TABLE pilot_mind ADD COLUMN needs_text INTEGER DEFAULT 0');
  if (!m.has('text_attempts')) db.exec('ALTER TABLE pilot_mind ADD COLUMN text_attempts INTEGER DEFAULT 0');
}

// Welt einmalig anlegen: Zustand, Orte, erster Pilot
function seed(db) {
  const ws = db.prepare('SELECT id FROM world_state WHERE id = 1').get();
  if (!ws) {
    db.prepare('INSERT INTO world_state (id, last_tick_at, last_novelty_tick) VALUES (1, ?, 0)')
      .run(new Date().toISOString());
  }
  const ins = db.prepare(`INSERT OR IGNORE INTO world_entities
    (id, type, name, pos_x, pos_z, physics_traits_json, visual_kit_preset, discovered)
    VALUES (?, ?, ?, ?, ?, NULL, ?, 0)`);
  for (const e of ENTITIES) ins.run(e.id, e.type, e.name, e.x, e.z, e.id);
  // Layout ist code-definiert: bestehende DBs auf die Config-Koordinaten ziehen
  const lege = db.prepare('UPDATE world_entities SET pos_x=?, pos_z=? WHERE id=?');
  for (const e of ENTITIES) lege.run(e.x, e.z, e.id);

  const anzahl = db.prepare('SELECT COUNT(*) c FROM pilots').get().c;
  if (!anzahl) {
    db.prepare(`INSERT INTO pilots (cycle_num, name, hunger, exhaustion, stress, created_tick)
      VALUES (1, ?, ?, ?, ?, 0)`).run('Kapitän Meero', START.hunger, START.exhaustion, START.stress);
  }
}

// --- kleine Helfer ---------------------------------------------------------
const q = {
  world: (db) => db.prepare('SELECT * FROM world_state WHERE id = 1').get(),
  pilot: (db) => db.prepare('SELECT * FROM pilots ORDER BY id DESC LIMIT 1').get(),
  pilotById: (db, id) => db.prepare('SELECT * FROM pilots WHERE id = ?').get(id),
  entities: (db) => db.prepare('SELECT * FROM world_entities').all(),
  lastThoughts: (db, n = 15) =>
    db.prepare('SELECT text FROM thoughts ORDER BY id DESC LIMIT ?').all(n).map((r) => r.text),
  recentNerve: (db, pilotId, n = 5) =>
    db.prepare('SELECT * FROM nerve_events WHERE pilot_id = ? ORDER BY id DESC LIMIT ?').all(pilotId, n),
  feed: (db, limit = 50) =>
    db.prepare('SELECT * FROM events WHERE in_feed = 1 ORDER BY id DESC LIMIT ?').all(limit),
  mind: (db, pilotId) =>
    db.prepare('SELECT * FROM pilot_mind WHERE pilot_id = ? ORDER BY is_locked DESC, times_borne_out DESC').all(pilotId),
  novelty: (db, pilotId) =>
    db.prepare('SELECT * FROM novelty WHERE pilot_id = ?').all(pilotId),
  lastEvent: (db, type) =>
    db.prepare('SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(type),
};

function logEvent(db, tick, type, payload = {}, inFeed = false) {
  db.prepare('INSERT INTO events (tick, type, payload_json, in_feed) VALUES (?, ?, ?, ?)')
    .run(tick, type, JSON.stringify(payload), inFeed ? 1 : 0);
}

module.exports = { open, q, logEvent, seed };

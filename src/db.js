'use strict';
// Datenbank: node:sqlite (in Node 22+ eingebaut), keine nativen Abhängigkeiten.
// Zwei Kernwerte: body (0..100, hoch = gut) und psyche (-100..+100).
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { ENTITIES, START, clusterPos, spawnPos } = require('./config');

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
  body REAL DEFAULT 100.0,
  psyche REAL DEFAULT 0.0,
  hunger REAL DEFAULT 15.0,
  thermo REAL DEFAULT 0.0,
  drang REAL DEFAULT 10.0,
  halt REAL DEFAULT 80.0,
  pos_x REAL DEFAULT 0.0,
  pos_y REAL DEFAULT 120.0,
  pos_z REAL DEFAULT 0.0,
  heading_x REAL,
  heading_y REAL,
  heading_z REAL,
  mania_until_tick INTEGER,
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
  psyche_at_start REAL,
  vorhaben_json TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS pilot_mind (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pilot_id INTEGER REFERENCES pilots(id),
  layer TEXT NOT NULL,
  action_key TEXT,
  times_borne_out INTEGER DEFAULT 1,
  avg_psyche_delta REAL DEFAULT 0.0,
  belief_text TEXT NOT NULL,
  is_locked INTEGER DEFAULT 0,
  needs_text INTEGER DEFAULT 1,
  text_attempts INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS world_entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  pos_x REAL, pos_y REAL, pos_z REAL,
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
  migrateAlteWerte(db);      // muss vor dem Schema laufen: alte Werte auf Körper/Psyche abbilden
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
  const altSpalten = ['food', 'energy', 'sanity'];
  const alt = altSpalten.some((a) => haben.has(a));
  if (!alt) return;

  // Alte Drei-Werte-Welt (food/energy/sanity, hoch = gut) auf Körper/Psyche abbilden:
  // Körper = was vom Leib ist (100 minus der schlechteste alte Verbrauch),
  // Psyche = alte Ausgeglichenheit, linear auf -100..+100 gestreckt.
  // Danach alte Spalten entfernen.
  if (!haben.has('body')) db.exec('ALTER TABLE pilots ADD COLUMN body REAL NOT NULL DEFAULT 100');
  if (!haben.has('psyche')) db.exec('ALTER TABLE pilots ADD COLUMN psyche REAL NOT NULL DEFAULT 0');
  db.exec(`UPDATE pilots SET
    body = 100 - CASE
      WHEN food IS NULL AND energy IS NULL THEN 0
      ELSE max(COALESCE(food, 0), COALESCE(energy, 0)) END,
    psyche = CASE
      WHEN sanity IS NULL THEN 0
      ELSE 2 * sanity - 100 END
    WHERE food IS NOT NULL OR energy IS NOT NULL OR sanity IS NOT NULL`);
  for (const a of [...altSpalten, 'sanity_at_start']) {
    if (haben.has(a)) db.exec(`ALTER TABLE pilots DROP COLUMN ${a}`);
  }
  // hunger/exhaustion/stress aus einer Zwischenversion ebenfalls entfernen
  const danach = new Set(db.prepare('PRAGMA table_info(pilots)').all().map((r) => r.name));
  for (const a of ['hunger', 'exhaustion', 'stress', 'stress_at_start']) {
    if (danach.has(a)) db.exec(`ALTER TABLE pilots DROP COLUMN ${a}`);
  }

  // Beliefs sind inhaltlich falsch geworden (Stress war Nerven) — neu lernen lassen
  const mindTab = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pilot_mind'").all();
  if (mindTab.length) {
    const mind = db.prepare('PRAGMA table_info(pilot_mind)').all().map((r) => r.name);
    if (mind.includes('avg_sanity_delta') && !mind.includes('avg_psyche_delta')) {
      db.exec('ALTER TABLE pilot_mind RENAME COLUMN avg_sanity_delta TO avg_psyche_delta');
    } else if (mind.includes('avg_stress_delta') && !mind.includes('avg_psyche_delta')) {
      db.exec('ALTER TABLE pilot_mind RENAME COLUMN avg_stress_delta TO avg_psyche_delta');
    }
    db.exec("DELETE FROM pilot_mind WHERE layer = 'somatic_theory'");
  }
}

// Spalten nachziehen, wenn eine ältere Datenbank weiterläuft
function migrate(db) {
  const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name));

  // Welche Orte er gerade berührt: muss den Tick überleben, sonst zählt jeder Tick als Ankunft
  if (!cols('pilots').has('near_json')) db.exec("ALTER TABLE pilots ADD COLUMN near_json TEXT DEFAULT ''");

  // Paket A: aktives Vorhaben als JSON (Ziel, Grund, seit wann) — überlebt Ticks,
  // wird nicht bei bloßem Aktionswechsel gelöscht
  if (!cols('pilots').has('vorhaben_json')) db.exec("ALTER TABLE pilots ADD COLUMN vorhaben_json TEXT DEFAULT ''");

  const w = cols('world_state');
  if (!w.has('last_novelty_tick')) db.exec('ALTER TABLE world_state ADD COLUMN last_novelty_tick INTEGER DEFAULT 0');
  // Tag/Nacht: Sonnenwinkel (Umdrehungen seit Start, 2 h pro Umdrehung).
  // Alte Datenbanken ohne die Spalte werden nachgezogen, Default 0 = Tagesbeginn.
  if (!w.has('sun_angle')) db.exec('ALTER TABLE world_state ADD COLUMN sun_angle REAL DEFAULT 0.0');

  // Paket K: hunger/exhaustion/stress -> body/psyche, Positionen -> 3D, Blick -> Vektor
  const p = cols('pilots');
  if (!p.has('body')) {
    db.exec('ALTER TABLE pilots ADD COLUMN body REAL DEFAULT 100.0');
    db.exec('ALTER TABLE pilots ADD COLUMN psyche REAL DEFAULT 0.0');
    if (p.has('hunger') || p.has('exhaustion') || p.has('stress')) {
      // Körper: der schlechtere der beiden alten Abflüsse regiert; Psyche: Stress gedreht
      db.exec(`UPDATE pilots SET body = 100 - MAX(
        COALESCE(hunger, 0), COALESCE(exhaustion, 0)),
        psyche = -COALESCE(stress, 0)`);
      db.exec('ALTER TABLE pilots DROP COLUMN hunger');
      db.exec('ALTER TABLE pilots DROP COLUMN exhaustion');
      db.exec('ALTER TABLE pilots DROP COLUMN stress');
    }
    if (p.has('stress_at_start')) db.exec('ALTER TABLE pilots RENAME COLUMN stress_at_start TO psyche_at_start');
  }
  if (!cols('pilots').has('pos_y')) {
    db.exec('ALTER TABLE pilots ADD COLUMN pos_y REAL DEFAULT 120.0');
    db.exec(`UPDATE pilots SET pos_y = sqrt(MAX(120.0*120.0 - pos_x*pos_x - pos_z*pos_z, 0.0))
      WHERE pos_y IS NULL OR pos_y = 120.0`);
  }
  if (cols('pilots').has('heading') && !cols('pilots').has('heading_x')) {
    db.exec('ALTER TABLE pilots DROP COLUMN heading');
  }
  if (!cols('pilots').has('heading_x')) {
    db.exec('ALTER TABLE pilots ADD COLUMN heading_x REAL');
    db.exec('ALTER TABLE pilots ADD COLUMN heading_y REAL');
    db.exec('ALTER TABLE pilots ADD COLUMN heading_z REAL');
  }
  if (!cols('pilots').has('mania_until_tick')) {
    db.exec('ALTER TABLE pilots ADD COLUMN mania_until_tick INTEGER');
  }

  // Paket K: Level-2-Treiber (Startwerte aus TREIBER in config.js).
  // Bestehende Piloten starten frisch — alte hunger/exhaustion/stress-Spalten
  // wurden oben bereits entfernt, es gibt nichts zu übernehmen.
  if (!cols('pilots').has('hunger')) {
    db.exec('ALTER TABLE pilots ADD COLUMN hunger REAL DEFAULT 15.0');
    db.exec('ALTER TABLE pilots ADD COLUMN thermo REAL DEFAULT 0.0');
    db.exec('ALTER TABLE pilots ADD COLUMN drang REAL DEFAULT 10.0');
    db.exec('ALTER TABLE pilots ADD COLUMN halt REAL DEFAULT 80.0');
    db.exec(`UPDATE pilots SET hunger = 15.0, thermo = 0.0, drang = 10.0, halt = 80.0
      WHERE hunger IS NULL`);
  }

  // Erkanntheitsgrad je Ort: wächst nur (0 ungesehen … 3 klar), nie zurück
  const we = cols('world_entities');
  if (!we.has('sicht')) db.exec('ALTER TABLE world_entities ADD COLUMN sicht INTEGER DEFAULT 0');
  if (!we.has('pos_y')) {
    db.exec('ALTER TABLE world_entities ADD COLUMN pos_y REAL DEFAULT 120.0');
    db.exec(`UPDATE world_entities SET pos_y = sqrt(MAX(120.0*120.0 - pos_x*pos_x - pos_z*pos_z, 0.0))
      WHERE pos_y IS NULL OR pos_y = 120.0`);
  }

  const m = cols('pilot_mind');
  if (m.has('avg_stress_delta') && !m.has('avg_psyche_delta')) {
    db.exec('ALTER TABLE pilot_mind RENAME COLUMN avg_stress_delta TO avg_psyche_delta');
    db.exec('UPDATE pilot_mind SET avg_psyche_delta = -avg_psyche_delta');   // Vorzeichen dreht mit
  }
  if (!m.has('needs_text')) db.exec('ALTER TABLE pilot_mind ADD COLUMN needs_text INTEGER DEFAULT 1');
  if (!m.has('text_attempts')) db.exec('ALTER TABLE pilot_mind ADD COLUMN text_attempts INTEGER DEFAULT 0');

  // Festgefahrene Erstpiloten befreien: wer in Tick 0 noch exakt auf
  // clusterPos(0, 0) steht (idle), kommt einmalig auf spawnPos() (15 m raus).
  try {
    const k0 = clusterPos(0, 0);
    const k1 = spawnPos();
    db.prepare(`UPDATE pilots SET pos_x = ?, pos_y = ?, pos_z = ?
      WHERE status = 'alive' AND created_tick = 0 AND current_action = 'idle'
      AND pos_x = ? AND pos_z = ?`)
      .run(k1.pos_x, k1.pos_y, k1.pos_z, k0.x, k0.z);
  } catch { /* alte DB ohne Spalten — seed/migrate oben regelt das */ }
}

// Welt einmalig anlegen: Zustand, Orte, erster Pilot
function seed(db) {
  const ws = db.prepare('SELECT id FROM world_state WHERE id = 1').get();
  if (!ws) {
    db.prepare('INSERT INTO world_state (id, last_tick_at, last_novelty_tick) VALUES (1, ?, 0)')
      .run(new Date().toISOString());
  }
  const ins = db.prepare(`INSERT OR IGNORE INTO world_entities
    (id, type, name, pos_x, pos_y, pos_z, physics_traits_json, visual_kit_preset, discovered)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0)`);
  for (const e of ENTITIES) {
    const w = clusterPos(e.x, e.z);
    ins.run(e.id, e.type, e.name, w.x, w.y, w.z, e.id);
  }
  // Layout ist code-definiert: bestehende DBs auf die Config-Koordinaten ziehen
  const lege = db.prepare('UPDATE world_entities SET pos_x=?, pos_y=?, pos_z=? WHERE id=?');
  for (const e of ENTITIES) {
    const w = clusterPos(e.x, e.z);
    lege.run(w.x, w.y, w.z, e.id);
  }

  const anzahl = db.prepare('SELECT COUNT(*) c FROM pilots').get().c;
  if (!anzahl) {
    const k = spawnPos();   // 15 m neben dem sichtbaren Kapsel-Anker, nicht im Glas
    db.prepare(`INSERT INTO pilots (cycle_num, name, body, psyche, created_tick,
      pos_x, pos_y, pos_z)
      VALUES (1, ?, ?, ?, 0, ?, ?, ?)`).run('Kapitän Meero', START.body, START.psyche, k.pos_x, k.pos_y, k.pos_z);
  }
}

// --- kleine Helfer ---------------------------------------------------------
const q = {
  world: (db) => db.prepare('SELECT * FROM world_state WHERE id = 1').get(),
  pilot: (db) => db.prepare('SELECT * FROM pilots ORDER BY id DESC LIMIT 1').get(),
  pilotById: (db, id) => db.prepare('SELECT * FROM pilots WHERE id = ?').get(id),
  entities: (db) => db.prepare('SELECT * FROM world_entities').all(),
  lastThoughts: (db, n = 15, pilotId = null) =>
    (pilotId == null
      ? db.prepare('SELECT text FROM thoughts ORDER BY id DESC LIMIT ?').all(n)
      : db.prepare('SELECT text FROM thoughts WHERE pilot_id = ? ORDER BY id DESC LIMIT ?').all(pilotId, n)
    ).map((r) => r.text),
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
  lastThoughtTick: (db, pilotId) =>
    db.prepare('SELECT MAX(tick) AS t FROM thoughts WHERE pilot_id = ?').get(pilotId).t,
  ereignisseSeit: (db, tick, typen) =>
    db.prepare(`SELECT type FROM events WHERE tick > ? AND type IN (${typen.map(() => '?').join(',')})`)
      .all(tick, ...typen).map((r) => r.type),
};

// Aufräumen für den 24/7-Betrieb: altes Nicht-Feed-Rauschen und alte Gedanken
// beschneiden (alle 3600 Ticks und einmal beim Serverstart).
function pruneDB(db) {
  const alt = db.prepare(`DELETE FROM events
    WHERE in_feed = 0 AND created_at < datetime('now', '-7 days')`).run();
  let gedanken = 0;
  const piloten = db.prepare('SELECT DISTINCT pilot_id FROM thoughts WHERE pilot_id IS NOT NULL').all();
  for (const { pilot_id } of piloten) {
    const r = db.prepare(`DELETE FROM thoughts WHERE pilot_id = ?
      AND id NOT IN (SELECT id FROM thoughts WHERE pilot_id = ? ORDER BY id DESC LIMIT 500)`)
      .run(pilot_id, pilot_id);
    gedanken += r.changes;
  }
  return { events: alt.changes, gedanken };
}

function logEvent(db, tick, type, payload = {}, inFeed = false) {
  db.prepare('INSERT INTO events (tick, type, payload_json, in_feed) VALUES (?, ?, ?, ?)')
    .run(tick, type, JSON.stringify(payload), inFeed ? 1 : 0);
}

module.exports = { open, q, logEvent, seed, pruneDB };

'use strict';
// Meilenstein-1-Test: DB initialisieren + Route apartment -> otzentreff.
// Aufruf: npm test  (oder: node scripts/test-m1.js)
// Nutzt eine TEMP-DB, damit die echte Welt-DB unangetastet bleibt.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const dbMod = require('../src/db');
const pf = require('../src/pathfinding');

const ERWARTETE_TABELLEN = [
  'world_state', 'character', 'character_sheet', 'memories', 'open_loops',
  'work_pieces', 'pois', 'poi_offers', 'jobs', 'messages_outbox',
  'inventory', 'books', 'home_library', 'practised', 'day_summaries',
  'events', 'hall_of_fame',
];

function main() {
  const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aiq-m1-')), 'world.sqlite');
  console.log('[m1] temp-db:', tmpDb);

  const karte = dbMod.ladeKiezKarte();
  assert.ok(karte && karte.navGraph, 'kiez_map.json mit navGraph erwartet');
  console.log('[m1] karte: ' + karte.buildings.length + ' gebaeude, '
    + karte.navGraph.nodes.length + ' knoten, ' + karte.navGraph.edges.length + ' kanten');

  const { db, characterId } = dbMod.init(tmpDb, karte);

  // 1) Alle Tabellen vorhanden?
  const tabellen = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r) => r.name);
  for (const t of ERWARTETE_TABELLEN) assert.ok(tabellen.includes(t), 'tabelle fehlt: ' + t);
  console.log('[m1] tabellen ok (' + ERWARTETE_TABELLEN.length + ')');

  // 2) Seed: 13 POIs, nur apartment entdeckt?
  const pois = db.prepare('SELECT * FROM pois ORDER BY id').all();
  assert.strictEqual(pois.length, 13, '13 seed-POIs erwartet, gefunden: ' + pois.length);
  const apt = pois.find((p) => p.id === 'apartment');
  assert.ok(apt && apt.discovered === 1, 'apartment muss discovered=1 sein');
  assert.ok(pois.filter((p) => p.id !== 'apartment').every((p) => p.discovered === 0), 'nur apartment entdeckt');
  console.log('[m1] pois ok: ' + pois.map((p) => p.id).join(','));

  // 3) Charakter + Sheet + Inventar + Buecher?
  const ch = db.prepare('SELECT * FROM character WHERE id = ?').get(characterId);
  assert.ok(ch, 'charakter fehlt');
  assert.strictEqual(ch.geld, 18.0, 'startgeld 18.00 erwartet');
  assert.strictEqual(ch.hunger, 20.0);
  assert.strictEqual(ch.erschoepfung, 15.0);
  assert.strictEqual(ch.inside_poi, 'apartment');
  const sheetN = db.prepare('SELECT COUNT(*) AS n FROM character_sheet WHERE character_id = ?').get(characterId).n;
  assert.ok(sheetN >= 10, 'sheet-zeilen erwartet, gefunden: ' + sheetN);
  const inv = db.prepare('SELECT item_key FROM inventory WHERE character_id = ?').all(characterId).map((r) => r.item_key);
  assert.ok(inv.includes('notizblock'), 'notizblock im inventar erwartet');
  const books = db.prepare('SELECT id FROM books').all().map((r) => r.id);
  assert.ok(books.includes('stadtlexikon') && books.includes('notizbuch'), 'buecher-seed erwartet');
  console.log('[m1] charakter ok: id=' + characterId + ' geld=' + ch.geld + ' sheet=' + sheetN + ' inv=' + inv.join(','));

  // 4) Route apartment -> otzentreff auf dem Gehweg-Graphen
  const route = pf.findePoiRoute(karte.navGraph, pois, 'apartment', 'otzentreff');
  assert.ok(route.pfad.length >= 2, 'route braucht >= 2 knoten');
  assert.ok(Number.isFinite(route.distanzM) && route.distanzM > 0, 'distanz muss endlich und > 0 sein');
  assert.ok(route.distanzM < 2000, 'distanz plausibel (< 2 km), war: ' + route.distanzM);
  console.log('[m1] route apartment -> otzentreff: ' + route.pfad.length + ' knoten, ' + route.distanzM + ' m');
  console.log('[m1]   startknoten ' + route.startKnoten.knoten.id + ' (' + route.startKnoten.distanzM.toFixed(1) + ' m vom POI)');
  console.log('[m1]   zielknoten  ' + route.zielKnoten.knoten.id + ' (' + route.zielKnoten.distanzM.toFixed(1) + ' m vom POI)');
  console.log('[m1]   pfad: ' + route.pfad.slice(0, 12).join(' -> ') + (route.pfad.length > 12 ? ' ...' : ''));

  // 5) Slot-Limit-Spalten vorhanden? (Meilenstein-Auftrag: memories mit Slot-Limit)
  const memInfo = db.prepare('PRAGMA table_info(memories)').all().map((r) => r.name);
  assert.ok(memInfo.includes('tier') && memInfo.includes('worth'), 'memories braucht tier + worth');
  db.close();
  console.log('[m1] ALLES OK');
}

try {
  main();
} catch (err) {
  console.error('[m1] FEHLER:', err.message);
  process.exit(1);
}

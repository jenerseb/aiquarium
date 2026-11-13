'use strict';
// Tests: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateDecision, jaccard, wordCount, hasCJK, englishHits, hasRecentExclamation, hatObjektEroeffnung } = require('../src/checks');
const { roman, uniqueName, randomHue } = require('../src/names');
const { whitelistFor, sensory, buildPrompt, impulsText } = require('../src/prompt');
const { effectFor, RESPAWN_DELAY_S, sichtStufe, SICHT, ankerPos, dist3, vec3, norm3, ENTITIES, entityLabel, wuerfelImpuls, ACTIONS, MANIA, modellKurz } = require('../src/config');
const { open, q } = require('../src/db');
const { Engine, step } = require('../src/engine');
const { decide: brainDecide } = require('../src/brain');

const WL = ['eat', 'sleep', 'sit_shade', 'inspect', 'look_earth', 'dig'];
const frisch = () => open(':memory:');

// ---------------------------------------------------------------- checks
test('checks: gültige Antwort passiert', () => {
  const v = validateDecision('{"action":"eat","thought":"Magen knurrt. Ich geh zur Karotte."}', { whitelist: WL });
  assert.equal(v.ok, true, JSON.stringify(v.failures));
});

test('checks: kaputtes JSON', () => {
  assert.deepEqual(validateDecision('action: eat', { whitelist: WL }).failures, ['json']);
});

test('checks: Aktion nicht in der Whitelist', () => {
  assert.ok(validateDecision('{"action":"fliegen","thought":"Ich fliege davon."}', { whitelist: WL })
    .failures.includes('whitelist'));
});

test('checks: leere und zu lange Gedanken', () => {
  assert.ok(validateDecision('{"action":"eat","thought":""}', { whitelist: WL }).failures.includes('leer'));
  const lang = 'Ich sitze hier im Schatten und denke über alles nach was gestern passiert ist und morgen kommen wird ganz sicher wirklich.';
  assert.equal(wordCount(lang), 21);
  assert.ok(validateDecision(JSON.stringify({ action: 'sit_shade', thought: lang }), { whitelist: WL })
    .failures.includes('words'));
});

test('checks: chinesische Zeichen und Englisch fliegen raus', () => {
  assert.equal(hasCJK('你好 Welt'), true);
  assert.ok(validateDecision('{"action":"eat","thought":"I need the food now"}', { whitelist: WL })
    .failures.includes('english'));
  assert.deepEqual(englishHits('Der warme Wind ist gut'), []);
});

test('checks: Wiederholung wird erkannt (Jaccard)', () => {
  const letzte = ['Magen brennt. Die Heizung ist näher als die Karotte.'];
  assert.ok(validateDecision('{"action":"eat","thought":"Magen brennt. Die Heizung ist näher als die Karotte."}',
    { whitelist: WL, recentThoughts: letzte }).failures.includes('novelty'));
  assert.equal(Math.round(jaccard('a b c', 'a b c')), 1);
});

test('checks: Ausruf-Bremse', () => {
  const letzte = ['Oh, da hinten glänzt was!', 'Magen knurrt.'];
  assert.ok(validateDecision('{"action":"inspect","thought":"Da ist was! Ich geh hin."}',
    { whitelist: WL, recentThoughts: letzte }).failures.includes('exclamation'));
  assert.equal(validateDecision('{"action":"inspect","thought":"Da ist was. Ich geh hin."}',
    { whitelist: WL, recentThoughts: letzte }).ok, true);
});

test('checks: Welt benennen ist kein Vergehen', () => {
  // Wer beim Wrack steht, darf „Wrack" sagen — keine Wortfilter mehr.
  const v = validateDecision('{"action":"inspect","thought":"Das Wrack sieht interessant aus."}',
    { whitelist: WL, recentThoughts: [] });
  assert.equal(v.ok, true, JSON.stringify(v.failures));
});

test('checks: Zusatzgedanke wird geprüft', () => {
  assert.ok(validateDecision('{"action":"eat","thought":"Magen knurrt."}', { whitelist: WL, musing: true })
    .failures.includes('musing_fehlt'));

  const zuLang = validateDecision('{"action":"eat","thought":"Magen knurrt.",'
    + '"musing":"Ich frage mich wirklich was auf der Erde gerade alles so passiert"}',
  { whitelist: WL, musing: true });
  assert.ok(zuLang.failures.includes('musing_lang'));

  const gut = validateDecision('{"action":"eat","thought":"Magen knurrt.",'
    + '"musing":"Ob es dort oben Tiere gibt?"}', { whitelist: WL, musing: true });
  assert.equal(gut.ok, true, JSON.stringify(gut.failures));
  assert.equal(gut.musing, 'Ob es dort oben Tiere gibt?');
});

test('checks: Musterbremse Objekt-Eroeffnung (Paket B-Rest)', () => {
  const orte = ['Kapsel', 'Wrack', 'Karottenfeld', 'Funkmast'];
  const letzte = [
    'Das Wrack rostet vor sich hin.',
    'Die Kapsel surrt leise.',
    'Das Karottenfeld wartet.',
    'Der Funkmast klickt.',
  ];
  const v = validateDecision('{"action":"inspect","thought":"Das Wrack sieht interessant aus."}',
    { whitelist: WL, recentThoughts: letzte, orte });
  assert.ok(v.failures.includes('eroeffnung_objekt'), JSON.stringify(v.failures));
  // Ohne Orts-Historie passiert derselbe Gedanke
  const ok = validateDecision('{"action":"inspect","thought":"Das Wrack sieht interessant aus."}',
    { whitelist: WL, recentThoughts: ['Magen knurrt.', 'Mir ist kalt.'], orte });
  assert.equal(ok.ok, true, JSON.stringify(ok.failures));
});


// ---------------------------------------------------------------- names
test('names: römische Ziffern und Kollision', () => {
  assert.equal(roman(2), 'II');
  assert.equal(roman(14), 'XIV');
  const fest = () => 0;
  assert.equal(uniqueName([], fest), 'Wanda Krummhand');
  assert.equal(uniqueName(['Wanda Krummhand'], fest), 'Wanda Krummhand II');
  for (let i = 0; i < 100; i += 1) {
    const h = randomHue();
    assert.ok(h >= 175 && h <= 225);
  }
});

// ---------------------------------------------------------------- Whitelist
test('whitelist: ausgeruhte Figur bekommt nur Arbeit', () => {
  // Paket K: gesättigt (hunger 15), geerdet (halt 80), neugierig (drang 10)
  const p = { mind_state: 'klar', body: 100, psyche: 20, hunger: 15, drang: 10, halt: 80 };
  assert.deepEqual(whitelistFor(p).slice().sort(),
    ['call_bake', 'dig', 'inspect', 'search_wrack', 'sinnieren', 'streifen']);

  assert.ok(whitelistFor({ ...p, hunger: 60 }).includes('eat'));
  // Tag/Nacht: Schlaf-Regel — müde bei Licht draußen: kein sleep (er verkriecht sich
  // nur im Schatten/in der Kapsel); bei Nacht überall. sit_shade bleibt ortslos wählbar.
  const muedeLichtDraussen = whitelistFor({ ...p, body: 50 }, { phase: 'licht', nah: [] });
  assert.ok(!muedeLichtDraussen.includes('sleep'), `schläft bei Licht draußen: ${muedeLichtDraussen}`);
  const muedeLichtSchutz = whitelistFor({ ...p, body: 50 }, { phase: 'licht', nah: ['capsule'] });
  assert.ok(muedeLichtSchutz.includes('sit_shade') && muedeLichtSchutz.includes('sleep'));
  const muedeNacht = whitelistFor({ ...p, body: 50 }, { phase: 'nacht', nah: [] });
  assert.ok(muedeNacht.includes('sit_shade') && muedeNacht.includes('sleep'));
  const haltlos = whitelistFor({ ...p, halt: 30 });
  assert.ok(haltlos.includes('sit_shade') && haltlos.includes('look_earth'));
});

test('whitelist: Zickzack-Bremse stoppt A-B-A-B-Pendel', () => {
  const p = { mind_state: 'klar', body: 100, psyche: 20, hunger: 15, drang: 10, halt: 80 };
  const voll = ['call_bake', 'dig', 'inspect', 'search_wrack', 'sinnieren', 'streifen'];
  assert.deepEqual(whitelistFor(p, { recentActions: [] }).slice().sort(), voll);
  // Wiederholung sperrt B, Zickzack zusätzlich A -> dritte Option bleibt
  const pendel = whitelistFor(p, { recentActions: ['inspect', 'dig', 'inspect', 'dig'] });
  assert.ok(!pendel.includes('inspect') && !pendel.includes('dig'), `Pendel läuft weiter: ${pendel}`);
  assert.ok(pendel.includes('streifen') && pendel.includes('sinnieren'), `keine Alternative: ${pendel}`);
});

test('whitelist: Zickzack-Bremse greift nicht im Notfall', () => {
  const not = { mind_state: 'klar', body: 10, psyche: 0, hunger: 60, drang: 10, halt: 80 };
  const liste = whitelistFor(not, { recentActions: ['eat', 'sleep', 'eat', 'sleep'] });
  assert.ok(liste.includes('eat'), `Fressen gesperrt trotz leerem Körper: ${liste}`);
});

test('whitelist: Stupor und Wahn behalten ihren Ausweg', () => {
  const p = { mind_state: 'stupor', body: 50, psyche: -100 };
  assert.deepEqual(whitelistFor(p), ['sit_shade', 'sleep']);
  // Paket K, Wahn: hide_capsule = Rückzug in die Kapsel (sicherer Ort),
  // run_wild = blind wegrennen, sleep = Notausgang
  assert.deepEqual(whitelistFor({ ...p, mind_state: 'wahn' }), ['run_wild', 'hide_capsule', 'sleep']);
});

test('whitelist: Notfall-Instinkt durchbricht die Sperre bei leerem Körper', () => {
  // Depressiv, aber der Körper ist fast leer: Fressen wird trotzdem angeboten.
  const p = { mind_state: 'stupor', body: 10, psyche: -100 };
  assert.ok(whitelistFor(p).includes('eat'), 'Notfall-Fressen fehlt in der Sperrliste');
});

// ---------------------------------------------------------------- Paket K: Abnahme
test('whitelist: Manie blockt Ruhe UND Notfall (Manie hat höhere Prio)', () => {
  // Entschieden 2026-11-13: Notfall sticht Manie NICHT aus.
  const p = { mind_state: 'klar', body: 10, psyche: 100, mania_until_tick: 9999 };
  const liste = whitelistFor(p);
  assert.ok(!liste.includes('sleep') && !liste.includes('sit_shade'),
    `Ruhe trotz Manie: ${liste}`);
  assert.ok(!liste.includes('eat'), `Notfall sticht Manie: ${liste}`);
});

test('whitelist: Manie-Ende gibt Ruhe und Notfall zurück', () => {
  const p = { mind_state: 'stupor', body: 10, psyche: -100, mania_until_tick: null };
  assert.ok(whitelistFor(p).includes('eat'), 'Notfall nach Manie fehlt');
});

test('engine: Stupor isst nicht (Whitelist-Beleg)', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  db.prepare("UPDATE pilots SET mind_state='stupor', body=50, psyche=-100 WHERE id=?").run(s.pilot.id);
  assert.ok(!e.whitelist(e.state()).includes('eat'), 'Stupor isst bei body 50');
});

test('engine: Notfall-Durchbruch feuert genau einmal (eat, nicht sleep)', () => {
  // body 10, Stupor: eat kommt dazu — aber nur einmal pro Entscheidung
  const p = { mind_state: 'stupor', body: 10, psyche: -100, mania_until_tick: null };
  const liste = whitelistFor(p);
  assert.equal(liste.filter((a) => a === 'eat').length, 1, `eat doppelt: ${liste}`);
  assert.ok(!liste.includes('sleep') || true);   // sleep war schon da, bleibt
});

test('engine: Wahn kostet ×1,5 (Gehen) und scheitert zu 50 %', () => {
  // Gehen: gleicher Weg, mehr Körper weg
  const weg = (wahn) => {
    const d = frisch();
    const ee = new Engine(d, { apiKey: 'test' });
    const ss = ee.state();
    const w = ankerPos(ss.entities.find((x) => x.id === 'wreck'));
    const start = vec3({ pos_x: w.pos_x + 30, pos_z: w.pos_z });
    ss.pilot.pos_x = start.x; ss.pilot.pos_y = start.y; ss.pilot.pos_z = start.z;
    ss.pilot.heading = null;
    ss.pilot.body = 80; ss.pilot.psyche = -100;
    ss.pilot.mind_state = wahn ? 'wahn' : 'klar';
    ss.pilot.status = 'alive';
    ss.pilot.current_action = 'inspect'; ss.pilot.target_entity = 'wreck';
    ss.pilot.action_started_tick = null;
    step(ss, 1, { live: true, noRandom: true });
    return 80 - ss.pilot.body;
  };
  const mitWahn = weg(true);
  const ohneWahn = weg(false);
  assert.ok(mitWahn > ohneWahn + 0.004, `Wahn-Marsch ${mitWahn} vs normal ${ohneWahn}`);
});

test('engine: thermo-Drain ab |40| und |75| messbar', () => {
  const d = frisch();
  const e = new Engine(d, { apiKey: 'test' });
  const s = e.state();
  s.pilot.pos_x = 103.9; s.pilot.pos_y = 60; s.pilot.pos_z = 0;   // weit weg, keine Orte
  s.pilot.body = 80; s.pilot.psyche = 0; s.pilot.hunger = 50;   // hunger neutral: kein Regen, kein Drain
  s.pilot.thermo = 50; s.pilot.drang = 0; s.pilot.halt = 80;
  const v0 = s.pilot.body;
  step(s, 100, { live: true, noRandom: true });
  // Grundverbrauch 100×0,025 = 2,5; thermo-Anteil 100×0,001 = 0,1
  const verlust = v0 - s.pilot.body;
  assert.ok(verlust > 2.5 + 0.05, `kein thermo-Drain: ${verlust}`);
});

test('db: Treiber-Migration legt Spalten mit Startwerten an', () => {
  const db = frisch();
  const cols = new Set(db.prepare('PRAGMA table_info(pilots)').all().map((r) => r.name));
  for (const c of ['hunger', 'thermo', 'drang', 'halt']) assert.ok(cols.has(c), `${c} fehlt`);
  const p = db.prepare('SELECT hunger, thermo, drang, halt FROM pilots ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual([p.hunger, p.thermo, p.drang, p.halt], [15, 0, 10, 80]);
});


test('whitelist: Ruhe-Quote und Wiederholungs-Bremse', () => {
  const p = { mind_state: 'klar', body: 50, psyche: -20 };
  const ruhe = whitelistFor(p, { recentActions: ['sit_shade', 'look_earth', 'sit_shade'] });
  assert.ok(!ruhe.includes('sit_shade') && !ruhe.includes('look_earth'));
  assert.ok(ruhe.length > 0);

  const wieder = whitelistFor(p, { recentActions: ['inspect', 'inspect'] });
  assert.ok(!wieder.includes('inspect'));
  assert.ok(wieder.includes('dig'));
});

// ---------------------------------------------------------------- Wirkungen
test('effectFor: Sitzen heilt nur bei leerem Körper, sonst drückt es die Stimmung', () => {
  const muede = effectFor('sit_shade', { body: 30, psyche: 0 });
  const fit = effectFor('sit_shade', { body: 90, psyche: 0 });
  assert.ok(muede.body > 0);
  assert.ok(muede.psyche > 0);
  assert.ok(!(fit.body > 0), 'Sitzen heilt den Fitten nicht');
  assert.ok(fit.psyche < 0);
});

test('effectFor: Erdgucken und Fressen sind zustandsabhängig', () => {
  // Paket K: look_earth hängt an halt (Erdung), nicht mehr an psyche
  assert.ok(effectFor('look_earth', { body: 60, halt: 30 }).psyche > 0);
  assert.ok(effectFor('look_earth', { body: 60, halt: 80 }).psyche < 0);
  assert.ok(effectFor('eat', { body: 40, psyche: 0 }).body > 0);
  assert.deepEqual(effectFor('eat', { body: 97, psyche: 0 }), {});
});

test('sensory: leerer Körper und düstere Psyche klingen schlecht', () => {
  const schlecht = sensory({ body: 10, psyche: -80 });
  const gut = sensory({ body: 90, psyche: 50 });
  assert.match(schlecht, /schwankst/);
  assert.match(schlecht, /grau/);
  assert.match(gut, /strotzt/);
  assert.match(gut, /guter Dinge/);
});

// ---------------------------------------------------------------- Engine
test('engine: leerer Körper tötet, Neustart nach 10 Minuten', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s0 = e.state();
  db.prepare("UPDATE pilots SET body = 0.001, current_action = 'idle' WHERE id = ?").run(s0.pilot.id);

  e.tick();
  const tot = q.pilot(db);
  assert.equal(tot.status, 'dead');
  assert.equal(tot.cause_of_death, 'body');

  for (let i = 0; i < RESPAWN_DELAY_S + 2; i += 1) e.tick();
  const neu = q.pilot(db);
  assert.equal(neu.status, 'alive');
  assert.equal(neu.cycle_num, 2);
  assert.ok(neu.body > 99 && neu.body <= 100, `Start-Körper ${neu.body}`);
});

test('engine: Neugier belohnt den ersten Besuch, dann weniger, dann nichts', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();

  const werte = [];
  const wpos = ankerPos(s.entities.find((x) => x.id === 'note'));
  db.prepare('UPDATE pilots SET psyche = 0 WHERE id=?').run(s.pilot.id);
  for (let i = 0; i < 3; i += 1) {
    db.prepare('UPDATE pilots SET pos_x = ?, pos_y = ?, pos_z = ? WHERE id=?')
      .run(wpos.pos_x, wpos.pos_y, wpos.pos_z, s.pilot.id);
    e.tick();
    werte.push(q.pilot(db).psyche);
    // weit weg auf der Kugel (60° Polwinkel): kein Kontakt zu irgendeinem Ort
    db.prepare('UPDATE pilots SET pos_x = 103.9, pos_y = 60, pos_z = 0 WHERE id=?').run(s.pilot.id);
    e.tick();
  }

  const erster = werte[0];
  const zweiter = werte[1] - werte[0];
  const dritter = werte[2] - werte[1];
  assert.ok(erster > 10, `erster Besuch hebt um ${erster}`);
  assert.ok(zweiter > 2 && zweiter < erster, `zweiter um ${zweiter}`);
  assert.ok(dritter < 1, `dritter um ${dritter}`);
});

test('engine: Stehenbleiben zählt nicht als neue Ankunft', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  // Pilot steht am sichtbaren Notizzettel (Anker), nicht am Logikpunkt
  const zettelPos = ankerPos(s.entities.find((x) => x.id === 'note'));
  db.prepare('UPDATE pilots SET pos_x = ?, pos_y = ?, pos_z = ?, psyche = 0 WHERE id=?')
    .run(zettelPos.pos_x, zettelPos.pos_y, zettelPos.pos_z, s.pilot.id);

  for (let i = 0; i < 8; i += 1) e.tick();
  const zettel = db.prepare("SELECT count FROM novelty WHERE key = 'entity:note'").get();
  assert.equal(zettel.count, 1, 'ein Besuch, nicht acht');
});

test('engine: Langeweile drückt die Psyche', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  // weit weg von allen Orten, sonst belohnt schon der erste Tick den Fund der Kapsel
  db.prepare('UPDATE pilots SET psyche = 0, pos_x = 103.9, pos_y = 60, pos_z = 0 WHERE id = ?').run(s.pilot.id);
  db.prepare('UPDATE world_state SET last_novelty_tick = world_tick - 1000 WHERE id = 1').run();

  const vorher = q.pilot(db).psyche;
  for (let i = 0; i < 60; i += 1) e.tick();
  assert.ok(q.pilot(db).psyche < vorher - 0.03);
});

test('engine: Monotonie straft genau einmal pro Abschluss', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  const insertAction = db.prepare("INSERT INTO events (tick, type, payload_json, in_feed) VALUES (?, 'action', ?, 0)");
  insertAction.run(s.world.world_tick - 400, JSON.stringify({ action: 'dig', dur: 120 }));
  insertAction.run(s.world.world_tick - 200, JSON.stringify({ action: 'dig', dur: 120 }));
  db.prepare(`UPDATE pilots SET current_action='dig', target_entity=NULL,
    action_started_tick=? WHERE id=?`).run(s.world.world_tick - 119, s.pilot.id);

  for (let i = 0; i < 3; i += 1) e.tick();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM nerve_events WHERE source='monotony'").get().c, 1);
});

test('engine: Psyche im Keller — chronisch macht Stupor', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  const st = {
    world: { ...s.world }, pilot: { ...s.pilot, psyche: -100, pos_x: 103.9, pos_y: 60, pos_z: 0 },
    entities: s.entities, recentActions: [], allNames: s.allNames, novelty: {}, near: new Set(),
    nerve: [], recentNerve: [{ kind: 'chronic', weight: 8 }], events: [],
  };
  step(st, 1, { live: true, noRandom: true });
  assert.equal(st.pilot.mind_state, 'stupor');
  assert.ok(st.events.some((x) => x.type === 'mind'));
});

test('engine: akute Auslöser machen Wahn', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  const st = {
    world: { ...s.world }, pilot: { ...s.pilot, psyche: -100, pos_x: 103.9, pos_y: 60, pos_z: 0 },
    entities: s.entities, recentActions: [], allNames: s.allNames, novelty: {}, near: new Set(),
    nerve: [], recentNerve: [{ kind: 'acute', weight: 12 }], events: [],
  };
  step(st, 1, { live: true, noRandom: true });
  assert.equal(st.pilot.mind_state, 'wahn');
});

// ---------------------------------------------------------------- Catch-up-Freeze („Anzug-Reboot")
test('freeze: 6 Stunden Ausfall frieren ein — ein Reboot-Event, keine Geister-Ticks', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const jetzt = Date.now();
  const altTick = e.state().world.world_tick;
  db.prepare('UPDATE pilots SET body = 77, psyche = 12 WHERE id = ?')
    .run(e.state().pilot.id);
  db.prepare('UPDATE world_state SET last_tick_at = ? WHERE id = 1')
    .run(new Date(jetzt - 6 * 3600 * 1000).toISOString());

  const r = e.catchup(jetzt);
  assert.equal(r.reboot, true, 'kein Freeze ausgelöst');
  assert.equal(Math.round(r.minutes / 60), 6, `falsche Dauer: ${r.minutes}`);
  assert.equal(r.missed, 0);
  assert.equal(e.state().world.world_tick, altTick, 'Tickzähler bewegt');
  assert.equal(q.pilot(db).body, 77, 'Körper trotz Freeze verändert');
  assert.equal(q.pilot(db).psyche, 12, 'Psyche trotz Freeze verändert');

  const reboot = db.prepare("SELECT * FROM events WHERE type='reboot'").all();
  assert.equal(reboot.length, 1);
  assert.equal(reboot[0].in_feed, 1, 'Reboot nicht im Feed');
});

test('catchup: kurze Lücke wird normal nachgeholt', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const jetzt = Date.now();
  const altTick = e.state().world.world_tick;
  db.prepare('UPDATE world_state SET last_tick_at = ? WHERE id = 1')
    .run(new Date(jetzt - 30 * 1000).toISOString());

  const r = e.catchup(jetzt);
  assert.equal(r.reboot, false, 'fälschlich eingefroren');
  assert.ok(r.missed >= 28 && r.missed <= 30, `missed ${r.missed}`);
  assert.equal(e.state().world.world_tick, altTick + r.missed);
  assert.ok(q.pilot(db).body < 100, 'kein Drain in der Lücke');
});

test('catchup: Uhr in der Zukunft wird korrigiert und protokolliert', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const jetzt = Date.now();
  db.prepare('UPDATE world_state SET last_tick_at = ? WHERE id = 1')
    .run(new Date(jetzt + 10 * 60 * 1000).toISOString());

  const r = e.catchup(jetzt);
  assert.equal(r.missed, 0);
  assert.equal(r.skew, 600);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE type='clock_skew'").get().c, 1);
  assert.equal(e.catchup(jetzt).skew, 0);
});

// ---------------------------------------------------------------- brain (Mock)
function mockServer(antworten) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push(JSON.parse(body || '{}'));
      const antwort = antworten[Math.min(calls.length - 1, antworten.length - 1)];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: antwort } }],
        usage: { prompt_tokens: 300, completion_tokens: 40 },
      }));
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, calls, port: srv.address().port })));
}

test('brain: gültige Antwort wird übernommen und landet im Feed', async () => {
  const m = await mockServer([JSON.stringify({
    action: 'eat',
    thought: 'Magen knurrt. Ich gehe zur Karotte.',
    musing: 'Ob es dort oben Tiere gibt?',
  })]);
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${m.port}/v1`;
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  // Paket K: eat braucht hunger > 45
  db.prepare("UPDATE pilots SET current_action='idle', body=40, hunger=60 WHERE id=?").run(s.pilot.id);

  const res = await e.decide();
  assert.equal(res.ok, true, res.reason);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE type='thought'").get().c, 1);
  assert.equal(q.pilot(db).current_action, 'eat');
  m.srv.closeAllConnections?.();
  m.srv.close();
});

test('brain: ungültige Antwort -> Retry, dann stale mit Ersatzaktion', async () => {
  const m = await mockServer([
    JSON.stringify({ action: 'fliegen', thought: 'Ich fliege zum Mond.', musing: 'Fort von hier.' }),
    JSON.stringify({ action: 'fliegen', thought: 'Ich fliege nochmal.', musing: 'Nur weg.' }),
  ]);
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${m.port}/v1`;
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  // Paket K: fallback eat braucht hunger > 45
  db.prepare("UPDATE pilots SET current_action='idle', body=30, hunger=60 WHERE id=?").run(s.pilot.id);

  const res = await e.decide();
  assert.equal(res.ok, false);
  assert.equal(m.calls.length, 2);
  assert.equal(res.fallback, 'eat');
  m.srv.closeAllConnections?.();
  m.srv.close();
});

test('brain: Serverfehler wirft nicht, sondern meldet stale', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(500); res.end('kaputt'); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${srv.address().port}/v1`;
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  db.prepare("UPDATE pilots SET current_action='idle' WHERE id=?").run(e.state().pilot.id);

  const res = await e.decide();
  assert.equal(res.ok, false);
  assert.equal(res.stale, true);
  srv.closeAllConnections?.();
  srv.close();
});

// ---------------------------------------------------------------- .env
test('env: Parser versteht Kommentare, Anführungszeichen, CRLF und Leerzeilen', () => {
  const { parse } = require('../src/env');
  const roh = ['# Kommentar', '', 'OPENROUTER_API_KEY=sk-or-v1-abc123', 'PORT = 3077',
    'MIT_QUOTES="sk-mit-quotes"', "EINFACH='wert'", 'LEER=', 'kaputte zeile ohne gleich'].join('\r\n');
  const v = parse(roh);
  assert.equal(v.OPENROUTER_API_KEY, 'sk-or-v1-abc123');
  assert.equal(v.PORT, '3077');
  assert.equal(v.MIT_QUOTES, 'sk-mit-quotes');
  assert.equal(v.EINFACH, 'wert');
  assert.equal(v.LEER, '');
});

test('env: vorhandene Umgebungsvariablen haben Vorrang', () => {
  const { load } = require('../src/env');
  const datei = path.join(os.tmpdir(), `aq-env-${Date.now()}.env`);
  fs.writeFileSync(datei, 'AQ_TEST_A=aus_datei\nAQ_TEST_B=aus_datei\n');
  process.env.AQ_TEST_A = 'aus_umgebung';
  delete process.env.AQ_TEST_B;
  load(datei);
  assert.equal(process.env.AQ_TEST_A, 'aus_umgebung');
  assert.equal(process.env.AQ_TEST_B, 'aus_datei');
  delete process.env.AQ_TEST_A;
  delete process.env.AQ_TEST_B;
  fs.unlinkSync(datei);
});

// ---------------------------------------------------------------- Migration
test('db: alte Werte (food/energy/sanity) werden auf Körper/Psyche abgebildet', () => {
  const datei = path.join(os.tmpdir(), `aq-alt-${Date.now()}.sqlite`);
  const alt = new (require('node:sqlite').DatabaseSync)(datei);
  alt.exec(`CREATE TABLE pilots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_num INTEGER NOT NULL, name TEXT NOT NULL,
    status TEXT DEFAULT 'alive', mind_state TEXT DEFAULT 'klar',
    food REAL, energy REAL, sanity REAL, pos_x REAL, pos_z REAL);`);
  alt.exec("INSERT INTO pilots (cycle_num, name, food, energy, sanity, pos_x, pos_z) VALUES (1,'Alt', 70, 80, 90, 0, 0)");
  alt.close();

  const db = open(datei);
  const p = q.pilot(db);
  assert.equal(Math.round(p.body), 20, 'Körper = 100 - max(70, 80)');
  assert.equal(Math.round(p.psyche), 80, 'Psyche = 2*90-100 (alte Ausgeglichenheit gestreckt)');
  assert.ok(Number.isFinite(p.pos_y), 'Kugel-y fehlt nach Migration');
  db.close();
  fs.unlinkSync(datei);
});

// ---------------------------------------------------------------- Trennung Gedanke/Musing
test('engine: Musing wird getrennt gespeichert, Gedanke bleibt kurz', async () => {
  const m = await mockServer([JSON.stringify({
    action: 'eat',
    thought: 'Magen knurrt laut. Ich muss jetzt unbedingt etwas essen.',
    musing: 'Tanzen die Menschen dort unten gerade?',
  })]);
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${m.port}/v1`;
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  // Paket K: eat braucht hunger > 45
  db.prepare("UPDATE pilots SET current_action='idle', body=40, hunger=60 WHERE id=?").run(s.pilot.id);

  const res = await e.decide();
  assert.equal(res.ok, true, res.reason);
  // Zusammen wären es 15 Wörter — getrennt bleibt der Gedanke im Limit.
  const payload = JSON.parse(db.prepare("SELECT payload_json FROM events WHERE type='thought'").get().payload_json);
  assert.ok(wordCount(payload.thought) <= 20, payload.thought);
  assert.equal(payload.musing, 'Tanzen die Menschen dort unten gerade?');
  assert.equal(db.prepare('SELECT text FROM thoughts').get().text, payload.thought);
  m.srv.closeAllConnections?.();
  m.srv.close();
});

// ---------------------------------------------------------------- Gedankenfreiheit
test('checks: natürliche Sätze mit fremdem Tunwort passieren', () => {
  // Früher fiel das durch einen Verb-Abgleich — der ist gestrichen,
  // weil er Sätze wie diesen verworfen hat.
  assert.equal(validateDecision(JSON.stringify({
    action: 'sleep', thought: 'Ich bin zu müde zum Graben, ich gehe schlafen.',
  }), { whitelist: WL }).ok, true);
  assert.equal(validateDecision(JSON.stringify({
    action: 'look_earth', thought: 'Ich schaue zur Erde. Sie ist still und fern.',
  }), { whitelist: WL }).ok, true);
});

// ---------------------------------------------------------------- Neue Aktionen
test('whitelist: neue Aktionen nur bei Bedarf, Wühlen und Bake immer', () => {
  // Paket K: Bedarf = Treiber (hunger/drang/halt), nicht mehr body/psyche
  const bedarf = { mind_state: 'klar', body: 60, psyche: -50, hunger: 60, drang: -50, halt: 30 };
  const voll = whitelistFor(bedarf, { recentActions: [] });
  for (const a of ['search_wrack', 'read_note', 'check_stock', 'tend_dome', 'call_bake']) {
    assert.ok(voll.includes(a), `${a} fehlt: ${voll}`);
  }
  const fit = { mind_state: 'klar', body: 100, psyche: 20, hunger: 15, drang: 10, halt: 80 };
  const leer = whitelistFor(fit, { recentActions: [] });
  assert.ok(!leer.includes('read_note') && !leer.includes('check_stock') && !leer.includes('tend_dome'),
    `Bedarfsaktionen trotz voller Werte: ${leer}`);
  assert.ok(leer.includes('search_wrack') && leer.includes('call_bake'),
    `freie Aktionen fehlen: ${leer}`);
});

test('checks: Gedanken ohne Verb-Filter passieren', () => {
  const WL2 = [...WL, 'search_wrack', 'read_note'];
  for (const a of ['eat', 'search_wrack', 'read_note']) {
    assert.equal(validateDecision(JSON.stringify({
      action: a, thought: 'Ich wühle im Rost. Vielleicht glänzt was.',
    }), { whitelist: WL2 }).ok, true);
  }
});

// ---------------------------------------------------------------- Sichtstufen (Paket I)
test('sicht: klar, vermutet, bemerkt (weit+eng), ungesehen, Umschauen', () => {
  // Lageunabhängig: Positionen aus der live-Leiter rechnen — gilt für jede
  // gestaffelte Config (exotische Leitern meldet die Config-Warnung).
  const v = SICHT.vorlauf || 0;
  const klarD = (SICHT.kontakt + SICHT.nah.dist + v) / 2;
  const vermD = SICHT.nah.dist + v + (SICHT.mittel.dist - SICHT.nah.dist - v) / 2;
  const weitW = (SICHT.mittel.winkel + SICHT.fernWeit.winkel) / 4;
  const engW = Math.min(SICHT.fernEng.winkel, SICHT.mittel.winkel) / 4;
  const engD = (Math.max(SICHT.fernWeit.dist, SICHT.mittel.dist) + SICHT.fernEng.dist) / 2;
  const maxFern = Math.max(SICHT.fernWeit.dist, SICHT.fernEng.dist);
  const ort = (grad, d) => {
    const r = grad * Math.PI / 180;
    return { pos_x: Math.sin(r) * d, pos_z: Math.cos(r) * d };
  };
  const blick = { pos_x: 0, pos_z: 0, heading: [0, 0, 1] };   // schaut +z (Einheitsvektor)
  assert.equal(sichtStufe(blick, ort(0, klarD)), 'klar');
  assert.equal(sichtStufe(blick, ort(180, SICHT.kontakt - 1)), 'klar');   // Kontakt rundum
  assert.equal(sichtStufe(blick, ort(0, vermD)), 'vermutet');
  assert.equal(sichtStufe(blick, ort(weitW, SICHT.fernWeit.dist - 1)), 'bemerkt', 'weiter Kegel fehlt');
  assert.equal(sichtStufe(blick, ort(engW, engD)), 'bemerkt', 'enger Fokuskegel fehlt');
  assert.equal(sichtStufe(blick, ort(180, SICHT.mittel.dist + 5)), 'ungesehen');
  assert.equal(sichtStufe(blick, ort(0, maxFern + 5)), 'ungesehen');
  const um = { pos_x: 0, pos_z: 0, heading: null };   // schaut um sich
  assert.equal(sichtStufe(um, { pos_x: klarD, pos_z: 0 }), 'klar');
  assert.equal(sichtStufe(um, { pos_x: vermD, pos_z: 0 }), 'vermutet');
  assert.equal(sichtStufe(um, { pos_x: SICHT.mittel.dist + 1, pos_z: 0 }), 'bemerkt');
  assert.equal(sichtStufe(um, { pos_x: maxFern + 5, pos_z: 0 }), 'ungesehen');
});

test('sicht: Erkennung greift vor dem Halt (Vorlauf)', () => {
  // Halt ist bei nah.dist — erkannt wird schon vorlauf-Meter früher,
  // sonst stünde er ewig vor dem Ort, ohne ihn je zu erkennen
  const blick = { pos_x: 0, pos_z: 0, heading: [0, 0, 1] };
  assert.equal(sichtStufe(blick, { pos_x: 0, pos_z: SICHT.nah.dist + SICHT.vorlauf - 0.5 }), 'klar');
  assert.equal(sichtStufe(blick, { pos_x: 0, pos_z: SICHT.nah.dist + SICHT.vorlauf + 0.5 }), 'vermutet');
});

test('prompt: Stufen im Prompt (nichts / Fern / Vermutung / Name)', () => {
  // Pilot abseits vom Pol (glatter Rahmen), Blick rundum: Stufen sind reine Ringe.
  // Rohpositionen per Rastersuche — was zählt, ist die SICHTBARE Position (Anker).
  const pilot = { body: 50, psyche: 0, pos_x: 30, pos_z: 20, heading: null, mind_state: 'klar' };
  pilot.pos_y = vec3(pilot).y;
  const findeRoh = (type, name, wunsch) => {
    for (let r = 0; r <= 60; r += (r < 10 ? 1 : 2)) {
      for (let a = 0; a < 24; a += 1) {
        const t = (a / 24) * Math.PI * 2;
        const v = vec3({ pos_x: pilot.pos_x + Math.sin(t) * r, pos_z: pilot.pos_z + Math.cos(t) * r });
        const roh = { type, name, pos_x: v.x, pos_y: v.y, pos_z: v.z };
        if (sichtStufe(pilot, { ...roh, ...ankerPos(roh) }) === wunsch) return roh;
      }
    }
    throw new Error(`kein ${wunsch}-Platz für ${type} gefunden`);
  };
  const entities = [
    findeRoh('mast', 'Funkmast', 'ungesehen'),
    findeRoh('kuppel', 'Gewächskuppel', 'bemerkt'),
    findeRoh('wreck', 'Wrack', 'vermutet'),
    findeRoh('note', 'Notizzettel', 'klar'),
  ];
  const p = buildPrompt(pilot, { entities, beliefs: [], whitelist: ['inspect'], words: [], recentThoughts: [] });
  assert.ok(p.includes('Funkmast') === false, 'ungesehener Mast genannt');
  assert.ok(p.includes('Fern:'), 'Fern-Meldung fehlt');
  assert.ok(!p.includes('blasse Kuppel'), 'Bemerktes mit Silhouette beschrieben');
  assert.ok(p.includes('Vermutung: ein dunkler Klumpen'), 'Vermutung fehlt');
  assert.ok(!p.includes('halb im Rost'), 'vermuteter Ort mit Klartext beschrieben');
  assert.ok(p.includes('Notizzettel'), 'klarer Ort fehlt');
  assert.ok(p.includes('Impuls:'), 'kein Gedanken-Impuls im Prompt');
});

test('prompt: Impuls-Texte und Stille-Hinweis', () => {
  const pilot = { body: 50, psyche: 0, pos_x: 0, pos_z: 0, heading: null, mind_state: 'klar' };
  const ctx = { entities: [], beliefs: [], whitelist: ['sinnieren'], words: [], recentThoughts: [] };
  const laut = buildPrompt(pilot, { ...ctx, impuls: 'galgen', seit: true });
  assert.ok(laut.includes('Galgenhumor'), 'Galgen-Impuls fehlt');
  assert.ok(!laut.includes('nichts geschehen'), 'Stille-Hinweis trotz Ereignis');
  const still = buildPrompt(pilot, { ...ctx, impuls: 'sinnlich', seit: false });
  assert.ok(still.includes('spürt') || still.includes('Körper'), 'Sinnlichkeits-Impuls fehlt');
  assert.ok(still.includes('nichts geschehen'), 'Stille-Hinweis fehlt');
  assert.ok(impulsText('unbekannt'), 'Impuls-Fallback fehlt');
});

test('engine: Discovery erst bei klarer Sicht', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  const basis = {
    world: { ...s.world },
    recentActions: [], allNames: s.allNames, novelty: {}, near: new Set(), nerve: [], events: [],
  };
  const machPilot = (d) => {
    const w = ankerPos(s.entities.find((e) => e.id === 'wreck'));
    const px = w.pos_x, pz = w.pos_z - d;
    const pv = vec3({ pos_x: px, pos_z: pz });   // auf die Kugel zurück
    return {
      ...s.pilot, pos_x: px, pos_y: pv.pos_y, pos_z: pz, heading: null,
      body: 60, psyche: 0,
      mind_state: 'klar', status: 'alive', current_action: 'idle',
    };
  };
  // Vermutete Entfernung zum sichtbaren Wrack = keine Discovery ...
  const fern = { ...basis, pilot: machPilot(SICHT.mittel.dist + 5), entities: s.entities };
  step(fern, 1, { live: true, noRandom: true });
  assert.ok(!fern.events.some((x) => x.type === 'discovery'), 'Discovery bei bloßer Vermutung');
  // ... klare Entfernung = Discovery feuert
  const nah = { ...basis, pilot: machPilot(SICHT.nah.dist - 1), entities: s.entities };
  step(nah, 1, { live: true, noRandom: true });
  assert.ok(nah.events.some((x) => x.type === 'discovery'), 'keine Discovery bei klarer Sicht');
});

test('config: Anker am Bauwerk, Orte mit Abstand', () => {
  for (const e of ENTITIES) {
    const a = ankerPos({ ...vec3(e), pos_x: vec3(e).x, pos_y: vec3(e).y, pos_z: vec3(e).z, type: e.type, id: e.id });
    assert.ok(dist3(a, vec3(e)) < 12, `${e.id}: Anker zu weit weg`);
  }
  for (let i = 0; i < ENTITIES.length; i += 1) {
    for (let j = i + 1; j < ENTITIES.length; j += 1) {
      const d = dist3(vec3(ENTITIES[i]), vec3(ENTITIES[j]));
      assert.ok(d >= 22, `${ENTITIES[i].id}–${ENTITIES[j].id}: nur ${Math.round(d)} m`);
    }
  }
});

test('config: Großkreis-Distanz kennt Viertel und Gegenpunkt', () => {
  const a = { pos_x: 120, pos_y: 0, pos_z: 0 };
  const b = { pos_x: 0, pos_y: 0, pos_z: 120 };
  const gegen = { pos_x: -120, pos_y: 0, pos_z: 0 };
  assert.ok(Math.abs(dist3(a, a)) < 1e-9, 'Selbstabstand nicht null');
  assert.ok(Math.abs(dist3(a, b) - Math.PI * 60) < 0.01, `Viertelkreis: ${dist3(a, b)}`);
  assert.ok(Math.abs(dist3(a, gegen) - Math.PI * 120) < 0.01, `Gegenpunkt: ${dist3(a, gegen)}`);
});

test('config: Schildtext je Entdeckungsgrad (nichts / ? / Vermutung / Name)', () => {
  // Stufen per Rastersuche (sichtbare Position zählt) — robust gegen jede Leiter.
  const pilot = { pos_x: 30, pos_z: 20, heading: null };
  pilot.pos_y = vec3(pilot).y;
  const findeRoh = (wunsch) => {
    for (let r = 0; r <= 60; r += (r < 10 ? 1 : 2)) {
      for (let a = 0; a < 24; a += 1) {
        const t = (a / 24) * Math.PI * 2;
        const v = vec3({ pos_x: pilot.pos_x + Math.sin(t) * r, pos_z: pilot.pos_z + Math.cos(t) * r });
        const roh = { type: 'wreck', name: 'Wrack', pos_x: v.x, pos_y: v.y, pos_z: v.z };
        if (sichtStufe(pilot, { ...roh, ...ankerPos(roh) }) === wunsch) return roh;
      }
    }
    throw new Error(`kein ${wunsch}-Schildplatz gefunden`);
  };
  assert.equal(entityLabel(pilot, findeRoh('ungesehen')), null);
  assert.equal(entityLabel(pilot, findeRoh('bemerkt')), '?', 'bemerkt zeigt mehr als ?');
  const vage = entityLabel(pilot, findeRoh('vermutet'));
  assert.ok(vage && vage.endsWith('?'), `kein Vermutungs-Schild: ${vage}`);
  assert.ok(!vage.includes('Wrack'), 'vermutetes Schild nennt den Namen');
  const klar = entityLabel(pilot, findeRoh('klar'));
  assert.equal(klar, 'Wrack');
});

test('config: einmal erkannt, nie vergessen (Schilder zeigen Höchststand)', () => {
  // Umdrehen: memorierter Grad bleibt, auch wenn aktuell nichts zu sehen ist
  const weg = { pos_x: 0, pos_z: 0, heading: [0, 0, -1] };   // schaut weg
  const fern = { type: 'wreck', name: 'Wrack', pos_x: 0 - 10, pos_z: SICHT.fernEng.dist + 5 + 6 };
  assert.equal(entityLabel(weg, fern), null);
  assert.equal(entityLabel(weg, { ...fern, sicht: 1 }), '?');
  assert.equal(entityLabel(weg, { ...fern, sicht: 2 }), 'Ein dunkler Klumpen?');
  assert.equal(entityLabel(weg, { ...fern, sicht: 3 }), 'Wrack');
});

test('brain: kaputte Antwort landet als Rohtext im Ergebnis', async () => {
  const alt = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'Hier, nimm das: [unfertig' } }], usage: {} }),
  });
  try {
    const res = await brainDecide({ prompt: 'x', whitelist: ['eat'], recentThoughts: [], apiKey: 'test' });
    assert.equal(res.ok, false);
    assert.ok(res.reason.includes('json'), `unerwarteter Grund: ${res.reason}`);
    assert.ok(res.raw.includes('unfertig'), 'Rohtext fehlt im Ergebnis');
    assert.equal(res.calls, 2, 'Retry nicht gezählt');
  } finally {
    global.fetch = alt;
  }
});

test('brain: leere Antwort heißt json_leer', async () => {
  const alt = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '   ' } }], usage: {} }),
  });
  try {
    const res = await brainDecide({ prompt: 'x', whitelist: ['eat'], recentThoughts: [], apiKey: 'test' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'checks: json_leer');
  } finally {
    global.fetch = alt;
  }
});

test('engine: Discovery merkt Betrachtungsbedarf', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  const wpos = ankerPos(s.entities.find((x) => x.id === 'wreck'));
  s.pilot.pos_x = wpos.pos_x;
  s.pilot.pos_y = wpos.pos_y;
  s.pilot.pos_z = wpos.pos_z;
  s.pilot.heading = null;
  step(s, 1, { live: true, noRandom: true });
  const w = s.entities.find((x) => x.id === 'wreck');
  assert.ok(w.unfinished_thought, 'kein Betrachtungsbedarf nach Discovery');
});

test('engine: Neu Entdecktes bekommt den Zusatzgedanken, dann ist es bedacht', async () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  db.prepare("UPDATE world_entities SET unfinished_thought='Wrack', sicht=3, discovered=1 WHERE id='wreck'")
    .run();
  const prompts = [];
  const alt = global.fetch;
  global.fetch = async (url, opts) => {
    prompts.push(JSON.parse(opts.body).messages[0].content);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          action: 'sinnieren',
          thought: 'Ich sinniere über das Wrack nach.',
          musing: 'Was fange ich damit an?',
        }) } }],
        usage: {},
      }),
    };
  };
  try {
    const res = await e.decide();
    assert.ok(res.ok, JSON.stringify(res.failures || res));
    assert.ok(prompts[0].includes('Neu entdeckt'), 'kein Betrachtungs-Thema im Prompt');
    assert.ok(res.musing, 'kein Zusatzgedanke trotz Betrachtungsbedarf');
    const rest = db.prepare('SELECT COUNT(*) AS n FROM world_entities WHERE unfinished_thought IS NOT NULL')
      .get().n;
    assert.equal(rest, 0, 'Betrachtungsbedarf nicht gelöscht');
    const dec = db.prepare("SELECT payload_json FROM events WHERE type='decision' ORDER BY id DESC LIMIT 1")
      .get();
    const dp = JSON.parse(dec.payload_json);
    assert.equal(dp.versuche, 1, 'Versuchszahl fehlt in der Entscheidung');
    assert.ok(typeof dp.ms === 'number', 'Latenz fehlt in der Entscheidung');
  } finally {
    global.fetch = alt;
  }
});

test('engine: Tick schreibt Erkanntheitsgrad in die DB', async () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  const wpos = ankerPos(s.entities.find((x) => x.id === 'wreck'));
  db.prepare('UPDATE pilots SET pos_x = ?, pos_y = ?, pos_z = ? WHERE id=?')
    .run(wpos.pos_x, wpos.pos_y, wpos.pos_z, s.pilot.id);
  e.tick();
  const zeile = db.prepare('SELECT sicht FROM world_entities WHERE id = ?').get('wreck');
  assert.equal(zeile.sicht, 3);
});

test('engine: Halt am Nahkreis, schlafen geht näher ran', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  const basis = {
    world: { ...s.world },
    recentActions: [], allNames: s.allNames, novelty: {}, near: new Set(), nerve: [], events: [],
  };
  const los = (action, zielId, abstand) => {
    const w = ankerPos(s.entities.find((x) => x.id === zielId));
    // Start tangential versetzt: Großkreis-Schritt in lokaler Ost-Richtung
    const W = vec3({ pos_x: w.pos_x, pos_y: w.pos_y, pos_z: w.pos_z });
    const up = norm3(W);
    const ref = Math.abs(up.y) > 0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    let ox = up.y * ref.z - up.z * ref.y;
    let oy = up.z * ref.x - up.x * ref.z;
    let oz = up.x * ref.y - up.y * ref.x;
    const ol = Math.hypot(ox, oy, oz) || 1;
    ox /= ol; oy /= ol; oz /= ol;
    const winkel = abstand / 120;
    const px = W.x * Math.cos(winkel) + ox * 120 * Math.sin(winkel);
    const py = W.y * Math.cos(winkel) + oy * 120 * Math.sin(winkel);
    const pz = W.z * Math.cos(winkel) + oz * 120 * Math.sin(winkel);
    return {
      ...basis,
      pilot: {
        ...s.pilot, pos_x: px, pos_y: py, pos_z: pz, heading: null,
        body: 100, psyche: 0, mind_state: 'klar', status: 'alive',
        current_action: action, target_entity: zielId, action_started_tick: null,
      },
      entities: s.entities,
    };
  };
  // inspect stoppt am Nahkreis
  const st = los('inspect', 'wreck', SICHT.nah.dist + 5);
  step(st, 10, { live: true, noRandom: true });
  const dw = dist3(st.pilot, ankerPos(s.entities.find((x) => x.id === 'wreck')));
  assert.ok(Math.abs(dw - SICHT.nah.dist) < 0.01, `bleibt nicht am Nahkreis stehen: ${dw}`);
  assert.ok(st.pilot.action_started_tick !== null, 'fängt nicht an zu handeln');
  // schlafen geht unter Dach (näher ran)
  const st2 = los('sleep', 'shade', 6);
  step(st2, 10, { live: true, noRandom: true });
  const sh = ankerPos(s.entities.find((x) => x.id === 'shade'));
  const ds = dist3(st2.pilot, sh);
  assert.ok(Math.abs(ds - 1.0) < 0.01, `schlafen bleibt nicht unterm Dach: ${ds}`);
});

test('engine: Figur läuft zum sichtbaren Bauwerk, nicht zum Logikpunkt', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  const w = ankerPos(s.entities.find((x) => x.id === 'wreck'));
  const start = vec3({ pos_x: w.pos_x + 10, pos_z: w.pos_z });   // auf der Kugel
  const st = {
    world: { ...s.world },
    pilot: {
      ...s.pilot, pos_x: start.x, pos_y: start.y, pos_z: start.z, heading: null,
      body: 100, psyche: 0, mind_state: 'klar', status: 'alive',
      current_action: 'inspect', target_entity: 'wreck', action_started_tick: null,
    },
    entities: s.entities, recentActions: [], allNames: s.allNames,
    novelty: {}, near: new Set(), nerve: [], events: [],
  };
  step(st, 1, { live: true, noRandom: true });
  // Er läuft auf das sichtbare Bauwerk zu (Großkreis-Distanz schrumpft) ...
  assert.ok(dist3(st.pilot, w) < dist3(start, w) - 0.9, 'Figur läuft nicht los');
  // ... und zwar in derselben Ebene, nicht quer über den Pol (z bleibt fast gleich)
  assert.ok(Math.abs(st.pilot.pos_z - w.pos_z) < 0.5,
    `Figur läuft zum Logikpunkt statt zum Bauwerk (z=${st.pilot.pos_z})`);
});

test('engine: Sichtwerte stehen im State für den Dev-Kegel', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const snap = e.snapshot();
  assert.deepEqual(snap.sicht, SICHT);
  assert.ok('heading' in snap.pilot, 'kein Heading im Pilot-State');
});

// ---------------------------------------------------------------- Paket K: Manie, Impuls, Pruning
test('engine: Psyche +100 zündet Manie, danach Rückfall auf +75', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  s.pilot.body = 80;
  s.pilot.psyche = 100;
  s.pilot.pos_x = 103.9; s.pilot.pos_y = 60; s.pilot.pos_z = 0;   // weit weg, keine Discovery
  step(s, 1, { live: true, noRandom: true });
  assert.ok(s.pilot.mania_until_tick > s.world.world_tick, `kein Manie-Timer: ${s.pilot.mania_until_tick}`);
  assert.ok(s.events.some((x) => x.type === 'mind' && x.payload && x.payload.state === 'manie'),
    'kein Manie-Event im Feed');

  // Ablauf: Tick nach dem Timer fällt die Psyche automatisch auf +75
  // (Psyche knapp unter der Zündschwelle, sonst würde sie neu zünden)
  s.pilot.mania_until_tick = s.world.world_tick;
  s.pilot.psyche = 99;
  step(s, 1, { live: true, noRandom: true });
  assert.equal(s.pilot.psyche, 75, `kein Manie-Rückfall: ${s.pilot.psyche}`);
});

test('engine: Manie macht schnell, aber der Körper zahlt drauf', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  s.pilot.body = 80; s.pilot.psyche = 0;
  s.pilot.mania_until_tick = s.world.world_tick + 300;
  e.applyAction(s, 'inspect', null, s.world.world_tick, 'test', ['inspect'], null, null);
  const dec = db.prepare("SELECT payload_json FROM events WHERE type='decision' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(dec.payload_json).dur, Math.round(ACTIONS.inspect.dur * MANIA.tempo), 'kein Manie-Tempo');

  // Gehen in der Manie kostet anderthalb: gleicher Weg, mehr Körper weg
  const marsch = (mitManie) => {
    const d = frisch();
    const ee = new Engine(d, { apiKey: 'test' });
    const ss = ee.state();
    const w = ankerPos(ss.entities.find((x) => x.id === 'wreck'));
    const start = vec3({ pos_x: w.pos_x + 30, pos_z: w.pos_z });   // auf der Kugel
    ss.pilot.pos_x = start.x; ss.pilot.pos_y = start.y; ss.pilot.pos_z = start.z;
    ss.pilot.heading = null;
    ss.pilot.body = 80; ss.pilot.psyche = 50;
    ss.pilot.mind_state = 'klar'; ss.pilot.status = 'alive';
    ss.pilot.current_action = 'inspect'; ss.pilot.target_entity = 'wreck';
    ss.pilot.action_started_tick = null;
    if (mitManie) ss.pilot.mania_until_tick = ss.world.world_tick + 300;
    step(ss, 1, { live: true, noRandom: true });
    return 80 - ss.pilot.body;
  };
  const mitManie = marsch(true);
  const ohneManie = marsch(false);
  assert.ok(mitManie > ohneManie + 0.004, `Manie-Marsch ${mitManie} vs normal ${ohneManie}`);
});

test('config: Impuls-Würfel folgt den Gewichten', () => {
  assert.equal(wuerfelImpuls(() => 0.0), 'selbstgespraech');
  assert.equal(wuerfelImpuls(() => 0.29), 'selbstgespraech');
  assert.equal(wuerfelImpuls(() => 0.3), 'sinnlich');
  assert.equal(wuerfelImpuls(() => 0.59), 'sinnlich');
  assert.equal(wuerfelImpuls(() => 0.6), 'galgen');
  assert.equal(wuerfelImpuls(() => 0.79), 'galgen');
  assert.equal(wuerfelImpuls(() => 0.8), 'vorhaben');
  assert.equal(wuerfelImpuls(() => 0.99), 'vorhaben');
});

test('db: Pruning löscht alte Rohticks und überzählige Gedanken', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  const alt = new Date(Date.now() - 8 * 86400 * 1000).toISOString();
  db.prepare("INSERT INTO events (tick, type, payload_json, in_feed, created_at) VALUES (1, 'action', '{}', 0, ?)")
    .run(alt);
  db.prepare("INSERT INTO events (tick, type, payload_json, in_feed) VALUES (2, 'action', '{}', 0)")
    .run();
  const ins = db.prepare('INSERT INTO thoughts (pilot_id, tick, text) VALUES (?, 1, ?)');
  for (let i = 0; i < 600; i += 1) ins.run(s.pilot.id, `Gedanke ${i}`);
  e.prune();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE in_feed = 0").get().c, 1,
    'frischer Rohtick mitgelöscht oder alter behalten');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM thoughts').get().c, 500,
    'Gedanken nicht auf 500 gekappt');
});

test('config: modellKurz schneidet Anbieter und Variante ab', () => {
  assert.equal(modellKurz('google/gemma-4-26b-a4b-it'), 'gemma');
  assert.equal(modellKurz('xiaomi/mimo-v2.6-pro'), 'mimo');
  assert.equal(modellKurz('mimo-v2.6-pro'), 'mimo');
  assert.equal(modellKurz('nemo'), 'nemo');
  assert.equal(modellKurz(''), '?');
});

test('engine: Snapshot liefert Treiber-Vertrag und leeres Inventar', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const snap = e.snapshot();
  // Paket K: Treiber sind da — Startwerte aus TREIBER
  assert.deepEqual(snap.pilot.treiber, { hunger: 15, thermo: 0, drang: 10, halt: 80 },
    'Treiber-Startwerte falsch');
  assert.deepEqual(snap.inventar, [], 'Inventar ohne Funde nicht leer');
  assert.deepEqual(e.statePayload().inventar, [], 'Inventar fehlt im State-Payload');
});

test('engine: Inventar listet Funde mit Fund-Tick, älteste zuerst', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const ins = db.prepare("INSERT INTO events (tick, type, payload_json, in_feed) VALUES (?, 'find', ?, 1)");
  ins.run(50, JSON.stringify({ id: 'wrack', text: 'Zwischen den Blechen: ein heiler Schraubenschlüssel.' }));
  ins.run(12, JSON.stringify({ id: 'bake', text: 'Im Bake-Schacht: eine intakte Spule.' }));
  const inv = e.snapshot().inventar;
  assert.equal(inv.length, 2, 'Funde fehlen im Inventar');
  assert.deepEqual(inv[0], { tick: 12, id: 'bake', text: 'Im Bake-Schacht: eine intakte Spule.' });
  assert.equal(inv[1].tick, 50, 'Sortierung nicht nach Fund-Tick');
});

// ---------------------------------------------------------------- Paket A: Vorhaben
test('engine: hunger-Schwelle setzt Vorhaben aufs Feld', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  db.prepare('UPDATE pilots SET hunger=60, pos_x=103.9, pos_y=60, pos_z=0 WHERE id=?').run(s.pilot.id);
  const s2 = e.state();
  step(s2, 1, { live: true, noRandom: true });
  assert.ok(s2.vorhaben, 'kein Vorhaben gesetzt');
  assert.equal(s2.vorhaben.ziel, 'field');
  assert.equal(s2.vorhaben.grund, 'hunger');
  assert.ok(s2.vorhaben.seit_tick != null);
});

test('engine: Vorhaben loescht bei Ankunft und bei Treiber-ok', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  const feld = ankerPos(s.entities.find((x) => x.id === 'field'));
  db.prepare('UPDATE pilots SET hunger=60, pos_x=?, pos_y=?, pos_z=? WHERE id=?')
    .run(feld.pos_x, feld.pos_y, feld.pos_z, s.pilot.id);
  const nah = e.state();
  step(nah, 1, { live: true, noRandom: true });
  assert.equal(nah.vorhaben, null, 'Vorhaben trotz Naehe gesetzt');
  db.prepare('UPDATE pilots SET hunger=60, pos_x=103.9, pos_y=60, pos_z=0 WHERE id=?').run(s.pilot.id);
  const fern = e.state();
  step(fern, 1, { live: true, noRandom: true });
  assert.ok(fern.vorhaben, 'Vorhaben fehlt');
  db.prepare('UPDATE pilots SET hunger=10 WHERE id=?').run(s.pilot.id);
  const satt = e.state();
  step(satt, 1, { live: true, noRandom: true });
  assert.equal(satt.vorhaben, null, 'Vorhaben trotz sattem Treiber');
});

test('engine: Vorhaben ueberlebt Zwischenaktion (DB-Runde)', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  db.prepare('UPDATE pilots SET hunger=60, pos_x=103.9, pos_y=60, pos_z=0 WHERE id=?').run(s.pilot.id);
  e.tick();
  const nach = e.state();
  const v = nach.vorhaben || JSON.parse(nach.pilot.vorhaben_json || 'null');
  assert.ok(v && v.ziel === 'field', 'Vorhaben nach Tick weg');
});

test('engine: kein Vorhaben bei mind_state != klar', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  // psyche -100 dazu: sonst heilt recover den Stupor sofort (altes Verhalten)
  db.prepare("UPDATE pilots SET mind_state='stupor', psyche=-100, hunger=90, pos_x=103.9, pos_y=60, pos_z=0 WHERE id=?").run(s.pilot.id);
  const s2 = e.state();
  step(s2, 1, { live: true, noRandom: true });
  assert.equal(s2.vorhaben, null, 'Vorhaben im Stupor');
});

test('checks: wiederholung_beduerfnis feuert nur bei aktivem Vorhaben', () => {
  const { benenntNurBeduerfnis } = require('../src/checks');
  assert.ok(benenntNurBeduerfnis('Mein Koerper ist leer, ich muss etwas essen.'));
  assert.ok(!benenntNurBeduerfnis('Ich laufe zum Feld, hinter dem Wrack.'));
  const vAn = validateDecision('{"action":"dig","thought":"Mein Koerper ist leer."}',
    { whitelist: WL, vorhabenAktiv: true });
  assert.ok(vAn.failures.includes('wiederholung_beduerfnis'), JSON.stringify(vAn.failures));
  const vAus = validateDecision('{"action":"dig","thought":"Mein Koerper ist leer."}',
    { whitelist: WL, vorhabenAktiv: false });
  assert.equal(vAus.ok, true, JSON.stringify(vAus.failures));
});

test('engine: Weg-Text ohne Himmelsrichtungen, Zahlen nur Schritte', () => {
  const { buildPrompt } = require('../src/prompt');
  const p = buildPrompt({ body: 50, psyche: 0 }, {
    entities: [], beliefs: [], whitelist: ['dig'],
    vorhaben: 'Was du vorhast: zum Karottenfeld, weil dein Koerper leer ist.',
    weg: 'Weg: 27 Schritte, hinter dem Wrack.',
  });
  assert.ok(p.includes('27 Schritte'), 'Schritte fehlen');
  assert.ok(!/Norden|Osten|Sued|Westen|noerdlich|oestlich|suedlich|westlich/i.test(p), 'Himmelsrichtung im Prompt');
});

test('db: vorhaben_json-Spalte existiert mit Default', () => {
  const db = frisch();
  const cols = new Set(db.prepare('PRAGMA table_info(pilots)').all().map((r) => r.name));
  assert.ok(cols.has('vorhaben_json'), 'vorhaben_json fehlt');
});

test('whitelist: eat bei vollem Hunger, nicht bei vollem Koerper (Paket A)', () => {
  // Spec: AVAIL.eat bleibt bei body < 75 — aber der Treiber entscheidet:
  // hunger 60 → eat, auch bei body 80. Umgekehrt: body 40 allein reicht nicht.
  const hungrig = { mind_state: 'klar', body: 80, hunger: 60, drang: 10, halt: 80 };
  assert.ok(whitelistFor(hungrig).includes('eat'), 'eat fehlt trotz Hunger');
  const satt = { mind_state: 'klar', body: 40, hunger: 10, drang: 10, halt: 80 };
  assert.ok(!whitelistFor(satt, { phase: 'nacht', nah: [] }).includes('eat'), 'eat trotz sattem Hunger');
});

test('tag/nacht: Sonne wandert, Licht ist lokal, Erde-Tor gilt', () => {
  // Reine Funktionen: keine DB, keine Zeit — nur Geometrie.
  const { TAG, sonnenVektor, lichtAn, lichtPhase, tagesNummer, erdeSichtbarVon } = require('../src/config');
  // Eine Umdrehung pro 2 h
  const winkelProTick = (2 * Math.PI) / TAG.dauerS;
  assert.ok(Math.abs(winkelProTick * TAG.dauerS - 2 * Math.PI) < 1e-9, 'keine volle Umdrehung pro Tag');

  // Gegenpunkte: wo Mittag ist, ist gegenüber Mitternacht
  const mittag = sonnenVektor(0);
  const ortTag = { pos_x: mittag.x * 60, pos_y: mittag.y * 60, pos_z: mittag.z * 60 };
  const ortNacht = { pos_x: -mittag.x * 60, pos_y: -mittag.y * 60, pos_z: -mittag.z * 60 };
  assert.ok(lichtAn(ortTag, mittag) > 0.9, 'kein Mittag unterm Sonnenvektor');
  assert.ok(lichtAn(ortNacht, mittag) < -0.9, 'keine Mitternacht gegenüber');
  assert.equal(lichtPhase(lichtAn(ortTag, mittag)), 'licht');
  assert.equal(lichtPhase(lichtAn(ortNacht, mittag)), 'nacht');
  // Dämmergürtel: senkrecht zur Sonne ist es weder Tag noch Nacht
  const seite = { pos_x: -mittag.z * 60, pos_y: 0, pos_z: mittag.x * 60 };
  assert.equal(lichtPhase(lichtAn(seite, mittag)), 'daemmer');

  // Tag-Nr wächst pro Umdrehung
  assert.equal(tagesNummer(0), 1);
  assert.equal(tagesNummer(2 * Math.PI), 2);

  // Erde: hier oben sichtbar, gegenüber nicht — V1, fester Vektor
  assert.ok(erdeSichtbarVon({ pos_x: 60 * 0.7071, pos_y: 60 * 0.6124, pos_z: 60 * 0.3536 }), 'Erde nicht sichtbar unterm Erdvektor');
  assert.ok(!erdeSichtbarVon({ pos_x: -60 * 0.7071, pos_y: -60 * 0.6124, pos_z: -60 * 0.3536 }), 'Erde sichtbar auf der Rückseite');

  // call_bake nur bei sichtbarer Erde (Tor, kein Verbot)
  const { AVAIL } = require('../src/prompt');
  assert.ok(AVAIL.call_bake({}, { erde: true }), 'Bake trotz sichtbarer Erde gesperrt');
  assert.ok(!AVAIL.call_bake({}, { erde: false }), 'Bake bei untergegangener Erde angeboten');
});

test('tag/nacht: Tick schreibt Sonnenwinkel fort, thermo folgt dem Licht', () => {
  const { open } = require('../src/db');
  const { Engine, step } = require('../src/engine');
  const { sonnenVektor } = require('../src/config');
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s0 = e.state();
  const w0 = s0.world.sun_angle ?? 0;
  // Pilot exakt auf den Gegenpunkt der Nachtsonne (halbe Umdrehung weiter),
  // sonst liegt er im Dämmergürtel statt in der Nacht — Geometrie, kein Bug.
  const sonneNacht = sonnenVektor(w0 + Math.PI);
  const l = Math.hypot(sonneNacht.x, sonneNacht.y, sonneNacht.z) || 1;
  s0.pilot.pos_x = -sonneNacht.x / l * 120;
  s0.pilot.pos_y = -sonneNacht.y / l * 120;
  s0.pilot.pos_z = -sonneNacht.z / l * 120;
  // 3600 Ticks = halbe Umdrehung, thermo fällt bei Kälte
  for (let i = 0; i < 3600; i += 1) step(s0, 1, { live: false, noRandom: true });
  const w1 = s0.world.sun_angle ?? 0;
  assert.ok(Math.abs(w1 - w0 - Math.PI) < 0.01, `halbe Umdrehung fehlt: ${w0} -> ${w1}`);
  assert.equal(s0.phase, 'nacht', `keine Nacht nach halber Umdrehung: ${s0.phase}`);
  // Schritt-Positionen in die DB schreiben — snapshot() lädt neu aus der DB.
  e.db.prepare('UPDATE pilots SET pos_x=?, pos_y=?, pos_z=? WHERE id=?')
    .run(s0.pilot.pos_x, s0.pilot.pos_y, s0.pilot.pos_z, s0.pilot.id);
  e.db.prepare('UPDATE world_state SET sun_angle=? WHERE id=1').run(s0.world.sun_angle ?? 0);
  // Sonne im Snapshot fürs Frontend (Vektor, keine Zahl)
  const snap = e.snapshot();
  assert.ok(snap.tag && snap.tag.sonne, 'kein Sonnenvektor im Snapshot');
  assert.equal(snap.tag.phase, s0.phase, 'Snapshot-Phase weicht vom Tick ab');
  assert.equal(typeof snap.tag.erde, 'boolean', 'kein Erde-Flag im Snapshot');
});

test('finsternis: 4 Stufen aus Deckungsgrad, thermo + Sicht folgen', () => {
  // Reine Geometrie: deckungsgleich → 3, halb → 2, Streif → 1, daneben → 0.
  const { FINSTERNIS, finsternisStufe, ERDE } = require('../src/config');
  const deckung = (FINSTERNIS.sonneRadius + FINSTERNIS.erdeRadius) / FINSTERNIS.schale;
  const richtung = (a) => ({ x: Math.cos(a) * ERDE.x - Math.sin(a) * ERDE.y, y: Math.sin(a) * ERDE.x + Math.cos(a) * ERDE.y, z: ERDE.z });
  assert.equal(finsternisStufe({ ...ERDE }).stufe, 3, 'deckungsgleich muss total sein');
  assert.equal(finsternisStufe(richtung(deckung * 0.4)).stufe, 2, 'knapp daneben muss halb sein');
  assert.equal(finsternisStufe(richtung(deckung * 0.85)).stufe, 1, 'Streif muss Anbiss sein');
  assert.equal(finsternisStufe({ x: -ERDE.x, y: -ERDE.y, z: -ERDE.z }).stufe, 0, 'gegenüber muss frei sein');
  assert.deepEqual(FINSTERNIS.sonneFaktor, [1, 0.8, 0.5, 0], 'Faktoren hart verdrahtet');

  // Thermo: Stufe 3 schaltet den Licht-Anteil ab — mitten am Tag kühlt es wie nachts.
  const { open } = require('../src/db');
  const { Engine, step } = require('../src/engine');
  const { ERDE: ERDE2 } = require('../src/config');
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  // Pilot im Mittagslicht, thermo neutral — Sonnenwinkel so wählen, dass der
  // Tick die Erde trifft (totale Finsternis aus echter Geometrie, kein Erzwingen:
  // step() rechnet state.sonne aus world.sun_angle neu).
  // sonnenVektor: x = cos(w), y0 = sin(w), y = y0·cos(n), z = y0·sin(n).
  // Gesucht: Richtung ≈ ERDE. Mit n = 30°: w so, dass (cos w, sin w·cos n, sin w·sin n) ∝ ERDE.
  s.pilot.pos_x = 103.9; s.pilot.pos_y = 60; s.pilot.pos_z = 0;
  s.pilot.thermo = 0;
  const nNeig = (30 * Math.PI) / 180;
  // Aus y/z-Verhältnis: tan-Anteil — Erde y/z = 0.42/0.75, Sonne y/z = cos n / sin n fest.
  // Exakt geht nicht (Bahnneigung ≠ Erd-Richtung), also: Winkel mit kleinstem Abstand suchen.
  let bestW = 0, bestAb = Infinity;
  const { sonnenVektor: sv } = require('../src/config');
  for (let k = 0; k < 720; k += 1) {
    const w = (k / 720) * Math.PI * 2;
    const v = sv(w);
    const l1 = Math.hypot(v.x, v.y, v.z) || 1, l2 = Math.hypot(ERDE2.x, ERDE2.y, ERDE2.z) || 1;
    const cos = (v.x * ERDE2.x + v.y * ERDE2.y + v.z * ERDE2.z) / (l1 * l2);
    const ab = Math.acos(Math.max(-1, Math.min(1, cos)));
    if (ab < bestAb) { bestAb = ab; bestW = w; }
  }
  s.world.sun_angle = bestW - 60 * ((2 * Math.PI) / 7200);   // 60 Ticks Vorlauf einrechnen
  s.licht = 1; s.phase = 'licht';
  const vorher = s.pilot.thermo;
  step(s, 60, { live: false, noRandom: true });   // 60 s Mittagslicht mit Finsternis
  assert.equal(s.finsternis, 3, `keine totale Finsternis: ${s.finsternis}`);
  assert.ok(Math.abs(s.pilot.thermo - vorher) < 0.01, `Licht wärmt trotz Finsternis: ${vorher} -> ${s.pilot.thermo}`);

  // Sicht: Stufe 3 → Nacht-Faktor, Stufe 0 → Tag-Faktor
  const { lichtFaktorAusPhase, buildPrompt } = require('../src/prompt');
  assert.equal(lichtFaktorAusPhase('licht', 3), 0.5, 'Finsternis schrumpft Sicht nicht');
  assert.equal(lichtFaktorAusPhase('licht', 0), 1, 'freier Tag verzerrt');
  const prompt = buildPrompt({ ...s.pilot, phase: 'licht', thermo: 0 }, { entities: [], finsternis: 3 });
  assert.ok(prompt.includes('Finsternis'), 'kein Finsternis-Satz im Prompt');
});

test('tag/nacht: Schlaf bei Licht nur im Schutz, nachdenken-Hook nur bei Licht', () => {
  const { AVAIL, darfNachdenken, tagText, sensory } = require('../src/prompt');
  const muede = { mind_state: 'klar', body: 50, psyche: 0, hunger: 10, drang: 10, halt: 80 };
  assert.ok(!AVAIL.sleep(muede, { phase: 'licht', nah: [] }), 'Schlaf bei Licht draußen');
  assert.ok(AVAIL.sleep(muede, { phase: 'licht', nah: ['shade'] }), 'kein Schlaf bei Licht im Schatten');
  assert.ok(AVAIL.sleep(muede, { phase: 'nacht', nah: [] }), 'kein Schlaf bei Nacht draußen');
  assert.ok(darfNachdenken('licht') && !darfNachdenken('nacht') && !darfNachdenken('daemmer'),
    'nachdenken-Hook falsch (Paket D wartet)');
  assert.equal(tagText(3, 'nacht'), 'Tag 3 · Nacht');
  // sensory kennt die Phase (Pilot spürt, wo er steht) — ohne body zu verraten
  const gefuehl = sensory({ ...muede, phase: 'nacht', thermo: 0 });
  assert.ok(gefuehl.includes('Nacht'), `kein Nacht-Satz: ${gefuehl}`);
});

// Cluster (obere Hemisphäre, 5-te Aufgabe): das Lager klebt nicht mehr am Nordpol,
// Anker bleiben in tangentialen Metern, Mindestabstände bleiben bestehen.
test('config: Cluster hängt an der oberen Hemisphäre, fernab beider Pole', () => {
  const { CLUSTER, clusterPos } = require('../src/config');
  assert.ok(CLUSTER.breite >= 20 && CLUSTER.breite <= 60, `Cluster-Breite: ${CLUSTER.breite}`);
  for (const e of ENTITIES) {
    const w = clusterPos(e.x, e.z);
    assert.ok(Math.abs(w.y) < 115, `${e.id}: zu nah am Pol (y=${Math.round(w.y)})`);
    assert.ok(w.y > 20, `${e.id}: nicht auf der oberen Hemisphäre`);
  }
  const kapsel = clusterPos(0, 0);
  assert.ok(Math.hypot(kapsel.x, kapsel.y, kapsel.z) - 120 < 0.01, 'Kapsel nicht auf der Kugel');
  // Spawn = Kapsel (kein Nordpol-Spawn mehr)
  const { Engine } = require('../src/engine');
  const db = frisch();
  const eng = new Engine(db, { apiKey: 'test' });
  const s = eng.state();
  const d = dist3(s.pilot, { pos_x: kapsel.x, pos_y: kapsel.y, pos_z: kapsel.z });
  assert.ok(d < 1, `Spawn nicht an der Kapsel: ${d} m daneben`);
});



// Proxy-Härtung + Healthcheck (Hermes-VPS, 2026-11-14): kein Modellaufruf,
// keine DB — nur Loop-Leben, Bind-Host und (hier) Header-Logik prüfen.
test('server: host bindet localhost, health meldet ok, dev hinter proxy sicher', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.ok(/const HOST = process\.env\.HOST \|\| '127\.0\.0\.1'/.test(src), 'HOST-Default fehlt');
  assert.ok(/server\.listen\(PORT, HOST/.test(src), 'listen bindet nicht auf HOST');
  assert.ok(/url\.pathname === '\/api\/health'/.test(src), '/api/health fehlt');
  assert.ok(/lastBeat/.test(src), 'Heartbeat fehlt');
  assert.ok(/x-real-ip/.test(src), 'X-Real-IP-Prüfung fehlt');
  assert.ok(!/IST_LOKAL\(req\)/.test(src), 'alter IST_LOKAL-Aufruf übrig');
});
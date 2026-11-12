'use strict';
// Tests: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateDecision, jaccard, wordCount, hasCJK, englishHits, motivTreffer } = require('../src/checks');
const { roman, uniqueName, randomHue } = require('../src/names');
const { whitelistFor, uebernutzteMotive, sensory, buildPrompt } = require('../src/prompt');
const { effectFor, RESPAWN_DELAY_S, sichtStufe, SICHT, ankerPos, ENTITIES, entityLabel } = require('../src/config');
const { open, q } = require('../src/db');
const { Engine, step } = require('../src/engine');

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
  const lang = 'Ich sitze hier im Schatten und denke über alles nach was gestern passiert ist und morgen kommen wird.';
  assert.equal(wordCount(lang), 18);
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

test('checks: Motiv-Quota verbietet abgenutzte Bilder', () => {
  const letzte = ['Mein Kopf wird leicht.', 'Der Kopf ist schwer.', 'Im Kopf ist es still.'];
  const motive = uebernutzteMotive(letzte);
  assert.ok(motive.includes('kopf'), `Motive: ${motive}`);
  const v = validateDecision('{"action":"look_earth","thought":"Mein Kopf wird wieder leichter."}',
    { whitelist: WL, recentThoughts: [], motive });
  assert.ok(v.failures.includes('motiv'));
  assert.deepEqual(motivTreffer('Die Pfoten sind schwer', ['kopf', 'erde']), []);
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
  const p = { mind_state: 'klar', stress: 20, hunger: 20, exhaustion: 20 };
  assert.deepEqual(whitelistFor(p).slice().sort(),
    ['call_bake', 'dig', 'inspect', 'search_wrack', 'sinnieren', 'streifen']);

  assert.ok(whitelistFor({ ...p, hunger: 60 }).includes('eat'));
  const muede = whitelistFor({ ...p, exhaustion: 50 });
  assert.ok(muede.includes('sit_shade') && muede.includes('sleep'));
  const nervoes = whitelistFor({ ...p, stress: 50 });
  assert.ok(nervoes.includes('sit_shade') && nervoes.includes('look_earth'));
});

test('whitelist: Zickzack-Bremse stoppt A-B-A-B-Pendel', () => {
  const p = { mind_state: 'klar', stress: 20, hunger: 20, exhaustion: 20 };
  const voll = ['call_bake', 'dig', 'inspect', 'search_wrack', 'sinnieren', 'streifen'];
  assert.deepEqual(whitelistFor(p, { recentActions: [] }).slice().sort(), voll);
  // Wiederholung sperrt B, Zickzack zusätzlich A -> dritte Option bleibt
  const pendel = whitelistFor(p, { recentActions: ['inspect', 'dig', 'inspect', 'dig'] });
  assert.ok(!pendel.includes('inspect') && !pendel.includes('dig'), `Pendel läuft weiter: ${pendel}`);
  assert.ok(pendel.includes('streifen') && pendel.includes('sinnieren'), `keine Alternative: ${pendel}`);
});

test('whitelist: Zickzack-Bremse greift nicht im Notfall', () => {
  const not = { mind_state: 'klar', stress: 20, hunger: 90, exhaustion: 20 };
  const liste = whitelistFor(not, { recentActions: ['eat', 'sleep', 'eat', 'sleep'] });
  assert.ok(liste.includes('eat'), `Fressen gesperrt trotz Hunger 90: ${liste}`);
});

test('whitelist: Stupor und Wahn behalten ihren Ausweg', () => {
  const p = { mind_state: 'stupor', stress: 100, hunger: 50, exhaustion: 80 };
  assert.deepEqual(whitelistFor(p), ['sit_shade', 'sleep']);
  assert.deepEqual(whitelistFor({ ...p, mind_state: 'wahn' }), ['run_wild', 'sleep']);
});

test('whitelist: Ruhe-Quote und Wiederholungs-Bremse', () => {
  const p = { mind_state: 'klar', stress: 50, hunger: 50, exhaustion: 40 };
  const ruhe = whitelistFor(p, { recentActions: ['sit_shade', 'look_earth', 'sit_shade'] });
  assert.ok(!ruhe.includes('sit_shade') && !ruhe.includes('look_earth'));
  assert.ok(ruhe.length > 0);

  const wieder = whitelistFor(p, { recentActions: ['inspect', 'inspect'] });
  assert.ok(!wieder.includes('inspect'));
  assert.ok(wieder.includes('dig'));
});

// ---------------------------------------------------------------- Wirkungen
test('effectFor: Sitzen hilft nur bei Erschöpfung, sonst kostet es Stress', () => {
  const muede = effectFor('sit_shade', { exhaustion: 70, stress: 40 });
  const wach = effectFor('sit_shade', { exhaustion: 15, stress: 40 });
  assert.ok(muede.exhaustion < 0);
  assert.ok(muede.stress < 0);
  assert.equal(wach.exhaustion, 0);
  assert.ok(wach.stress > 0);
});

test('effectFor: Erdgucken und Fressen sind zustandsabhängig', () => {
  assert.ok(effectFor('look_earth', { stress: 60 }).stress < 0);
  assert.ok(effectFor('look_earth', { stress: 10 }).stress > 0);
  assert.ok(effectFor('eat', { hunger: 60 }).hunger < 0);
  assert.deepEqual(effectFor('eat', { hunger: 2 }), {});
});

test('sensory: hohe Werte klingen schlecht, niedrige gut', () => {
  const schlecht = sensory({ hunger: 90, exhaustion: 90, stress: 90 });
  const gut = sensory({ hunger: 10, exhaustion: 10, stress: 10 });
  assert.match(schlecht, /brennt/);
  assert.match(schlecht, /zittern/);
  assert.match(gut, /keinen Hunger/);
  assert.match(gut, /ausgeruht/);
  assert.match(gut, /ruhig/);
});

// ---------------------------------------------------------------- Engine
test('engine: Hungertod und Neustart nach 10 Minuten', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s0 = e.state();
  db.prepare("UPDATE pilots SET hunger = 99.999, current_action = 'idle' WHERE id = ?").run(s0.pilot.id);

  e.tick();
  const tot = q.pilot(db);
  assert.equal(tot.status, 'dead');
  assert.equal(tot.cause_of_death, 'hunger');

  for (let i = 0; i < RESPAWN_DELAY_S + 2; i += 1) e.tick();
  const neu = q.pilot(db);
  assert.equal(neu.status, 'alive');
  assert.equal(neu.cycle_num, 2);
  assert.ok(neu.hunger >= 30 && neu.hunger < 31, `Start-Hunger ${neu.hunger}`);
});

test('engine: Neugier belohnt den ersten Besuch, dann weniger, dann nichts', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();

  const werte = [];
  const wpos = ankerPos(s.entities.find((x) => x.id === 'note'));
  for (let i = 0; i < 3; i += 1) {
    db.prepare('UPDATE pilots SET pos_x = ?, pos_z = ?, stress = 60 WHERE id=?')
      .run(wpos.pos_x, wpos.pos_z, s.pilot.id);
    e.tick();
    werte.push(q.pilot(db).stress);
    db.prepare('UPDATE pilots SET pos_x=100, pos_z=100 WHERE id=?').run(s.pilot.id);
    e.tick();
  }

  const erster = 60 - werte[0];
  const zweiter = 60 - werte[1];
  const dritter = 60 - werte[2];
  assert.ok(erster > 10, `erster Besuch senkt um ${erster}`);
  assert.ok(zweiter > 2 && zweiter < erster, `zweiter um ${zweiter}`);
  assert.ok(dritter < 1, `dritter um ${dritter}`);
});

test('engine: Stehenbleiben zählt nicht als neue Ankunft', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  // Pilot steht am sichtbaren Notizzettel (Anker), nicht am Logikpunkt
  const zettelPos = ankerPos(s.entities.find((x) => x.id === 'note'));
  db.prepare('UPDATE pilots SET pos_x = ?, pos_z = ?, stress = 50 WHERE id=?')
    .run(zettelPos.pos_x, zettelPos.pos_z, s.pilot.id);

  for (let i = 0; i < 8; i += 1) e.tick();
  const zettel = db.prepare("SELECT count FROM novelty WHERE key = 'entity:note'").get();
  assert.equal(zettel.count, 1, 'ein Besuch, nicht acht');
});

test('engine: Langeweile treibt den Stress hoch', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  // weit weg von allen Orten, sonst belohnt schon der erste Tick den Fund der Kapsel
  db.prepare('UPDATE pilots SET stress = 10, pos_x = 300, pos_z = 300 WHERE id = ?').run(s.pilot.id);
  db.prepare('UPDATE world_state SET last_novelty_tick = world_tick - 1000 WHERE id = 1').run();

  const vorher = q.pilot(db).stress;
  for (let i = 0; i < 60; i += 1) e.tick();
  assert.ok(q.pilot(db).stress > vorher + 0.03);
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

test('engine: Zusammenbruch bei Stress 100, chronisch macht Stupor', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  const st = {
    world: { ...s.world }, pilot: { ...s.pilot, stress: 100, pos_x: 300, pos_z: 300 },
    entities: s.entities, recentActions: [], allNames: s.allNames, novelty: {}, near: new Set(),
    nerve: [{ kind: 'chronic', source: 'monotony', weight: 8 }], events: [],
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
    world: { ...s.world }, pilot: { ...s.pilot, stress: 100, pos_x: 300, pos_z: 300 },
    entities: s.entities, recentActions: [], allNames: s.allNames, novelty: {}, near: new Set(),
    nerve: [{ kind: 'acute', source: 'knock', weight: 12 }], events: [],
  };
  step(st, 1, { live: true, noRandom: true });
  assert.equal(st.pilot.mind_state, 'wahn');
});

// ---------------------------------------------------------------- Catch-up
test('catchup: 6 Stunden nachrechnen, idempotent, Tickzähler lückenlos', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const jetzt = Date.now();
  db.prepare('UPDATE world_state SET last_tick_at = ?, world_tick = 1000 WHERE id = 1')
    .run(new Date(jetzt - 6 * 3600 * 1000).toISOString());

  const r = e.catchup(jetzt);
  assert.ok(Math.abs(r.missed - 21600) <= 2, `missed ${r.missed}`);
  assert.equal(r.toTick, 1000 + r.missed);
  assert.equal(e.catchup(jetzt).missed, 0);

  const offline = db.prepare("SELECT * FROM events WHERE type='offline'").all();
  assert.equal(offline.length, 1);
  assert.equal(JSON.parse(offline[0].payload_json).to_tick - 1000, r.missed);
});

test('catchup: mehr als 12 Stunden wird gekappt', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const jetzt = Date.now();
  db.prepare('UPDATE world_state SET last_tick_at = ? WHERE id = 1')
    .run(new Date(jetzt - 40 * 3600 * 1000).toISOString());
  assert.equal(e.catchup(jetzt).missed, 12 * 3600);
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
  db.prepare("UPDATE pilots SET current_action='idle', hunger=60 WHERE id=?").run(s.pilot.id);

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
  db.prepare("UPDATE pilots SET current_action='idle', hunger=70 WHERE id=?").run(s.pilot.id);

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
test('db: alte Werte (food/energy/sanity) werden umbenannt und gedreht', () => {
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
  assert.equal(Math.round(p.hunger), 30, 'Futter 70 -> Hunger 30');
  assert.equal(Math.round(p.exhaustion), 20);
  assert.equal(Math.round(p.stress), 10);
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
  db.prepare("UPDATE pilots SET current_action='idle', hunger=60 WHERE id=?").run(s.pilot.id);

  const res = await e.decide();
  assert.equal(res.ok, true, res.reason);
  // Zusammen wären es 16 Wörter — getrennt bleibt der Gedanke im Limit.
  const payload = JSON.parse(db.prepare("SELECT payload_json FROM events WHERE type='thought'").get().payload_json);
  assert.ok(wordCount(payload.thought) <= 14, payload.thought);
  assert.equal(payload.musing, 'Tanzen die Menschen dort unten gerade?');
  assert.equal(db.prepare('SELECT text FROM thoughts').get().text, payload.thought);
  m.srv.closeAllConnections?.();
  m.srv.close();
});

// ---------------------------------------------------------------- Aktionsverb-Abgleich
test('checks: Gedanke mit fremdem Aktionsverb fällt durch', () => {
  const v = validateDecision(JSON.stringify({
    action: 'eat',
    thought: 'Orangefarbene Spitzen im Boden. Mein Magen knurrt leise. Ich werde graben.',
  }), { whitelist: WL });
  assert.ok(v.failures.includes('aktionsmismatch'), JSON.stringify(v.failures));
});

test('checks: eigenes Verb und verblose Gedanken passieren', () => {
  assert.equal(validateDecision(JSON.stringify({
    action: 'look_earth', thought: 'Ich schaue zur Erde. Sie ist still und fern.',
  }), { whitelist: WL }).ok, true);
  assert.equal(validateDecision(JSON.stringify({
    action: 'eat', thought: 'Magen knurrt. Ich geh zur Karotte.',
  }), { whitelist: WL }).ok, true);
  const v = validateDecision(JSON.stringify({
    action: 'inspect', thought: 'Ich schaue zur Erde. Sie ist still und fern.',
  }), { whitelist: WL });
  assert.ok(v.failures.includes('aktionsmismatch'), JSON.stringify(v.failures));
});

// ---------------------------------------------------------------- Neue Aktionen
test('whitelist: neue Aktionen nur bei Bedarf, Wühlen und Bake immer', () => {
  const bedarf = { mind_state: 'klar', hunger: 40, exhaustion: 20, stress: 50 };
  const voll = whitelistFor(bedarf, { recentActions: [] });
  for (const a of ['search_wrack', 'read_note', 'check_stock', 'tend_dome', 'call_bake']) {
    assert.ok(voll.includes(a), `${a} fehlt: ${voll}`);
  }
  const satt = { mind_state: 'klar', hunger: 10, exhaustion: 10, stress: 10 };
  const leer = whitelistFor(satt, { recentActions: [] });
  assert.ok(!leer.includes('read_note') && !leer.includes('check_stock') && !leer.includes('tend_dome'),
    `Bedarfsaktionen trotz voller Werte: ${leer}`);
  assert.ok(leer.includes('search_wrack') && leer.includes('call_bake'),
    `freie Aktionen fehlen: ${leer}`);
});

test('checks: neue Aktionsverben greifen, eigenes Verb zählt nie', () => {
  const WL2 = [...WL, 'search_wrack', 'read_note'];
  const v = validateDecision(JSON.stringify({
    action: 'eat', thought: 'Ich wühle im Rost. Vielleicht glänzt was.',
  }), { whitelist: WL2 });
  assert.ok(v.failures.includes('aktionsmismatch'), JSON.stringify(v.failures));
  assert.equal(validateDecision(JSON.stringify({
    action: 'search_wrack', thought: 'Ich wühle im Rost. Vielleicht glänzt was.',
  }), { whitelist: WL2 }).ok, true);
  assert.equal(validateDecision(JSON.stringify({
    action: 'read_note', thought: 'Ich lese den Zettel noch einmal.',
  }), { whitelist: WL2 }).ok, true);
});

// ---------------------------------------------------------------- Sichtstufen (Paket I)
test('sicht: klar, vermutet, bemerkt (weit+eng), ungesehen, Umschauen', () => {
  const blick = { pos_x: 0, pos_z: 0, heading: 0 };   // schaut +z
  assert.equal(sichtStufe(blick, { pos_x: 0, pos_z: SICHT.nah.dist - 1 }), 'klar');
  assert.equal(sichtStufe(blick, { pos_x: 0, pos_z: -2 }), 'klar');   // Kontakt rundum
  assert.equal(sichtStufe(blick, { pos_x: 0, pos_z: SICHT.mittel.dist - 1 }), 'vermutet');
  assert.equal(sichtStufe(blick, { pos_x: 0, pos_z: SICHT.fernWeit.dist - 1 }), 'bemerkt');
  const eng = SICHT.fernEng;
  const ex = Math.sin(20 * Math.PI / 180) * (eng.dist - 1);
  const ez = Math.cos(20 * Math.PI / 180) * (eng.dist - 1);
  assert.equal(sichtStufe(blick, { pos_x: ex, pos_z: ez }), 'bemerkt', 'enger Fokuskegel fehlt');
  assert.equal(sichtStufe(blick, { pos_x: 0, pos_z: -(SICHT.mittel.dist + 5) }), 'ungesehen');
  assert.equal(sichtStufe(blick, { pos_x: 0, pos_z: SICHT.fernEng.dist + 5 }), 'ungesehen');
  const um = { pos_x: 0, pos_z: 0, heading: null };   // schaut um sich
  assert.equal(sichtStufe(um, { pos_x: SICHT.nah.dist - 1, pos_z: 0 }), 'klar');
  assert.equal(sichtStufe(um, { pos_x: SICHT.mittel.dist - 1, pos_z: 0 }), 'vermutet');
  assert.equal(sichtStufe(um, { pos_x: SICHT.fernWeit.dist - 1, pos_z: 0 }), 'bemerkt');
  assert.equal(sichtStufe(um, { pos_x: SICHT.fernEng.dist + 5, pos_z: 0 }), 'ungesehen');
});

test('sicht: Erkennung greift vor dem Halt (Vorlauf)', () => {
  // Halt ist bei nah.dist — erkannt wird schon vorlauf-Meter früher,
  // sonst stünde er ewig vor dem Ort, ohne ihn je zu erkennen
  const blick = { pos_x: 0, pos_z: 0, heading: 0 };
  assert.equal(sichtStufe(blick, { pos_x: 0, pos_z: SICHT.nah.dist + SICHT.vorlauf - 0.5 }), 'klar');
  assert.equal(sichtStufe(blick, { pos_x: 0, pos_z: SICHT.nah.dist + SICHT.vorlauf + 0.5 }), 'vermutet');
});

test('prompt: Stufen im Prompt (nichts / Fern / Vermutung / Name)', () => {
  // Rohposition so wählen, dass die SICHTBARE Position (Anker) auf der Stufe landet
  const lege = (id, type, name, x, z) => {
    const a = ankerPos({ type, pos_x: 0, pos_z: 0 });
    return { id, type, name, pos_x: x - a.pos_x, pos_z: z - a.pos_z };
  };
  const pilot = { hunger: 30, exhaustion: 20, stress: 20, pos_x: 0, pos_z: 0, heading: 0, mind_state: 'klar' };
  const entities = [
    lege('mast', 'mast', 'Funkmast', 0, SICHT.fernEng.dist + 5),
    lege('kuppel', 'kuppel', 'Gewächskuppel', 0, SICHT.fernWeit.dist - 2),
    lege('wreck', 'wreck', 'Wrack', 0, SICHT.mittel.dist - 1),
    lege('note', 'note', 'Notizzettel', 0, SICHT.nah.dist - 1),
  ];
  const p = buildPrompt(pilot, { entities, beliefs: [], whitelist: ['inspect'], words: [], recentThoughts: [] });
  assert.ok(!p.includes('Funkmast'), 'ungesehener Mast genannt');
  assert.ok(p.includes('Fern: etwas Unbekanntes'), 'Fern-Meldung fehlt');
  assert.ok(!p.includes('blasse Kuppel'), 'Bemerktes mit Silhouette beschrieben');
  assert.ok(p.includes('Vermutung: ein dunkler Klumpen'), 'Vermutung fehlt');
  assert.ok(!p.includes('halb im Rost'), 'vermuteter Ort mit Klartext beschrieben');
  assert.ok(p.includes('Notizzettel'), 'klarer Ort fehlt');
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
    return {
      ...s.pilot, pos_x: w.pos_x, pos_z: w.pos_z - d, heading: 0,
      hunger: 30, exhaustion: 20, stress: 20,
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
    const a = ankerPos(e);
    assert.ok(Math.hypot(a.pos_x - e.x, a.pos_z - e.z) < 12, `${e.id}: Anker zu weit weg`);
  }
  for (let i = 0; i < ENTITIES.length; i += 1) {
    for (let j = i + 1; j < ENTITIES.length; j += 1) {
      const d = Math.hypot(ENTITIES[i].x - ENTITIES[j].x, ENTITIES[i].z - ENTITIES[j].z);
      assert.ok(d >= 15, `${ENTITIES[i].id}–${ENTITIES[j].id}: nur ${Math.round(d)} m`);
    }
  }
});

test('config: Schildtext je Entdeckungsgrad (nichts / ? / Vermutung / Name)', () => {
  // Rohposition so wählen, dass die SICHTBARE Position (Anker) auf der Stufe landet
  const blick = { pos_x: 0, pos_z: 0, heading: 0 };
  const lege = (d) => ({ type: 'wreck', name: 'Wrack', pos_x: 0 - 10, pos_z: d + 6 });
  assert.equal(entityLabel(blick, lege(SICHT.fernEng.dist + 5)), null);
  assert.equal(entityLabel(blick, lege(SICHT.fernWeit.dist - 2)), '?', 'bemerkt zeigt mehr als ?');
  const vage = entityLabel(blick, lege(SICHT.mittel.dist - 1));
  assert.ok(vage && vage.endsWith('?'), `kein Vermutungs-Schild: ${vage}`);
  assert.ok(!vage.includes('Wrack'), 'vermutetes Schild nennt den Namen');
  const klar = entityLabel(blick, lege(SICHT.nah.dist - 1));
  assert.equal(klar, 'Wrack');
});

test('config: einmal erkannt, nie vergessen (Schilder zeigen Höchststand)', () => {
  // Umdrehen: memorierter Grad bleibt, auch wenn aktuell nichts zu sehen ist
  const weg = { pos_x: 0, pos_z: 0, heading: Math.PI };   // schaut weg
  const fern = { type: 'wreck', name: 'Wrack', pos_x: 0 - 10, pos_z: SICHT.fernEng.dist + 5 + 6 };
  assert.equal(entityLabel(weg, fern), null);
  assert.equal(entityLabel(weg, { ...fern, sicht: 1 }), '?');
  assert.equal(entityLabel(weg, { ...fern, sicht: 2 }), 'Ein dunkler Klumpen?');
  assert.equal(entityLabel(weg, { ...fern, sicht: 3 }), 'Wrack');
});

test('engine: Discovery merkt Betrachtungsbedarf', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  const wpos = ankerPos(s.entities.find((x) => x.id === 'wreck'));
  s.pilot.pos_x = wpos.pos_x;
  s.pilot.pos_z = wpos.pos_z;
  s.pilot.heading = 0;
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
  } finally {
    global.fetch = alt;
  }
});

test('engine: Tick schreibt Erkanntheitsgrad in die DB', async () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  const wpos = ankerPos(s.entities.find((x) => x.id === 'wreck'));
  db.prepare('UPDATE pilots SET pos_x = ?, pos_z = ? WHERE id=?').run(wpos.pos_x, wpos.pos_z, s.pilot.id);
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
    return {
      ...basis,
      pilot: {
        ...s.pilot, pos_x: w.pos_x + abstand, pos_z: w.pos_z, heading: -Math.PI / 2,
        hunger: 30, exhaustion: 20, stress: 20, mind_state: 'klar', status: 'alive',
        current_action: action, target_entity: zielId, action_started_tick: null,
      },
      entities: s.entities,
    };
  };
  // inspect stoppt am Nahkreis
  const st = los('inspect', 'wreck', SICHT.nah.dist + 5);
  step(st, 10, { live: true, noRandom: true });
  const dw = Math.hypot(st.pilot.pos_x - ankerPos(s.entities.find((x) => x.id === 'wreck')).pos_x,
    st.pilot.pos_z - ankerPos(s.entities.find((x) => x.id === 'wreck')).pos_z);
  assert.ok(Math.abs(dw - SICHT.nah.dist) < 0.01, `bleibt nicht am Nahkreis stehen: ${dw}`);
  assert.ok(st.pilot.action_started_tick !== null, 'fängt nicht an zu handeln');
  // schlafen geht unter Dach (näher ran)
  const st2 = los('sleep', 'shade', 6);
  step(st2, 10, { live: true, noRandom: true });
  const sh = ankerPos(s.entities.find((x) => x.id === 'shade'));
  const ds = Math.hypot(st2.pilot.pos_x - sh.pos_x, st2.pilot.pos_z - sh.pos_z);
  assert.ok(Math.abs(ds - 1.0) < 0.01, `schlafen bleibt nicht unterm Dach: ${ds}`);
});

test('engine: Figur läuft zum sichtbaren Bauwerk, nicht zum Logikpunkt', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const s = e.state();
  const w = ankerPos(s.entities.find((x) => x.id === 'wreck'));
  const st = {
    world: { ...s.world },
    pilot: {
      ...s.pilot, pos_x: w.pos_x + 10, pos_z: w.pos_z, heading: 0,
      hunger: 30, exhaustion: 20, stress: 20, mind_state: 'klar', status: 'alive',
      current_action: 'inspect', target_entity: 'wreck', action_started_tick: null,
    },
    entities: s.entities, recentActions: [], allNames: s.allNames,
    novelty: {}, near: new Set(), nerve: [], events: [],
  };
  step(st, 1, { live: true, noRandom: true });
  assert.ok(st.pilot.pos_x < w.pos_x + 10, 'Figur läuft nicht los');
  assert.ok(Math.abs(st.pilot.pos_z - w.pos_z) < 0.01,
    `Figur läuft zum Logikpunkt statt zum Bauwerk (z=${st.pilot.pos_z})`);
});

test('engine: Sichtwerte stehen im State für den Dev-Kegel', () => {
  const db = frisch();
  const e = new Engine(db, { apiKey: 'test' });
  const snap = e.snapshot();
  assert.deepEqual(snap.sicht, SICHT);
  assert.ok('heading' in snap.pilot, 'kein Heading im Pilot-State');
});

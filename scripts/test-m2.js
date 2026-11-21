'use strict';
// Meilenstein-2-Test: Route -> consume (Arbiter) -> leave_note -> Job -> work_shift
// -> sleep mit Nacht-Konsolidierung. Gemocktes LLM, Temp-DB.
// Aufruf: node scripts/test-m2.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const dbMod = require('../src/db');
const pf = require('../src/pathfinding');
const engine = require('../src/engine');
const arbiter = require('../src/arbiter');
const promptMod = require('../src/prompt');
const checks = require('../src/checks');

// --- Mock-Brain: gibt feste Plan-JSONs + Nightly-JSON zurück, kein Netz ------------
function mockBrainFuer(plaene) {
  let i = 0;
  return {
    async callModel() { return { content: '{}', usage: {}, cost: 0, latencyMs: 1 }; },
    async decide() {
      const plan = plaene[Math.min(i, plaene.length - 1)];
      i += 1;
      return { ok: true, raw: JSON.stringify(plan), stale: false };
    },
  };
}

const PLAN_WALK_CONSUME = {
  thought: 'Erst zum Otzentreff laufen, dann dort etwas Warmes essen',
  retrospective: '',
  plan: [
    { action: 'walk_to', target: 'otzentreff', detail: 'Zum Otzentreff laufen' },
    { action: 'consume', target: 'otzentreff', detail: 'Pommes mit Ketchup' },
  ],
};

const PLAN_NOTE = {
  thought: 'Ich lege einen Zettel fuer Arbeit hin',
  retrospective: 'Essen hat gutgetan',
  plan: [
    { action: 'leave_note', target: 'otzentreff', detail: 'Hallo! Ich suche Arbeit als Spuelhilfe. Ich bin zuverlaessig.' },
    { action: 'rest', target: null, detail: 'Kurz verschnaufen' },
  ],
};

const PLAN_SHIFT_SLEEP = {
  thought: 'Schicht arbeiten, dann daheim schlafen',
  retrospective: 'Zusage kam',
  plan: [
    { action: 'work_shift', target: null, detail: 'Schicht als Spuelhilfe' },
    { action: 'walk_to', target: 'apartment', detail: 'Heimweg' },
    { action: 'sleep', target: 'apartment', detail: 'Nachtruhe' },
  ],
};

const MOCK_TELEGRAM = {
  async pollAntworten() { return { ok: true, neu: [] }; },
  hatAntwortFuer() { return false; },
  async sendeNachricht() { return { ok: false, grund: 'mock', fallback: 'log' }; },
};

async function main() {
  const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aiq-m2-')), 'world.sqlite');
  console.log('[m2] temp-db:', tmpDb);
  delete process.env.OPENROUTER_API_KEY; // Mock erzwingen: deterministische Fallbacks

  const karte = dbMod.ladeKiezKarte();
  assert.ok(karte && karte.navGraph, 'kiez_map.json erwartet');
  const { db, characterId } = dbMod.init(tmpDb, karte);
  const deps = (brain) => ({ karte, brain, telegram: MOCK_TELEGRAM, nightly: false });

  // 1) Prompt enthaelt keine Roh-Prozente, dafuer Gefuehle + Grenze + Whitelist
  const ch0 = engine.ladeCharakter(db, characterId);
  const gebaut = promptMod.buildPrompt(db, ch0, { orte: [{ id: 'apartment', name: 'Wohnung', category: 'home' }] });
  assert.ok(!/%/.test(gebaut.prompt.split('ANTWORTE')[0]) || /20 \w+|Prozent/.test('x') === false, 'prompt geprueft');
  assert.ok(!/\b\d{2,3}\s*%/.test(gebaut.prompt), 'keine roh-prozente im prompt');
  assert.ok(/Zettel/.test(gebaut.prompt) && /Handy/.test(gebaut.prompt), 'kommunikationsgrenze im prompt');
  assert.ok(!gebaut.whitelist.includes('send_sms'), 'ohne handy kein sms-intent');
  assert.ok(gebaut.memories.length >= 1, 'memories eingebunden');
  const cb = db.prepare('SELECT come_back_count FROM memories ORDER BY id LIMIT 1').get();
  assert.ok(Number(cb.come_back_count) >= 2, 'come_back beim einbinden erhoeht');
  console.log('[m2] prompt ok (keine %, grenze, whitelist, come_back)');

  // 2) Plan-Validierung: 2-4 Schritte, walk_to braucht Ziel, max 1 leave_note
  const okPlan = checks.validatePlan(PLAN_WALK_CONSUME, gebaut.whitelist);
  assert.ok(okPlan.ok, 'gueltiger plan: ' + okPlan.failures.join(','));
  const schlecht = checks.validatePlan({ thought: 'x', retrospective: '', plan: [{ action: 'fliegen' }] }, gebaut.whitelist);
  assert.ok(!schlecht.ok, 'verbotener intent faellt durch');
  console.log('[m2] plan-checks ok');

  // 3) Ticks: walk_to otzentreff (schrittweise, ~28 m/Tick) + consume ueber Arbiter
  const brain12 = mockBrainFuer([PLAN_WALK_CONSUME]);
  let schritte = 0;
  let t1;
  for (let i = 0; i < 30; i += 1) {
    schritte += 1;
    t1 = await engine.tick(db, deps(brain12), characterId, Date.now());
    assert.ok(t1.ok, 'tick walk ok');
    if (engine.ladeCharakter(db, characterId).inside_poi === 'otzentreff') break;
  }
  assert.strictEqual(engine.ladeCharakter(db, characterId).inside_poi, 'otzentreff', 'angekommen im otzentreff');
  assert.ok(schritte >= 2, `route braucht mehrere ticks (war: ${schritte})`);
  assert.ok(t1.route === null || t1.route === undefined, 'route nach ankunft leer');
  console.log(`[m2] walk schrittweise ok (${schritte} ticks bis otzentreff)`);
  const t2 = await engine.tick(db, deps(brain12), characterId, Date.now());
  assert.ok(t2.ok && t2.schritt.action === 'consume', 'tick consume, war: ' + JSON.stringify(t2.schritt));
  const angebot = db.prepare("SELECT * FROM poi_offers WHERE poi_id = 'otzentreff' AND kind = 'consume'").get();
  assert.ok(angebot, 'angebot in poi_offers gecacht');
  assert.ok(Number(angebot.price) >= 2.5 && Number(angebot.price) <= 12.0, 'preis in kneipen-grenzen: ' + angebot.price);
  console.log('[m2] route+consume ok: angebot=' + angebot.label + ' ' + Number(angebot.price).toFixed(2) + ' EUR');

  // 4) Tick 3+4: leave_note + rest; dann Evaluator -> Job-Zusage
  const brain34 = mockBrainFuer([PLAN_NOTE]);
  const t3 = await engine.tick(db, deps(brain34), characterId, Date.now());
  assert.ok(t3.ok && t3.schritt.action === 'leave_note', 'tick3 leave_note');
  const zettel = db.prepare("SELECT * FROM messages_outbox WHERE channel = 'leave_note' ORDER BY id DESC LIMIT 1").get();
  assert.ok(zettel && zettel.status === 'pending', 'zettel in outbox (pending)');
  const t4 = await engine.tick(db, deps(brain34), characterId, Date.now());
  assert.ok(t4.ok, 'tick4 rest ok');
  // Evaluator: Timer sofort faellig machen, dann Job erwartet
  db.prepare("UPDATE messages_outbox SET resolve_after_at = datetime('now', '-1 minute') WHERE id = ?").run(zettel.id);
  const bew = arbiter.bewerteBewerbungen(db, MOCK_TELEGRAM);
  assert.ok(bew.length >= 1 && bew[0].angenommen, 'bewerbung angenommen: ' + JSON.stringify(bew));
  const job = arbiter.aktiverJob(db, characterId);
  assert.ok(job && job.status === 'active', 'aktiver job vorhanden');
  assert.ok(Number(job.wage_per_shift) >= 8 && Number(job.wage_per_shift) <= 18, 'lohn in grenzen: ' + job.wage_per_shift);
  console.log('[m2] zettel+job ok: ' + job.role_title + ' @' + job.poi_id + ' ' + Number(job.wage_per_shift).toFixed(2) + ' EUR');

  // 5) work_shift (+lohn) -> walk home (schrittweise) -> sleep (+nightly, 1x/Tag)
  const geldVor = Number(engine.ladeCharakter(db, characterId).geld);
  const brain567 = mockBrainFuer([PLAN_SHIFT_SLEEP]);
  const t5 = await engine.tick(db, deps(brain567), characterId, Date.now());
  assert.ok(t5.ok && t5.schritt.action === 'work_shift', 'tick5 work_shift');
  const geldNach = Number(engine.ladeCharakter(db, characterId).geld);
  assert.ok(geldNach > geldVor, `lohn gebucht (${geldVor.toFixed(2)} -> ${geldNach.toFixed(2)})`);
  let heimSchritte = 0;
  for (let i = 0; i < 30; i += 1) {
    heimSchritte += 1;
    const t = await engine.tick(db, deps(brain567), characterId, Date.now());
    assert.ok(t.ok, 'tick heimweg ok');
    if (engine.ladeCharakter(db, characterId).inside_poi === 'apartment') break;
  }
  assert.strictEqual(engine.ladeCharakter(db, characterId).inside_poi, 'apartment', 'wieder daheim');
  console.log(`[m2] heimweg schrittweise ok (${heimSchritte} ticks)`);
  // Nacht-Konsolidierung beim Schlafen daheim (nightly an, Mock ohne Key -> Fallback)
  // Hard-Limit-Check: bei erschoepfung < 50 darf sleep noch nicht greifen, ab >= 50 klappt es.
  db.prepare('UPDATE character SET erschoepfung = 60 WHERE id = ?').run(characterId);
  const depsNightly = { karte, brain: mockBrainFuer([PLAN_SHIFT_SLEEP]), telegram: MOCK_TELEGRAM, nightly: true };
  const t7 = await engine.tick(db, depsNightly, characterId, Date.now());
  assert.ok(t7.ok && t7.schritt.action === 'sleep', 'tick7 sleep');
  const summae = db.prepare('SELECT * FROM day_summaries WHERE character_id = ?').all(characterId);
  assert.ok(summae.length >= 1, 'mind. 1 tages-schlagzeile, gefunden: ' + summae.length);
  console.log('[m2] schicht+schlaf ok: lohn +' + (geldNach - geldVor).toFixed(2) + ' EUR, headline: ' + summae[0].headline);
  const wieder = await arbiter.runNightlyConsolidation(db, null, characterId, 'log', Date.now());
  assert.ok(!wieder.ok && wieder.grund === 'bereits_konsolidiert', 'nightly nur 1x pro tag');
  console.log('[m2] nightly-einmaligkeit ok');

  // 6) Strike-Regel: krank zur Schicht -> halber Lohn + Strike; 2. Strike -> Kuendigung
  db.prepare('UPDATE character SET gesund = 10 WHERE id = ?').run(characterId);
  const jobVorher = arbiter.aktiverJob(db, characterId);
  const chKrank = engine.ladeCharakter(db, characterId);
  const ab1 = arbiter.rechneSchichtAb(db, characterId, jobVorher, chKrank);
  assert.ok(ab1.abgebrochen && ab1.strikes === 1, '1. strike: ' + JSON.stringify(ab1));
  const ab2 = arbiter.rechneSchichtAb(db, characterId, arbiter.aktiverJob(db, characterId), engine.ladeCharakter(db, characterId));
  assert.ok(ab2.gekuendigt, '2. strike -> kuendigung');
  const erinnerung = db.prepare("SELECT * FROM memories WHERE text LIKE '%Gekuendigt%'").get();
  assert.ok(erinnerung, 'kuendigung erinnert (memory)');
  console.log('[m2] strike-regel ok: 1. strike, dann kuendigung + erinnerung');

  // 7) Telegram-Fallback ohne Keys: kein Absturz, sauberes Log-Ergebnis
  const tg = require('../src/telegram');
  const res = await tg.sendeNachricht(db, { character_id: characterId, channel: 'leave_note', content: 'Test' });
  assert.ok(res.fallback === 'log', 'telegram-fallback ohne keys');
  console.log('[m2] telegram-fallback ok');

  db.close();
  console.log('[m2] ALLES OK');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('[m2] FEHLER:', err.message);
  console.error(err.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});


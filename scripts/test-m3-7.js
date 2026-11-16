'use strict';
// 7-Punkte-Verifikation: explore_route (> 30 m, mehrere Ticks), Route in State,
// Marker-/Straßennamen-/Augen-/Licht-/Kamera-Stichworte in scene.js, Dev-Badges.
// Aufruf: node scripts/test-m3-7.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const dbMod = require('../src/db');
const engine = require('../src/engine');

function mockBrainFuer(plaene) {
  let i = 0;
  return {
    async callModel() { return { content: '{}', usage: {}, cost: 0, latencyMs: 1 }; },
    async decide() {
      const plan = plaene[Math.min(i, plaene.length - 1)];
      i += 1;
      // Modell-Slug + Tokens wie echtes brain.decide (für Dev-Badges)
      return { ok: true, raw: JSON.stringify(plan), stale: false, modell: 'google/gemma-4-26b:free', usage: { completion_tokens: 148, total_tokens: 900 } };
    },
  };
}

const MOCK_TG = {
  async pollAntworten() { return { ok: true, neu: [] }; },
  hatAntwortFuer() { return false; },
  async sendeNachricht() { return { ok: false, fallback: 'log' }; },
};

async function main() {
  const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aiq-m37-')), 'world.sqlite');
  delete process.env.OPENROUTER_API_KEY;
  const karte = dbMod.ladeKiezKarte();
  const { db, characterId } = dbMod.init(tmpDb, karte);
  const deps = (brain) => ({ karte, brain, telegram: MOCK_TG, nightly: false });

  // --- Punkt 1: explore_street erzeugt echte A*-Route (> 30 m), Figur bewegt sich ---
  const brainEx = mockBrainFuer([{
    thought: 'Ich schaue mich um', retrospective: '',
    plan: [{ action: 'explore_street', target: null, detail: 'Umschauen' }],
  }]);
  const start = engine.ladeCharakter(db, characterId);
  const sx = Number(start.pos_x);
  const sz = Number(start.pos_z);
  let bewegt = 0;
  let routeGesehen = null;
  for (let i = 0; i < 12; i += 1) {
    const t = await engine.tick(db, deps(brainEx), characterId, Date.now());
    assert.ok(t.ok, 'explore-tick ok');
    if (t.route && t.route.restM > 1.5) routeGesehen = t.route;
    const c = engine.ladeCharakter(db, characterId);
    bewegt = Math.max(bewegt, Math.hypot(Number(c.pos_x) - sx, Number(c.pos_z) - sz));
    if (t.route === null && i > 2 && bewegt > 30) break;
  }
  assert.ok(bewegt > 30, `explore bewegt figur > 30 m (war: ${bewegt.toFixed(1)} m)`);
  assert.ok(routeGesehen && routeGesehen.waypoints.length >= 2, 'route mit waypoints im tick');
  console.log(`[7] punkt 1 ok: explore-route ${routeGesehen.restM.toFixed(0)} m rest, figur ${bewegt.toFixed(0)} m bewegt, ${routeGesehen.waypoints.length} waypoints`);

  // --- Punkt 7: Quelle + Tokens im Tick + Feed (erster Tick = frischer LLM-Plan) ---
  const brainQ = mockBrainFuer([{
    thought: 'Zum Otzentreff laufen und umsehen', retrospective: '',
    plan: [
      { action: 'walk_to', target: 'otzentreff', detail: 'Los' },
      { action: 'rest', target: null, detail: 'Verschnaufen' },
    ],
  }]);
  db.prepare("UPDATE character SET pos_x = -3, pos_z = -68, inside_poi = 'apartment', current_action = 'idle', action_meta_json = NULL, plan_queue_json = '[]' WHERE id = ?").run(characterId);
  const tq = await engine.tick(db, deps(brainQ), characterId, Date.now());
  assert.ok(tq.quelle && tq.quelle.source === 'llm', 'tick-quelle llm, war: ' + JSON.stringify(tq.quelle));
  assert.ok(tq.quelle.model.includes('gemma'), 'modell-slug im tick: ' + tq.quelle.model);
  assert.ok(tq.quelle.tokens === 148, 'tokens im tick: ' + tq.quelle.tokens);
  assert.ok(tq.route && Array.isArray(tq.route.waypoints) && tq.route.target_pos, 'route + target_pos im tick');
  const planEv = db.prepare("SELECT payload_json FROM events WHERE type = 'plan' ORDER BY id DESC LIMIT 1").get();
  assert.ok(planEv, 'plan-event im feed');
  assert.ok(JSON.parse(planEv.payload_json).quelle.model.includes('gemma'), 'quelle im feed-event');
  console.log('[7] punkt 7 ok: quelle=llm, modell=gemma-4-26b:free, tokens=148 (tick + feed)');

  // --- Punkte 2–6: scene.js-Stichworte ---
  const szene = fs.readFileSync(path.join(__dirname, '..', 'public', 'scene.js'), 'utf8');
  const stich = [
    'bauMarkerGruppe', 'hoehe + 3.4', 'textSpriteZweizeilig', // 2: Marker + Fog + Dev-Zweitzeile
    'baueStrassennamen', 'VERSATZ = 5', 'position.set(mx, 6, mz)', // 3: Schilder andockend + aufgestellt
    'pupille', 'apfel.position.set(seite', // 4: Augen
    '220, 100', '2.6', '0xbfd8ff', '0xffffff, 0.45', // 5: Licht
    'overviewTarget', 'panUm', 'klemmeUeber', // 6: Panning/Zoom (Diorama-Scheibe)
    'figurRouteSetzen', 'atan2(dx, dz)', 'badgeHtml', 'plan-queue', 'not:', 'grund2', // 1+7: Route + Soll-Badges
    'DIORAMA', 'dioramaBerechnen', 'dioramaShader', 'uDioramaRadius', 'dioramaAussenAusblenden', // Scheibe + Kreisschnitt
    'CylinderGeometry(DIORAMA.r', '2b2d30', 'scene.fog = null', // Sockel + Nebel-Aus
  ];
  for (const s of stich) assert.ok(szene.includes(s), 'scene.js ohne: ' + s);
    'DIORAMA_V1', 'effektiveHoehe', 'baueHimmel', 'baueWolken', 'baueDioramaBaeume', 'bevelEnabled', 'uebersprungen', 'engine/diorama', // Diorama + Modul
  console.log(`[7] punkte 2–6 ok: ${stich.length} stichworte in scene.js`);

  // --- Punkt 2b: Dev-Badge-Regel (Teil zwischen / und -, free-Extraktion) ---
  const regel = (slug) => {
    const nachSlash = slug.includes('/') ? slug.split('/').pop() : slug;
    const kurz = (nachSlash.split('-')[0] || nachSlash).toLowerCase();
    return { kurz, free: slug.includes(':free') };
  };
  assert.deepStrictEqual([regel('google/gemma-4-26b:free').kurz, regel('google/gemma-4-26b:free').free], ['gemma', true]);
  assert.deepStrictEqual([regel('z-ai/glm-5.3-flash').kurz, regel('z-ai/glm-5.3-flash').free], ['glm', false]);
  assert.deepStrictEqual([regel('moonshotai/mimo-v2.6-pro').kurz, regel('moonshotai/mimo-v2.6-pro').free], ['mimo', false]);
  console.log('[7] badge-regel ok: gemma+free, glm, mimo');

  db.close();
  console.log('[7] ALLES OK');
}

main().catch((err) => { console.error('[7] FEHLER:', err.message); process.exit(1); });

'use strict';
// Routing-Verifikation (Punkt 2): Dev = überall :free, Live = exakte Slugs,
// Primary → Fallback bei 429 / kaputtem JSON. Kein Netz nötig (Mock-fetch).
// Aufruf: node scripts/test-routing.js

const assert = require('node:assert');

// fetch mocken, BEVOR config/brain geladen werden (config liest env beim Import)
function setzeFetch(antworten) {
  let i = 0;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const r = antworten[Math.min(i, antworten.length - 1)];
    i += 1;
    if (r.httpFehler) {
      return { ok: false, status: r.httpFehler, text: async () => 'rate limit' };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: r.content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: r.tokens || 50, total_tokens: 150 },
      }),
    };
  };
  return () => i;
}

function ladeConfigFrisch(devWert) {
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith('src/config.js') || k.endsWith('src/brain.js')) delete require.cache[k];
  }
  process.env.AIQUARIUM_DEV = devWert;
  const config = require('../src/config');
  const brain = require('../src/brain');
  return { config, brain };
}

const GUELTIG = JSON.stringify({ action: 'rest', thought: 'Kurze Pause hier', musing: null });

async function main() {
  // --- 1) Dev-Modus (Standard): alle Rollen :free ---
  let { config, brain } = ladeConfigFrisch('1');
  assert.ok(config.devPrioAn(), 'dev prio an');
  for (const rolle of ['alltag', 'arbiter', 'nightly']) {
    const pair = config.getRoleSlots(rolle);
    assert.ok(pair.primary.model.includes(':free'), `${rolle}.primary free, war: ${pair.primary.model}`);
    assert.ok(pair.fallback.model.includes(':free'), `${rolle}.fallback free, war: ${pair.fallback.model}`);
  }
  console.log('[routing] dev: alltag/arbiter/nightly = :free-paare');

  // --- 2) Live-Modus (AIQUARIUM_DEV=0): exakte Slugs aus dem Auftrag ---
  ({ config, brain } = ladeConfigFrisch('0'));
  assert.ok(!config.devPrioAn(), 'dev prio aus');
  assert.strictEqual(config.getRoleSlots('alltag').primary.model, 'google/gemma-4-26b-a4b-it:free');
  assert.strictEqual(config.getRoleSlots('alltag').fallback.model, 'google/gemma-4-26b');
  assert.strictEqual(config.getRoleSlots('arbiter').primary.model, 'z-ai/glm-5.3-flash');
  assert.strictEqual(config.getRoleSlots('nightly').primary.model, 'xiaomi/mimo-v2.6-pro');
  assert.strictEqual(config.getRoleSlots('nightly').fallback.model, 'xiaomi/mimo-v2.6-pro');
  console.log('[routing] live: gemma-free → gemma-paid, glm, mimo exakt');

  // --- 3) Primary → Fallback: 429 auf primary, fallback antwortet gültig ---
  ({ config, brain } = ladeConfigFrisch('0'));
  setzeFetch([{ httpFehler: 429 }, { content: GUELTIG, tokens: 77 }]);
  const d = await brain.decide({
    prompt: 'test', whitelist: ['rest'], apiKey: 'mock-key', role: 'alltag',
  });
  assert.ok(d.ok, 'decide ok via fallback: ' + (d.reason || ''));
  assert.strictEqual(d.usedModel, 'google/gemma-4-26b', 'fallback-modell genutzt, war: ' + d.usedModel);
  assert.strictEqual(d.versuch, 'fallback', 'versuch=fallback');
  assert.strictEqual(d.tokens, 77, 'tokens vom fallback: ' + d.tokens);
  console.log('[routing] fallback-kette ok: 429 → gemma-paid, usedModel + tokens korrekt');

  // --- 4) Kaputtes JSON auf primary → fallback ---
  setzeFetch([{ content: 'kein json {{{', tokens: 10 }, { content: GUELTIG, tokens: 88 }]);
  const d2 = await brain.decide({
    prompt: 'test', whitelist: ['rest'], apiKey: 'mock-key', role: 'alltag',
  });
  assert.ok(d2.ok, 'decide ok via fallback nach kaputtem json');
  assert.strictEqual(d2.usedModel, 'google/gemma-4-26b', 'fallback nach json-fehler');
  console.log('[routing] json-fallback ok: kaputt → fallback mit 88 tokens');

  // --- 5) Dev-Modus nutzt NUR :free (niemals paid) ---
  ({ config, brain } = ladeConfigFrisch('1'));
  const aufrufe = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    aufrufe.push(body.model);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: GUELTIG }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    };
  };
  await brain.decide({ prompt: 't', whitelist: ['rest'], apiKey: 'k', role: 'alltag' });
  await brain.decide({ prompt: 't', whitelist: ['rest'], apiKey: 'k', role: 'arbiter' });
  await brain.decide({ prompt: 't', whitelist: ['rest'], apiKey: 'k', role: 'nightly' });
  assert.ok(aufrufe.length >= 3, '3 rollen-decides');
  for (const m of aufrufe) assert.ok(m.includes(':free'), 'dev-call free, war: ' + m);
  console.log('[routing] dev-calls: ' + [...new Set(aufrufe)].join(', ') + ' (alle :free)');

  // --- 6) Fallback-Badge-Felder: tried + grund bei 429 ---
  ({ config, brain } = ladeConfigFrisch('0'));
  setzeFetch([{ httpFehler: 429 }, { content: GUELTIG, tokens: 33 }]);
  const d3 = await brain.decide({ prompt: 't', whitelist: ['rest'], apiKey: 'k', role: 'arbiter' });
  assert.ok(d3.ok && d3.versuch === 'fallback', 'arbiter-fallback ok');
  assert.ok(d3.tried && d3.tried.includes('glm'), 'tried = arbiter-primary, war: ' + d3.tried);
  assert.strictEqual(d3.grund, '429', 'grund=429, war: ' + d3.grund);
  assert.ok(d3.usedModel.includes('glm'), 'usedModel fallback: ' + d3.usedModel);
  console.log(`[routing] badge-felder ok: tried=${d3.tried} grund=${d3.grund} used=${d3.usedModel} → [not:glm:429] [fallback] [glm]`);

  // --- 7) Doppel-429 (beide free down): grund + grund2, kein Modell ---
  ({ config, brain } = ladeConfigFrisch('1')); // dev: nemotron → gemma-free
  setzeFetch([{ httpFehler: 429 }, { httpFehler: 429 }]);
  const d4 = await brain.decide({ prompt: 't', whitelist: ['rest'], apiKey: 'k', role: 'alltag' });
  assert.ok(!d4.ok && d4.stale && d4.versuch === 'fallback', 'doppel-429 stale, war: ' + JSON.stringify({ ok: d4.ok, versuch: d4.versuch }));
  assert.ok(d4.tried && d4.tried.includes('nemotron'), 'tried = primary, war: ' + d4.tried);
  assert.strictEqual(d4.grund, '429', 'grund=429');
  assert.strictEqual(d4.grund2, '429', 'grund2=429 (fallback auch down), war: ' + d4.grund2);
  console.log(`[routing] doppel-429 ok: tried=${d4.tried} grund=${d4.grund} grund2=${d4.grund2} → [not:nemotron:429] [not:gemma:429] [fallback]`);

  console.log('[routing] ALLES OK');
}

main().catch((err) => { console.error('[routing] FEHLER:', err.message); process.exit(1); });

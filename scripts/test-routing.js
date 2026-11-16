'use strict';
// Routing-Verifikation: model.json ist die einzige Quelle der Wahrheit.
// Getestet: Key-Filter (google-Einträge ohne Key raus), Ketten pro Rolle,
// Primary → Fallback bei 429 / kaputtem JSON, Google-Direct-Erfolg.
// Kein Netz nötig (Mock-fetch). Aufruf: node scripts/test-routing.js

const assert = require('node:assert');

// fetch mocken, BEVOR config/brain geladen werden (config liest model.json beim Import)
function setzeFetch(antworten) {
  let i = 0;
  global.fetch = async (url, opts) => {
    const r = antworten[Math.min(i, antworten.length - 1)];
    i += 1;
    if (r.httpFehler) return { ok: false, status: r.httpFehler, text: async () => 'rate limit' };
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

function ladeConfigFrisch(umgebung = {}) {
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith('src/config.js') || k.endsWith('src/brain.js')) delete require.cache[k];
  }
  delete process.env.AIQUARIUM_DEV; // Schalter existiert nicht mehr – Umgebungsreste weg
  if ('gemini' in umgebung) {
    if (umgebung.gemini) process.env.GEMINI_API_KEY = umgebung.gemini;
    else delete process.env.GEMINI_API_KEY;
  }
  if ('nodeEnv' in umgebung) {
    if (umgebung.nodeEnv) process.env.NODE_ENV = umgebung.nodeEnv;
    else delete process.env.NODE_ENV;
  }
  const config = require('../src/config');
  const brain = require('../src/brain');
  return { config, brain };
}

const GUELTIG = JSON.stringify({ action: 'rest', thought: 'Kurze Pause hier', musing: null });

async function main() {
  // --- 0) Key-lose Basis (NODE_ENV=test): google-Einträge gefiltert, Ketten = model.json ---
  let { config, brain } = ladeConfigFrisch({ gemini: null, nodeEnv: 'test' });
  assert.ok(!config.googleDirektAktiv(), 'google aus ohne key/test');
  // Kein Env-Override mehr: AIQUARIUM_MODEL hat KEINEN Effekt mehr.
  process.env.AIQUARIUM_MODEL = 'boese/ueberschrieben';
  const alltagKette = config.getRoleSlots('alltag').kette;
  delete process.env.AIQUARIUM_MODEL;
  assert.strictEqual(alltagKette[0].model, 'nvidia/nemotron-3-ultra-550b-a55b:free', 'alltag primary = model.json (kein Env-Override)');
  assert.strictEqual(alltagKette[0].reasoningExclude, true, 'alltag nvidia reasoningExclude=true (model.json)');
  assert.ok(alltagKette[1].model.includes('gemma'), 'alltag fallback-1 = model.json Eintrag 2');
  assert.ok(String(config.getRoleSlots('arbiter').primary.model).includes('nemotron'), 'arbiter nvidia (model.json)');
  assert.ok(String(config.getRoleSlots('nightly').primary.model).includes('mimo'), 'nightly mimo (model.json)');
  assert.ok(String(config.getRoleSlots('dev').primary.model).includes(':free'), 'dev free ohne key');
  console.log('[routing] key-los: google gefiltert, ketten = model.json, kein env-override');

  // --- 1) Google-Direct aktiv (AQ-Key, kein Test): google vorne, model.json dahinter ---
  ({ config, brain } = ladeConfigFrisch({ gemini: 'AQ.test-key', nodeEnv: 'dev' }));
  assert.ok(config.googleDirektAktiv(), 'google an mit key');
  assert.strictEqual(config.getRoleSlots('dev').primary.provider, 'google', 'dev primary google');
  assert.strictEqual(config.getRoleSlots('dev').primary.model, 'gemma-4-26b-a4b-it', 'google-modell aus model.json');
  assert.ok(config.getRoleSlots('dev').fallback2, 'dev fallback-2 vorhanden');
  assert.ok(config.getRoleSlots('dev').fallback2.model.includes('nemotron'), 'dev fallback-2 diversifiziert (model.json), war: ' + config.getRoleSlots('dev').fallback2.model);
  assert.strictEqual(config.getRoleSlots('alltag').primary.provider, 'google', 'alltag primary google');
  assert.strictEqual(config.getRoleSlots('arbiter').primary.provider, 'google', 'arbiter primary google');
  assert.strictEqual(config.getRoleSlots('nightly').primary.provider, 'openrouter', 'nightly primary openrouter (kein google-Eintrag mehr in model.json)');
  assert.strictEqual(config.getRoleSlots('nightly').fallback.model, 'xiaomi/mimo-v2.6-pro', 'nightly fallback-1 mimo (model.json)');
  console.log('[routing] mit-key: google vorne, model.json-ketten dahinter');

  // --- 2) decide() nutzt die Kette: primary → fallback bei 429 ---
  ({ config, brain } = ladeConfigFrisch({ gemini: null, nodeEnv: 'test' }));
  setzeFetch([{ httpFehler: 429 }, { content: GUELTIG, tokens: 77 }]);
  const d = await brain.decide({ prompt: 'test', whitelist: ['rest'], apiKey: 'mock-key', role: 'alltag' });
  assert.ok(d.ok && d.versuch === 'fallback', '429 → fallback, war: ' + JSON.stringify({ ok: d.ok, versuch: d.versuch }));
  assert.strictEqual(d.tokens, 77, 'tokens vom fallback nach 429');
  console.log('[routing] 429 → fallback ok (kette eintrag 2)');

  // --- 3) Kaputtes JSON auf primary → fallback ---
  setzeFetch([{ content: 'kein json {{{', tokens: 10 }, { content: GUELTIG, tokens: 88 }]);
  const d2 = await brain.decide({ prompt: 'test', whitelist: ['rest'], apiKey: 'mock-key', role: 'alltag' });
  assert.ok(d2.ok && d2.versuch === 'fallback', 'json-fehler → fallback');
  assert.strictEqual(d2.tokens, 88, 'tokens vom fallback nach json-fehler');
  console.log('[routing] json-fehler → fallback ok');

  // --- 4) Rollen trennen: alltag/arbiter/nightly rufen ihre model.json-Modelle ---
  setzeFetch([
    { content: GUELTIG, tokens: 11 }, { content: GUELTIG, tokens: 22 },
    { content: GUELTIG, tokens: 33 }, { content: GUELTIG, tokens: 44 },
    { content: GUELTIG, tokens: 55 }, { content: GUELTIG, tokens: 66 },
  ]);
  await brain.decide({ prompt: 't', whitelist: ['rest'], apiKey: 'k', role: 'alltag' });
  await brain.decide({ prompt: 't', whitelist: ['rest'], apiKey: 'k', role: 'arbiter' });
  await brain.decide({ prompt: 't', whitelist: ['rest'], apiKey: 'k', role: 'nightly' });
  console.log('[routing] rollen-calls ok (alltag/arbiter/nightly getrennt)');

  // --- 5) Fallback-Badge-Felder: tried + grund bei 429 ---
  setzeFetch([{ httpFehler: 429 }, { content: GUELTIG, tokens: 33 }]);
  const d3 = await brain.decide({ prompt: 't', whitelist: ['rest'], apiKey: 'k', role: 'arbiter' });
  assert.ok(d3.ok && d3.versuch === 'fallback', 'arbiter-fallback ok');
  assert.ok(d3.tried && d3.tried.includes('nemotron'), 'tried = arbiter-primary, war: ' + d3.tried);
  assert.strictEqual(d3.grund, '429', 'grund=429, war: ' + d3.grund);
  console.log('[routing] badge-felder ok: tried=' + d3.tried + ' grund=' + d3.grund + ' → [not:nvidia:429] [fallback]');

  // --- 6) Doppel-429 (beide down): grund + grund2, kein Modell ---
  setzeFetch([{ httpFehler: 429 }, { httpFehler: 429 }, { httpFehler: 429 }]);
  const d4 = await brain.decide({ prompt: 't', whitelist: ['rest'], apiKey: 'k', role: 'alltag' });
  assert.ok(!d4.ok && d4.stale, 'doppel-429 stale, war: ' + JSON.stringify({ ok: d4.ok, versuch: d4.versuch }));
  assert.ok(d4.tried && d4.tried.includes('nemotron'), 'tried = primary, war: ' + d4.tried);
  assert.strictEqual(d4.grund, '429', 'grund=429');
  console.log('[routing] doppel-429 ok: tried=' + d4.tried + ' grund=' + d4.grund + ' grund2=' + d4.grund2);

  // --- 7) Google-primary Erfolg (Mock, kein Netz): provider + tokens ---
  ({ config, brain } = ladeConfigFrisch({ gemini: 'AQ.test-key', nodeEnv: 'dev' }));
  global.fetch = async (url, opts) => {
    assert.ok(String(url).includes('generativelanguage.googleapis.com'), 'ai-studio-url, war: ' + url);
    assert.strictEqual(opts.headers['x-goog-api-key'], 'AQ.test-key', 'api-key per header');
    const body = JSON.parse(opts.body);
    assert.ok(Array.isArray(body.contents), 'google-contents');
    assert.strictEqual(body.generationConfig.responseMimeType, 'application/json', 'json-mode');
    assert.deepStrictEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' }, 'gemma-4 thinking minimal');
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ thought: true, text: 'hmm...' }, { text: GUELTIG }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22, totalTokenCount: 33 },
      }),
    };
  };
  const dg = await brain.decide({ prompt: 'test', whitelist: ['rest'], apiKey: 'mock-key', role: 'alltag' });
  assert.ok(dg.ok && dg.versuch === 'primary', 'google-primary ok, war: ' + JSON.stringify({ ok: dg.ok, versuch: dg.versuch }));
  assert.strictEqual(dg.usedModel, 'gemma-4-26b-a4b-it', 'google-modell, war: ' + dg.usedModel);
  assert.strictEqual(dg.tokens, 22, 'google-tokens, war: ' + dg.tokens);
  assert.ok(String(dg.provider || '').includes('Google Direct'), 'provider google, war: ' + dg.provider);
  console.log('[routing] google-primary ok: provider=' + dg.provider + ' used=' + dg.usedModel + ' tokens=' + dg.tokens + ' → [primary] (Google Direct)');

  // --- 8) rollenTabelle() druckt eine lesbare Übersicht ---
  const tab = config.rollenTabelle();
  assert.ok(tab.includes('alltag') && tab.includes('[google] gemma-4-26b-a4b-it'), 'tabelle listet rollen + modelle');
  console.log('[routing] rollenTabelle ok');

  console.log('[routing] ALLES OK');
}

main().catch((err) => { console.error('[routing] FEHLER:', err.message); process.exit(1); });

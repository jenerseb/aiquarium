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

function ladeConfigFrisch(devWert, umgebung = {}) {
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith('src/config.js') || k.endsWith('src/brain.js')) delete require.cache[k];
  }
  process.env.AIQUARIUM_DEV = devWert;
  if ('gemini' in umgebung) {
    if (umgebung.gemini) process.env.GEMINI_API_KEY = umgebung.gemini;
    else delete process.env.GEMINI_API_KEY;
  }
  if ('nodeEnv' in umgebung) {
    if (umgebung.nodeEnv) process.env.NODE_ENV = umgebung.nodeEnv;
    else delete process.env.NODE_ENV;
  }
  if ('modell' in umgebung) {
    if (umgebung.modell) process.env.GEMINI_MODEL = umgebung.modell;
    else delete process.env.GEMINI_MODEL;
  }
  const config = require('../src/config');
  const brain = require('../src/brain');
  return { config, brain };
}

const GUELTIG = JSON.stringify({ action: 'rest', thought: 'Kurze Pause hier', musing: null });

async function main() {
  // --- 0) Key-lose Basis (NODE_ENV=test): alle Rollen :free, kein Paid ---
  // Hinweis: dev.fallback bewusst :free (Config-Mismatch bereinigt).
  let { config, brain } = ladeConfigFrisch('1', { gemini: null, nodeEnv: 'test', modell: null });
  assert.ok(config.devPrioAn(), 'dev prio an');
  assert.ok(!config.googleDirektAktiv(), 'google aus ohne key/test');
  for (const rolle of ['dev', 'alltag', 'arbiter', 'nightly']) {
    const pair = config.getRoleSlots(rolle);
    assert.ok(String(pair.primary.model).includes(':free'), `${rolle}.primary free, war: ${pair.primary.model}`);
    assert.ok(String(pair.fallback.model).includes(':free'), `${rolle}.fallback free, war: ${pair.fallback.model}`);
    assert.ok(!pair.fallback2, `${rolle} ohne fallback2 ohne key`);
  }
  console.log('[routing] key-los: alle rollen = :free-paare, google aus');

  // --- 1) Google-Direct aktiv (AQ-Key, kein Test): primary = google, OpenRouter dahinter ---
  ({ config, brain } = ladeConfigFrisch('1', { gemini: 'AQ.test-key', nodeEnv: 'dev', modell: 'gemma-4-26b-a4b-it' }));
  assert.ok(config.googleDirektAktiv(), 'google an mit key');
  assert.strictEqual(config.getRoleSlots('dev').primary.provider, 'google', 'dev primary google');
  assert.strictEqual(config.getRoleSlots('dev').primary.model, 'gemma-4-26b-a4b-it', 'dev modell gesaeubert');
  assert.ok(config.getRoleSlots('dev').fallback2, 'dev fallback-2 vorhanden');
  assert.strictEqual(config.getRoleSlots('alltag').primary.provider, 'google', 'alltag primary google');
  assert.strictEqual(config.getRoleSlots('arbiter').primary.provider, 'google', 'arbiter primary google');
  assert.strictEqual(config.getRoleSlots('nightly').primary.provider, 'google', 'nightly primary google');
  assert.strictEqual(config.getRoleSlots('nightly').fallback.model, 'xiaomi/mimo-v2.6-pro', 'nightly fallback-1 mimo');
  // Endpoint-Wahl + Modell-Saeuberung (kein Netz, reine Funktionen)
  const epV = brain.googleEndpoint('google/gemma-4-26b-a4b-it:free', 'AQ.test-key');
  assert.ok(epV.url.includes('aiplatform.googleapis.com'), 'vertex-url fuer AQ, war: ' + epV.url);
  assert.strictEqual(epV.modell, 'gemma-4-26b-a4b-it', 'modell gesaeubert: ' + epV.modell);
  const epS = brain.googleEndpoint('gemini-2.5-flash', 'AIza-test');
  assert.ok(epS.url.includes('generativelanguage.googleapis.com'), 'ai-studio-url fuer AIza');
  console.log('[routing] google-direct: primary ueberall google, endpoint + modell-id ok');

  // --- 2) Live-Modus (AIQUARIUM_DEV=0): Google vorne (Key aus .env), OpenRouter dahinter ---
  ({ config, brain } = ladeConfigFrisch('0', { gemini: 'AQ.test-key', nodeEnv: 'live', modell: 'gemma-4-26b-a4b-it' }));
  assert.ok(config.googleDirektAktiv(), 'google an im live-modus mit key');
  assert.strictEqual(config.getRoleSlots('alltag').primary.provider, 'google', 'alltag primary google');
  assert.strictEqual(config.getRoleSlots('alltag').fallback.model, 'google/gemma-4-26b-a4b-it:free', 'alltag fallback-1 free');
  assert.strictEqual(config.getRoleSlots('alltag').fallback2.model, 'google/gemma-4-26b-it', 'alltag fallback-2 paid');
  assert.strictEqual(config.getRoleSlots('arbiter').primary.provider, 'google', 'arbiter primary google');
  assert.strictEqual(config.getRoleSlots('nightly').primary.provider, 'google', 'nightly primary google');
  assert.strictEqual(config.getRoleSlots('nightly').fallback.model, 'xiaomi/mimo-v2.6-pro', 'nightly fallback-1 mimo');
  assert.ok(!config.devPrioAn(), 'dev prio aus');
 console.log('[routing] live: google vorne, openrouter dahinter'); 

  v

  // --- 3) Primary → Fallback: 429 auf primary, fallback antwortet gültig ---
  ({ config, brain } = ladeConfigFrisch('0', { gemini: None, 'nodeEnv': 'test' }));
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

  // --- 5) Dev-Modus ohne Key nutzt NUR :free (niemals paid) ---
  ({ config, brain } = ladeConfigFrisch('1', { gemini: None, 'nodeEnv': 'test' }));
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
  ({ config, brain } = ladeConfigFrisch('0', { gemini: None, 'nodeEnv': 'test' }));
  setzeFetch([{ httpFehler: 429 }, { content: GUELTIG, tokens: 33 }]);
  const d3 = await brain.decide({ prompt: 't', whitelist: ['rest'], apiKey: 'k', role: 'arbiter' });
  assert.ok(d3.ok && d3.versuch === 'fallback', 'arbiter-fallback ok');
  assert.ok(d3.tried && d3.tried.includes('glm'), 'tried = arbiter-primary, war: ' + d3.tried);
  assert.strictEqual(d3.grund, '429', 'grund=429, war: ' + d3.grund);
  assert.ok(d3.usedModel.includes('glm'), 'usedModel fallback: ' + d3.usedModel);
  console.log(`[routing] badge-felder ok: tried=${d3.tried} grund=${d3.grund} used=${d3.usedModel} → [not:glm:429] [fallback] [glm]`);

  // --- 7) Doppel-429 (beide free down): grund + grund2, kein Modell ---
  ({ config, brain } = ladeConfigFrisch('1', { gemini: None, 'nodeEnv': 'test' })); // dev: :free → :free
  setzeFetch([{ httpFehler: 429 }, { httpFehler: 429 }]);
  const d4 = await brain.decide({ prompt: 't', whitelist: ['rest'], apiKey: 'k', role: 'alltag' });
  assert.ok(!d4.ok && d4.stale && d4.versuch === 'fallback', 'doppel-429 stale, war: ' + JSON.stringify({ ok: d4.ok, versuch: d4.versuch }));
  assert.ok(d4.tried && d4.tried.includes('gemma'), 'tried = primary, war: ' + d4.tried);
  assert.strictEqual(d4.grund, '429', 'grund=429');
  assert.strictEqual(d4.grund2, '429', 'grund2=429 (fallback auch down), war: ' + d4.grund2);
  console.log(`[routing] doppel-429 ok: tried=${d4.tried} grund=${d4.grund} grund2=${d4.grund2} → [not:gemma:429] [not:gemma:429] [fallback]`);

  // --- 8) Google-primary Erfolg (Mock, kein Netz): provider + tokens ---
  ({ config, brain } = ladeConfigFrisch('1', { gemini: 'AQ.test-key', nodeEnv: 'dev', modell: 'gemma-4-26b-a4b-it' }));
  global.fetch = async (url, opts) => {
    assert.ok(String(url).includes('aiplatform.googleapis.com'), 'vertex-url, war: ' + url);
    const body = JSON.parse(opts.body);
    assert.ok(Array.isArray(body.contents), 'google-contents');
    assert.strictEqual(body.generationConfig.responseMimeType, 'application/json', 'json-mode');
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: GUELTIG }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22, totalTokenCount: 33 },
      }),
    };
  };
  const dg = await brain.decide({ prompt: 'test', whitelist: ['rest'], apiKey: 'mock-key', role: 'alltag' });
  assert.ok(dg.ok && dg.versuch === 'primary', 'google-primary ok, war: ' + JSON.stringify({ ok: dg.ok, versuch: dg.versuch }));
  assert.strictEqual(dg.usedModel, 'gemma-4-26b-a4b-it', 'google-modell, war: ' + dg.usedModel);
  assert.strictEqual(dg.tokens, 22, 'google-tokens, war: ' + dg.tokens);
  assert.ok(String(dg.provider || '').includes('Google Direct'), 'provider google, war: ' + dg.provider);
  console.log(`[routing] google-primary ok: provider=${dg.provider} used=${dg.usedModel} tokens=${dg.tokens} → [primary] (Google Direct)`);

  console.log('[routing] ALLES OK');
}

main().catch((err) => { console.error('[routing] FEHLER:', err.message); process.exit(1); });

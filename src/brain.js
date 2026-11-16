'use strict';
// Der einzige Ort, an dem das Modell aufgerufen wird. Timeout, Retry, Validierung.
// Routing (Punkt 2): pro Rolle { primary, fallback } via getRoleSlots(role) –
// zuerst pair.primary, bei HTTP-Fehler (z. B. 429) oder ungültigem JSON
// automatisch pair.fallback. Gibt usedModel + Tokens für den Dev-Feed zurück.
const { validateDecision } = require('./checks');
const { MODEL, getRoleSlots } = require('./config');

const PRICE = { in: 0, out: 0 }; // Free-Tier-Default, Stand 2026-11-13

async function callModel({ prompt, apiKey, baseUrl = MODEL.baseUrl, model = MODEL.name,
  reasoningExclude = MODEL.reasoningExclude, maxTokens = MODEL.maxTokens,
  timeoutMs = MODEL.timeoutMs, temperature = MODEL.temperature }) {
  const started = Date.now();
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      ...(reasoningExclude ? { reasoning: { exclude: true } } : {}),
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  const usage = data?.usage || {};
  const finish = data?.choices?.[0]?.finish_reason ?? data?.choices?.[0]?.native_finish_reason ?? null;
  const cost = (usage.prompt_tokens || 0) * PRICE.in + (usage.completion_tokens || 0) * PRICE.out;
  return { content, usage, cost, latencyMs: Date.now() - started, finish, usedModel: model };
}

// Ein Slot-Versuch: callModel + Validierung. Wirft bei HTTP-Fehler, gibt bei
// ungültigem JSON { ok:false } zurück (Fallback-Kette entscheidet weiter).
async function versucheSlot({ prompt, apiKey, slot, temperature, label, whitelist, recentThoughts, musing, orte, vorhabenAktiv }) {
  const r = await callModel({
    prompt, apiKey, model: slot.model, reasoningExclude: slot.reasoningExclude,
    maxTokens: slot.maxTokens || MODEL.maxTokens, temperature,
  });
  const v = validateDecision(r.content, {
    whitelist,
    recentThoughts,
    maxWords: MODEL.maxWords,
    maxWordsMusing: MODEL.maxWordsMusing,
    jaccardMax: MODEL.jaccardMax,
    exclamationWindow: MODEL.exclamationWindow,
    musing,
    orte,
    vorhabenAktiv,
  });
  const info = {
    usage: r.usage, finish: r.finish, modell: slot.model, usedModel: slot.model,
    versuch: label, tokens: Number(r.usage.completion_tokens) || 0, totalTokens: Number(r.usage.total_tokens) || 0,
  };
  return { v, raw: r.content, info, latencyMs: r.latencyMs, cost: r.cost };
}

/**
 * Entscheidung holen. Nie werfen: bei Fehlschlag kommt { ok:false, stale:true }
 * zurück und die Engine arbeitet mit der letzten Absicht weiter.
 * Rolle: 'alltag' | 'arbiter' | 'nightly' – Slots via getRoleSlots(role).
 */
async function decide(opts) {
  const { prompt, whitelist = [], recentThoughts = [], apiKey, musing = false, orte = [], vorhabenAktiv = false, role = 'alltag' } = opts;
  if (!apiKey) {
    return { ok: false, action: null, thought: '', musing: null, stale: true, reason: 'no_key', failures: ['no_key'] };
  }

  const pair = getRoleSlots(role);
  const attempts = [
    { slot: pair.primary, temperature: opts.temperature ?? MODEL.temperature, label: 'primary' },
    { slot: pair.fallback, temperature: MODEL.retryTemperature, label: 'fallback' },
  ];
  let last = null;
  const total = { latencyMs: 0, cost: 0, calls: 0 };
  let primaryGrund = ''; // womit primary scheiterte (für [not:x:grund]-Badge bei Fallback-Erfolg)
  let primaryTried = ''; // Soll-Modell (primary-Slug, für Doppel-429-Badge)

  for (const a of attempts) {
    let ergebnis;
    try {
      ergebnis = await versucheSlot({
        prompt, apiKey, slot: a.slot, temperature: a.temperature, label: a.label,
        whitelist, recentThoughts, musing, orte, vorhabenAktiv,
      });
    } catch (err) {
      // HTTP-Fehler (429 etc.): nahtlos zum Fallback.
      // tried = Soll-Modell (primary), reason = Kurzgrund (z. B. 429) für [not:x:y]-Badge.
      const m429 = String(err.message || '').match(/HTTP\s+(\d{3})/);
      primaryGrund = m429 ? m429[1] : 'http';
      primaryTried = pair.primary.model;
      last = { ok: false, stale: true, reason: `request: ${err.message}`, failures: ['request'], modell: a.slot.model, usedModel: a.slot.model, versuch: a.label, tried: pair.primary.model, grund: primaryGrund };
      continue;
    }
    total.latencyMs += ergebnis.latencyMs;
    total.cost += ergebnis.cost;
    total.calls += 1;
    const { v, raw, info } = ergebnis;
    // Erfolg via Fallback-Slot: tried = Soll-Modell (primary) für [not:x:y]-Badge mitschleppen
    const infoMitSoll = a.label === 'fallback' && !info.tried
      ? { ...info, tried: pair.primary.model, grund: primaryGrund || 'fallback' }
      : info;
    if (v.ok) return { ...v, stale: false, raw, ...total, ...infoMitSoll };
    // Leere Antwort eigens benennen: „Modell schweigt" ist etwas anderes als Kauderwelsch.
    // tried/gründe für [not:x:y]-Badge mitschleppen (primary war Soll, Validierung schlug fehl).
    const leer = !raw || !raw.trim();
    primaryGrund = leer ? 'leer' : 'json';
    primaryTried = pair.primary.model;
    last = { ...v, stale: true, reason: `checks: ${leer ? 'json_leer' : v.failures.join(',')}`, raw, ...info, tried: pair.primary.model, grund: primaryGrund };
  }
  // BEIDE Slots gescheitert (z. B. beide 429 bei free):
  // tried = primary-Soll, grund = primary-Grund, grund2 = Fallback-Grund.
  if (last && last.versuch === 'fallback') {
    last.tried = pair.primary.model;
    last.grund = primaryGrund || last.grund || 'down';
    const mFb = String(last.reason || '').match(/HTTP\s+(\d{3})/);
    last.grund2 = (mFb && mFb[1]) || last.grund;
  }
  return { ...(last || { ok: false, stale: true, failures: ['unknown'] }), ...total };
}

module.exports = { callModel, decide, PRICE };

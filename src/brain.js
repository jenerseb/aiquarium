'use strict';
// Der einzige Ort, an dem das Modell aufgerufen wird. Timeout, Retry, Validierung.
// Routing: 1) aktiver Slot (dev-Prio) normal, 2) gleicher Slot kühler (retryTemperature),
// 3) Fallback-Slot kühler — erst dann deterministisch + stale.
const { validateDecision } = require('./checks');
const { MODEL, aktiverSlot, fallbackSlot } = require('./config');

const PRICE = { in: 0, out: 0 }; // Free-Tier-Default (Nemotron 3.5 Super VL), Stand 2026-11-13

async function callModel({ prompt, apiKey, baseUrl = MODEL.baseUrl, model = MODEL.name,
  reasoningExclude = MODEL.reasoningExclude,
  timeoutMs = MODEL.timeoutMs, temperature = MODEL.temperature }) {
  const started = Date.now();
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: MODEL.maxTokens,
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
  return { content, usage, cost, latencyMs: Date.now() - started, finish };
}

/**
 * Entscheidung holen. Nie werfen: bei Fehlschlag kommt { ok:false, stale:true }
 * zurück und die Engine arbeitet mit der letzten Absicht weiter.
 */
async function decide(opts) {
  const { prompt, whitelist = [], recentThoughts = [], apiKey, musing = false, orte = [], vorhabenAktiv = false } = opts;
  if (!apiKey) {
    return { ok: false, action: null, thought: '', musing: null, stale: true, reason: 'no_key', failures: ['no_key'] };
  }

  const aktiv = opts.slot || aktiverSlot();
  const fallback = opts.fallbackSlot || fallbackSlot();
  const attempts = [
    { slot: aktiv, temperature: opts.temperature ?? MODEL.temperature, label: 'first' },
    { slot: aktiv, temperature: MODEL.retryTemperature, label: 'retry' },
    { slot: fallback, temperature: MODEL.retryTemperature, label: 'fallback' },
  ];
  let last = null;
  const total = { latencyMs: 0, cost: 0, calls: 0 };

  for (const a of attempts) {
    let raw;
    let info = {};
    try {
      const r = await callModel({
        ...opts, model: a.slot.model, reasoningExclude: a.slot.reasoningExclude,
        temperature: a.temperature,
      });
      total.latencyMs += r.latencyMs;
      total.cost += r.cost;
      total.calls += 1;
      raw = r.content;
      info = { usage: r.usage, finish: r.finish, modell: a.slot.model, versuch: a.label };
    } catch (err) {
      last = { ok: false, stale: true, reason: `request: ${err.message}`, failures: ['request'], modell: a.slot.model, versuch: a.label };
      continue;
    }
    const v = validateDecision(raw, {
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
    if (v.ok) return { ...v, stale: false, raw, ...total, ...info };
    // Leere Antwort eigens benennen: „Modell schweigt" ist etwas anderes als Kauderwelsch
    const leer = !raw || !raw.trim();
    last = { ...v, stale: true, reason: `checks: ${leer ? 'json_leer' : v.failures.join(',')}`, raw, ...info };
  }
  return { ...(last || { ok: false, stale: true, failures: ['unknown'] }), ...total };
}

module.exports = { callModel, decide, PRICE };

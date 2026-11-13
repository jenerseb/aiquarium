'use strict';
// Der einzige Ort, an dem das Modell aufgerufen wird. Timeout, Retry, Validierung.
const { validateDecision } = require('./checks');
const { MODEL } = require('./config');

const PRICE = { in: 0.08e-6, out: 0.10e-6 }; // Gemma 4 26B bei OpenRouter, Stand 2026-11-12

async function callModel({ prompt, apiKey, baseUrl = MODEL.baseUrl, model = MODEL.name,
  timeoutMs = MODEL.timeoutMs, temperature = MODEL.temperature }) {
  const started = Date.now();
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  const usage = data?.usage || {};
  const cost = (usage.prompt_tokens || 0) * PRICE.in + (usage.completion_tokens || 0) * PRICE.out;
  return { content, usage, cost, latencyMs: Date.now() - started };
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

  const attempts = [
    { temperature: opts.temperature ?? MODEL.temperature, label: 'first' },
    { temperature: MODEL.retryTemperature, label: 'retry' },
  ];
  let last = null;
  const total = { latencyMs: 0, cost: 0, calls: 0 };

  for (const a of attempts) {
    let raw;
    try {
      const r = await callModel({ ...opts, temperature: a.temperature });
      total.latencyMs += r.latencyMs;
      total.cost += r.cost;
      total.calls += 1;
      raw = r.content;
    } catch (err) {
      last = { ok: false, stale: true, reason: `request: ${err.message}`, failures: ['request'] };
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
    if (v.ok) return { ...v, stale: false, raw, ...total };
    // Leere Antwort eigens benennen: „Modell schweigt" ist etwas anderes als Kauderwelsch
    const leer = !raw || !raw.trim();
    last = { ...v, stale: true, reason: `checks: ${leer ? 'json_leer' : v.failures.join(',')}`, raw };
  }
  return { ...(last || { ok: false, stale: true, failures: ['unknown'] }), ...total };
}

module.exports = { callModel, decide, PRICE };

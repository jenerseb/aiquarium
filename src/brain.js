'use strict';
// Der einzige Ort, an dem das Modell aufgerufen wird. Timeout, Retry, Validierung.
// Routing (Punkt 2): pro Rolle { primary, fallback } via getRoleSlots(role) –
// zuerst pair.primary, bei HTTP-Fehler (z. B. 429) oder ungültigem JSON
// automatisch pair.fallback. Gibt usedModel + Tokens für den Dev-Feed zurück.
const { validateDecision, validatePlan } = require('./checks');
const { MODEL, getRoleSlots } = require('./config');

const PRICE = { in: 0, out: 0 }; // Free-Tier-Default, Stand 2026-11-13

async function callModel({ prompt, apiKey, baseUrl = MODEL.baseUrl, model = MODEL.name,
  reasoningExclude = MODEL.reasoningExclude, maxTokens = MODEL.maxTokens,
  timeoutMs = MODEL.timeoutMs, temperature = MODEL.temperature }) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(baseUrl, {
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
  } catch (err) {
    // Timeout / Abort: als http-Code 'timeout' weiterreichen, damit decide() daraus ein Debug-Objekt baut
    const istTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted|abgebrochen/i.test(String(err.message || '')));
    const code = istTimeout ? 'timeout' : 'http';
    const meldung = istTimeout ? `Timeout nach ${timeoutMs} ms (AbortSignal.timeout)` : String((err && err.message) || err);
    throw Object.assign(new Error(`${code === 'timeout' ? 'Timeout' : 'HTTP'}: ${meldung}`), { _debugCode: code, _modell: model });
  }
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { body = ''; }
    const gekuerzt = String(body || '').slice(0, 500);
    const fehler = new Error(`HTTP ${res.status}: ${gekuerzt}`);
    // Status + gekürzten Body mitschleppen (Debug-Objekt in decide())
    fehler._debugCode = 'http';
    fehler._httpStatus = res.status;
    fehler._httpBody = body;
    fehler._modell = model;
    throw fehler;
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  const usage = data?.usage || {};
  const finish = data?.choices?.[0]?.finish_reason ?? data?.choices?.[0]?.native_finish_reason ?? null;
  const cost = (usage.prompt_tokens || 0) * PRICE.in + (usage.completion_tokens || 0) * PRICE.out;
  return { content, usage, cost, latencyMs: Date.now() - started, finish, usedModel: model };
}

// Strukturiertes Debug-Objekt pro Fehlversuch (Dev-/Debug-Modus):
// { code, reason, rawResponse, model, tier }. Code: 'http' | 'timeout' | 'json' | 'whitelist' | 'empty' | 'schema'
function debugAusHttpFehler(err, slot, tier) {
  const status = err && err._httpStatus ? Number(err._httpStatus) : null;
  const code = (err && err._debugCode) || 'http';
  const body = err && typeof err._httpBody === 'string' ? err._httpBody : '';
  const meldung = body ? String(err.message || '') : String((err && err.message) || 'unbekannt');
  const reason = status
    ? `HTTP ${status}: Provider meldet „${body.slice(0, 300) || meldung.slice(0, 300)}" – Anfrage an ${slot.model} verworfen.`
    : String(err.message || 'Netz-/HTTP-Fehler');
  return { code, reason, rawResponse: body || '', model: slot.model, tier };
}

function debugAusValidierung(v, raw, slot, tier) {
  // Erstes Detail ist die exakte Ursache (checks.js liefert reason + rawResponse)
  const details = Array.isArray(v.fehlerDetails) ? v.fehlerDetails : [];
  const erstes = details[0] || null;
  const code = (erstes && erstes.code) || ((v.failures || [])[0] === 'whitelist' ? 'whitelist' : 'schema');
  const reason = (erstes && erstes.reason) || `Validierung schlug fehl: ${(v.failures || []).join(', ') || 'unbekannt'}.`;
  return { code, reason, rawResponse: typeof raw === 'string' ? raw : JSON.stringify(raw ?? null), model: slot.model, tier, feld: erstes && erstes.feld, wert: erstes && erstes.wert, erlaubt: erstes && erstes.erlaubt };
}

// Ein Slot-Versuch: callModel + Validierung. Wirft bei HTTP-Fehler, gibt bei
// ungültigem JSON { ok:false } zurück (Fallback-Kette entscheidet weiter).
// Hängt pro Fehlversuch ein Debug-Objekt an (versuchDebug).
// schema: 'decision' (default, {action,thought}) oder 'plan' ({thought,plan[]}) –
async function versucheSlot({ prompt, apiKey, slot, temperature, label, whitelist, recentThoughts, musing, orte, vorhabenAktiv, schema = 'decision' }) {
  const r = await callModel({
    prompt, apiKey, model: slot.model, reasoningExclude: slot.reasoningExclude,
    maxTokens: slot.maxTokens || MODEL.maxTokens, temperature,
  });
  let v;
  if (schema === 'plan') {
    // Plan-Schema: einzelne Schritte in parsed.plan prüfen (step.action/step.target),
    // echte Whitelist aus buildPrompt() (ENGINE übergibt gebaut.whitelist).
    const erlaubt = Array.isArray(whitelist) && whitelist.length > 0 ? whitelist : null;
    let obj = null;
    try { obj = JSON.parse(r.content); } catch { obj = null; }
    if (!obj || typeof obj !== 'object') {
      try { JSON.parse(r.content); } catch (err) {
        const { jsonFehlerGrund } = require('./checks');
        v = { ok: false, failures: ['json'], fehlerDetails: [{ code: 'json', reason: jsonFehlerGrund(r.content, err), rawResponse: r.content }] };
      }
      if (!v) v = { ok: false, failures: ['json'], fehlerDetails: [{ code: 'json', reason: 'Antwort ist kein Objekt.', rawResponse: r.content }] };
    } else {
      v = validatePlan(obj, { intents: erlaubt, raw: r.content, orte: Array.isArray(orte) ? orte : [] });
    }
  } else {
    v = validateDecision(r.content, {
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
  }
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
  const { prompt, whitelist = [], recentThoughts = [], apiKey, musing = false, orte = [], vorhabenAktiv = false, role = 'alltag', schema = 'decision' } = opts;
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
  let primaryDebug = null; // strukturiertes Debug des primary-Fehlversuchs (für Terminal + UI)

  for (const a of attempts) {
    let ergebnis;
    try {
      ergebnis = await versucheSlot({
        prompt, apiKey, slot: a.slot, temperature: a.temperature, label: a.label,
        whitelist, recentThoughts, musing, orte, vorhabenAktiv, schema,
      });
    } catch (err) {
      // HTTP-Fehler (429 etc.): nahtlos zum Fallback.
      // tried = Soll-Modell (primary), reason = Kurzgrund (z. B. 429) für [not:x:y]-Badge.
      const m429 = String(err.message || '').match(/HTTP\s+(\d{3})/);
      const mTimeout = /timeout/i.test(String(err.message || ''));
      primaryGrund = m429 ? m429[1] : (mTimeout ? 'timeout' : 'http');
      primaryTried = pair.primary.model;
      const dbg = debugAusHttpFehler(err, a.slot, a.label);
      if (!primaryDebug) primaryDebug = dbg;
      last = { ok: false, stale: true, reason: `request: ${err.message}`, failures: ['request'], modell: a.slot.model, usedModel: a.slot.model, versuch: a.label, tried: pair.primary.model, grund: primaryGrund, debug: dbg, versuchDebug: [dbg] };
      if (a.label === 'fallback') last.debugFallback = dbg;
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
    if (v.ok) {
      // Fallback-Erfolg: primary-Debug (exakte Ursache + rawResponse) mitschleppen, damit UI/Terminal sie zeigen kann
      if (a.label === 'fallback' && primaryDebug) {
        infoMitSoll.debug = primaryDebug;
      }
      return { ...v, stale: false, raw, ...total, ...infoMitSoll };
    }
    // Leere Antwort eigens benennen: „Modell schweigt" ist etwas anderes als Kauderwelsch.
    // tried/gründe für [not:x:y]-Badge mitschleppen (primary war Soll, Validierung schlug fehl).
    const leer = !raw || !raw.trim();
    primaryGrund = leer ? 'leer' : 'json';
    // Exakter Validierungs-Code fürs Badge: whitelist/json/empty statt immer 'json'
    try {
      const det0 = Array.isArray(v.fehlerDetails) && v.fehlerDetails[0] ? v.fehlerDetails[0] : null;
      primaryGrund = (det0 && det0.code) || (leer ? 'empty' : primaryGrund);
    } catch { /* Badge-Grund bleibt heuristisch */ }
    primaryTried = pair.primary.model;
    const dbgV = debugAusValidierung(v, raw, a.slot, a.label);
    if (!primaryDebug) primaryDebug = dbgV;
    last = { ...v, stale: true, reason: `checks: ${leer ? 'json_leer' : v.failures.join(',')}`, raw, ...info, tried: pair.primary.model, grund: primaryGrund, debug: dbgV, versuchDebug: [dbgV] };
    if (a.label === 'fallback') last.debugFallback = dbgV;
  }
  // BEIDE Slots gescheitert (z. B. beide 429 bei free):
  // tried = primary-Soll, grund = primary-Grund, grund2 = Fallback-Grund.
  if (last && last.versuch === 'fallback') {
    last.tried = pair.primary.model;
    last.grund = primaryGrund || last.grund || 'down';
    const mFb = String(last.reason || '').match(/HTTP\s+(\d{3})/);
    last.grund2 = (mFb && mFb[1]) || last.grund;
  }
  if (last && Array.isArray(last.versuchDebug) && last.debugFallback && last.debug && last.debug !== last.debugFallback) {
    // beide Debugs (primary + fallback) fürs UI mitschleppen
    last.versuchDebug = [last.debug, last.debugFallback].filter(Boolean);
  }
  return { ...(last || { ok: false, stale: true, failures: ['unknown'] }), ...total };
}

module.exports = { callModel, decide, PRICE, debugAusHttpFehler, debugAusValidierung };

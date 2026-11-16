'use strict';
// Der einzige Ort, an dem das Modell aufgerufen wird. Timeout, Retry, Validierung.
// Routing (Punkt 2): pro Rolle { primary, fallback } via getRoleSlots(role) –
// zuerst pair.primary, bei HTTP-Fehler (z. B. 429) oder ungültigem JSON
// automatisch pair.fallback. Gibt usedModel + Tokens für den Dev-Feed zurück.
const { validateDecision, validatePlan } = require('./checks');
const { MODEL, GEMINI, getRoleSlots } = require('./config');

const PRICE = { in: 0, out: 0 }; // Free-Tier-Default, Stand 2026-11-13

// ---- Google-Direct (eigener GEMINI_API_KEY, kein OpenRouter-BYOK) ----
// Standard: immer AI Studio (generativelanguage) mit x-goog-api-key-Header –
// AQ.-Keys funktionieren dort direkt (Curl: HTTP 200). Vertex nur Opt-in.
function googleModellIdAufraeumen(modell) {
  return String(modell || '').replace(/^google\//, '').replace(/:free$/, '');
}

function googleEndpoint(modellId, apiKey) {
  const id = googleModellIdAufraeumen(modellId);
  void apiKey;
  if (String(process.env.GOOGLE_VERTEX || '') === '1') {
    return { url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${id}:generateContent`, viaHeader: false, label: 'Google Direct (Vertex)', modell: id };
  }
  return { url: `https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`, viaHeader: true, label: 'Google Direct (AI Studio)', modell: id };
}

// Thinking je Modellfamilie (exakte Werte, sonst 400 INVALID_ARGUMENT):
// gemma-4* / gemini-3* -> minimal (nur 'minimal'/'high' erlaubt), gemini-2.5* -> Budget 0.
function googleThinkingFuer(modellId) {
  const id = String(modellId || '').toLowerCase();
  if (id.startsWith('gemma-4') || id.startsWith('gemini-3')) return { thinkingLevel: 'minimal' };
  if (id.startsWith('gemini-2.5')) return { thinkingBudget: 0 };
  return null;
}

// Direkter Google-Call mit OpenAI-kompatibler Antwort-Form (content/usage/usedModel).
// messages: [{ role, content }] – system → systemInstruction, assistant → model, Rest → user.
async function callGoogleDirect({ model, messages, temperature = MODEL.temperature, maxTokens = MODEL.maxTokens, jsonMode = true, timeoutMs = MODEL.timeoutMs, apiKey }) {
  const started = Date.now();
  const key = String(apiKey || (GEMINI && GEMINI.apiKey) || '').trim();
  if (!key) throw Object.assign(new Error('HTTP: GEMINI_API_KEY fehlt'), { _debugCode: 'http', _modell: model });
  const { url, viaHeader, label, modell } = googleEndpoint(model, key);
  const thinking = googleThinkingFuer(modell);
  const systemTexte = (messages || []).filter((m) => m.role === 'system').map((m) => String(m.content || ''));
  const inhalte = (messages || []).filter((m) => m.role !== 'system').map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }],
  }));
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(viaHeader ? { 'x-goog-api-key': key } : {}) },
      body: JSON.stringify({
        ...(systemTexte.length ? { systemInstruction: { parts: [{ text: systemTexte.join('\n') }] } } : {}),
        contents: inhalte.length ? inhalte : [{ role: 'user', parts: [{ text: '' }] }],
        generationConfig: { temperature, maxOutputTokens: maxTokens, ...(jsonMode ? { responseMimeType: 'application/json' } : {}), ...(thinking ? { thinkingConfig: thinking } : {}) },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const istTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted|abgebrochen/i.test(String(err.message || '')));
    const code = istTimeout ? 'timeout' : 'http';
    const meldung = istTimeout ? `Timeout nach ${timeoutMs} ms (AbortSignal.timeout)` : String((err && err.message) || err);
    throw Object.assign(new Error(`${code === 'timeout' ? 'Timeout' : 'HTTP'}: ${meldung}`), { _debugCode: code, _modell: modell });
  }
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { body = ''; }
    const fehler = new Error(`HTTP ${res.status}: ${String(body || '').slice(0, 500)}`);
    fehler._debugCode = 'http';
    fehler._httpStatus = res.status;
    fehler._httpBody = body;
    fehler._modell = modell;
    throw fehler;
  }
  const data = await res.json();
  // Text aus ALLEN Nicht-Thinking-Parts (Gemma 4: parts[0] = thought, parts[1] = JSON).
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const textTeile = parts.filter((p) => p && p.thought !== true && typeof p.text === 'string' && p.text.length > 0).map((p) => p.text);
  let content = textTeile.length > 0 ? textTeile.join('') : ((parts.find((p) => p && typeof p.text === 'string') || {}).text ?? '');
  const finishReason = data?.candidates?.[0]?.finishReason || null;
  const blockReason = data?.promptFeedback?.blockReason || null;
  // Fix Leer-Antwort: bei HTTP 200 + leerem Text den echten Grund ins Debug schreiben
  // (SAFETY / MAX_TOKENS / Modell unbekannt / Thought-only) + gekuerzte Roh-JSON.
  let leerGrund = '';
  if (!content || !String(content).trim()) {
    const stich = [];
    if (finishReason) stich.push(`finishReason=${finishReason}`);
    if (blockReason) stich.push(`blockReason=${blockReason}`);
    const thoughtNur = parts.length > 0 && parts.every((p) => p.thought === true);
    if (thoughtNur) stich.push('nur Thought-Parts (Thinking ohne Text)');
    else if (parts.length > 0) stich.push(`${parts.length} Parts, aber kein Text-Part`);
    else stich.push('keine Parts');
    if (finishReason === 'MAX_TOKENS') stich.push('Hinweis: maxTokens erhoehen oder Reasoning-Budget pruefen');
    let roh = '';
    try { roh = JSON.stringify(data).slice(0, 500); } catch { roh = ''; }
    leerGrund = `Leere Antwort trotz HTTP 200 (${stich.join(', ')}). Roh-JSON: ${roh}`;
  }
  const meta = data?.usageMetadata || {};
  const usage = {
    prompt_tokens: Number(meta.promptTokenCount) || 0,
    completion_tokens: Number(meta.candidatesTokenCount) || 0,
    total_tokens: Number(meta.totalTokenCount) || 0,
  };
  const cost = usage.prompt_tokens * PRICE.in + usage.completion_tokens * PRICE.out;
  return { content, usage, cost, latencyMs: Date.now() - started, finish: finishReason, usedModel: modell, providerLabel: label, leerGrund };
}

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
  // Fix 429-im-200: OpenRouter liefert Fehler teils mit HTTP 200 + {error}-Body.
  // Ohne verwertbaren content als HTTP-Fehler werten (statt Schema-Fehlalarm).
  const errBody = data && typeof data === 'object' ? data.error : null;
  let content = data?.choices?.[0]?.message?.content ?? '';
  // Fix Fehler-JSON im content-String: OpenRouter schickt {"error":{code:429}} teils
  // als String in choices[0].message.content (HTTP 200). Ohne verwertbaren Text
  // als HTTP-Fehler werten (Kette läuft weiter), statt Schema-Fehlalarm.
  const _errAusContent = (() => {
    const s = typeof content === 'string' ? content.trim().replace(/^﻿/, '') : '';
    if (!s.startsWith('{"error"') && !s.startsWith('{ "error"') && !s.startsWith('{')) return null;
    try {
      const o = JSON.parse(s);
      return o && o.error ? o.error : null;
    } catch { return null; }
  })();
  const _restText = (() => {
    if (!_errAusContent) return (typeof content === 'string' ? content.trim() : '');
    try {
      const o = JSON.parse(content.trim());
      const rest = { ...o };
      delete rest.error;
      const txt = rest.choices?.[0]?.message?.content || rest.content || '';
      return String(txt || '').trim();
    } catch { return ''; }
  })();
  if ((_errAusContent && !_restText) || (errBody && !content)) {
    const code = Number((_errAusContent && _errAusContent.code) || (errBody && errBody.code)) || 429;
    const body = (() => { try { return JSON.stringify(data).slice(0, 500); } catch { return String(data).slice(0, 500); } })();
    const fehler = new Error(`HTTP ${code}: ${body}`);
    fehler._debugCode = 'http';
    fehler._httpStatus = code;
    fehler._httpBody = (() => { try { return JSON.stringify(data); } catch { return body; } })();
    fehler._modell = model;
    throw fehler;
  }
  const finish = data?.choices?.[0]?.finish_reason ?? data?.choices?.[0]?.native_finish_reason ?? null;
  // Fix Leer-Antwort (OpenRouter): Reasoning-Text statt content -> finish + Hinweis loggen.
  let leerGrund = '';
  if (!content || !String(content).trim()) {
    const reasoning = data?.choices?.[0]?.message?.reasoning
      ?? data?.choices?.[0]?.message?.reasoning_content ?? '';
    const stich = [`finish=${finish ?? '?'}`];
    if (reasoning && String(reasoning).length > 0) {
      stich.push(`reasoning ${String(reasoning).length} Zeichen, aber content leer (volles Reasoning-Budget? Modell ohne sichtbaren Output oder max_tokens zu klein)`);
    } else {
      stich.push('kein content, kein reasoning');
    }
    let roh = '';
    try { roh = JSON.stringify(data).slice(0, 500); } catch { roh = ''; }
    leerGrund = `Leere OpenRouter-Antwort trotz HTTP 200 (${stich.join(', ')}). Roh-JSON: ${roh}`;
  }
  const usage = data?.usage || {};
  const cost = (usage.prompt_tokens || 0) * PRICE.in + (usage.completion_tokens || 0) * PRICE.out;
  return { content, usage, cost, latencyMs: Date.now() - started, finish, usedModel: model, leerGrund };
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
  // Fix 2: tier + versuch aus Slot-Label, providerLabel durchreichen (Google Direct sichtbar)
  return { code, reason, rawResponse: body || '', model: slot.model, tier, versuch: tier, provider: slot.provider || 'openrouter', providerLabel: slot.providerLabel };
}

function debugAusValidierung(v, raw, slot, tier) {
  // Erstes Detail ist die exakte Ursache (checks.js liefert reason + rawResponse)
  const details = Array.isArray(v.fehlerDetails) ? v.fehlerDetails : [];
  const erstes = details[0] || null;
  const code = (erstes && erstes.code) || ((v.failures || [])[0] === 'whitelist' ? 'whitelist' : 'schema');
  const reason = (erstes && erstes.reason) || `Validierung schlug fehl: ${(v.failures || []).join(', ') || 'unbekannt'}.`;
  // Fix 2: tier immer aus Slot-Label, rawResponse nie 'null'/'undefined' (sonst '?' ohne Roh-Antwort)
  const roh = typeof raw === 'string' ? raw : (raw == null ? '' : JSON.stringify(raw ?? null));
  return { code, reason, rawResponse: roh, model: slot.model, tier, versuch: tier, provider: slot.provider || 'openrouter', providerLabel: slot.providerLabel, feld: erstes && erstes.feld, wert: erstes && erstes.wert, erlaubt: erstes && erstes.erlaubt };
}

// Ein Slot-Versuch: Provider-Call (google | openrouter) + Validierung.
// Wirft bei HTTP-Fehler, gibt bei ungültigem JSON { ok:false } zurück
// (Fallback-Kette entscheidet weiter). Hängt pro Fehlversuch ein
// Debug-Objekt an (versuchDebug).
// schema: 'decision' (default, {action,thought}) oder 'plan' ({thought,plan[]}) –
async function versucheSlot({ prompt, apiKey, slot, temperature, label, whitelist, recentThoughts, musing, orte, vorhabenAktiv, schema = 'decision', geminiKey }) {
  const istGoogle = slot && slot.provider === 'google';
  const r = istGoogle
    ? await callGoogleDirect({
      model: slot.model, temperature,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: slot.maxTokens || MODEL.maxTokens,
      jsonMode: true, timeoutMs: MODEL.timeoutMs,
      apiKey: geminiKey || (GEMINI && GEMINI.apiKey),
    })
    : await callModel({
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
    usage: r.usage, finish: r.finish, modell: slot.model, usedModel: r.usedModel || slot.model,
    versuch: label, tokens: Number(r.usage.completion_tokens) || 0, totalTokens: Number(r.usage.total_tokens) || 0,
    provider: istGoogle ? (r.providerLabel || 'Google Direct') : 'OpenRouter',
    providerLabel: istGoogle ? (r.providerLabel || 'Google Direct') : undefined,
  };
  // Fix Leer-Antwort: leerGrund (finishReason/blockReason/reasoning-Hinweis) als raw-Ersatz
  // mitgeben, damit thought_leer/plan_fehlend nie ohne Grund dastehen.
  const rohText = (typeof r.content === 'string' && r.content) ? r.content : (r.leerGrund || r.content || '');
  // Fix Primary-Debug: Eigen-Debug je Versuch (Google-Status/finishReason sichtbar),
  // auch bei Erfolg – decide() akkumuliert daraus die Kette.
  const eigenDbg = { code: (v.ok ? 'ok' : ((v.fehlerDetails && v.fehlerDetails[0] && v.fehlerDetails[0].code) || 'schema')), reason: (v.ok ? ('OK via ' + label) : ((v.fehlerDetails && v.fehlerDetails[0] && v.fehlerDetails[0].reason) || ('Validierung: ' + (v.failures || []).join(',')))), rawResponse: rohText, model: slot.model, tier: label, versuch: label, provider: slot.provider || 'openrouter', providerLabel: slot.providerLabel || info.providerLabel };
  return { v, raw: rohText, info, latencyMs: r.latencyMs, cost: r.cost, debugInfo: eigenDbg };
}

/**
 * Entscheidung holen. Nie werfen: bei Fehlschlag kommt { ok:false, stale:true }
 * zurück und die Engine arbeitet mit der letzten Absicht weiter.
 * Rolle: 'alltag' | 'arbiter' | 'nightly' – Slots via getRoleSlots(role).
 */
async function decide(opts) {
  const { prompt, whitelist = [], recentThoughts = [], apiKey, musing = false, orte = [], vorhabenAktiv = false, role = 'alltag', schema = 'decision' } = opts;
  const pair = getRoleSlots(role);
  if (!pair || !pair.primary) {
    return { ok: false, action: null, thought: '', musing: null, stale: true, reason: 'kein_modell_konfiguriert', failures: ['kein_modell_konfiguriert'] };
  }
  const brauchtOpenRouter = [pair.primary, pair.fallback, pair.fallback2].filter(Boolean).some((s) => s.provider !== 'google');
  const hatGoogleKey = Boolean((GEMINI && GEMINI.apiKey) || opts.geminiKey);
  if (!apiKey && (brauchtOpenRouter || !hatGoogleKey)) {
    return { ok: false, action: null, thought: '', musing: null, stale: true, reason: 'no_key', failures: ['no_key'] };
  }

  // Kette: Alle Einträge aus model.json der Reihe nach (primary, fallback, fallback-2…).
  // Nur vorhandene Einträge werden Versuche — null-Einträge (Key-Filter) entfallen.
  const attempts = (pair.kette && pair.kette.length > 0 ? pair.kette : [pair.primary, pair.fallback, pair.fallback2])
    .filter(Boolean)
    .map((slot, i) => ({
      slot,
      temperature: i === 0 ? (opts.temperature ?? MODEL.temperature) : MODEL.retryTemperature,
      label: i === 0 ? 'primary' : (i === 1 ? 'fallback' : 'fallback-' + i),
    }));
  if (attempts.length === 0) {
    return { ok: false, action: null, thought: '', musing: null, stale: true, reason: 'kein_modell_konfiguriert', failures: ['kein_modell_konfiguriert'] };
  }
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
        whitelist, recentThoughts, musing, orte, vorhabenAktiv, schema, geminiKey: opts.geminiKey,
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
      // Fix 2: Versuche akkumulieren (429 + Schema-Fehler beide sichtbar), nicht ersetzen
      const bisherH = Array.isArray(last && last.versuchDebug) ? last.versuchDebug.filter(Boolean) : [];
      last = { ok: false, stale: true, reason: `request: ${err.message}`, failures: ['request'], modell: a.slot.model, usedModel: a.slot.model, versuch: a.label, tried: pair.primary.model, grund: primaryGrund, debug: dbg, versuchDebug: [...bisherH, dbg] };
      if (a.label === 'fallback') last.debugFallback = dbg;
      if (a.label === 'fallback-2') last.debugFallback2 = dbg;
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
      // Fix Primary-Debug: Google-primary immer mitschleppen (Erfolg wie Fehlschlag),
      // damit im Log sofort sichtbar ist, was gemini-2.5-flash-lite zurückliefert.
      // versuchDebug akkumulieren: alle Versuche (primary + fallback-1/-2) sichtbar.
      const bisherOk = Array.isArray(last && last.versuchDebug) ? last.versuchDebug.filter(Boolean) : [];
      const eigenDbg = (ergebnis && ergebnis.debugInfo) ? ergebnis.debugInfo : null;
      const kette = [...bisherOk];
      if (eigenDbg) kette.push(eigenDbg);
      else if (primaryDebug && a.label !== 'primary') kette.unshift(primaryDebug);
      if (a.label !== 'primary' && primaryDebug) {
        infoMitSoll.debug = primaryDebug;
      }
      if (kette.length) infoMitSoll.versuchDebug = kette;
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
    // Fix 2: Versuche akkumulieren (429 + Schema-Fehler beide sichtbar), nicht ersetzen
    const bisher = Array.isArray(last && last.versuchDebug) ? last.versuchDebug.filter(Boolean) : [];
    last = { ...v, stale: true, reason: `checks: ${leer ? 'json_leer' : v.failures.join(',')}`, raw, ...info, tried: pair.primary.model, grund: primaryGrund, debug: dbgV, versuchDebug: [...bisher, dbgV] };
    if (a.label === 'fallback') last.debugFallback = dbgV;
    if (a.label === 'fallback-2') last.debugFallback2 = dbgV;
  }
  // BEIDE Slots gescheitert (z. B. beide 429 bei free):
  // tried = primary-Soll, grund = primary-Grund, grund2 = Fallback-Grund.
  if (last && last.versuch === 'fallback') {
    last.tried = pair.primary.model;
    last.grund = primaryGrund || last.grund || 'down';
    const mFb = String(last.reason || '').match(/HTTP\s+(\d{3})/);
    last.grund2 = (mFb && mFb[1]) || last.grund;
  }
  if (last && Array.isArray(last.versuchDebug) && last.debug && last.debug !== last.debugFallback) {
    // Fix 2: alle Debugs (primary + fallback + fallback-2) fürs UI mitschleppen, dedupliziert
    const alle = [last.debug, last.debugFallback, last.debugFallback2, ...(last.versuchDebug || [])].filter(Boolean);
    const gesehen = new Set();
    last.versuchDebug = alle.filter((d) => {
      const k = `${d.model}|${d.code}|${d.reason}`;
      if (gesehen.has(k)) return false;
      gesehen.add(k);
      return true;
    });
  }
  return { ...(last || { ok: false, stale: true, failures: ['unknown'] }), ...total };
}

module.exports = { callModel, callGoogleDirect, decide, PRICE, debugAusHttpFehler, debugAusValidierung, googleEndpoint, googleThinkingFuer, googleModellIdAufraeumen };

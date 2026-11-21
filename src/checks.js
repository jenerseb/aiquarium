'use strict';
// Post-Checks aus §6 des Plans. Reine Funktionen, damit sie ohne Modell testbar sind.
// Neu: Motiv-Quota (Wiederholung von Bildern) und Zusatzgedanken (Musing).

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

// Absichtlich konservativ: nur Wörter, die im Deutschen nicht vorkommen.
const ENGLISH = [
  'the', 'and', 'with', 'you', 'your', 'are', 'were', 'have', 'has',
  'need', 'want', 'look', 'feel', 'food', 'sleep', 'afraid', 'tired', 'very',
  'please', 'because', 'from', 'they', 'them', 'there', 'this', 'that', 'should',
  'would', 'could', 'much', 'more', 'just', 'again', 'something', 'nothing',
];

function words(text) {
  return String(text || '').toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function wordCount(text) {
  return words(text).length;
}

function hasCJK(text) {
  return CJK.test(String(text || ''));
}

function englishHits(text) {
  const set = new Set(words(text));
  return ENGLISH.filter((w) => set.has(w));
}

function jaccard(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function maxSimilarity(text, recent = []) {
  let max = 0;
  for (const r of recent) max = Math.max(max, jaccard(text, r));
  return max;
}

function hasRecentExclamation(recent = [], window = 5) {
  return recent.slice(0, window).some((t) => String(t).includes('!'));
}

// Paket A: Bedürfnis-Bremse — benennt der Gedanke nur das laufende Bedürfnis
// („der Körper ist leer", „ich muss schlafen"), während ein Vorhaben dazu
// aktiv ist, wird verworfen und neu gefragt. Das Vorhaben steht, der Weg zählt.
const BEDUERFNIS_SAETZE = [
  'körper ist leer', 'magen ist leer', 'bauch ist leer', 'muss essen',
  'muss etwas essen', 'muss schlafen', 'muss mich ausruhen', 'bin müde',
  'bin so müde', 'brauche schlaf', 'brauche ruhe', 'körper braucht',
];

function benenntNurBeduerfnis(thought) {
  // Umlaute normalisieren (oe→ö etc.), damit „Koerper" und „Körper" matchen
  const t = String(thought || '').toLowerCase()
    .replace(/ae/g, 'ä').replace(/oe/g, 'ö').replace(/ue/g, 'ü');
  return BEDUERFNIS_SAETZE.some((s) => t.includes(s));
}
// Paket B-Rest: Musterbremse „Objekt-Eröffnung" — beginnt der Gedanke mit
// einem Ortsnamen (aus OBJECT_HINTS) und war das in 3 der letzten 4 Gedanken
// auch so, wird verworfen. Fängt die Schablone „Das X …" von innen.
function beginntMitOrt(thought, orte = []) {
  const worte = words(thought).slice(0, 3).map((w) => w.toLowerCase());
  return orte.some((o) => {
    const oName = String(o || '').toLowerCase();
    return oName && worte.some((w) => w.startsWith(oName.slice(0, 4)) || (w.length >= 4 && oName.startsWith(w)));
  });
}

function hatObjektEroeffnung(thought, recent = [], orte = []) {
  if (!beginntMitOrt(thought, orte)) return false;
  const letzte4 = recent.slice(0, 4);
  if (letzte4.length < 3) return false;
  const mitOrt = letzte4.filter((t) => beginntMitOrt(t, orte)).length;
  return mitOrt >= 3;
}

// --- Strukturierte Fehler-Diagnose (Dev-/Debug-Modus) ---------------------------
// Jedes Detail: { code, reason, feld?, wert?, erlaubt?, rawResponse? }
// code: 'http' | 'timeout' | 'json' | 'whitelist' | 'empty' | 'schema' | ...
function kontextHinweis(raw) {
  const s = String(raw || '');
  if (s.includes('```')) return ' (Markdown-Codeblock nicht entfernt)';
  if (/^\s*```json/i.test(s)) return ' (Markdown-Codeblock ```json nicht entfernt)';
  return '';
}

function jsonFehlerGrund(raw, err) {
  const msg = String((err && err.message) || 'ungültiges JSON');
  const mPos = msg.match(/position\s+(\d+)/i);
  const pos = mPos ? ` (Position ${mPos[1]})` : '';
  const anzeigen = String(raw || '').trim().slice(0, 120);
  return `JSON-Parse-Fehler: ${msg}${pos}${kontextHinweis(raw)} – Anfang: ${JSON.stringify(anzeigen)}`;
}

function whitelistGrundDecision(action, whitelist) {
  const erlaubt = Array.isArray(whitelist) ? whitelist : [];
  const bekommen = action == null || action === '' ? '(leer/fehlend)' : `"${String(action)}"`;
  return `Whitelist-Verstoß: action ${bekommen} nicht erlaubt (erlaubt: ${erlaubt.join(', ') || '–'})`;
}

function detailFuerFailure(code, ctx = {}) {
  const { action, whitelist, thought, raw, err } = ctx;
  switch (code) {
    case 'json':
      return { code: 'json', reason: jsonFehlerGrund(raw, err) };
    case 'json_leer':
    case 'leer':
      // 'leer' = thought leer; 'json_leer' = leere Roh-Antwort
      if (code === 'json_leer') return { code: 'empty', reason: 'Leere Modell-Antwort (nur Whitespace) – Modell schweigt.' };
      return { code: 'empty', reason: 'Gedanke leer (thought fehlt).' };
    case 'whitelist':
      return { code: 'whitelist', reason: whitelistGrundDecision(action, whitelist) };
    case 'words':
      return { code: 'schema', reason: `Gedanke zu lang (${wordCount(thought)} Wörter, max. erlaubt).` };
    case 'cjk':
      return { code: 'schema', reason: 'CJK-Zeichen im Gedanken (nicht erlaubt).' };
    case 'english':
      return { code: 'schema', reason: `Englische Wörter im Gedanken: ${(englishHits(thought) || []).join(', ') || '–'}.` };
    case 'novelty':
      return { code: 'schema', reason: 'Gedanke zu ähnlich zu recentThoughts (Jaccard ≥ Limit).' };
    case 'exclamation':
      return { code: 'schema', reason: 'Ausrufezeichen-Häufung (recent-Fenster enthält bereits „!").' };
    case 'eroeffnung_objekt':
      return { code: 'schema', reason: 'Musterbremse Objekt-Eröffnung (Ortsname am Start, 3/4-Häufung).' };
    case 'wiederholung_beduerfnis':
      return { code: 'schema', reason: 'Bedürfnis-Bremse: Gedanke benennt nur das laufende Bedürfnis, obwohl ein Vorhaben aktiv ist.' };
    case 'musing_fehlt':
      return { code: 'schema', reason: 'Zusatzgedanke (musing) fehlt, obwohl angefordert.' };
    case 'musing_lang':
      return { code: 'schema', reason: 'Zusatzgedanke (musing) zu lang.' };
    case 'musing_zahl':
      return { code: 'schema', reason: 'Zusatzgedanke (musing) enthält Ziffern (nicht erlaubt).' };
    case 'musing_wiederholung':
      return { code: 'schema', reason: 'Zusatzgedanke (musing) zu ähnlich zu recentThoughts.' };
    default:
      return { code: String(code || 'schema'), reason: `Check fehlgeschlagen: ${String(code)}` };
  }
}

/**
 * Prüft eine Modell-Antwort.
 * Checkliste: JSON, Whitelist, Wörter, CJK/Englisch, Jaccard, Ausruf,
 *       Objekt-Eröffnung (B-Rest), Bedürfnis bei Vorhaben (A).
 * opts: whitelist, recentThoughts, maxWords, maxWordsMusing, jaccardMax,
 *       exclamationWindow, musing (bool), orte (für Musterbremse, Paket B-Rest),
 *       vorhabenAktiv (für Bedürfnis-Bremse, Paket A)
 * Gibt { ok, action, thought, musing, failures[] } zurück.
 */
function validateDecision(raw, opts = {}) {
  const {
    whitelist = [],
    recentThoughts = [],
    maxWords = 20,
    maxWordsMusing = 10,
    jaccardMax = 0.65,
    exclamationWindow = 5,
    musing: willMusing = false,
    orte = [],
    vorhabenAktiv = false,
  } = opts;

  const failures = [];
  const fehlerDetails = [];
  const notiere = (code, extra = {}) => {
    failures.push(code);
    const d = detailFuerFailure(code, { action: extra.action ?? null, whitelist, thought: extra.thought ?? '', raw, err: extra.err });
    d.rawResponse = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
    fehlerDetails.push(d);
  };
  let action = null;
  let thought = '';
  let musing = null;

  let obj = null;
  let jsonErr = null;
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    jsonErr = err;
  }
  if (jsonErr || !obj || typeof obj !== 'object') {
    if (!raw || !String(raw).trim()) {
      notiere('json_leer');
      return { ok: false, action, thought, musing, failures, fehlerDetails };
    }
    notiere('json', { err: jsonErr });
    return { ok: false, action, thought, musing, failures, fehlerDetails };
  }

  action = typeof obj.action === 'string' ? obj.action.trim() : null;
  thought = typeof obj.thought === 'string' ? obj.thought.trim() : '';
  musing = typeof obj.musing === 'string' ? obj.musing.trim() : null;

  if (!action || !whitelist.includes(action)) notiere('whitelist', { action });
  if (!thought) notiere('leer', { thought });
  if (wordCount(thought) > maxWords) notiere('words', { thought });
  if (hasCJK(thought) || (musing && hasCJK(musing))) notiere('cjk', { thought });
  if (englishHits(thought).length || (musing && englishHits(musing).length)) notiere('english', { thought });
  if (maxSimilarity(thought, recentThoughts) >= jaccardMax) notiere('novelty', { thought });
  if (thought.includes('!') && hasRecentExclamation(recentThoughts, exclamationWindow)) {
    notiere('exclamation', { thought });
  }
  if (orte.length && hatObjektEroeffnung(thought, recentThoughts, orte)) {
    notiere('eroeffnung_objekt', { thought });
  }
  if (vorhabenAktiv && benenntNurBeduerfnis(thought)) {
    notiere('wiederholung_beduerfnis', { thought });
  }

  if (willMusing) {
    if (!musing) notiere('musing_fehlt', { thought });
    else {
      if (wordCount(musing) > maxWordsMusing) notiere('musing_lang', { thought });
      if (/\d/.test(musing)) notiere('musing_zahl', { thought });
      if (maxSimilarity(musing, recentThoughts) >= jaccardMax) notiere('musing_wiederholung', { thought });
    }
  }

  return { ok: failures.length === 0, action, thought, musing, failures, fehlerDetails };
}

function planSchrittGrund(failure, intents, obj) {
  const mVerbot = String(failure).match(/^schritt_(\d+)_intent_verboten:(.*)$/);
  if (mVerbot) {
    const idx = Number(mVerbot[1]);
    const wert = mVerbot[2];
    const erlaubt = Array.isArray(intents) ? intents.join(', ') : '–';
    return { code: 'whitelist', reason: `Whitelist-Verstoß: action "${wert}" nicht erlaubt in Schritt ${idx + 1} (erlaubt: ${erlaubt}).`, feld: `plan[${idx}].action`, wert, erlaubt: intents || [] };
  }
  const mOhneZiel = String(failure).match(/^schritt_(\d+)_walk_to_ohne_ziel$/);
  if (mOhneZiel) {
    return { code: 'whitelist', reason: `Whitelist-Verstoß: walk_to in Schritt ${Number(mOhneZiel[1]) + 1} ohne target (poi_id fehlt).`, feld: `plan[${mOhneZiel[1]}].target`, wert: '', erlaubt: intents || [] };
  }
  if (failure === 'json') return { code: 'json', reason: 'Antwort ist kein Objekt mit plan[] (JSON-Parse oder Typfehler).' };
  return { code: 'schema', reason: `Plan-Check fehlgeschlagen: ${failure}` };
}

function validatePlan(obj, intents) {
  let rawText = '';
  let orte = [];
  if (intents && typeof intents === 'object' && !Array.isArray(intents)) {
    rawText = typeof intents.raw === 'string' ? intents.raw : '';
    orte = Array.isArray(intents.orte) ? intents.orte : [];
    intents = intents.intents;
  }
  const failures = [];
  const fehlerDetails = [];
  const notiere = (code) => {
    failures.push(code);
    let d = planSchrittGrund(code, intents, obj);
    if (rawText) d.rawResponse = rawText;
    // JSON-Anfang + Markdown-Hinweis bei json-Fehlern anreichern
    if (d.code === 'json' && rawText) {
      try { JSON.parse(rawText); } catch (err) { d.reason = jsonFehlerGrund(rawText, err); }
      if (!rawText.trim()) d = { code: 'empty', reason: 'Leere Modell-Antwort (nur Whitespace) – Modell schweigt.', rawResponse: rawText };
    }
    fehlerDetails.push(d);
  };
  if (!obj || typeof obj !== 'object') {
    notiere('json');
    return { ok: false, failures, fehlerDetails, plan: [] };
  }
  const thought = typeof obj.thought === 'string' ? obj.thought.trim() : '';
  const whyHere = typeof obj.why_here === 'string' ? obj.why_here.trim().slice(0, 200) : '';
  const retrospective = typeof obj.retrospective === 'string' ? obj.retrospective.trim() : '';
  const plan = Array.isArray(obj.plan) ? obj.plan : null;
  if (!thought) notiere('thought_leer');
  else if (wordCount(thought) > 20) notiere('thought_lang');
  if (!plan) notiere('plan_fehlend');
  else {
    if (plan.length < 2 || plan.length > 4) notiere('plan_laenge');
    const erlaubt = Array.isArray(intents) && intents.length > 0 ? intents : null;
    let leaveNoteN = 0;
    plan.forEach((s, i) => {
      if (!s || typeof s !== 'object') { notiere('schritt_' + i + '_kein_objekt'); return; }
      const action = typeof s.action === 'string' ? s.action.trim() : '';
      if (!action) { notiere('schritt_' + i + '_ohne_action'); return; }
      if (action === 'walk_to' && Array.isArray(orte) && orte.length > 0 && typeof s.target === 'string' && s.target.trim()) {
        // Hinweis: KEIN harter Fehler – walk_to zu unentdeckten POIs ist Kernmechanik (§5.2 Discovery).
        // Unbekannte Ziele scheitern erst auf Ausführungsebene (ort_unbekannt) – dort erzeugt
        // die Engine dann ein präzises Debug-Objekt (reason + erlaubte Orte + rawResponse).
        void orte;
      }
      if (erlaubt && !erlaubt.includes(action)) { notiere('schritt_' + i + '_intent_verboten:' + action); return; }
      if (action === 'walk_to' && !(typeof s.target === 'string' && s.target.trim())) {
        notiere('schritt_' + i + '_walk_to_ohne_ziel');
      }
      if (action === 'leave_note') leaveNoteN += 1;
    });
    if (leaveNoteN > 1) notiere('leave_note_max_1');
  }
  const sauber = (plan || []).slice(0, 4).map((s) => ({
    action: String(s.action || '').trim(),
    target: typeof s.target === 'string' && s.target.trim() ? s.target.trim() : null,
    detail: typeof s.detail === 'string' ? s.detail.trim().slice(0, 280) : '',
  }));
  if (rawText) fehlerDetails.forEach((d) => { if (!d.rawResponse) d.rawResponse = rawText; });
  return { ok: failures.length === 0, failures, fehlerDetails, thought, why_here: whyHere, retrospective, plan: sauber };
}

module.exports = {
  validateDecision, validatePlan, jaccard, maxSimilarity, wordCount, words,
  hasCJK, englishHits, hasRecentExclamation, beginntMitOrt, hatObjektEroeffnung,
  benenntNurBeduerfnis, detailFuerFailure, kontextHinweis, jsonFehlerGrund,
};

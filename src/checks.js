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
  let action = null;
  let thought = '';
  let musing = null;

  let obj = null;
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    failures.push('json');
    return { ok: false, action, thought, musing, failures };
  }
  if (!obj || typeof obj !== 'object') {
    failures.push('json');
    return { ok: false, action, thought, musing, failures };
  }

  action = typeof obj.action === 'string' ? obj.action.trim() : null;
  thought = typeof obj.thought === 'string' ? obj.thought.trim() : '';
  musing = typeof obj.musing === 'string' ? obj.musing.trim() : null;

  if (!action || !whitelist.includes(action)) failures.push('whitelist');
  if (!thought) failures.push('leer');
  if (wordCount(thought) > maxWords) failures.push('words');
  if (hasCJK(thought) || (musing && hasCJK(musing))) failures.push('cjk');
  if (englishHits(thought).length || (musing && englishHits(musing).length)) failures.push('english');
  if (maxSimilarity(thought, recentThoughts) >= jaccardMax) failures.push('novelty');
  if (thought.includes('!') && hasRecentExclamation(recentThoughts, exclamationWindow)) {
    failures.push('exclamation');
  }
  // Paket B-Rest: Musterbremse Objekt-Eröffnung
  if (orte.length && hatObjektEroeffnung(thought, recentThoughts, orte)) {
    failures.push('eroeffnung_objekt');
  }
  // Paket A: Bedürfnis-Bremse — Vorhaben steht, Bedürfnis-Satz fliegt raus
  if (vorhabenAktiv && benenntNurBeduerfnis(thought)) {
    failures.push('wiederholung_beduerfnis');
  }

  if (willMusing) {
    if (!musing) failures.push('musing_fehlt');
    else {
      if (wordCount(musing) > maxWordsMusing) failures.push('musing_lang');
      if (/\d/.test(musing)) failures.push('musing_zahl');
      if (maxSimilarity(musing, recentThoughts) >= jaccardMax) failures.push('musing_wiederholung');
    }
  }

  return { ok: failures.length === 0, action, thought, musing, failures };
}

module.exports = {
  validateDecision, jaccard, maxSimilarity, wordCount, words,
  hasCJK, englishHits, hasRecentExclamation, beginntMitOrt, hatObjektEroeffnung,
  benenntNurBeduerfnis,
};

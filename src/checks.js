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

// Welche der verbotenen Motive stecken im Text?
function motivTreffer(text, motive = []) {
  const t = String(text || '').toLowerCase();
  return motive.filter((m) => t.includes(m));
}

// Tunwörter je Aktion (Wortanfänge, kleingeschrieben). Absichtlich nur echte
// Verben, keine Orte oder Zustände — sonst hagelt es Fehlalarme
// („Karottenfeld" ist kein Fressen, „Schatten" kein Sitzen).
const AKTIONSVERBEN = {
  eat: ['ess', 'iss', 'friss', 'fress', 'kau', 'beiss', 'beiß', 'schling', 'knabb', 'nasch'],
  sleep: ['schlaf', 'schlumm', 'penn', 'nick', 'hinleg', 'traum', 'dös', 'does'],
  sit_shade: ['sitz', 'ausruh', 'rast', 'verschnauf', 'faulenz', 'hock', 'setz'],
  inspect: ['untersuch', 'inspiz', 'betracht', 'beobacht'],
  search_wrack: ['wühl', 'wuehl', 'durchsuch', 'stöber', 'stoeb', 'kram', 'plünder', 'pluender'],
  read_note: ['les', 'entziffer', 'buchstab', 'enträtsel', 'entraetsel'],
  check_stock: ['prüf', 'pruef', 'zähl', 'zaehl', 'inventur'],
  tend_dome: ['pfleg', 'gieß', 'giess', 'jät', 'jaet', 'pflanz', 'umtopf'],
  call_bake: ['funk', 'notruf', 'bake', 'mors', 'send'],
  streifen: ['streif', 'wander', 'spazier', 'bummel', 'schweif', 'schlender', 'stromer', 'schlend'],
  sinnieren: ['sinnier', 'denk', 'grübel', 'gruebel', 'philosophier', 'nachdenk'],
  look_earth: ['erd', 'himmel', 'stern', 'heimat'],
  dig: ['grab', 'gräb', 'graeb', 'buddel', 'schaufel'],
  run_wild: ['renn', 'flieh', 'flücht', 'fluecht', 'sprint', 'tob'],
};

/**
 * Findet das Verb einer *anderen* angebotenen Aktion im Gedanken.
 * Gibt den fremden Aktions-Schlüssel zurück oder null. Das eigene Verb zählt
 * nie als Treffer — „Ich schaue zur Erde" ist für look_earth in Ordnung,
 * für inspect ein Fehlgriff.
 */
function fremdesAktionsverb(text, aktion, whitelist = []) {
  const woerter = words(text);
  const treffer = Object.keys(AKTIONSVERBEN).filter((a) =>
    woerter.some((w) => AKTIONSVERBEN[a].some((s) => w.startsWith(s))));
  return treffer.find((a) => a !== aktion && whitelist.includes(a)) || null;
}

/**
 * Prüft eine Modell-Antwort.
 * opts: whitelist, recentThoughts, maxWords, maxWordsMusing, jaccardMax,
 *       exclamationWindow, motive[], musing (bool)
 * Gibt { ok, action, thought, musing, failures[] } zurück.
 */
function validateDecision(raw, opts = {}) {
  const {
    whitelist = [],
    recentThoughts = [],
    maxWords = 14,
    maxWordsMusing = 10,
    jaccardMax = 0.65,
    exclamationWindow = 5,
    motive = [],
    musing: willMusing = false,
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
  if (motivTreffer(thought, motive).length) failures.push('motiv');
  if (fremdesAktionsverb(thought, action, whitelist)) failures.push('aktionsmismatch');

  if (willMusing) {
    if (!musing) failures.push('musing_fehlt');
    else {
      if (wordCount(musing) > maxWordsMusing) failures.push('musing_lang');
      if (/\d/.test(musing)) failures.push('musing_zahl');
      if (motivTreffer(musing, motive).length) failures.push('motive_motiv');
      if (maxSimilarity(musing, recentThoughts) >= jaccardMax) failures.push('musing_wiederholung');
    }
  }

  return { ok: failures.length === 0, action, thought, musing, failures };
}

module.exports = {
  validateDecision, jaccard, maxSimilarity, wordCount, words,
  hasCJK, englishHits, hasRecentExclamation, motivTreffer,
  AKTIONSVERBEN, fremdesAktionsverb,
};

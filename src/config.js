'use strict';
// Zentrale Konstanten für AIquarium Hamburg (Meilenstein 1).
// Alles, was die Engine an Zahlen braucht, steht hier –
// das Modell rechnet nie selbst mit Geld, Zeit oder Prozenten.

const path = require('node:path');

// ---- Flaches metrisches Koordinatensystem (St. Pauli) ----
// Ursprung (0, 0): Kreuzung Lerchenstraße / Otzenstraße.
// +x = Ost, -z = Nord (passend zu Three.js), Einheit = Meter.
const KOORD = {
  origin: { lat: 53.5588, lon: 9.9612 },
  bbox: { south: 53.5562, west: 9.9578, north: 53.5622, east: 9.9650 },
  einheit: 'meter',
  xOsten: '+x = Ost',
  zNorden: '-z = Nord',
};

function toLocalMeters(lat, lon) {
  const cosLat = Math.cos((KOORD.origin.lat * Math.PI) / 180);
  const x = (lon - KOORD.origin.lon) * 111320 * cosLat;
  const z = -(lat - KOORD.origin.lat) * 111320;
  return [Math.round(x * 10) / 10, Math.round(z * 10) / 10];
}

// ---- Grundwerte ----
const GESUND = {
  min: 0,
  max: 100,
  start: 100,
  // 5 Chunks à 20 %: [0–20], (20–40], (40–60], (60–80], (80–100]
  chunk: 20,
  chunks: [20, 40, 60, 80, 100],
  // Schwellen, ab denen gesund langsam sinkt
  hungerSchwelle: 85,
  erschoepfungSchwelle: 90,
};

function chunkCapFuer(gesund) {
  const g = Math.max(0, Math.min(100, gesund));
  for (const c of GESUND.chunks) {
    if (g <= c) return c;
  }
  return 100;
}

const FROH = {
  min: -100,
  max: 100,
  start: 20,
};

// ---- Sekundärwerte ----
const SEKUNDAER = {
  hunger: { min: 0, max: 100, start: 20, proStunde: 3.5, proSchicht: 15 },
  erschoepfung: { min: 0, max: 100, start: 15, proStunde: 3.0, proSchicht: 22 },
  geld: { start: 18.0, einheit: 'EUR' },
};

// ---- Aktionsdauern (Aquarium-Zeit, Sekunden) ----
const AKTION = {
  walkToSpeedMs: 1.3, // m/s für walk_to
  entdeckenRadiusM: 22,
  exploreStreetS: 3 * 60,
  consumeS: 6 * 60,
  doActivityS: 10 * 60,
  workOnProjectS: 15 * 60,
  readBookS: 8 * 60,
  writeNotebookS: 5 * 60,
  leaveNoteS: 3 * 60,
  workShiftS: 20 * 60, // 20-Min-Schichten
  collectPfandS: 8 * 60,
  returnPfandS: 2 * 60,
  buyItemS: 3 * 60,
  restS: 10 * 60,
  sleepS: 35 * 60,
  visitDoctorS: 15 * 60,
};

// ---- Wirtschaft / Leitplanken (ENGINE klammert hart) ----
const ECONOMY = {
  shiftDurationS: 20 * 60,
  wageBounds: [8.0, 18.0], // € pro 20-Min-Schicht
  priceBounds: {
    spaeti: [1.0, 6.0],
    imbiss: [3.5, 10.0],
    kneipe: [2.5, 12.0],
    club: [4.0, 15.0],
    kino: [7.0, 13.0],
  },
  deltaBounds: {
    consumeHunger: [-50, -5],
    consumeFroh: [-2, 14],
    activityFroh: [-8, 16],
    activityErschoepfung: [2, 15], // freie Aktivitäten geben NIEMALS Geld
  },
  arztKosten: 15.0,
  pfandWert: 0.5,
};

// ---- Gedächtnis-Limits ----
const MEMORY = {
  maxShort: 25,
  maxLong: 25,
  decayShort: 0.25,
  decayLong: 0.03,
};

// ---- OpenRouter-Routing: einheitliche { primary, fallback }-Paare pro Rolle ----
// Dev-Modus (AIQUARIUM_DEV !== '0', Standard): überall :free-Modelle (0,00 €).
// Live (AIQUARIUM_DEV === '0'): alltag primary free → fallback paid, Rest fix.
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';

const MODEL = {
  baseUrl: process.env.AIQUARIUM_BASE_URL || OPENROUTER_BASE,
  // Default-Modell für Tagesbetrieb (wird von SLOTS.alltag.primary gespiegelt)
  name: process.env.AIQUARIUM_MODEL || 'google/gemma-4-26b-a4b-it:free',
  timeoutMs: 45000,
  temperature: 0.7,
  retryTemperature: 0.3,
  maxTokens: 1200,
  maxWords: 20,
  maxWordsMusing: 10,
  jaccardMax: 0.65,
  exclamationWindow: 5,
  reasoningExclude: false,
};

const SLOTS = {
  // Aktiv solange AIQUARIUM_DEV !== '0' (garantiert 0,00 € beim Testen)
  dev: {
    primary: { model: process.env.AIQUARIUM_DEV_MODEL || 'nvidia/nemotron-3-nano-30b-a3b:free', reasoningExclude: true, maxTokens: 1800 },
    fallback: { model: 'google/gemma-4-26b-a4b-it:free', reasoningExclude: false, maxTokens: 1200 },
  },
  // Live-Alltag (AIQUARIUM_DEV=0): erst kostenlose Gemma-Variante testen, bei Rate-Limit/Fehler auf Paid-Gemma ausweichen
  alltag: {
    primary: { model: process.env.AIQUARIUM_MODEL || 'google/gemma-4-26b-a4b-it:free', reasoningExclude: false, maxTokens: 1200 },
    fallback: { model: process.env.AIQUARIUM_FALLBACK_MODEL || 'google/gemma-4-26b', reasoningExclude: false, maxTokens: 1200 },
  },
  // Welt-Schiedsrichter (Ladenpreise, Job-Zusagen): einheitliches primary/fallback-Paar zum schnellen Tauschen
  arbiter: {
    primary: { model: process.env.AIQUARIUM_ARBITER_MODEL || 'z-ai/glm-5.3-flash', reasoningExclude: false, maxTokens: 900 },
    fallback: { model: process.env.AIQUARIUM_ARBITER_FALLBACK || 'z-ai/glm-5.3-flash', reasoningExclude: false, maxTokens: 900 },
  },
  // Nächtliche Schlaf-Konsolidierung (1x pro Tag): einheitliches primary/fallback-Paar
  nightly: {
    primary: { model: process.env.AIQUARIUM_NIGHTLY_MODEL || 'xiaomi/mimo-v2.6-pro', reasoningExclude: false, maxTokens: 1400 },
    fallback: { model: process.env.AIQUARIUM_NIGHTLY_FALLBACK || 'xiaomi/mimo-v2.6-pro', reasoningExclude: false, maxTokens: 1400 },
  },
};

// Dev-Prio: AIQUARIUM_DEV !== '0' (Standard an → 0,00 €). Live nur mit explizit '0'.
function devPrioAn() {
  return String(process.env.AIQUARIUM_DEV ?? '1') !== '0';
}

// Zentraler Helper: Rolle → { primary, fallback }.
// Dev-Modus: IMMER das kostenlose dev-Paar (nie versehentlich paid).
// Live: das jeweilige Rollen-Paar.
function getRoleSlots(role) {
  if (devPrioAn()) return SLOTS.dev;
  if (role === 'arbiter') return SLOTS.arbiter;
  if (role === 'nightly') return SLOTS.nightly;
  return SLOTS.alltag;
}

// Rückwärtskompatibilität (altes brain.js / Engine): flache Slot-Form { model, reasoningExclude }.
function aktiverSlot() {
  return getRoleSlots('alltag').primary;
}

function fallbackSlot() {
  return getRoleSlots('alltag').fallback;
}

function slotFuer(zweck) {
  if (zweck === 'nightly') return getRoleSlots('nightly').primary;
  if (zweck === 'arbiter') return getRoleSlots('arbiter').primary;
  if (zweck === 'dev') return SLOTS.dev.primary;
  return getRoleSlots('alltag').primary;
}

const DB = {
  // Absichtlich außerhalb des syncenden Ordners (siehe .env: AIQUARIUM_DB)
  defaultPfad: process.env.AIQUARIUM_DB
    || path.join(process.env.HOME || '/tmp', '.local', 'share', 'aiquarium', 'world.sqlite'),
};

module.exports = {
  KOORD,
  toLocalMeters,
  GESUND,
  chunkCapFuer,
  FROH,
  SEKUNDAER,
  AKTION,
  ECONOMY,
  MEMORY,
  MODEL,
  SLOTS,
  OPENROUTER_BASE,
  aktiverSlot,
  fallbackSlot,
  slotFuer,
  devPrioAn,
  getRoleSlots,
  DB,
};

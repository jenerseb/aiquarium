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
  bbox: { south: 53.5525, west: 9.9578, north: 53.5637, east: 9.9725 },
  einheit: 'meter',
  xOsten: '+x = Ost',
  zNorden: '-z = Nord',
};

function toLocalMeters(lat, lon) {
  const cosLat = Math.cos((KOORD.origin.lat * Math.PI) / 180);
  const x = (lon - KOORD.origin.lon) * 111320 * cosLat;
  const z = -(lat - KOORD.origin.lat) * 111320; // BEWUSST alte Projektion (Bild 2 = Referenz), cos-Revert 2026-11-16
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
    // NW/S-Erweiterung 2026-11-17: Stadion + Gastro am Kiez-Rand
    restaurant: [4.0, 14.0],
    cafe: [2.0, 8.0],
    stadion: [5.0, 15.0],
    park: [0.0, 4.0],
    markt: [1.0, 12.0],
    denkmal: [0.0, 8.0],
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

// ---- Modell-Routing: ALLES lebt in model.json (Projekt-Root) ---------------------------
// Diese Datei ist nur der LOADER: model.json lesen → Key-Filter → Slots bauen.
// „Welches Modell ruft wann?" steht in model.json (mit _lies_mich-Erklärung).
// Env-Overrides (AIQUARIUM_MODEL etc.) gibt es bewusst NICHT mehr — eine Quelle, eine Wahrheit.
const fs = require('node:fs');
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';

// ---- Google-Direct (eigener Key, kein OpenRouter-BYOK) ----
// GEMINI_API_KEY: AQ.* (Express) und AIza* (Studio) laufen beide ueber AI Studio.
const GEMINI = {
  apiKey: String(process.env.GEMINI_API_KEY || '').trim() || null,
};

// Google-Einträge brauchen einen Key (und sind in Tests bewusst aus, damit
// Mock-Tests deterministisch gegen OpenRouter-Mocks laufen).
function googleEintragAktiv() {
  return Boolean(GEMINI.apiKey) && process.env.NODE_ENV !== 'test';
}

function googleSlot(eintrag) {
  const vertex = String(GEMINI.apiKey || '').startsWith('AQ.');
  return {
    provider: 'google',
    model: eintrag.modell,
    providerLabel: vertex ? 'Google Direct (Vertex)' : 'Google Direct (AI Studio)',
    reasoningExclude: false,
    maxTokens: eintrag.maxTokens || 1200,
  };
}

function openrouterSlot(eintrag) {
  return {
    provider: 'openrouter',
    model: eintrag.modell,
    reasoningExclude: Boolean(eintrag.reasoningExclude),
    maxTokens: eintrag.maxTokens || 1200,
  };
}

// model.json laden + in Slot-Form übersetzen. Kaputte Datei → sofort laute
// Fehlermeldung (nicht stillschweigend ein Default), damit man den Fehler sieht.
function ladeModellRouten() {
  const datei = path.join(__dirname, '..', 'model.json');
  let roh;
  try {
    roh = JSON.parse(fs.readFileSync(datei, 'utf8'));
  } catch (err) {
    throw new Error(`[model] model.json ist kaputt oder fehlt (${datei}): ${err.message}`);
  }
  if (!roh || typeof roh !== 'object' || !roh.rollen || typeof roh.rollen !== 'object') {
    throw new Error('[model] model.json muss ein Objekt mit "rollen" sein (Erklärung in der Datei).');
  }
  const routen = {};
  for (const [name, def] of Object.entries(roh.rollen)) {
    if (!def || !Array.isArray(def.kette)) {
      throw new Error(`[model] model.json: Rolle "${name}" braucht ein "kette"-Array.`);
    }
    const kette = [];
    for (const e of def.kette) {
      if (!e || (e.provider !== 'google' && e.provider !== 'openrouter') || !e.modell) {
        throw new Error(`[model] model.json: Rolle "${name}" hat einen kaputten Eintrag (provider 'google'|'openrouter' + modell nötig): ${JSON.stringify(e)}`);
      }
      if (e.provider === 'google' && !googleEintragAktiv()) {
        console.log(`[model] Rolle "${name}": google-Eintrag (${e.modell}) übersprungen — kein GEMINI_API_KEY (bzw. Test-Modus).`);
        continue;
      }
      kette.push(e.provider === 'google' ? googleSlot(e) : openrouterSlot(e));
    }
    // Kompatible Form für brain.js/arbiter.js: primary/fallback/fallback2 = kette[0..2].
    routen[name] = {
      _wofuer: def._wofuer || '',
      kette,
      primary: kette[0] || null,
      fallback: kette[1] || null,
      fallback2: kette[2] || null,
    };
  }
  return routen;
}

const SLOTS = ladeModellRouten();

const MODEL = {
  baseUrl: process.env.AIQUARIUM_BASE_URL || OPENROUTER_BASE,
  // Default-Modell (nur Notfall-Default für callModel ohne explizites model):
  name: (SLOTS.alltag && SLOTS.alltag.primary && SLOTS.alltag.primary.model) || 'google/gemma-4-26b-a4b-it:free',
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

// Zentraler Helper: Rolle → Kette aus model.json (primary/fallback/fallback2).
function getRoleSlots(role) {
  return SLOTS[role] || SLOTS.alltag;
}

// Rückwärtskompatibilität (altes brain.js / Engine): flache Slot-Form { model, reasoningExclude }.
function aktiverSlot() {
  return getRoleSlots('alltag').primary;
}

function fallbackSlot() {
  return getRoleSlots('alltag').fallback;
}

function slotFuer(zweck) {
  return getRoleSlots(zweck === 'nightly' || zweck === 'arbiter' || zweck === 'dev' ? zweck : 'alltag').primary;
}

// Konsole-Demo: druckt die effektiven Ketten (was WANN wirklich gerufen wird).
function rollenTabelle() {
  const zeilen = ['Effektives Modell-Routing (aus model.json, nach Key-Filter):'];
  for (const [name, r] of Object.entries(SLOTS)) {
    zeilen.push(`  ${name.padEnd(8)} — ${r._wofuer}`);
    r.kette.forEach((s, i) => {
      zeilen.push(`    ${i + 1}. [${s.provider}] ${s.model}${s.providerLabel ? ` (${s.providerLabel})` : ''}`);
    });
    if (r.kette.length === 0) zeilen.push('    (leer — kein Modell verfügbar, Calls laufen in den Engine-Fallback)');
  }
  return zeilen.join('\n');
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
  GEMINI,
  googleDirektAktiv: googleEintragAktiv,
  aktiverSlot,
  fallbackSlot,
  slotFuer,
  getRoleSlots,
  rollenTabelle,
  DB,
};

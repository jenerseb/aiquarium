'use strict';
// Zentrale Konstanten. Alle Werte sind "hoch = schlecht":
// Hunger, Erschöpfung, Stress. 0 = gesund, 100 = tot bzw. durchgedreht.

const TICK_MS = 1000;                 // Simulationstakt (eine Sekunde Simulationszeit)
const CATCHUP_MAX_H = 12;             // mehr Offline-Zeit wird nicht nachsimuliert
const CATCHUP_WRITE_EVERY = 60;       // während Catch-up nur alle 60 Ticks ein Ereignis schreiben
const CATCHUP_MAX_TICKS = CATCHUP_MAX_H * 3600;

// --- Verbrauch pro Sekunde (steigt) ---------------------------------------
const DRAIN = {
  hunger: 0.0025,        // 0 -> 100 in ~11 h ohne Fressen
  exhaustion: 0.0015,
  stress: 0.0004,
};
const SUN_COST = 1.5;    // Erschöpfung beim Laufen in der Sonne

// --- Wirkung pro Sekunde (negativ = besser) -------------------------------
const EFFECT = {
  eat:        { hunger: -0.506, exhaustion: +0.0045, stress: -0.0011 },
  sleep:      { exhaustion: -0.043, stress: -0.0043 },
  sit_shade:  {},                                    // vollständig in effectFor()
  inspect:    { exhaustion: +0.012, stress: -0.008 },
  look_earth: { stress: -0.006 },                    // verfeinert in effectFor()
  dig:        { exhaustion: +0.024, stress: -0.002 },
  search_wrack: { exhaustion: +0.012, stress: -0.006 },
  read_note:  { stress: -0.008 },
  check_stock: {},                                   // nur Info, keine Wirkung
  tend_dome:  { hunger: -0.15, exhaustion: +0.008, stress: -0.004 },
  call_bake:  { exhaustion: +0.004, stress: +0.002 },
  streifen:   { exhaustion: +0.008, stress: -0.002 }, // Umherschweifen kostet Beine, kühlt den Kopf
  sinnieren:  {},                                    // nur Denken; Monotonie-Bremse fängt Spam
  run_wild:   { exhaustion: +0.005, stress: +0.001 },
  idle:       {},
};

// Sitzen hilft nur, wenn Erschöpfung da ist. Sonst wird es langweilig und kostet Stress.
const SHADE = { min: 25, full: 85, gainPerS: 0.040, boredomPerS: +0.0027, comfortPerS: -0.0027 };
// Unter diesem Hunger passt nichts mehr rein.
const EAT_FULL = 5;
// Sehnsucht nach der Erde hilft nur, wenn Stress da ist.
const EARTH = { minStress: 30, gainPerS: 0.006, idlePerS: +0.003 };

/**
 * Zustandsabhängige Wirkung einer Aktion pro Sekunde.
 * Hier steckt die Spiel-Logik: eine Aktion bleibt wählbar, bringt aber nur etwas,
 * wenn der Körper sie gerade braucht.
 */
function effectFor(action, pilot) {
  if (action === 'sit_shade') {
    const anteil = Math.max(0, Math.min(1,
      (pilot.exhaustion - SHADE.min) / (SHADE.full - SHADE.min)));
    const stress = pilot.exhaustion < SHADE.min ? SHADE.boredomPerS : SHADE.comfortPerS;
    return { exhaustion: -SHADE.gainPerS * anteil, stress };
  }
  if (action === 'look_earth') {
    return { stress: pilot.stress > EARTH.minStress ? -EARTH.gainPerS : EARTH.idlePerS };
  }
  if (action === 'eat' && pilot.hunger < EAT_FULL) return {};
  return EFFECT[action] || {};
}

// --- Aktionen: Dauer (Sim-Sekunden), Zielort, Label -----------------------
const ACTIONS = {
  eat:        { dur: 40,  needs: ['field', 'capsule'], label: 'fressen' },
  sleep:      { dur: 420, needs: null,                  label: 'Schlaf' },
  sit_shade:  { dur: 90,  needs: ['shade', 'capsule'],  label: 'im Schatten sitzen' },
  inspect:    { dur: 90,  needs: ['wreck'],             label: 'Wrack untersuchen' },
  search_wrack: { dur: 150, needs: ['wreck'],           label: 'Wrack durchwühlen' },
  read_note:  { dur: 90,  needs: ['note'],              label: 'Notizzettel entziffern' },
  check_stock: { dur: 30, needs: ['capsule', 'field'],  label: 'Vorrat prüfen' },
  tend_dome:  { dur: 120, needs: ['kuppel'],            label: 'Beet pflegen' },
  call_bake:  { dur: 180, needs: ['bake'],             label: 'Notruf senden' },
  streifen:   { dur: 120, needs: null,                  label: 'umherschweifen' },
  sinnieren:  { dur: 60,  needs: null,                  label: 'sinnieren' },
  look_earth: { dur: 60,  needs: null,                  label: 'nach der Erde schauen' },
  dig:        { dur: 120, needs: ['field', 'wreck'],    label: 'graben' },
  run_wild:   { dur: 60,  needs: null,                  label: 'rennen' },   // nur im Wahn
};

// Sättigung: Faktor je Durchgang — nach wenigen Wiederholungen wirkt die
// Aktion kaum noch. Zählt über die Neugier-Tabelle, kein neues Schema.
const SATT = {
  read_note: [1, 0.35, 0.1],
  tend_dome: [1, 0.5, 0.2],
};

const WALK_SPEED = 0.8;            // Meter pro Sekunde

// --- Stress ----------------------------------------------------------------
const STRESS = {
  low: 60,            // ab hier fliegen anspruchsvolle Aktionen raus
  collapse: 100,      // ab hier Stupor oder Wahn
  recover: 85,        // darunter zurück auf "klar"
  monotony_penalty: 8,
  knock_penalty: 12,
  force_sleep_stupor_s: 6 * 3600,
  force_sleep_wahn_s: 3 * 3600,
};

// --- Neugier: der Motor für Erkundung --------------------------------------
const NOVELTY = {
  entity: [12, 4],      // 1. Besuch, 2. Besuch (ab dem 3. nichts mehr)
  entityAction: 8,      // Aktion an diesem Ort zum ersten Mal
  action: 6,            // Aktion überhaupt zum ersten Mal
  minStress: 10,        // darunter keine Belohnung (sonst farmt er)
  boredBelow: 20,       // unter diesem Stress wird Langeweile zum Druck
  boredAfterS: 600,     // 10 Minuten ohne Neues
  boredRate: 0.0015,    // Stress pro Sekunde
};

// Was auf dem Notizzettel steht — ein Fetzen je Entziffern, max. drei.
const NOTEN = ['…Ankunft…', '…nicht öffnen…', '…sie hören zu…'];

// Sichtstufen (Paket I): Sehen ≠ Verstehen. Ungesehen fehlt im Prompt,
// bemerkt zeigt nur „?", vermutet eine Vermutung („Eine Art Turm?"),
// klar erkennt (Namen entdecken). Verstehen braucht Untersuchen vor Ort.
let SICHT = {
  fernWeit: { winkel: 160, dist: 30 },   // peripheres Bemerken: da ist etwas
  fernEng:  { winkel: 45,  dist: 40 },   // fokussiertes Bemerken: weiter, aber schmal
  mittel:   { winkel: 100, dist: 20 },   // erkennen: Vermutung
  nah:      { winkel: 90,  dist: 5 },    // genau erkennen: Name
  kontakt:  3,                            // Stolperradius: rundum klar
  vorlauf:  1,                            // Erkennung greift 1 m VOR dem Halt — erst sehen, dann stehenbleiben
};
// Übergang: alte Form {vage, klar, nah, winkel} mappen, damit eigene
// Experimente nicht mit TypeError abstürzen (z. B. halb-syncte Config).
if (SICHT.fernWeit === undefined && SICHT.vage !== undefined) {
  console.warn('[config] alte SICHT-Form erkannt — wird gemappt, bitte prüfen');
  SICHT = {
    fernWeit: { winkel: SICHT.winkel ?? 160, dist: SICHT.vage },
    fernEng: { winkel: 45, dist: Math.max(SICHT.vage, 40) },
    mittel: { winkel: 100, dist: SICHT.klar },
    nah: { winkel: 90, dist: SICHT.nah },
    kontakt: 3,
    vorlauf: 1,
  };
}

const VAGUE_HINTS = {
  capsule: 'ein runder Bau',
  shade: 'eine dunkle Platte',
  wreck: 'ein dunkler Klumpen',
  field: 'etwas Grünliches am Boden',
  mast: 'eine Art Turm',
  note: 'irgendetwas Kleines auf dem Boden',
  kuppel: 'eine blasse Kuppel',
  bake: 'ein dünner Stab',
};

// Winkelabstand zwischen Blickrichtung und Ziel, 0..π
function winkelAbstand(pilot, e) {
  let diff = Math.abs(Math.atan2(e.pos_x - pilot.pos_x, e.pos_z - pilot.pos_z) - pilot.heading)
    % (Math.PI * 2);
  if (diff > Math.PI) diff = Math.PI * 2 - diff;
  return diff;
}

/**
 * Sichtstufe eines Orts aus Pilotensicht: 'klar' | 'vermutet' | 'bemerkt' | 'ungesehen'.
 * heading ist atan2(dx, dz); NULL heißt umschauen (Rundumblick).
 * Fern gibt es doppelt: breit + kurz (peripher) oder schmal + weit (Fokus).
 * Reine Funktion — ohne Modell und DB testbar.
 */
function sichtStufe(pilot, e) {
  const d = Math.hypot(e.pos_x - pilot.pos_x, e.pos_z - pilot.pos_z);
  if (d <= SICHT.kontakt) return 'klar';                    // Stolpern geht auch hinterm Rücken
  const grad = pilot.heading == null
    ? 0
    : winkelAbstand(pilot, e) * 180 / Math.PI;
  if (grad <= SICHT.nah.winkel / 2 && d <= SICHT.nah.dist + SICHT.vorlauf) return 'klar';
  if (grad <= SICHT.mittel.winkel / 2 && d <= SICHT.mittel.dist) return 'vermutet';
  if ((grad <= SICHT.fernWeit.winkel / 2 && d <= SICHT.fernWeit.dist)
    || (grad <= SICHT.fernEng.winkel / 2 && d <= SICHT.fernEng.dist)) return 'bemerkt';
  return 'ungesehen';
}

function richtungWort(pilot, e) {
  if (pilot.heading == null) return 'um dich herum';
  const grad = winkelAbstand(pilot, e) * 180 / Math.PI;
  if (grad < 30) return 'vor dir';
  if (grad < 90) return 'seitlich von dir';
  return 'hinter dir';
}

// Erkanntheitsgrad: einmal Erkanntes vergisst er nicht — Schilder zeigen den
// höchsten je erreichten Grad, auch hinter seinem Rücken (DB-Spalte `sicht`).
const STUFE_RANG = { ungesehen: 0, bemerkt: 1, vermutet: 2, klar: 3 };
function entityLabel(pilot, e) {
  const a = ankerPos(e);
  const stufe = sichtStufe(pilot, { pos_x: a.pos_x, pos_z: a.pos_z });
  const rang = Math.max(STUFE_RANG[stufe] ?? 0, e.sicht ?? 0);
  if (rang <= 0) return null;
  if (rang === 1) return '?';
  if (rang === 2) {
    const w = VAGUE_HINTS[e.type] || 'etwas';
    return w.charAt(0).toUpperCase() + w.slice(1) + '?';
  }
  return e.name;
}

// Halt-Abstand: stehenbleiben, sobald das Ziel den Nahkreis berührt —
// nicht hineingehen. Ausnahmen: schlafen geht unter Dach, rennen will hindurch.
const HALT_ABSTAND = { sleep: 1.0, run_wild: 0.5 };
function haltAbstand(action) {
  return HALT_ABSTAND[action] ?? SICHT.nah.dist;
}

// --- Tod und Neustart ------------------------------------------------------
const RESPAWN_DELAY_S = 600;
const START = { hunger: 30, exhaustion: 20, stress: 25 };

// --- Modell ----------------------------------------------------------------
const MODEL = {
  baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions',
  name: process.env.AIQUARIUM_MODEL || 'google/gemma-4-26b-a4b-it',
  timeoutMs: 30000,
  temperature: 0.85,
  retryTemperature: 0.55,
  maxWords: 14,
  maxWordsMusing: 10,
  maxBeliefs: 3,
  jaccardMax: 0.65,
  exclamationWindow: 5,
};

const WORLD_RADIUS = 60;
const PLANET_R = 120;      // Anzeige-Radius; 1 Weltmeter bleibt 1 Meter (Bogenlänge)

// Acht Orte (v0.1). Koordinaten in Metern, Kapsel im Ursprung.
// Abstände bewusst groß (≥ 25 m): Wege sind Teil des Spiels (Vorhaben).
const ENTITIES = [
  { id: 'capsule', type: 'capsule', name: 'Kapsel',        x: 0,    z: 0    },
  { id: 'shade',   type: 'shade',   name: 'Blechschatten', x: 22,   z: 14   },
  { id: 'wreck',   type: 'wreck',   name: 'Wrack',         x: -40,  z: 26   },
  { id: 'field',   type: 'field',   name: 'Karottenfeld',  x: 48,   z: -18  },
  { id: 'mast',    type: 'mast',    name: 'Funkmast',      x: -12,  z: -52  },
  { id: 'note',    type: 'note',    name: 'Notizzettel',   x: 30,   z: 38   },
  { id: 'kuppel',  type: 'kuppel',  name: 'Gewächskuppel', x: 54,   z: 8    },
  { id: 'bake',    type: 'bake',    name: 'Notfunkbake',   x: -30,  z: -34  },
];

// Anker: das Bauwerk steht versetzt zum Logikpunkt, damit die Figur nicht im
// Mesh steht. Engine und Prompt rechnen mit der SICHTBAREN Position (ankerPos),
// die DB behält Logikkoordinaten — keine Migration nötig.
const VERSATZ = {
  capsule: [3.4, 3.0], shade: [4, 2], wreck: [10, -6], field: [0, 0],
  mast: [2, 3], note: [-2, 1], kuppel: [5.5, 0], bake: [2.5, 1.5],
};

function ankerPos(e) {
  const off = VERSATZ[e.type] || [0, 0];
  const px = e.pos_x ?? e.x;   // DB-Zeilen (pos_x) und Config-Orte (x) gehen beide
  const pz = e.pos_z ?? e.z;
  return { pos_x: px + off[0], pos_z: pz + off[1] };
}

module.exports = {
  TICK_MS, CATCHUP_MAX_H, CATCHUP_WRITE_EVERY, CATCHUP_MAX_TICKS,
  DRAIN, SUN_COST, EFFECT, effectFor, SHADE, EAT_FULL, EARTH, SATT,
  ACTIONS, WALK_SPEED, STRESS, NOVELTY, NOTEN, SICHT, VAGUE_HINTS, sichtStufe, richtungWort,
  ankerPos, STUFE_RANG, entityLabel, haltAbstand,
  RESPAWN_DELAY_S, START, MODEL, WORLD_RADIUS, PLANET_R, ENTITIES,
};

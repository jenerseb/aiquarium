'use strict';
// Zentrale Konstanten. Zwei Kernwerte:
// Körper (body, 0..100, hoch = gut, 0 = tot) und Psyche (psyche, -100..+100).

const TICK_MS = 1000;                 // Simulationstakt (eine Sekunde Simulationszeit)
const FREEZE_S = 60;                  // längere Ausfälle werden eingefroren, nicht nachsimuliert
const CATCHUP_WRITE_EVERY = 60;       // während Mini-Catch-up nur alle 60 Ticks schreiben

// --- Verbrauch pro Sekunde -------------------------------------------------
const DRAIN = {
  body: 0.025,        // 100 -> 0 in ~67 min ohne Essen (passiver Grundverbrauch)
};
const MOVE_COST = 0.1;   // Körper pro gelaufenem Meter (30 m Weg ≈ 3 Körper)

// --- Wirkung pro Sekunde (Körper: hoch = gut, Psyche: hoch = gut) -----------
const EFFECT = {
  eat:        { body: +0.506 },
  sleep:      { body: +0.043, psyche: +0.0043 },
  sit_shade:  {},                                    // vollständig in effectFor()
  inspect:    { body: -0.012, psyche: +0.008 },
  look_earth: {},                                    // verfeinert in effectFor()
  dig:        { body: -0.024, psyche: +0.002 },
  search_wrack: { body: -0.012, psyche: +0.006 },
  read_note:  { psyche: +0.008 },
  check_stock: {},                                   // nur Info, keine Wirkung
  tend_dome:  { body: +0.15, psyche: +0.004 },
  call_bake:  { body: -0.004, psyche: -0.002 },
  streifen:   { body: -0.008, psyche: +0.002 }, // Umherschweifen kostet Beine, hebt den Kopf
  sinnieren:  {},                                    // nur Denken; Monotonie-Bremse fängt Spam
  run_wild:   { body: -0.005, psyche: -0.001 },
  idle:       {},
};

// Sitzen hilft nur, wenn der Körper Ruhe braucht (Defizit = 100 - body).
// Wer fit sitzt, dem wird langweilig und die Stimmung sinkt.
const SHADE = { min: 25, full: 85, gainPerS: 0.040, boredPerS: 0.0027, comfortPerS: 0.0027 };
// Über diesem Körperstand passt nichts mehr rein (Völlerei bringt nichts).
const EAT_FULL = 95;
// Sehnsucht nach der Erde hilft nur, wenn die Psyche unten ist.
const EARTH = { minPsyche: -20, gainPerS: 0.006, idlePerS: 0.003 };

/**
 * Zustandsabhängige Wirkung einer Aktion pro Sekunde.
 * Hier steckt die Spiel-Logik: eine Aktion bleibt wählbar, bringt aber nur etwas,
 * wenn der Körper sie gerade braucht.
 */
function effectFor(action, pilot) {
  if (action === 'sit_shade') {
    const defizit = 100 - pilot.body;
    const anteil = Math.max(0, Math.min(1,
      (defizit - SHADE.min) / (SHADE.full - SHADE.min)));
    if (defizit < SHADE.min) return { psyche: -SHADE.boredPerS };   // fit sitzen langweilt
    return { body: +SHADE.gainPerS * anteil, psyche: +SHADE.comfortPerS };
  }
  if (action === 'look_earth') {
    // Paket K: Erde schauen erdet (halt), nicht die Psyche direkt.
    // halt-Regeneration (+5) steht beim Aktionsabschluss; hier nur der
    // Sofort-Trost bei niedrigem halt, sonst leichte Ernüchterung.
    return { psyche: (pilot.halt ?? 80) < 60 ? +EARTH.gainPerS : -EARTH.idlePerS };
  }
  if (action === 'eat') {
    if (pilot.body >= EAT_FULL) return {};                          // voll ist voll
    if (pilot.body < 50) return { body: +0.506, psyche: +0.01 };    // gutes Essen bei Bedarf
    return EFFECT.eat;
  }
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
  // hide_capsule: Rückzug in die Kapsel bei Wahn (sicherer Ort, Gegenstück zum
  // Wegrennen). Neue Aktion aus Paket K, Spec 2026-11-13 — nur im Wahn wählbar.
  hide_capsule: { dur: 90, needs: ['capsule'],           label: 'in die Kapsel flüchten' },
};

// Sättigung: Faktor je Durchgang — nach wenigen Wiederholungen wirkt die
// Aktion kaum noch. Zählt über die Neugier-Tabelle, kein neues Schema.
const SATT = {
  read_note: [1, 0.35, 0.1],
  tend_dome: [1, 0.5, 0.2],
};

const WALK_SPEED = 1.0;             // Meter pro Sekunde

// --- Psyche ----------------------------------------------------------------
const PSYCHE = {
  low: -60,          // darunter schrumpft die Whitelist aufs Nötigste
  collapse: -100,     // hier: Stupor (chronisch) oder Wahn (akut)
  recover: -60,       // darüber zurück auf "klar"
  monotony_penalty: 8,
  knock_penalty: 12,
  force_sleep_stupor_s: 6 * 3600,
  force_sleep_wahn_s: 3 * 3600,
};

// --- Manie: bei +100 kurz unaufhaltsam, danach Zwangs-Rückfall auf +75 -----
const MANIA = {
  at: 100,            // Auslöser
  ticks: 5 * 60,      // Dauer in Simulationstakt
  settle: 75,         // danach automatisch hierher
  tempo: 0.7,         // Aktionsdauer-Faktor (schneller)
  walk: 1.4,          // Gehtempo-Faktor
  cost: 1.5,          // Körperkosten-Faktor (Euphorie zehrt)
};

// --- Paket K: Level-2-Treiber (steuern Vorhaben, Whitelist, Zonen) -----------
// Alle Zahlen aus der Spec (01 Umsetzung, Paket K). Tag/Nacht-Anteil folgt erst
// mit dem Tag/Nacht-Punkt — thermo läuft bis dahin nur über den Orts-Anteil.
const TREIBER = {
  hunger: {
    start: 15, min: 0, max: 100,
    passiv: 0.0025,        // steigt pro Sekunde
    bodyRegen: 0.0015,     // body-Regeneration, wenn hunger < 35 (und ausgeruht)
    bodyDrain: 0.0020,     // body-Drain ab hunger > 50
    bodyDrainStark: 0.0050, // starker Drain ab hunger > 80
    eatMinus: 30,          // eat senkt hunger um 30
    schwelleEat: 45,       // eat verfügbar ab hunger > 45 (Paket A)
    schwelleVorhaben: 45,  // Vorhaben field ab hunger > 45
  },
  thermo: {
    start: 0, min: -100, max: 100,
    komfort: 30,           // -30..+30 neutral
    drainAb: 40,           // ab |thermo| > 40 leichter body-Drain + psyche-Abzug
    drainStarkAb: 75,      // ab |thermo| > 75 starker body-Drain
    // Orts-Anteil: shade kühlt, capsule wärmt
    ortRate: 0.05,         // pro Sekunde Richtung 0 am passenden Ort
    // Licht-Anteil (Tag/Nacht): Sonne wärmt bei Licht, Nacht kühlt schneller
    lichtAnteil: 0.02,     // pro Sekunde Richtung warm bei Licht
    nachtAnteil: 0.03,     // pro Sekunde Richtung kalt bei Nacht
  },
  drang: {
    start: 10, min: -100, max: 100,
    // Novelty hebt (Paket F/G/J), Monotonie senkt — Raten stehen bei NOVELTY
    wirkAb: 30,            // |drang| > 30 zieht psyche Richtung +100/-100
  },
  halt: {
    start: 80, min: 0, max: 100,
    stabilAb: 60,          // halt > 60 stabilisiert psyche Richtung 0
    wahnUnter: 40,         // halt < 40 zieht psyche stark nach unten (akut → Wahn)
    // Regeneration: look_earth, nachdenken (Paket D), sleep in capsule, Rituale (L4)
  },
};

// --- Tag/Nacht: wandernde Lichtkante + Erde-Tor --------------------------------
// Kein globaler Tag — die Kugel rotiert unter der Sonne. Helligkeit ist lokal:
// licht(punkt) = Skalarprodukt aus Ortsnormale und Sonnenvektor.
// +1 Mittag, 0 Dämmergürtel, -1 Mitternacht. Der Dämmergürtel (|licht| < 0.2)
// wandert mit der Sonne; der Pilot kann ihm davonlaufen (1 m/s > 0,05 m/s Kante).
const TAG = {
  dauerS: 7200,          // eine Umdrehung = 2 h (Tag + Nacht)
  neigungGrad: 30,       // geneigte Sonnenbahn, damit die Orte-Kappe echten Wechsel erlebt
  daemmerBis: 0.2,       // |licht| darunter = Dämmerung
};

// Sonnenvektor aus Winkel: geneigte Kreisbahn (Neigung um die X-Achse).
// Neigung um X, nicht exakt um Y — die Orte-Kappe (alle pos_y ≈ +120) erlebt
// sonst ewige Dämmerung statt Wechsel. Der Südpol (leer) kriegt Polartag/-nacht.
function sonnenVektor(winkel) {
  const n = (TAG.neigungGrad * Math.PI) / 180;
  const x = Math.cos(winkel);
  const y0 = Math.sin(winkel);
  return { x, y: y0 * Math.cos(n), z: y0 * Math.sin(n) };
}

// Lokale Helligkeit an einem Kugelpunkt (-1..+1). Reine Funktion, testbar.
function lichtAn(punkt, sonne) {
  const p = norm3(vec3(punkt));
  const l = Math.hypot(sonne.x, sonne.y, sonne.z) || 1;
  return (p.x * sonne.x + p.y * sonne.y + p.z * sonne.z) / l;
}

// Phasenwort für Prompt und HUD — keine Zahlen, keine Werte-Namen.
function lichtPhase(licht) {
  if (licht > TAG.daemmerBis) return 'licht';
  if (licht < -TAG.daemmerBis) return 'nacht';
  return 'daemmer';
}

// Tageszähler: Sonnen-Umdrehungen seit Start (global, nicht lokal).
function tagesNummer(winkel) {
  return Math.floor(winkel / (Math.PI * 2)) + 1;
}

// --- Erde: fester Himmelsvektor, Sichtbarkeit ist lokal ------------------------
// V1: Die Erde hängt fest, der Planet dreht sich darunter weg — ~1 h sichtbar,
// ~1 h weg pro 2-h-Tag. (V2-Idee: langsame Libration, steht in 01 Umsetzung.)
// Position AUF der Sonnenbahn (w = 45°): nur so gibt es echte Deckung
// (Finsternis). Mindestabstand sonst 0,46 rad — 8× über dem Deckungsfenster.
const ERDE = { x: 0.7071, y: 0.6124, z: 0.3536 };   // sonnenVektor(45°) bei 30° Neigung, normiert
const ERDE_HORIZONT = 0.15;   // so weit über der Kante muss sie stehen

// Ist die Erde vom Punkt aus zu sehen? Reine Funktion, testbar.
function erdeSichtbarVon(punkt) {
  const p = norm3(vec3(punkt));
  const l = Math.hypot(ERDE.x, ERDE.y, ERDE.z) || 1;
  return (p.x * ERDE.x + p.y * ERDE.y + p.z * ERDE.z) / l > ERDE_HORIZONT;
}

// --- Finsternis: Deckung in 4 Stufen (simplifiziert, kein Verlauf) --------------
// Winkeltreu, nicht maßstabstreu: Sonne (Radius 10) + Erde (Radius 40) stehen
// auf derselben Schale (×900). Deckung = Richtungsabstand < (10+40)/900.
// Stufen: 0 frei · 1 Anbiss (−20 % Licht) · 2 halb (−50 %) · 3 total (Nachtwerte).
// Reine Funktion: zwei Vektoren rein, Stufe + Faktoren raus. Testbar ohne DB.
const FINSTERNIS = {
  schale: 900,
  sonneRadius: 10,
  erdeRadius: 40,
  grenze1: 0.1, grenze2: 0.5, grenze3: 0.9,   // Deckungsgrad-Grenzen
  sonneFaktor: [1, 0.8, 0.5, 0],              // Multiplikator fürs Sonnenlicht
  hemiFaktor: [1, 1, 0.7, 0],                 // Multiplikator fürs Himmelslicht
  worte: [null, 'Anbiss', 'Halbbedeckt', 'Finsternis'],
  saetze: [null,
    'Die Erde schiebt sich vor die Sonne.',
    'Die Sonne ist halb bedeckt.',
    'Finsternis — es ist dunkel am hellen Tag.'],
};
function finsternisStufe(sonne, erdeVec = ERDE) {
  const l1 = Math.hypot(sonne.x, sonne.y, sonne.z) || 1;
  const l2 = Math.hypot(erdeVec.x, erdeVec.y, erdeVec.z) || 1;
  // Richtungsabstand (Winkel) zwischen Sonnen- und Erd-Richtung
  const cos = Math.max(-1, Math.min(1,
    (sonne.x * erdeVec.x + sonne.y * erdeVec.y + sonne.z * erdeVec.z) / (l1 * l2)));
  const abstand = Math.acos(cos);
  const deckung = (FINSTERNIS.sonneRadius + FINSTERNIS.erdeRadius) / FINSTERNIS.schale;
  if (abstand >= deckung) return { stufe: 0, grad: 0 };
  const grad = 1 - abstand / deckung;   // 0 streift, 1 deckungsgleich
  const stufe = grad >= FINSTERNIS.grenze3 ? 3 : grad >= FINSTERNIS.grenze2 ? 2 : 1;
  // Stufe 1 braucht Mindest-Deckung (Anbiss sichtbar), sonst 0
  if (stufe === 1 && grad < FINSTERNIS.grenze1) return { stufe: 0, grad };
  return { stufe, grad };
}

// --- Paket A: Vorhaben (Ziel + Weg aus echten Treibern) ----------------------
// Schwellen aus Paket K. Setzen nur wenn Distanz > setzenAb, löschen bei
// Ankunft (Distanz <= ankunftBei) oder wenn der Treiber über die Schwelle steigt.
const VORHABEN = {
  setzenAb: 8,        // Meter: erst ab dieser Distanz gibt es ein Vorhaben
  ankunftBei: 5,      // Meter: darunter gilt das Vorhaben als erreicht
  ziele: {
    hunger: { entity: 'field', fallback: 'capsule' },
    thermoHeiss: { entity: 'shade' },     // thermo > +40
    thermoKalt: { entity: 'capsule' },    // thermo < -40
    drang: { entity: null },              // nächstes Neues (Paket J verfeinert)
    halt: { entity: 'shade' },            // halt < 40
  },
};

// --- Neugier: der Motor für Erkundung --------------------------------------
const NOVELTY = {
  entity: [12, 4],      // 1. Besuch, 2. Besuch (ab dem 3. nichts mehr)
  entityAction: 8,      // Aktion an diesem Ort zum ersten Mal
  action: 6,            // Aktion überhaupt zum ersten Mal
  maxPsyche: 80,        // darüber keine Belohnung (sonst farmt er)
  boredBelow: -20,      // oberhalb wird Langeweile zum Druck
  boredAfterS: 600,     // 10 Minuten ohne Neues
  boredRate: 0.0015,    // Psyche pro Sekunde
};

// Was auf dem Notizzettel steht — ein Fetzen je Entziffern, max. drei.
const NOTEN = ['…Ankunft…', '…nicht öffnen…', '…sie hören zu…'];

// Sichtstufen (Paket I): Sehen ≠ Verstehen. Ungesehen fehlt im Prompt,
// bemerkt zeigt nur „?", vermutet eine Vermutung („Eine Art Turm?"),
// klar erkennt (Namen entdecken). Verstehen braucht Untersuchen vor Ort.
// Tag/Nacht: lichtFaktor 1 (Tag) … 0,5 (Nacht) — verkürzt alle Distanzen.
// Dämmerung interpoliert dazwischen (Faktor ~0,75). Der Stolperradius bleibt.
let SICHT = {
  fernWeit: { winkel: 120, dist: 15 },   // peripheres Bemerken: da ist etwas
  fernEng:  { winkel: 45,  dist: 30 },   // fokussiertes Bemerken: weiter, aber schmal
  mittel:   { winkel: 45, dist: 15 },   // erkennen: Vermutung
  nah:      { winkel: 45,  dist: 5 },    // genau erkennen: Name
  kontakt:  3,                            // Stolperradius: rundum klar
  vorlauf:  1,                            // Erkennung greift 1 m VOR dem Halt — erst sehen, dann stehenbleiben
};

// Leiter-Sanity: Stufen müssen sich staffeln, sonst greift die falsche zuerst.
// Nur Warnung — eine exotische Leiter darf trotzdem laufen.
{
  const s = SICHT, v = s.vorlauf || 0;
  const ok = s.kontakt < s.nah.dist + v && s.nah.dist + v <= s.mittel.dist
    && s.mittel.dist <= Math.max(s.fernWeit.dist, s.fernEng.dist)
    && s.mittel.dist < s.fernEng.dist
    && s.nah.winkel <= s.mittel.winkel && s.mittel.winkel < s.fernWeit.winkel;
  if (!ok) console.warn('[config] SICHT-Leiter überlappt — Stufen wirken anders als gedacht, bitte prüfen');
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

// --- 3D-Kugel-Geometrie ------------------------------------------------------
// Alle Positionen sind 3D-Vektoren auf der Kugel (Radius WORLD_RADIUS).
// Altbestände ohne pos_y werden auf die Kugel projiziert — kein Migrationsbruch.
function vec3(e) {
  // Drei Formen: gespeicherte pos_* (absolut) → direkt;
  // reine x/z-Werte (Config-Lokal) → clusterPos;
  // x/y/z-Tripel (Zwischenergebnis) → absolut wie es ist.
  if (e.pos_x != null && e.pos_y != null && e.pos_z != null) {
    return { x: e.pos_x, y: e.pos_y, z: e.pos_z };
  }
  if (e.x != null && e.y != null && e.z != null) {
    return { x: e.x, y: e.y, z: e.z };
  }
  if (e.x != null || e.z != null) return clusterPos(e.x ?? 0, e.z ?? 0);
  const x = e.pos_x ?? 0;
  const z = e.pos_z ?? 0;
  const y = Math.sqrt(Math.max(WORLD_RADIUS * WORLD_RADIUS - x * x - z * z, 0));
  return { x, y, z };
}

// Cluster lokal (Meter Ost/Nord um die Kapsel) → Kugelposition.
// Mitte = CLUSTER, lokale Achsen = Ost/Nord dort, Länge = Bogenmaß.
function clusterPos(lokalOst, lokalNord) {
  const rad = (d) => (d * Math.PI) / 180;
  const b0 = rad(CLUSTER.breite), l0 = rad(CLUSTER.laenge);
  // Mitte als Einheitsvektor
  const M = { x: Math.cos(b0) * Math.cos(l0), y: Math.sin(b0), z: Math.cos(b0) * Math.sin(l0) };
  // Tangentialrahmen an der Mitte: Ost + Nord
  const ost = { x: -Math.sin(l0), y: 0, z: Math.cos(l0) };
  const nord = { x: -Math.sin(b0) * Math.cos(l0), y: Math.cos(b0), z: -Math.sin(b0) * Math.sin(l0) };
  const px = M.x + ost.x * (lokalOst / WORLD_RADIUS) + nord.x * (lokalNord / WORLD_RADIUS);
  const py = M.y + ost.y * (lokalOst / WORLD_RADIUS) + nord.y * (lokalNord / WORLD_RADIUS);
  const pz = M.z + ost.z * (lokalOst / WORLD_RADIUS) + nord.z * (lokalNord / WORLD_RADIUS);
  const n = norm3({ x: px, y: py, z: pz });
  return { x: n.x * WORLD_RADIUS, y: n.y * WORLD_RADIUS, z: n.z * WORLD_RADIUS };
}
function norm3(v) {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
function skalar(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function klammer(v, lo = -1, hi = 1) { return Math.max(lo, Math.min(hi, v)); }

// Großkreis-Distanz in Metern zwischen zwei Kugelpunkten
function dist3(a, b) {
  const A = vec3(a), B = vec3(b);
  return WORLD_RADIUS * Math.acos(klammer(skalar(A, B) / (WORLD_RADIUS * WORLD_RADIUS)));
}

// Tangentialschritt: von P aus `meter` in Richtung Z, danach renormieren
function schritt3(P, Z, meter) {
  const p = vec3(P), z = vec3(Z);
  const n = norm3(p);
  const dx = z.x - p.x, dy = z.y - p.y, dz = z.z - p.z;
  const d = skalar({ x: dx, y: dy, z: dz }, n);
  let tx = dx - n.x * d, ty = dy - n.y * d, tz = dz - n.z * d;
  const l = Math.hypot(tx, ty, tz);
  if (l < 1e-9) return { ...p };   // Ziel deckungsgleich: stehenbleiben
  const s = Math.min(meter, l) / l;
  const q = { x: p.x + tx * s, y: p.y + ty * s, z: p.z + tz * s };
  const nq = norm3(q);
  return { x: nq.x * WORLD_RADIUS, y: nq.y * WORLD_RADIUS, z: nq.z * WORLD_RADIUS };
}

// Tangentialebene am Standpunkt: Ost/Nord für Anker-Versatz und Blickkegel
function tangentialRahmen(P) {
  const up = norm3(vec3(P));
  // Referenz: Welt-Nord, nur am Südpol (up.y < -0,99) weichen wir aus.
  // Der unvermeidliche Singularitätskreis (hairy ball) liegt damit am Südpol —
  // fernab aller Inhalte. Früher lag er bei 8° Polwinkel mitten im Geschehen
  // und ließ Anker beim Drüberlaufen metersweit springen.
  const ref = up.y < -0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const ost = norm3({
    x: up.y * ref.z - up.z * ref.y,
    y: up.z * ref.x - up.x * ref.z,
    z: up.x * ref.y - up.y * ref.x,
  });
  const nord = {
    x: up.y * ost.z - up.z * ost.y,
    y: up.z * ost.x - up.x * ost.z,
    z: up.x * ost.y - up.y * ost.x,
  };
  return { up, ost, nord };
}

/**
 * Sichtstufe eines Orts aus Pilotensicht: 'klar' | 'vermutet' | 'bemerkt' | 'ungesehen'.
 * heading ist ein tangentialer 3D-Richtungsvektor ([x,y,z]); NULL heißt umschauen.
 * Winkel über Skalarprodukt in der Tangentialebene — funktioniert überall auf der Kugel.
 * Reine Funktion — ohne Modell und DB testbar.
 */
function sichtWinkel(pilot, e) {
  const P = vec3(pilot), Z = vec3(e);
  const dist = WORLD_RADIUS * Math.acos(klammer(skalar(P, Z) / (WORLD_RADIUS * WORLD_RADIUS)));
  const h = pilot.heading;
  if (!h) return { dist, grad: 0 };   // umschauen: Rundumblick
  const n = norm3(P);
  const dx = Z.x - P.x, dy = Z.y - P.y, dz = Z.z - P.z;
  const d = dx * n.x + dy * n.y + dz * n.z;
  const tx = dx - n.x * d, ty = dy - n.y * d, tz = dz - n.z * d;
  const l = Math.hypot(tx, ty, tz);
  if (l < 1e-9) return { dist, grad: 0 };   // Ziel genau über/unter ihm
  const hl = Math.hypot(h[0], h[1], h[2]) || 1;
  const cos = klammer((tx * h[0] + ty * h[1] + tz * h[2]) / (l * hl));
  return { dist, grad: Math.acos(cos) * 180 / Math.PI };
}
function sichtStufe(pilot, e, lichtFaktor = 1) {
  const { dist: d, grad } = sichtWinkel(pilot, e);
  if (d <= SICHT.kontakt) return 'klar';                    // Stolpern geht auch hinterm Rücken
  const f = Math.max(0.5, Math.min(1, lichtFaktor));         // Nacht halbiert, Tag voll
  if (grad <= SICHT.nah.winkel / 2 && d <= SICHT.nah.dist * f + SICHT.vorlauf) return 'klar';
  if (grad <= SICHT.mittel.winkel / 2 && d <= SICHT.mittel.dist * f) return 'vermutet';
  if ((grad <= SICHT.fernWeit.winkel / 2 && d <= SICHT.fernWeit.dist * f)
    || (grad <= SICHT.fernEng.winkel / 2 && d <= SICHT.fernEng.dist * f)) return 'bemerkt';
  return 'ungesehen';
}

function richtungWort(pilot, e) {
  const { grad } = sichtWinkel(pilot, e);
  if (pilot.heading == null) return 'um dich herum';
  if (grad < 30) return 'vor dir';
  if (grad < 90) return 'seitlich von dir';
  return 'hinter dir';
}

// Erkanntheitsgrad: einmal Erkanntes vergisst er nicht — Schilder zeigen den
// höchsten je erreichten Grad, auch hinter seinem Rücken (DB-Spalte `sicht`).
const STUFE_RANG = { ungesehen: 0, bemerkt: 1, vermutet: 2, klar: 3 };
function entityLabel(pilot, e) {
  const a = ankerPos(e);
  const stufe = sichtStufe(pilot, a);
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
const START = { body: 100, psyche: 0 };

// --- Modell ----------------------------------------------------------------
// Default: Free-Tier-Modell. Gültiges Modell kommt bevorzugt aus der
// Umgebung (AIQUARIUM_MODEL in der .env überschreibt diesen Default).
const MODEL = {
  baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions',
  name: process.env.AIQUARIUM_MODEL || 'google/gemma-4-26b-a4b-it:free',
  timeoutMs: 30000,
  temperature: 0.85,
  retryTemperature: 0.55,
  maxWords: 20,          // Gedanken: höchstens 20 Wörter, 1–2 Sätze
  maxWordsMusing: 10,
  maxBeliefs: 3,
  jaccardMax: 0.65,
  exclamationWindow: 5,
};

// Kurzname fürs Log: nach dem letzten "/", vor dem nächsten "-"
// ("google/gemma-4-26b-a4b-it" → "gemma", "mimo-v2.6-pro" → "mimo").
function modellKurz(name = MODEL.name) {
  const nachSlash = String(name || '').split('/').pop();
  return nachSlash.split('-')[0] || nachSlash || '?';
}

const WORLD_RADIUS = 120;   // die GESAMTE Kugel ist begehbar (kein Polkappen-Ausschnitt mehr)
const PLANET_R = 120;      // Anzeige-Radius; 1 Weltmeter bleibt 1 Meter (Bogenlänge)

// Acht Orte (v0.1). Lokale Cluster-Koordinaten in Metern, Kapsel im Ursprung.
// Das Cluster hängt an CLUSTER (obere Hemisphäre, fernab beider Pole) —
// clusterPos() projiziert lokal → Kugel, vec3()/db.seed() nutzen das.
// Abstände bewusst groß (≥ 25 m): Wege sind Teil des Spiels (Vorhaben).
// Cluster-Mitte: 35° Breite, 20° Länge (obere Hemisphäre, kein Polkappen-Gedränge).
const CLUSTER = { breite: 35, laenge: 20 };
// Lokale Ausdehnung des Clusters (Meter Ost/Nord um die Mitte).
const CLUSTER_R = 60;
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
  capsule: [3.4, 3.0], shade: [4, 2], wreck: [8, -5], field: [0, 0],
  mast: [2, 3], note: [-2, 1], kuppel: [5.5, 0], bake: [2.5, 1.5],
};

function ankerPos(e) {
  // Anker: das Bauwerk steht versetzt zum Logikpunkt, in tangentialen METERN
  // (VERSATZ ist ein Meter-Offset, kein Skalar). Damit bleibt der Abstand
  // überall auf der Kugel gleich (früher skalierte er mit der Polnähe).
  const P = vec3(e);
  const { ost, nord } = tangentialRahmen(P);
  const off = VERSATZ[e.type] || [0, 0];
  const px = P.x + ost.x * off[0] + nord.x * off[1];
  const py = P.y + ost.y * off[0] + nord.y * off[1];
  const pz = P.z + ost.z * off[0] + nord.z * off[1];
  const n = norm3({ x: px, y: py, z: pz });
  return { pos_x: n.x * WORLD_RADIUS, pos_y: n.y * WORLD_RADIUS, pos_z: n.z * WORLD_RADIUS };
}

// Gedanken-Impulse: Die Engine würfelt pro Modellaufruf einen stilistischen
// Impuls (Gewichte hier, Texte in prompt.js) — Variation von innen, kein Retry.
const IMPULS_WAHL = [
  ['selbstgespraech', 30],   // Selbstgespräch oder offene Frage
  ['sinnlich', 30],          // körperlich-sinnliche Wahrnehmung
  ['galgen', 20],            // trockener Galgenhumor
  ['vorhaben', 20],          // Fokus auf das aktuelle Tun/Vorhaben
];
function wuerfelImpuls(zufall = Math.random) {
  const summe = IMPULS_WAHL.reduce((s, [, a]) => s + a, 0);
  let r = zufall() * summe;
  for (const [id, anteil] of IMPULS_WAHL) {
    r -= anteil;
    if (r < 0) return id;
  }
  return IMPULS_WAHL[0][0];
}

module.exports = {
  TICK_MS, FREEZE_S, CATCHUP_WRITE_EVERY,
  DRAIN, MOVE_COST, EFFECT, effectFor, SHADE, EAT_FULL, EARTH, SATT,
  ACTIONS, WALK_SPEED, PSYCHE, MANIA, TREIBER, VORHABEN, NOVELTY, NOTEN, SICHT, VAGUE_HINTS,
  vec3, norm3, dist3, schritt3, tangentialRahmen, sichtWinkel,
  sichtStufe, richtungWort, sonnenVektor, lichtAn, lichtPhase, tagesNummer,
  erdeSichtbarVon, TAG, ERDE, ERDE_HORIZONT, FINSTERNIS, finsternisStufe,
  ankerPos, VERSATZ, STUFE_RANG, entityLabel, haltAbstand, wuerfelImpuls, IMPULS_WAHL,
  RESPAWN_DELAY_S, START, MODEL, modellKurz, WORLD_RADIUS, PLANET_R, ENTITIES,
  CLUSTER, CLUSTER_R, clusterPos,
};

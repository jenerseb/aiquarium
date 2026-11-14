'use strict';
// Die Engine: einzige Wahrheit. Zwei Kernwerte: Körper (0..100, hoch = gut),
// Psyche (-100..+100).
const {
  DRAIN, MOVE_COST, effectFor, ACTIONS, WALK_SPEED, PSYCHE, MANIA, TREIBER, VORHABEN, START, NOVELTY, SATT, NOTEN,
  CATCHUP_WRITE_EVERY, FREEZE_S, RESPAWN_DELAY_S, MODEL, SICHT, sichtStufe, ankerPos,
  STUFE_RANG, entityLabel, haltAbstand, dist3, vec3, norm3, wuerfelImpuls, WORLD_RADIUS, modellKurz,
  TAG, sonnenVektor, lichtAn, lichtPhase, tagesNummer, erdeSichtbarVon, clusterPos, spawnPos,
  ERDE, FINSTERNIS, finsternisStufe,
} = require('./config');
const { q, logEvent } = require('./db');
const { uniqueName, randomHue, nextHue } = require('./names');
const { whitelistFor, buildPrompt, waehleMusingThema } = require('./prompt');
const { phraseBelief, fallbackText } = require('./belief');
const brain = require('./brain');

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const clampPsyche = (v) => Math.max(-100, Math.min(100, v));
// Treiber-Klammer: generisch für hunger/thermo/drang/halt mit eigenem min/max.
const klammerTreiber = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// --- Paket A: Vorhaben (Ziel + Weg aus echten Treibern) ----------------------
// Das Vorhaben ist eine Empfehlung im Prompt, kein Zwang — er darf abbiegen,
// das Vorhaben bleibt stehen, bis es erreicht ist oder der Treiber ok ist.
function leseVorhaben(pilot) {
  try {
    const v = JSON.parse(pilot.vorhaben_json || 'null');
    if (v && typeof v.ziel === 'string' && typeof v.grund === 'string') return v;
  } catch { /* kaputtes JSON — kein Vorhaben */ }
  return null;
}

function schreibeVorhaben(pilot, v) {
  pilot.vorhaben_json = v ? JSON.stringify(v) : '';
}

// Welcher Treiber ruft am lautesten? Reihenfolge = Dringlichkeit:
// hunger (Tod) > thermo (Drain) > halt (Wahn) > drang (Stupor schleichend).
function vorhabenBedarf(pilot) {
  if (pilot.mind_state !== 'klar') return null;
  if ((pilot.hunger ?? 15) > TREIBER.hunger.schwelleVorhaben) return { grund: 'hunger', ...VORHABEN.ziele.hunger };
  if ((pilot.thermo ?? 0) > TREIBER.thermo.drainAb) return { grund: 'thermoHeiss', ...VORHABEN.ziele.thermoHeiss };
  if ((pilot.thermo ?? 0) < -TREIBER.thermo.drainAb) return { grund: 'thermoKalt', ...VORHABEN.ziele.thermoKalt };
  if ((pilot.halt ?? 80) < TREIBER.halt.wahnUnter) return { grund: 'halt', ...VORHABEN.ziele.halt };
  if ((pilot.drang ?? 10) < -TREIBER.drang.wirkAb) return { grund: 'drang', ...VORHABEN.ziele.drang };
  return null;
}

// Weg-Text: reine Geometrie, keine Himmelsrichtungen (kein Kompass).
// „27 Schritte, hinter dem Wrack. Du kommst an der Kapsel vorbei."
function wegText(pilot, zielEntity, entities) {
  const zAnker = ankerPos(zielEntity);
  const dist = Math.round(dist3(pilot, zAnker));
  const bezug = sichtBezug(pilot, zielEntity, entities);
  const dazwischen = orteDazwischen(pilot, zAnker, entities, zielEntity.id);
  let weg = `${dist} Schritte${bezug}`;
  if (dazwischen.length) weg += `. Du kommst an ${dazwischen.join(' und ')} vorbei`;
  return weg;
}

// Bezug auf ein sichtbares Ding: „hinter dem Wrack", „neben der Kapsel".
// Artikel stehen im Ortsnamen-Kontext: Wir nutzen den bloßen Namen —
// „hinter Wrack" klingt falsch, also Map mit korrektem Dativ.
const ORT_DATIV = {
  capsule: 'der Kapsel', shade: 'dem Blechschatten', wreck: 'dem Wrack',
  field: 'dem Karottenfeld', mast: 'dem Funkmast', note: 'dem Notizzettel',
  kuppel: 'der Gewächskuppel', bake: 'der Notfunkbake',
};
function sichtBezug(pilot, ziel, entities) {
  let best = null;
  let bestD = Infinity;
  for (const e of entities) {
    if (e.id === ziel.id) continue;
    const a = ankerPos(e);
    const d = dist3(ankerPos(ziel), a);
    if (d < bestD && d < 40) { bestD = d; best = e; }
  }
  if (!best) return '';
  const praep = bestD < 12 ? 'neben' : 'hinter';
  return `, ${praep} ${ORT_DATIV[best.id] || best.name}`;
}

// Orte, die zwischen ihm und dem Ziel liegen (für „du kommst vorbei").
function orteDazwischen(pilot, zielAnker, entities, zielId) {
  const out = [];
  const gesamt = dist3(pilot, zielAnker);
  if (gesamt < 1) return out;
  for (const e of entities) {
    if (e.id === zielId) continue;
    const a = ankerPos(e);
    const d1 = dist3(pilot, a);
    const d2 = dist3(a, zielAnker);
    // Nahe an der Luftlinie und zwischen Start und Ziel
    if (d1 > 3 && d2 > 3 && d1 + d2 < gesamt + 6) out.push(ORT_DATIV[e.id] || e.name);
  }
  return out.slice(0, 2);
}

const SOMATIC = { minRuns: 3, minDelta: 0.2, maxTextAttempts: 3 };

// Manie aktiv? (manischer Schub nach psyche +100, danach Rückfall auf +75)
function istManie(pilot, tick) {
  return pilot.mania_until_tick != null && tick <= pilot.mania_until_tick;
}

function moveToward(pilot, target, dt, halt = 0.5, tempo = WALK_SPEED) {
  // Großkreis-Schritt auf der Kugel; Blick folgt der Gehrichtung (Paket I)
  const P = vec3(pilot), Z = vec3(target);
  const dx = Z.x - P.x, dy = Z.y - P.y, dz = Z.z - P.z;
  const n = norm3(P);
  const dN = dx * n.x + dy * n.y + dz * n.z;
  let tx = dx - n.x * dN, ty = dy - n.y * dN, tz = dz - n.z * dN;
  const l = Math.hypot(tx, ty, tz);
  const d = Math.acos(Math.max(-1, Math.min(1,
    (P.x * Z.x + P.y * Z.y + P.z * Z.z) / (WORLD_RADIUS * WORLD_RADIUS)))) * WORLD_RADIUS;
  if (d <= halt) return true;   // stehenbleiben, sobald das Ziel den Nahkreis berührt
  if (l < 1e-9) return true;
  const s = Math.min(d - halt, tempo * dt) / l;
  const qx = P.x + tx * s, qy = P.y + ty * s, qz = P.z + tz * s;
  const ql = Math.hypot(qx, qy, qz) || 1;
  pilot.pos_x = (qx / ql) * WORLD_RADIUS;
  pilot.pos_y = (qy / ql) * WORLD_RADIUS;
  pilot.pos_z = (qz / ql) * WORLD_RADIUS;
  pilot.heading = [tx / l, ty / l, tz / l];
  return d - Math.min(d - halt, tempo * dt) <= halt;
}

// --- Neugier: Neues belohnen ----------------------------------------------
// Merkt sich jede Begegnung. Belohnt wird nur, wenn es ihn überhaupt belastet —
// sonst ist er dauerhaft bei Stress 0 und die Neugier hat nichts zu tun.
function neuigkeit(state, key, weights, belohnen = true) {
  const eintrag = state.novelty[key] || { count: 0 };
  const stufe = eintrag.count;
  eintrag.count = stufe + 1;
  eintrag.last_tick = state.world.world_tick;
  state.novelty[key] = eintrag;

  let abzug = 0;
  if (stufe === 0) abzug = weights[0];
  else if (stufe === 1) abzug = weights[1];
  if (abzug > 0 && belohnen) {
    state.world.last_novelty_tick = state.world.world_tick;
    return abzug;
  }
  return 0;
}

function loadState(db) {
  const world = q.world(db);
  const pilot = q.pilot(db);
  if (pilot) {
    // Blick als Vektor zurück in den Speicher (NULL = umschauen)
    pilot.heading = pilot.heading_x != null
      ? [pilot.heading_x, pilot.heading_y, pilot.heading_z] : null;
  }
  const entities = q.entities(db);
  const recentActions = db.prepare("SELECT payload_json FROM events WHERE type='action' ORDER BY id DESC LIMIT 10")
    .all()
    .map((r) => { try { return JSON.parse(r.payload_json).action; } catch { return null; } })
    .filter(Boolean)
    .reverse();
  const allNames = db.prepare('SELECT name FROM pilots').all().map((r) => r.name);
  const novelty = {};
  if (pilot) {
    for (const n of q.novelty(db, pilot.id)) novelty[n.key] = { count: n.count, last_tick: n.last_tick };
  }
  const near = new Set(String((pilot && pilot.near_json) || '').split(',').filter(Boolean));
  // Nervenlage für den Zusammenbruch: Übergewicht der letzten 5 nerve_events
  const recentNerve = pilot ? q.recentNerve(db, pilot.id, 5) : [];

  // --- Tag/Nacht: Licht und Erde aus Welt-Winkel + Pilotenposition -------------
  // state.licht (-1..+1), state.phase (licht/daemmer/nacht), state.erde (bool).
  // Welt ohne Pilot (Tod): Sonne steht trotzdem, aber nichts ist zu sehen.
  // Finsternis: global (Himmel), nicht lokal — Stufe aus Sonnen- vs. Erd-Richtung.
  const winkel = (world && world.sun_angle != null) ? world.sun_angle : 0;
  const sonne = sonnenVektor(winkel);
  const licht = pilot ? lichtAn(pilot, sonne) : -1;
  const phase = lichtPhase(licht);
  const erde = pilot ? erdeSichtbarVon(pilot) : false;
  const finsternis = finsternisStufe(sonne).stufe;

  return { world, pilot, entities, recentActions, allNames, novelty, near, nerve: [], events: [], recentNerve,
    vorhaben: pilot ? leseVorhaben(pilot) : null, sonne, licht, phase, erde, finsternis };
}

function step(state, dt = 1, opts = {}) {
  const live = opts.live !== false;
  const { world, entities, events } = state;
  const pilot = state.pilot;
  const tick = world.world_tick + 1;
  world.world_tick = tick;

  // --- Tag/Nacht: Sonne wandert, eine Umdrehung pro TAG.dauerS -----------------
  // Der Winkel überlebt Neustarts (world_state.sun_angle) und läuft im
  // Catch-up normal mit (kein Freeze-Sonderfall — wie hunger).
  world.sun_angle = ((world.sun_angle ?? 0) + (dt * 2 * Math.PI) / TAG.dauerS) % (Math.PI * 2);
  state.sonne = sonnenVektor(world.sun_angle);
  // Finsternis: global, folgt der Sonne (kein Pilot nötig — Himmel, nicht Ort).
  state.finsternis = finsternisStufe(state.sonne).stufe;
  if (pilot) {
    state.licht = lichtAn(pilot, state.sonne);
    state.phase = lichtPhase(state.licht);
    state.erde = erdeSichtbarVon(pilot);
  }
  if (!pilot) return state;

  if (pilot.status === 'dead') {
    if (tick - (pilot.died_tick || tick) >= RESPAWN_DELAY_S) {
      state.pilot = spawn(state, tick, pilot);
      events.push({ type: 'spawn', in_feed: true,
        payload: { name: state.pilot.name, cycle: state.pilot.cycle_num } });
    }
    return state;
  }

  const def = ACTIONS[pilot.current_action];
  const rohZiel = pilot.target_entity ? entities.find((e) => e.id === pilot.target_entity) : null;
  const target = rohZiel ? { ...rohZiel, ...ankerPos(rohZiel) } : null;   // Anker: sichtbares Bauwerk anlaufen
  let walking = false;
  let acting = false;

  // Paket K, Wahn: body-Verbrauch ×1,5 (Startwert, Spec 2026-11-13).
  // Gilt für Gehen UND Aktionen. Manie und Wahn stapeln sich nicht —
  // beides gleichzeitig gibt es nicht (Manie braucht psyche +100, Wahn -100).
  const WAHN_KOSTEN = 1.5;
  const wahn = pilot.mind_state === 'wahn';

  if (def) {
    if (target) {
      const tempo = WALK_SPEED * (istManie(pilot, tick) ? MANIA.walk : 1);
      const dVor = dist3(pilot, target);
      const arrived = moveToward(pilot, target, dt, haltAbstand(pilot.current_action), tempo);
      const meter = Math.max(0, dVor - dist3(pilot, target));   // echte Meter, keine Schätzung
      if (!arrived) {
        walking = true;
        pilot.body -= MOVE_COST * meter * (istManie(pilot, tick) ? MANIA.cost : 1)
          * (wahn ? WAHN_KOSTEN : 1);
      } else {
        acting = true;
        if (!pilot.action_started_tick) {
          pilot.action_started_tick = tick;
          pilot.psyche_at_start = pilot.psyche;
        }
      }
    } else {
      acting = true;
      if (!pilot.action_started_tick) {
        pilot.action_started_tick = tick;
        pilot.psyche_at_start = pilot.psyche;
      }
    }
  }

  // Verbrauch: Grundlast immer, Gehen kostet extra pro Meter (Manie verteuert).
  const manie = istManie(pilot, tick);
  pilot.body -= DRAIN.body * dt;

  // --- Paket K: Level-2-Treiber -------------------------------------------
  // Reihenfolge: erst Manie-Zündung/Rückfall (Kern-Zustand, exakt),
  // dann Treiber-Dynamik. Treiber dürfen die Manie-Schwelle nicht im selben
  // Tick verwässern — sonst zündet +100 nie und der Rückfall landet bei 74,9.
  if (pilot.psyche >= MANIA.at && !manie) {
    pilot.mania_until_tick = tick + MANIA.ticks;
    events.push({ type: 'mind', in_feed: true, payload: { state: 'manie' } });
  } else if (pilot.mania_until_tick != null && tick > pilot.mania_until_tick) {
    pilot.mania_until_tick = null;
    pilot.psyche = MANIA.settle;
    pilot._manieRueckfall = true;   // frischer Rückfall: Stabilisator pausiert einen Tick
    events.push({ type: 'mind', in_feed: true, payload: { state: 'klar' } });
  }
  // hunger steigt passiv; thermo/drang/halt folgen unten ihren eigenen Regeln.
  // Tag/Nacht-Anteil von thermo folgt erst mit dem Tag/Nacht-Punkt.
  pilot.hunger = klammerTreiber((pilot.hunger ?? TREIBER.hunger.start) + TREIBER.hunger.passiv * dt,
    TREIBER.hunger.min, TREIBER.hunger.max);
  // hunger frisst oder heilt den Körper (Kopplung Treiber -> Kern)
  if (pilot.hunger > 80) pilot.body -= TREIBER.hunger.bodyDrainStark * dt;
  else if (pilot.hunger > 50) pilot.body -= TREIBER.hunger.bodyDrain * dt;
  else if (pilot.hunger < 35) pilot.body += TREIBER.hunger.bodyRegen * dt;
  // thermo-Drain ab |40| / |75| (Orts-Anteil steht weiter unten bei den Orten)
  const thermoAbs = Math.abs(pilot.thermo ?? 0);
  if (thermoAbs > TREIBER.thermo.drainStarkAb) pilot.body -= 0.004 * dt;
  else if (thermoAbs > TREIBER.thermo.drainAb) pilot.body -= 0.001 * dt;
  // drang zieht psyche Richtung Manie/Stupor, halt stabilisiert oder zieht zu Wahn.
  // Stabilisator greift nur oberhalb von recover und unterhalb der Manie —
  // Zusammenbruch und Manie gehören dem Kern, nicht den Treibern.
  if ((pilot.drang ?? 0) > TREIBER.drang.wirkAb) pilot.psyche += 0.002 * dt;
  else if ((pilot.drang ?? 0) < -TREIBER.drang.wirkAb) pilot.psyche -= 0.002 * dt;
  if (!pilot._manieRueckfall && (pilot.halt ?? 80) > TREIBER.halt.stabilAb && pilot.psyche > PSYCHE.recover
      && pilot.psyche < MANIA.at && pilot.mania_until_tick == null) {
    pilot.psyche += (0 - pilot.psyche) * 0.001 * dt;
  } else if ((pilot.halt ?? 80) < TREIBER.halt.wahnUnter) {
    pilot.psyche -= 0.004 * dt;
  }

  // Wirkung der Aktion; Manie verteuert körperliche Kosten
  if (acting && def) {
    const eff = effectFor(pilot.current_action, pilot);
    const saettigung = SATT[pilot.current_action];
    if (saettigung) {
      const n = (state.novelty[`action:${pilot.current_action}`] || { count: 0 }).count;
      const f = saettigung[Math.min(n, saettigung.length - 1)];
      for (const k of Object.keys(eff)) eff[k] *= f;
    }
    for (let [k, v] of Object.entries(eff)) {
      if (manie && k === 'body' && v < 0) v *= MANIA.cost;
      if (wahn && k === 'body' && v < 0) v *= WAHN_KOSTEN;
      pilot[k] += v * dt;
    }
    // Paket K: eat senkt hunger (Kopplung Aktion -> Treiber)
    if (pilot.current_action === 'eat') {
      pilot.hunger = klammerTreiber((pilot.hunger ?? TREIBER.hunger.start) - TREIBER.hunger.eatMinus * (dt / (def.dur || 40)),
        TREIBER.hunger.min, TREIBER.hunger.max);
    }
  }

  // Ort betreten: nur was klar zu sehen ist, zählt als Ankunft (Paket I).
  // Gerechnet wird mit der sichtbaren Position (Anker), nicht dem Logikpunkt.
  // Der Erkanntheitsgrad wächst bei jedem Kontakt — und bleibt (kein Vergessen).
  state.near = state.near || new Set();
  const jetztNah = new Set();
  for (const roh of entities) {
    const e = { ...roh, ...ankerPos(roh) };
    const stufe = sichtStufe(pilot, e);
    const rang = STUFE_RANG[stufe] ?? 0;
    if (rang > (roh.sicht || 0)) roh.sicht = rang;
    if (stufe !== 'klar') continue;
    jetztNah.add(String(e.id));
    if (!roh.discovered) {
      roh.discovered = 1;
      events.push({ type: 'discovery', in_feed: true, payload: { id: e.id, name: e.name } });
      // Betrachtungsbedarf: Beim nächsten Nachdenken fragt er sich,
      // was man damit wohl anfangen kann (kein Hardcode — nur die Richtung).
      roh.unfinished_thought = e.name;
    }
    if (!state.near.has(String(e.id))) {
      const abzug = neuigkeit(state, `entity:${e.id}`, NOVELTY.entity,
        pilot.psyche < NOVELTY.maxPsyche);
      if (abzug) {
        pilot.psyche += abzug;
        // Paket K: Orts-Neugier hebt drang
        pilot.drang = klammerTreiber((pilot.drang ?? TREIBER.drang.start) + abzug,
          TREIBER.drang.min, TREIBER.drang.max);
        events.push({ type: 'novelty', in_feed: false,
          payload: { key: `entity:${e.id}`, psyche: +abzug } });
      }
    }
  }
  state.near = jetztNah;
  pilot.near_json = [...jetztNah].join(',');

  // Aktion fertig? (Manie verkürzt die Dauer; Wahn lässt Aktionen scheitern)
  const sollDauer = (acting && pilot.action_duration_s) || (def ? def.dur : 0);
  if (def && acting && pilot.action_started_tick &&
      tick - pilot.action_started_tick >= sollDauer) {
    // Paket K, Wahn: Aktionen scheitern zu 50 % (Startwert, Spec 2026-11-13).
    // Kein Würfel-Tod — nur verschenkte Zeit: kein Effekt, kein Fund, kein Belief.
    // noRandom in Tests schaltet das Scheitern ab (deterministisch).
    if (wahn && !opts.noRandom && Math.random() < 0.5) {
      events.push({ type: 'action', in_feed: false,
        payload: { action: pilot.current_action, dur: sollDauer, psyche_delta: 0,
          entity: pilot.target_entity || null, wahn_scheitern: true } });
      state.recentActions.push(pilot.current_action);
      if (state.recentActions.length > 10) state.recentActions.shift();
      pilot.current_action = 'idle';
      pilot.target_entity = null;
      pilot.action_started_tick = null;
      pilot.psyche_at_start = null;
    } else {
    const delta = pilot.psyche - (pilot.psyche_at_start ?? pilot.psyche);
    events.push({ type: 'action', in_feed: false,
      payload: { action: pilot.current_action, dur: sollDauer, psyche_delta: delta,
        entity: pilot.target_entity || null } });
    state.recentActions.push(pilot.current_action);
    if (state.recentActions.length > 10) state.recentActions.shift();

    // Neues Tun belohnen — Paket K: hebt zusätzlich drang (Forscherdrang)
    {
      const belohnen = pilot.psyche < NOVELTY.maxPsyche;
      let abzug = neuigkeit(state, `action:${pilot.current_action}`, [NOVELTY.action, 0], belohnen);
      if (target) {
        abzug += neuigkeit(state, `at:${target.id}:${pilot.current_action}`,
          [NOVELTY.entityAction, 0], belohnen);
      }
      if (abzug) {
        pilot.psyche += abzug;
        pilot.drang = klammerTreiber((pilot.drang ?? TREIBER.drang.start) + abzug,
          TREIBER.drang.min, TREIBER.drang.max);
        events.push({ type: 'novelty', in_feed: false,
          payload: { key: `action:${pilot.current_action}`, psyche: +abzug } });
      }
    }

    // Fundstücke und Eigenheiten einzelner Aktionen
    {
      const anlass = pilot.current_action;
      const offen = pilot.psyche < NOVELTY.maxPsyche;
      if (anlass === 'search_wrack') {
        const fund = neuigkeit(state, 'find:wrack', [10, 0], offen);
        if (fund) {
          pilot.psyche += fund;
          events.push({ type: 'find', in_feed: true,
            payload: { id: 'wrack', text: 'Zwischen den Blechen: ein heiler Schraubenschlüssel.', pilot_id: pilot.id ?? null } });
        }
      }
      if (anlass === 'read_note') {
        const n = (state.novelty['action:read_note'] || { count: 0 }).count;
        if (n >= 1 && n <= NOTEN.length) {
          events.push({ type: 'note', in_feed: true, payload: { text: NOTEN[n - 1] } });
        }
      }
      if (anlass === 'call_bake') {
        events.push({ type: 'bake', in_feed: true, payload: {} });
      }
      if (anlass === 'check_stock') {
        const stunden = Math.max(0, pilot.body / DRAIN.body / 3600);
        events.push({ type: 'stock', in_feed: false,
          payload: { stunden: Math.round(stunden * 10) / 10 } });
      }
    }

    const ra = state.recentActions;
    if (ra.length >= 3 && ra.slice(-3).every((a) => a === ra[ra.length - 1])) {
      pilot.psyche -= PSYCHE.monotony_penalty;
      state.nerve.push({ kind: 'chronic', source: 'monotony', weight: PSYCHE.monotony_penalty });
      events.push({ type: 'nerve', in_feed: false, payload: { source: 'monotony' } });
    }

    // Paket K: halt-Regeneration — Erde schauen, Schlaf in der Kapsel und
    // sichere Rituale erden. (nachdenken aus Paket D und Tag/Nacht kommen dazu.)
    // Tag/Nacht (Erde-Tor): look_earth erdet voll (+5) nur bei sichtbarer Erde,
    // ins Leere starren gibt +2. Kein Psyche-Effekt — Sehnsucht braucht kein Licht.
    {
      const anlass = state.recentActions[state.recentActions.length - 1];
      const inKapsel = (target && target.id === 'capsule') || (rohZiel && rohZiel.id === 'capsule');
      let plus = 0;
      if (anlass === 'look_earth') plus = state.erde ? 5 : 2;
      else if (anlass === 'sleep' && inKapsel) plus = 8;
      if (plus) {
        pilot.halt = klammerTreiber((pilot.halt ?? TREIBER.halt.start) + plus,
          TREIBER.halt.min, TREIBER.halt.max);
      }
    }

    pilot.current_action = 'idle';
    pilot.target_entity = null;
    pilot.action_started_tick = null;
    pilot.psyche_at_start = null;
    }   // Ende Wahn-Scheitern-else (Erfolgspfad)
  }

  // Klopfen (akut): selten, unregelmäßig — senkt halt ruckartig (Paket K)
  if (!opts.noRandom && Math.random() < 1 / 2700) {
    pilot.psyche -= PSYCHE.knock_penalty;
    pilot.halt = klammerTreiber((pilot.halt ?? TREIBER.halt.start) - 15, TREIBER.halt.min, TREIBER.halt.max);
    state.nerve.push({ kind: 'acute', source: 'knock', weight: PSYCHE.knock_penalty });
    if (live) events.push({ type: 'knock', in_feed: false, payload: {} });
  }

  // Langeweile: nichts Neues und es geht ihm gut -> es zieht ihn runter.
  // Paket K: Monotonie senkt drang (chronisch -> Stupor), Novelty hebt drang.
  const seitNeuem = tick - (world.last_novelty_tick || 0);
  if (pilot.psyche > NOVELTY.boredBelow && seitNeuem > NOVELTY.boredAfterS) {
    pilot.psyche -= NOVELTY.boredRate * dt;
    pilot.drang = klammerTreiber((pilot.drang ?? TREIBER.drang.start) - 0.01 * dt,
      TREIBER.drang.min, TREIBER.drang.max);
  }

  // Paket K: thermo-Ortsanteil — shade kühlt bei Hitze, capsule wärmt bei Kälte.
  // Tag/Nacht: Licht wärmt, Nacht kühlt (schneller als der Tag wärmt) —
  // die Kapsel wird nachts zum Zuhause, der Schatten tagsüber zur Rettung.
  {
    const nahIds = state.near ? [...state.near] : [];
    const amShade = nahIds.includes('shade');
    const inCapsule = nahIds.includes('capsule');
    const t = pilot.thermo ?? 0;
    // shade kühlt, sobald es warm wird (ab +35 Richtung 0); capsule wärmt bei Kälte
    if (amShade && t > 35) {
      pilot.thermo = klammerTreiber(t - TREIBER.thermo.ortRate * dt, TREIBER.thermo.min, TREIBER.thermo.max);
    } else if (inCapsule && t < -35) {
      pilot.thermo = klammerTreiber(t + TREIBER.thermo.ortRate * dt, TREIBER.thermo.min, TREIBER.thermo.max);
    }
    // Licht-Anteil: Dämmerung ist neutral, Licht/Nacht ziehen Richtung warm/kalt.
    // In der Kapsel/im Schatten greift der Schutz: die Hälfte kommt noch durch
    // (ein Blech ist kein Bunker), draußen die volle Rate.
    // Finsternis: Stufe 3 schaltet den Licht-Anteil ab (nur Nacht kühlt noch),
    // Stufe 2 halbiert ihn, Stufe 1 (Anbiss) ändert nichts spürbar.
    const licht = state.licht ?? 0;
    const finst = state.finsternis ?? 0;
    const geschuetzt = amShade || inCapsule;
    const faktor = (geschuetzt ? 0.5 : 1) * (finst >= 3 ? 0 : finst >= 2 ? 0.5 : 1);
    if (licht > TAG.daemmerBis) {
      pilot.thermo = klammerTreiber((pilot.thermo ?? 0) + TREIBER.thermo.lichtAnteil * faktor * dt,
        TREIBER.thermo.min, TREIBER.thermo.max);
    } else if (licht < -TAG.daemmerBis) {
      pilot.thermo = klammerTreiber((pilot.thermo ?? 0) - TREIBER.thermo.nachtAnteil * faktor * dt,
        TREIBER.thermo.min, TREIBER.thermo.max);
    }
  }

  pilot.body = clamp(pilot.body);
  pilot.psyche = clampPsyche(pilot.psyche);
  // Paket K: Treiber klammern (hunger/thermo/drang/halt in ihren Bereichen)
  pilot.hunger = klammerTreiber(pilot.hunger ?? TREIBER.hunger.start, TREIBER.hunger.min, TREIBER.hunger.max);
  pilot.thermo = klammerTreiber(pilot.thermo ?? TREIBER.thermo.start, TREIBER.thermo.min, TREIBER.thermo.max);
  pilot.drang = klammerTreiber(pilot.drang ?? TREIBER.drang.start, TREIBER.drang.min, TREIBER.drang.max);
  pilot.halt = klammerTreiber(pilot.halt ?? TREIBER.halt.start, TREIBER.halt.min, TREIBER.halt.max);
  delete pilot._manieRueckfall;   // nur für diesen Tick

  // (Manie-Zündung/Rückfall steht oben bei den Treibern — Kern zuerst.)

  if (pilot.psyche <= PSYCHE.collapse && pilot.mind_state === 'klar') {
    // Stupor oder Wahn? Übergewicht der letzten 5 Nerven-Ereignisse entscheidet
    const verlauf = state.recentNerve || [];
    const chronic = verlauf.filter((n) => n.kind === 'chronic').reduce((s, n) => s + n.weight, 0);
    const acute = verlauf.filter((n) => n.kind === 'acute').reduce((s, n) => s + n.weight, 0);
    pilot.mind_state = acute > chronic ? 'wahn' : 'stupor';
    pilot.mind_state_since_tick = tick;
    pilot.current_action = 'idle';
    pilot.target_entity = null;
    pilot.action_started_tick = null;
    events.push({ type: 'mind', in_feed: true, payload: { state: pilot.mind_state } });
  } else if (pilot.psyche >= PSYCHE.recover && pilot.mind_state !== 'klar') {
    pilot.mind_state = 'klar';
    pilot.mind_state_since_tick = tick;
    events.push({ type: 'mind', in_feed: true, payload: { state: 'klar' } });
  }

  if (pilot.mind_state !== 'klar' && pilot.current_action === 'idle') {
    const limit = pilot.mind_state === 'stupor' ? PSYCHE.force_sleep_stupor_s : PSYCHE.force_sleep_wahn_s;
    if (tick - (pilot.mind_state_since_tick || tick) > limit) {
      pilot.current_action = 'sleep';
      pilot.action_started_tick = null;
      pilot.target_entity = 'shade';
      events.push({ type: 'force_sleep', in_feed: false, payload: {} });
    }
  }

  // --- Paket A: Vorhaben prüfen/setzen/löschen -------------------------------
  // Kein Vorhaben bei mind_state != klar. Löschen bei Ankunft oder wenn der
  // Treiber ok ist. Nie bei bloßem Aktionswechsel löschen.
  {
    const bedarf = vorhabenBedarf(pilot);
    let vorhaben = leseVorhaben(pilot);
    const zielEnt = (id) => entities.find((e) => e.id === id);
    if (vorhaben) {
      const z = zielEnt(vorhaben.ziel);
      const d = z ? dist3(pilot, ankerPos(z)) : Infinity;
      // Treiber ok? Dann Vorhaben erledigt — still löschen, kein Event.
      const treiberOk = vorhaben.grund === 'hunger' ? (pilot.hunger ?? 99) <= TREIBER.hunger.schwelleVorhaben
        : vorhaben.grund === 'thermoHeiss' ? (pilot.thermo ?? 0) <= TREIBER.thermo.drainAb
        : vorhaben.grund === 'thermoKalt' ? (pilot.thermo ?? 0) >= -TREIBER.thermo.drainAb
        : vorhaben.grund === 'halt' ? (pilot.halt ?? 0) >= TREIBER.halt.wahnUnter
        : vorhaben.grund === 'drang' ? (pilot.drang ?? 0) >= -TREIBER.drang.wirkAb
        : false;
      if (d <= VORHABEN.ankunftBei || treiberOk || !z) {
        vorhaben = null;
        schreibeVorhaben(pilot, null);
      }
    }
    if (!vorhaben && bedarf) {
      // Ziel auflösen: drang hat kein festes Ziel → nächstes Neues (vorerst Zufalls-Ort)
      let zielId = bedarf.entity;
      if (!zielId && bedarf.grund === 'drang') {
        const zufaellig = entities[Math.floor(Math.random() * entities.length)];
        zielId = zufaellig ? zufaellig.id : null;
      }
      if (!zielId && bedarf.fallback) zielId = bedarf.fallback;
      const z = zielId ? zielEnt(zielId) : null;
      // Fallback prüfen: field weit weg? Dann capsule.
      if (z && bedarf.fallback && bedarf.grund === 'hunger') {
        const dPrim = dist3(pilot, ankerPos(z));
        const fb = zielEnt(bedarf.fallback);
        if (fb && dPrim > 100) zielId = bedarf.fallback;
      }
      const ziel = zielId ? zielEnt(zielId) : null;
      if (ziel && dist3(pilot, ankerPos(ziel)) > VORHABEN.setzenAb) {
        vorhaben = { ziel: zielId, grund: bedarf.grund, seit_tick: tick };
        schreibeVorhaben(pilot, vorhaben);
      }
    }
    state.vorhaben = vorhaben;
  }

  if (pilot.body <= 0) {
    pilot.status = 'dead';
    pilot.cause_of_death = 'body';
    pilot.died_tick = tick;
    pilot.current_action = 'idle';
    events.push({ type: 'death', in_feed: true,
      payload: { cause: pilot.cause_of_death, name: pilot.name, tick } });
  }

  return state;
}

function spawn(state, tick, previous) {
  const existing = state.allNames || [];
  const name = uniqueName(existing);
  state.allNames = [...existing, name];
  state.novelty = {};                  // Neugier beginnt bei jedem Piloten neu
  const start = spawnPos();          // 10 m neben der Kapsel, nicht im Anker
  return {
    id: null,
    cycle_num: (previous?.cycle_num || 0) + 1,
    name,
    status: 'alive',
    mind_state: 'klar',
    body: START.body,
    psyche: START.psyche,
    hunger: 15.0,
    thermo: 0.0,
    drang: 10.0,
    halt: 80.0,
    vorhaben_json: '',
    pos_x: start.pos_x,
    pos_y: start.pos_y,
    pos_z: start.pos_z,
    heading: null,
    mania_until_tick: null,
    accent_hue: nextHue(previous?.accent_hue ?? null),
    current_action: 'idle',
    action_started_tick: null,
    action_duration_s: 0,
    target_entity: null,
    mind_state_since_tick: tick,
    cause_of_death: null,
    epitaph: null,
    created_tick: tick,
    died_tick: null,
    psyche_at_start: null,
  };
}

function savePilot(db, p) {
  if (!p) return p;
  if (p.id) {
    db.prepare(`UPDATE pilots SET status=?, mind_state=?, body=?, psyche=?,
      hunger=?, thermo=?, drang=?, halt=?,
      pos_x=?, pos_y=?, pos_z=?, heading_x=?, heading_y=?, heading_z=?, mania_until_tick=?,
      current_action=?, action_started_tick=?, target_entity=?,
      mind_state_since_tick=?, cause_of_death=?, died_tick=?, epitaph=?, psyche_at_start=?, near_json=?,
      vorhaben_json=?
      WHERE id=?`).run(
      p.status, p.mind_state, p.body, p.psyche,
      p.hunger ?? 15, p.thermo ?? 0, p.drang ?? 10, p.halt ?? 80,
      p.pos_x, p.pos_y ?? 120, p.pos_z, p.heading?.[0] ?? null, p.heading?.[1] ?? null, p.heading?.[2] ?? null,
      p.mania_until_tick ?? null,
      p.current_action, p.action_started_tick ?? null, p.target_entity ?? null,
      p.mind_state_since_tick ?? null, p.cause_of_death ?? null, p.died_tick ?? null,
      p.epitaph ?? null, p.psyche_at_start ?? null, p.near_json ?? '', p.vorhaben_json ?? '', p.id,
    );
  } else {
    const r = db.prepare(`INSERT INTO pilots (cycle_num, name, status, mind_state, body, psyche,
      hunger, thermo, drang, halt,
      pos_x, pos_y, pos_z, heading_x, heading_y, heading_z, mania_until_tick,
      accent_hue, current_action, action_started_tick, target_entity,
      mind_state_since_tick, created_tick, near_json, vorhaben_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      p.cycle_num, p.name, p.status, p.mind_state, p.body, p.psyche,
      p.hunger ?? 15, p.thermo ?? 0, p.drang ?? 10, p.halt ?? 80,
      p.pos_x, p.pos_y ?? 120, p.pos_z, p.heading?.[0] ?? null, p.heading?.[1] ?? null, p.heading?.[2] ?? null,
      p.mania_until_tick ?? null,
      p.accent_hue, p.current_action, p.action_started_tick ?? null,
      p.target_entity ?? null, p.mind_state_since_tick ?? null, p.created_tick, '', '',
    );
    p.id = Number(r.lastInsertRowid);
  }
  return p;
}

function updateSomatic(db, pilotId, action, delta) {
  if (!pilotId || !fallbackText(action, true)) return;
  const row = db.prepare(`SELECT * FROM pilot_mind
    WHERE pilot_id=? AND layer='somatic_theory' AND action_key=?`).get(pilotId, action);

  if (!row) {
    db.prepare(`INSERT INTO pilot_mind (pilot_id, layer, action_key, times_borne_out, avg_psyche_delta,
      belief_text, is_locked, needs_text, text_attempts)
      VALUES (?, 'somatic_theory', ?, 1, ?, '', 0, 0, 0)`).run(pilotId, action, delta);
    return;
  }

  const runs = row.times_borne_out + 1;
  const avg = (row.avg_psyche_delta * row.times_borne_out + delta) / runs;
  const reached = runs >= SOMATIC.minRuns && Math.abs(avg) >= SOMATIC.minDelta;
  const flipped = Math.sign(avg) !== Math.sign(row.avg_psyche_delta);
  const needsText = reached && (!row.belief_text || flipped) ? 1 : row.needs_text;

  db.prepare(`UPDATE pilot_mind SET times_borne_out=?, avg_psyche_delta=?, needs_text=? WHERE id=?`)
    .run(runs, avg, needsText, row.id);
}

class Engine {
  constructor(db, opts = {}) {
    this.db = db;
    this.apiKey = opts.apiKey || process.env.OPENROUTER_API_KEY || '';
    this.deciding = false;
    this.staleSince = null;
    this.lastSkew = 0;
    this.onTick = opts.onTick || (() => {});
    this.lastBrain = null;
  }

  state() {
    const s = loadState(this.db);
    if (!s.pilot) s.pilot = savePilot(this.db, spawn(s, s.world.world_tick, null));
    if (!s.pilot.id) s.pilot = savePilot(this.db, s.pilot);
    return s;
  }

  tick() {
    const s = this.state();
    step(s, 1, { live: true });
    savePilot(this.db, s.pilot);
    this.speichereNovelty(s);
    for (const e of s.entities) {
      if (e.discovered) this.db.prepare('UPDATE world_entities SET discovered=1 WHERE id=?').run(e.id);
      if ((e.sicht || 0) > 0) this.db.prepare('UPDATE world_entities SET sicht=? WHERE id=?').run(e.sicht, e.id);
      if (e.unfinished_thought) this.db.prepare('UPDATE world_entities SET unfinished_thought=? WHERE id=?')
        .run(e.unfinished_thought, e.id);
    }
    this.db.prepare('UPDATE world_state SET world_tick=?, last_tick_at=?, last_novelty_tick=?, sun_angle=? WHERE id=1')
      .run(s.world.world_tick, new Date().toISOString(), s.world.last_novelty_tick || 0, s.world.sun_angle ?? 0);
    for (const e of s.events) {
      logEvent(this.db, s.world.world_tick, e.type, e.payload, e.type === 'action' ? false : e.in_feed);
      if (e.type === 'action' && e.payload && typeof e.payload.psyche_delta === 'number') {
        updateSomatic(this.db, s.pilot.id, e.payload.action, e.payload.psyche_delta);
      }
    }
    for (const n of s.nerve) {
      this.db.prepare('INSERT INTO nerve_events (pilot_id, tick, kind, source, weight) VALUES (?,?,?,?,?)')
        .run(s.pilot.id ?? null, s.world.world_tick, n.kind, n.source, n.weight);
    }
    s.nerve = [];
    if (s.world.world_tick % 3600 === 0) this.prune();
    const needDecide = s.pilot.status === 'alive' && s.pilot.current_action === 'idle';
    this.onTick(s);
    return { state: s, needDecide, events: s.events };
  }

  speichereNovelty(s) {
    for (const [key, eintrag] of Object.entries(s.novelty || {})) {
      this.db.prepare(`INSERT INTO novelty (pilot_id, key, count, last_tick) VALUES (?,?,?,?)
        ON CONFLICT(pilot_id, key) DO UPDATE SET count=excluded.count, last_tick=excluded.last_tick`)
        .run(s.pilot.id ?? null, key, eintrag.count, eintrag.last_tick);
    }
  }

  whitelist(s) {
    // Tag/Nacht-Kontext an die Whitelist: Phase, Erde, Nahkreis (für Schlaf-Ort).
    return whitelistFor(s.pilot, {
      recentActions: s.recentActions, entities: s.entities,
      phase: s.phase || 'licht', erde: s.erde ?? true, nah: [...(s.near || [])],
    });
  }

  async decide() {
    if (this.deciding) return null;
    this.deciding = true;
    try {
      const s = this.state();
      if (s.pilot.status !== 'alive' || s.pilot.current_action !== 'idle') return null;
      const whitelist = this.whitelist(s);
      const recentThoughts = q.lastThoughts(this.db, 15);

      const letzteAktion = s.recentActions[s.recentActions.length - 1];
      const beliefs = q.mind(this.db, s.pilot.id)
        .filter((m) => m.layer === 'somatic_theory' && m.belief_text && m.action_key !== letzteAktion)
        .slice(0, MODEL.maxBeliefs)
        .map((m) => ({ text: m.belief_text, action: m.action_key }));

      // Betrachtung zuerst: Neu Entdecktes bekommt den Zusatzgedanken —
      // „was lässt sich damit wohl anfangen?" Die Antwort formuliert er selbst.
      // Paket K: Musing-Rate pro Zone — Flow 75 %, sonst 35 %.
      // Tag/Nacht: Schlaf-Traum — nachts träumt er von Flucht, Funk und Wärme.
      const offene = s.entities.filter((x) => x.unfinished_thought).map((x) => x.name);
      const schlaeft = s.pilot.current_action === 'sleep';
      const thema = offene.length
        ? `Neu entdeckt: ${offene.join(', ')} — was lässt sich damit wohl anfangen?`
        : (schlaeft && (s.phase || 'licht') === 'nacht')
          ? 'Traum: Fluchtwege, Stimmen aus dem Funk, wie sich Wärme anfühlt'
          : waehleMusingThema(s.pilot, s.entities);
      const musingRate = (s.pilot.psyche ?? 0) >= 35 ? 0.75 : 0.35;
      const musing = offene.length ? thema
        : (((whitelist.includes('sinnieren') && Math.random() < 0.8) || Math.random() < musingRate)
          ? thema : null);

      // Gedanken-Impuls würfeln: Stilvariation von innen, kein Retry (Paket B)
      const impuls = wuerfelImpuls();

      // Seit dem letzten Gedanken etwas geschehen? (Ankunft, Event ...)
      const letzterGedanke = q.lastThoughtTick(this.db, s.pilot.id);
      const seit = letzterGedanke == null || q.ereignisseSeit(this.db, letzterGedanke,
        ['action', 'discovery', 'mind', 'belief', 'death', 'spawn', 'find', 'note', 'bake', 'knock']).length > 0;

      // Frische Vorratskontrolle (max. eine Simulationsstunde alt) in den Prompt
      let vorrat = null;
      try {
        const se = q.lastEvent(this.db, 'stock');
        if (se) {
          const sp = JSON.parse(se.payload_json || '{}');
          const alter = tick - se.tick;
          if (alter >= 0 && alter <= 3600 && typeof sp.stunden === 'number') {
            vorrat = { minuten: Math.round(alter / 60), stunden: sp.stunden };
          }
        }
      } catch { /* keine Vorratsinfo — neutral weitermachen */ }

      // Paket A: Vorhaben-Text + Weg-Text für den Prompt (nur wenn aktiv)
      let vorhabenText = null;
      let wegTextStr = null;
      {
        const v = s.vorhaben || leseVorhaben(s.pilot);
        const z = v ? s.entities.find((e) => e.id === v.ziel) : null;
        if (v && z) {
          const grundWort = v.grund === 'hunger' ? 'dein Körper leer ist'
            : v.grund === 'thermoHeiss' ? 'dir zu warm ist'
            : v.grund === 'thermoKalt' ? 'dir zu kalt ist'
            : v.grund === 'halt' ? 'du Halt brauchst'
            : 'dich etwas Neues ruft';
          vorhabenText = `Was du vorhast: zum ${z.name}, weil ${grundWort}.`;
          wegTextStr = `Weg: ${wegText(s.pilot, z, s.entities)}.`;
        }
      }

      const prompt = buildPrompt(s.pilot, {
        entities: s.entities, beliefs, whitelist, recentThoughts, musing, vorrat, impuls, seit,
        vorhaben: vorhabenText, weg: wegTextStr,
        phase: s.phase || 'licht', erde: s.erde ?? true, finsternis: s.finsternis ?? 0,
      });

      const res = await brain.decide({
        prompt, whitelist, recentThoughts, apiKey: this.apiKey,
        baseUrl: process.env.OPENROUTER_BASE_URL, model: process.env.AIQUARIUM_MODEL,
        musing: !!musing,
        // Paket B-Rest: Ortsnamen für die Musterbremse (Objekt-Eröffnung)
        orte: s.entities.map((e) => e.name),
        // Paket A: Vorhaben aktiv? Dann Bedürfnis-Sätze verwerfen
        vorhabenAktiv: !!(vorhabenText),
      });
      this.lastBrain = res;
      const tick = s.world.world_tick;

      if (!res.ok) {
        this.staleSince = this.staleSince || Date.now();
        const rawStr = typeof res.raw === 'string' ? res.raw : '';
        logEvent(this.db, tick, 'stale', {
          reason: res.reason, failures: res.failures,
          roh: rawStr.slice(0, 2000) || null,
          ms: res.latencyMs ?? null, versuche: res.calls ?? null,
          finish: res.finish ?? null, usage: res.usage ?? null,
        }, false);
        const fallback = this.fallbackAction(s, whitelist);
        this.applyAction(s, fallback, null, tick, 'fallback', whitelist, null,
          { ms: res.latencyMs ?? null, versuche: res.calls ?? null,
            finish: res.finish ?? null, usage: res.usage ?? null,
            roh: rawStr.slice(0, 2000) || null });
        console.error(`[stale] tick ${tick}: ${res.reason} [${(res.failures || []).join(',')}]`
          + ` ms=${res.latencyMs ?? '?'} versuche=${res.calls ?? '?'}`
          + ` finish=${res.finish ?? '?'} tok=${JSON.stringify(res.usage ?? {})}`
          + ` roh=${(res.raw || '').slice(0, 300)}`);
        return { ...res, fallback };
      }

      this.staleSince = null;
      // Gedanke und Zusatzgedanke bleiben getrennt: der Feed-Text bricht sonst
      // das 14-Wörter-Limit, obwohl beide Teile einzeln geprüft sind.
      const gedanke = res.thought;
      const zusatz = res.musing || null;
      // Frisch gespawnt: erste Entscheidung raus aus dem Bauwerk — sonst läuft er
      // vom 15-m-Spawn sofort zum Kapsel-Anker zurück (eat/check_stock zielen dorthin).
      let aktion = res.action;
      if ((s.world.world_tick - (s.pilot.created_tick || 0)) <= 2 && whitelist.includes('streifen')
        && (aktion === 'eat' || aktion === 'check_stock' || aktion === 'sit_shade')) {
        aktion = 'streifen';
      }
      if (gedanke) {
        this.db.prepare('INSERT INTO thoughts (pilot_id, tick, text) VALUES (?,?,?)')
          .run(s.pilot.id, tick, gedanke);
        this.db.prepare('UPDATE pilots SET psyche = MIN(100, psyche + 0.5) WHERE id = ? AND psyche < 0')
          .run(s.pilot.id);
      }
      this.applyAction(s, aktion, gedanke, tick, 'model', whitelist, zusatz,
        { ms: res.latencyMs ?? null, versuche: res.calls ?? null,
          finish: res.finish ?? null, usage: res.usage ?? null,
          roh: typeof res.raw === 'string' ? res.raw.slice(0, 2000) : null });
      console.log(`[modell:${modellKurz()}] tick ${tick}: ${aktion} (${res.calls ?? '?'}V, ${Math.round(res.latencyMs ?? 0)}ms)`
        + ` „${gedanke || ''}"${zusatz ? ` ↳ ${zusatz}` : ''}`);
      if (offene.length) {
        this.db.prepare('UPDATE world_entities SET unfinished_thought=NULL WHERE unfinished_thought IS NOT NULL')
          .run();
      }
      return res;
    } finally {
      this.deciding = false;
    }
  }

  fallbackAction(s, whitelist) {
    const has = (a) => whitelist.includes(a);
    if (s.pilot.mind_state === 'wahn') return has('run_wild') ? 'run_wild' : 'sleep';
    if (s.pilot.body < 40 && has('eat')) return 'eat';
    if (s.pilot.body < 30 && has('sleep')) return 'sleep';
    if (s.pilot.psyche < -30 && has('sit_shade')) return 'sit_shade';
    return whitelist[s.world.world_tick % whitelist.length] || 'sleep';
  }

  targetFor(s, action) {
    // Ziele sind die sichtbaren Bauwerke (Anker), nicht die Logikpunkte —
    // die Figur läuft dorthin, was sie auch anschauen soll.
    const eff = s.entities.map((e) => ({ ...e, ...ankerPos(e) }));
    const names = {
      eat: ['field', 'capsule'],
      sit_shade: ['shade', 'capsule'],
      inspect: ['wreck'],
      search_wrack: ['wreck'],
      read_note: ['note'],
      check_stock: ['capsule', 'field'],
      tend_dome: ['kuppel'],
      call_bake: ['bake'],
      dig: ['field', 'wreck'],
      // hide_capsule: Rückzug in die Kapsel bei Wahn (Paket K)
      hide_capsule: ['capsule'],
    }[action];
    if (names) {
      return eff.filter((e) => names.includes(e.type))
        .sort((a, b) => dist3(s.pilot, a) - dist3(s.pilot, b))[0] || null;
    }
    if (action === 'sleep') {
      return eff.find((e) => e.type === 'shade') || eff.find((e) => e.type === 'capsule') || null;
    }
    if (action === 'run_wild') {
      return eff[Math.floor(Math.random() * eff.length)] || null;
    }
    if (action === 'streifen') {
      return eff[Math.floor(Math.random() * eff.length)] || null;   // ziellos: irgendein Ort
    }
    return null;
  }

  applyAction(s, action, thought, tick, source = 'model', whitelist = [], musing = null, extra = null) {
    const def = ACTIONS[action];
    const target = this.targetFor(s, action);
    // Manie verkürzt die Aktionsdauer (wird beim Abschluss geprüft)
    const dur = Math.round((def ? def.dur : 0) * (istManie(s.pilot, tick) ? MANIA.tempo : 1));
    logEvent(this.db, tick, 'decision', {
      action, source, thought: thought || null, musing: musing || null, target: target ? target.id : null,
      dur, mind: s.pilot.mind_state,
      whitelist, auswahl: whitelist.length,
      body: Math.round(s.pilot.body * 10) / 10,
      psyche: Math.round(s.pilot.psyche * 10) / 10,
      ...(extra || {}),
    }, false);
    this.db.prepare(`UPDATE pilots SET current_action=?, target_entity=?, action_started_tick=NULL,
      action_duration_s=?, psyche_at_start=NULL WHERE id=?`)
      .run(action, target ? target.id : null, dur, s.pilot.id);
    logEvent(this.db, tick, 'thought', {
      action, thought, musing: musing || null, name: s.pilot.name,
      x: s.pilot.pos_x, y: s.pilot.pos_y, z: s.pilot.pos_z,
      mind: s.pilot.mind_state, entity: target ? target.id : null,
    }, true);
  }

  async phrasePendingBeliefs(max = 2) {
    const s = this.state();
    const rows = this.db.prepare(`SELECT * FROM pilot_mind
      WHERE pilot_id=? AND layer='somatic_theory' AND needs_text=1 AND text_attempts < ?
      ORDER BY times_borne_out DESC LIMIT ?`)
      .all(s.pilot.id, SOMATIC.maxTextAttempts, max);
    const fertig = [];

    for (const row of rows) {
      const res = await phraseBelief({
        action: row.action_key,
        runs: row.times_borne_out,
        avgDelta: row.avg_psyche_delta,
        recentThoughts: q.lastThoughts(this.db, 5),
        apiKey: this.apiKey,
        baseUrl: process.env.OPENROUTER_BASE_URL,
        model: process.env.AIQUARIUM_MODEL,
      });

      let text = null;
      if (res.ok) {
        text = `${res.text} (${row.times_borne_out}x bestätigt)`;
        this.lastBrain = { ...(this.lastBrain || {}), beliefCost: res.cost };
      } else {
        const attempts = (row.text_attempts || 0) + 1;
        this.db.prepare('UPDATE pilot_mind SET text_attempts=? WHERE id=?').run(attempts, row.id);
        if (attempts >= SOMATIC.maxTextAttempts) {
          text = `${fallbackText(row.action_key, row.avg_psyche_delta > 0)} (${row.times_borne_out}x bestätigt)`;
        } else {
          console.warn(`[belief] Formulierung fehlgeschlagen (${res.reason}), neuer Versuch später`);
        }
      }

      if (text) {
        this.db.prepare('UPDATE pilot_mind SET belief_text=?, needs_text=0, text_attempts=0 WHERE id=?')
          .run(text, row.id);
        logEvent(this.db, s.world.world_tick, 'belief', { text, action: row.action_key }, true);
        fertig.push(text);
      }
    }
    return fertig;
  }

  catchup(now = Date.now()) {
    const s = this.state();
    const last = s.world.last_tick_at ? Date.parse(s.world.last_tick_at) : now;
    const raw = Math.floor((now - last) / 1000);

    if (raw < -1) {
      const skew = -raw;
      this.lastSkew = skew;
      this.db.prepare('UPDATE world_state SET last_tick_at=? WHERE id=1').run(new Date(now).toISOString());
      logEvent(this.db, s.world.world_tick, 'clock_skew', { seconds: skew, last_tick_at: s.world.last_tick_at }, false);
      console.warn(`[clock] last_tick_at lag ${skew}s in der Zukunft — korrigiert`);
      return { missed: 0, skew, reboot: false };
    }

    const missed = Math.max(0, raw);
    if (!missed) return { missed: 0, skew: 0, reboot: false };

    if (raw > FREEZE_S) {
      // Anzug-Reboot: einfrieren statt nachsimulieren. Kein blinder Geister-Pilot,
      // keine phantom-gegessenen Karotten — ein Kälteschlaf mit Filmriss-Meldung.
      this.db.prepare('UPDATE world_state SET last_tick_at=? WHERE id=1').run(new Date(now).toISOString());
      const minuten = Math.round(raw / 60);
      logEvent(this.db, s.world.world_tick, 'reboot', { minuten }, true);
      console.log(`[reboot] ${minuten} min eingefroren (kein Catch-up über ${FREEZE_S}s hinaus)`);
      return { missed: 0, deaths: 0, spawned: 0, reboot: true, minutes: minuten };
    }

    // Mini-Catch-up (≤ 60 s): kurz nachrechnen wie bisher
    const before = { body: s.pilot.body, psyche: s.pilot.psyche, name: s.pilot.name };
    let deaths = 0;
    let spawned = 0;
    const fromTick = s.world.world_tick;

    for (let i = 0; i < missed; i += 1) {
      step(s, 1, { live: false, noRandom: i % 11 !== 0 });
      for (const e of s.events) {
        if (e.type === 'death') deaths += 1;
        if (e.type === 'spawn') spawned += 1;
        if (e.type === 'action' && e.payload && typeof e.payload.psyche_delta === 'number') {
          updateSomatic(this.db, s.pilot.id, e.payload.action, e.payload.psyche_delta);
        }
      }
      s.events = [];
      if (s.pilot.status === 'alive' && s.pilot.current_action === 'idle') {
        // Catch-up entscheidet pragmatisch (Fallback), nicht per Modell —
        // aber mit echtem Tag/Nacht-Kontext, sonst schläft er bei Licht draußen.
        const wl = whitelistFor(s.pilot, {
          recentActions: s.recentActions, entities: s.entities,
          phase: s.phase || 'licht', erde: s.erde ?? true, nah: [...(s.near || [])],
        });
        this.applyActionCatchup(s, this.fallbackAction(s, wl));
      }
      // Nicht jeden Tick schreiben — 12 h Nachrechnen sind sonst zehntausende Schreibvorgänge
      if (i % CATCHUP_WRITE_EVERY === 0) {
        savePilot(this.db, s.pilot);
        for (const n of s.nerve) {
          this.db.prepare('INSERT INTO nerve_events (pilot_id, tick, kind, source, weight) VALUES (?,?,?,?,?)')
            .run(s.pilot.id ?? null, s.world.world_tick, n.kind, n.source, n.weight);
        }
        s.nerve = [];
      }
    }

    this.speichereNovelty(s);
    for (const e of s.entities) {
      this.db.prepare('UPDATE world_entities SET discovered=?, sicht=?, unfinished_thought=? WHERE id=?')
        .run(e.discovered ? 1 : 0, e.sicht || 0, e.unfinished_thought || null, e.id);
    }
    this.db.prepare('UPDATE world_state SET world_tick=?, last_tick_at=?, last_novelty_tick=?, sun_angle=? WHERE id=1')
      .run(fromTick + missed, new Date(now).toISOString(), s.world.last_novelty_tick || 0, s.world.sun_angle ?? 0);
    logEvent(this.db, fromTick + missed, 'offline', {
      minutes: Math.round(missed / 60), from_tick: fromTick, to_tick: fromTick + missed,
      deaths, spawned, before,
      after: { body: s.pilot.body, psyche: s.pilot.psyche, name: s.pilot.name },
    }, false);

    return { missed, skew: 0, reboot: false };
  }

  prune() {
    const { pruneDB } = require('./db');
    const r = pruneDB(this.db);
    if (r.events || r.gedanken) console.log(`[prune] ${r.events} alte Events, ${r.gedanken} alte Gedanken entfernt`);
    return r;
  }

  applyActionCatchup(s, action) {
    const def = ACTIONS[action];
    const target = this.targetFor(s, action);
    s.pilot.current_action = action;
    s.pilot.target_entity = target ? target.id : null;
    s.pilot.action_started_tick = null;
    s.pilot.action_duration_s = def ? def.dur : 0;
  }

  get staleMinutes() {
    return this.staleSince ? Math.round((Date.now() - this.staleSince) / 60000) : 0;
  }

  snapshot() {
    const s = this.state();
    const p = s.pilot;
    const ageSeconds = Math.max(0, s.world.world_tick - (p.created_tick || 0));
    const h = p.heading_x != null ? [p.heading_x, p.heading_y, p.heading_z]
      : (Array.isArray(p.heading) ? p.heading : null);
    return {
      world: { tick: s.world.world_tick, cycle: s.world.cycle, lastNovelty: s.world.last_novelty_tick || 0 },
      clock: {
        day: Math.floor(ageSeconds / 86400) + 1,
        ageSeconds,
        ageHours: Math.round(ageSeconds / 360) / 10,
      },
      // Tag/Nacht: wandernde Lichtkante (Sonne als Vektor) + Erde-Tor.
      // tagNr = Sonnen-Umdrehungen (global), phase/erde = lokal am Piloten.
      // Finsternis: global (Himmel), Stufe 0–3 + Wort fürs HUD.
      tag: {
        nr: tagesNummer(s.world.sun_angle ?? 0),
        phase: s.phase || 'licht',
        erde: s.erde ?? true,
        sonne: s.sonne || null,
        finsternis: s.finsternis ?? 0,
        finsternisWort: FINSTERNIS.worte[s.finsternis ?? 0] || null,
      },
      pilot: {
        name: p.name, cycle_num: p.cycle_num, status: p.status, mind_state: p.mind_state,
        body: round(p.body), psyche: round(p.psyche),
        phase: s.phase || 'licht',   // der Pilot spürt, wo er steht (für sensory)
        finsternis: s.finsternis ?? 0,   // Boden-Finsternis schrumpft die Sicht mit
        mania: p.mania_until_tick != null && s.world.world_tick <= p.mania_until_tick,
        // Paket K (Spec, Umsetzung offen): Treiber erscheinen hier, sobald die
        // Spalten existieren — das UI zeigt sie dann automatisch, vorher grau.
        treiber: (p.hunger != null) ? {
          hunger: round(p.hunger), thermo: round(p.thermo),
          drang: round(p.drang), halt: round(p.halt),
        } : null,
        x: round(p.pos_x, 1), y: round(p.pos_y ?? 120, 1), z: round(p.pos_z, 1),
        current_action: p.current_action, accent_hue: p.accent_hue,
        heading: h,
        created_tick: p.created_tick || 0,
      },
      sicht: SICHT,
      beliefs: q.mind(this.db, p.id).filter((m) => m.belief_text).map((m) => ({
        text: m.belief_text, runs: m.times_borne_out,
      })),
      entities: s.entities.map((e) => {
        const a = ankerPos(e);   // Frontend zeigt das sichtbare Bauwerk, nicht den Logikpunkt
        return {
          id: e.id, type: e.type, name: e.name,
          x: Math.round(a.pos_x * 10) / 10, y: Math.round(a.pos_y * 10) / 10, z: Math.round(a.pos_z * 10) / 10,
          stufe: sichtStufe(p, { pos_x: a.pos_x, pos_y: a.pos_y, pos_z: a.pos_z }),
          label: entityLabel(p, e), discovered: !!e.discovered,
        };
      }),
      feed: q.feed(this.db, 40),
      // Inventar: pilotengebunden (neuer Pilot startet leer — sein Vorgänger hat
      // alles mit ins Grab genommen), höchstens 10 Funde, ältestes zuerst
      // (FIFO — ältestes Item droppen). Alt-Events ohne pilot_id zählen mit.
      // Bauteil-Zähler aus Paket F zählt separat.
      inventar: this.db.prepare(`SELECT tick, payload_json FROM events WHERE type='find'
        AND (json_extract(payload_json, '$.pilot_id') IS NULL
          OR json_extract(payload_json, '$.pilot_id') = ?)
        ORDER BY tick DESC LIMIT 10`).all(p.id)
        .reverse()
        .map((r) => {
          let fund = {};
          try { fund = JSON.parse(r.payload_json || '{}'); } catch { /* kaputtes Payload — Tick bleibt */ }
          return { tick: r.tick, id: fund.id || null, text: fund.text || null };
        }),
      stale: this.staleMinutes > 0,
      staleMinutes: this.staleMinutes,
      model: { name: MODEL.name, last: this.lastBrain },
    };
  }

  statePayload() {
    const snap = this.snapshot();
    return {
      kind: 'state',
      world: snap.world, clock: snap.clock, tag: snap.tag, pilot: snap.pilot, entities: snap.entities,
      sicht: snap.sicht, inventar: snap.inventar,
      stale: snap.stale, staleMinutes: snap.staleMinutes, clockSkew: this.lastSkew || 0,
    };
  }
}

const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

module.exports = { Engine, step, spawn, loadState, savePilot, neuigkeit };

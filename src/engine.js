'use strict';
// Die Engine: einzige Wahrheit. Werte sind "hoch = schlecht".
const {
  DRAIN, SUN_COST, effectFor, ACTIONS, WALK_SPEED, STRESS, START, NOVELTY, SATT, NOTEN,
  CATCHUP_MAX_TICKS, CATCHUP_WRITE_EVERY, RESPAWN_DELAY_S, MODEL, SICHT, sichtStufe, ankerPos,
  STUFE_RANG, entityLabel, haltAbstand,
} = require('./config');
const { q, logEvent } = require('./db');
const { uniqueName, randomHue } = require('./names');
const { whitelistFor, buildPrompt, waehleMusingThema } = require('./prompt');
const { phraseBelief, fallbackText } = require('./belief');
const brain = require('./brain');

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const dist = (a, b) => Math.hypot(a.pos_x - b.pos_x, a.pos_z - b.pos_z);

const SOMATIC = { minRuns: 3, minDelta: 0.2, maxTextAttempts: 3 };

function moveToward(pilot, target, dt, halt = 0.5) {
  const dx = target.pos_x - pilot.pos_x;
  const dz = target.pos_z - pilot.pos_z;
  const d = Math.hypot(dx, dz);
  if (d <= halt) return true;   // stehenbleiben, sobald das Ziel den Nahkreis berührt
  pilot.heading = Math.atan2(dx, dz);   // Paket I: wohin er läuft, dahin schaut er
  const stepLen = Math.min(d - halt, WALK_SPEED * dt);
  pilot.pos_x += (dx / d) * stepLen;
  pilot.pos_z += (dz / d) * stepLen;
  return d - stepLen <= halt;
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
  return { world, pilot, entities, recentActions, allNames, novelty, near, nerve: [], events: [] };
}

function step(state, dt = 1, opts = {}) {
  const live = opts.live !== false;
  const { world, entities, events } = state;
  const pilot = state.pilot;
  const tick = world.world_tick + 1;
  world.world_tick = tick;
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

  if (def) {
    if (target) {
      const arrived = moveToward(pilot, target, dt, haltAbstand(pilot.current_action));
      if (!arrived) {
        walking = true;
      } else {
        acting = true;
        if (!pilot.action_started_tick) {
          pilot.action_started_tick = tick;
          pilot.stress_at_start = pilot.stress;
        }
      }
    } else {
      acting = true;
      if (!pilot.action_started_tick) {
        pilot.action_started_tick = tick;
        pilot.stress_at_start = pilot.stress;
      }
    }
  }

  // Verbrauch steigt
  pilot.hunger += DRAIN.hunger * dt;
  pilot.exhaustion += DRAIN.exhaustion * dt * (walking ? SUN_COST : 1);
  pilot.stress += DRAIN.stress * dt;

  // Wirkung der Aktion (negativ = besser); Sättigung dämpft Wiederholungen
  if (acting && def) {
    const eff = effectFor(pilot.current_action, pilot);
    const saettigung = SATT[pilot.current_action];
    if (saettigung) {
      const n = (state.novelty[`action:${pilot.current_action}`] || { count: 0 }).count;
      const f = saettigung[Math.min(n, saettigung.length - 1)];
      for (const k of Object.keys(eff)) eff[k] *= f;
    }
    for (const [k, v] of Object.entries(eff)) pilot[k] += v * dt;
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
        pilot.stress > NOVELTY.minStress);
      if (abzug) {
        pilot.stress -= abzug;
        events.push({ type: 'novelty', in_feed: false,
          payload: { key: `entity:${e.id}`, stress: -abzug } });
      }
    }
  }
  state.near = jetztNah;
  pilot.near_json = [...jetztNah].join(',');

  // Aktion fertig?
  if (def && acting && pilot.action_started_tick &&
      tick - pilot.action_started_tick >= def.dur) {
    const delta = pilot.stress - (pilot.stress_at_start ?? pilot.stress);
    events.push({ type: 'action', in_feed: false,
      payload: { action: pilot.current_action, dur: def.dur, stress_delta: delta,
        entity: pilot.target_entity || null } });
    state.recentActions.push(pilot.current_action);
    if (state.recentActions.length > 10) state.recentActions.shift();

    // Neues Tun belohnen
    {
      const belohnen = pilot.stress > NOVELTY.minStress;
      let abzug = neuigkeit(state, `action:${pilot.current_action}`, [NOVELTY.action, 0], belohnen);
      if (target) {
        abzug += neuigkeit(state, `at:${target.id}:${pilot.current_action}`,
          [NOVELTY.entityAction, 0], belohnen);
      }
      if (abzug) {
        pilot.stress -= abzug;
        events.push({ type: 'novelty', in_feed: false,
          payload: { key: `action:${pilot.current_action}`, stress: -abzug } });
      }
    }

    // Fundstücke und Eigenheiten einzelner Aktionen
    {
      const anlass = pilot.current_action;
      const offen = pilot.stress > NOVELTY.minStress;
      if (anlass === 'search_wrack') {
        const fund = neuigkeit(state, 'find:wrack', [10, 0], offen);
        if (fund) {
          pilot.stress -= fund;
          events.push({ type: 'find', in_feed: true,
            payload: { id: 'wrack', text: 'Zwischen den Blechen: ein heiler Schraubenschlüssel.' } });
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
        const stunden = Math.max(0, (100 - pilot.hunger) / DRAIN.hunger / 3600);
        events.push({ type: 'stock', in_feed: false,
          payload: { stunden: Math.round(stunden * 10) / 10 } });
      }
    }

    const ra = state.recentActions;
    if (ra.length >= 3 && ra.slice(-3).every((a) => a === ra[ra.length - 1])) {
      pilot.stress += STRESS.monotony_penalty;
      state.nerve.push({ kind: 'chronic', source: 'monotony', weight: STRESS.monotony_penalty });
      events.push({ type: 'nerve', in_feed: false, payload: { source: 'monotony' } });
    }

    pilot.current_action = 'idle';
    pilot.target_entity = null;
    pilot.action_started_tick = null;
    pilot.stress_at_start = null;
  }

  // Klopfen (akut): selten, unregelmäßig
  if (!opts.noRandom && Math.random() < 1 / 2700) {
    pilot.stress += STRESS.knock_penalty;
    state.nerve.push({ kind: 'acute', source: 'knock', weight: STRESS.knock_penalty });
    if (live) events.push({ type: 'knock', in_feed: false, payload: {} });
  }

  // Langeweile: nichts Neues und es geht ihm gut -> es kribbelt
  const seitNeuem = tick - (world.last_novelty_tick || 0);
  if (pilot.stress < NOVELTY.boredBelow && seitNeuem > NOVELTY.boredAfterS) {
    pilot.stress += NOVELTY.boredRate * dt;
  }

  pilot.hunger = clamp(pilot.hunger);
  pilot.exhaustion = clamp(pilot.exhaustion);
  pilot.stress = clamp(pilot.stress);

  if (pilot.stress >= STRESS.collapse && pilot.mind_state === 'klar') {
    const chronic = state.nerve.filter((n) => n.kind === 'chronic').reduce((s, n) => s + n.weight, 0);
    const acute = state.nerve.filter((n) => n.kind === 'acute').reduce((s, n) => s + n.weight, 0);
    pilot.mind_state = acute > chronic ? 'wahn' : 'stupor';
    pilot.mind_state_since_tick = tick;
    pilot.current_action = 'idle';
    pilot.target_entity = null;
    pilot.action_started_tick = null;
    events.push({ type: 'mind', in_feed: true, payload: { state: pilot.mind_state } });
  } else if (pilot.stress <= STRESS.recover && pilot.mind_state !== 'klar') {
    pilot.mind_state = 'klar';
    pilot.mind_state_since_tick = tick;
    events.push({ type: 'mind', in_feed: true, payload: { state: 'klar' } });
  }

  if (pilot.mind_state !== 'klar' && pilot.current_action === 'idle') {
    const limit = pilot.mind_state === 'stupor' ? STRESS.force_sleep_stupor_s : STRESS.force_sleep_wahn_s;
    if (tick - (pilot.mind_state_since_tick || tick) > limit) {
      pilot.current_action = 'sleep';
      pilot.action_started_tick = null;
      pilot.target_entity = 'shade';
      events.push({ type: 'force_sleep', in_feed: false, payload: {} });
    }
  }

  if (pilot.hunger >= 100 || pilot.exhaustion >= 100) {
    pilot.status = 'dead';
    pilot.cause_of_death = pilot.hunger >= 100 ? 'hunger' : 'exhaustion';
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
  return {
    id: null,
    cycle_num: (previous?.cycle_num || 0) + 1,
    name,
    status: 'alive',
    mind_state: 'klar',
    hunger: START.hunger,
    exhaustion: START.exhaustion,
    stress: START.stress,
    pos_x: 0,
    pos_z: 0,
    accent_hue: randomHue(),
    current_action: 'idle',
    action_started_tick: null,
    action_duration_s: 0,
    target_entity: null,
    mind_state_since_tick: tick,
    cause_of_death: null,
    epitaph: null,
    created_tick: tick,
    died_tick: null,
    stress_at_start: null,
  };
}

function savePilot(db, p) {
  if (!p) return p;
  if (p.id) {
    db.prepare(`UPDATE pilots SET status=?, mind_state=?, hunger=?, exhaustion=?, stress=?,
      pos_x=?, pos_z=?, current_action=?, action_started_tick=?, target_entity=?,
      mind_state_since_tick=?, cause_of_death=?, died_tick=?, epitaph=?, stress_at_start=?, near_json=?,
      heading=?
      WHERE id=?`).run(
      p.status, p.mind_state, p.hunger, p.exhaustion, p.stress,
      p.pos_x, p.pos_z, p.current_action, p.action_started_tick ?? null, p.target_entity ?? null,
      p.mind_state_since_tick ?? null, p.cause_of_death ?? null, p.died_tick ?? null,
      p.epitaph ?? null, p.stress_at_start ?? null, p.near_json ?? '', p.heading ?? null, p.id,
    );
  } else {
    const r = db.prepare(`INSERT INTO pilots (cycle_num, name, status, mind_state, hunger, exhaustion, stress,
      pos_x, pos_z, accent_hue, current_action, action_started_tick, target_entity,
      mind_state_since_tick, created_tick, near_json, heading)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      p.cycle_num, p.name, p.status, p.mind_state, p.hunger, p.exhaustion, p.stress,
      p.pos_x, p.pos_z, p.accent_hue, p.current_action, p.action_started_tick ?? null,
      p.target_entity ?? null, p.mind_state_since_tick ?? null, p.created_tick, '', p.heading ?? null,
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
    db.prepare(`INSERT INTO pilot_mind (pilot_id, layer, action_key, times_borne_out, avg_stress_delta,
      belief_text, is_locked, needs_text, text_attempts)
      VALUES (?, 'somatic_theory', ?, 1, ?, '', 0, 0, 0)`).run(pilotId, action, delta);
    return;
  }

  const runs = row.times_borne_out + 1;
  const avg = (row.avg_stress_delta * row.times_borne_out + delta) / runs;
  const reached = runs >= SOMATIC.minRuns && Math.abs(avg) >= SOMATIC.minDelta;
  const flipped = Math.sign(avg) !== Math.sign(row.avg_stress_delta);
  const needsText = reached && (!row.belief_text || flipped) ? 1 : row.needs_text;

  db.prepare(`UPDATE pilot_mind SET times_borne_out=?, avg_stress_delta=?, needs_text=? WHERE id=?`)
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
    this.db.prepare('UPDATE world_state SET world_tick=?, last_tick_at=?, last_novelty_tick=? WHERE id=1')
      .run(s.world.world_tick, new Date().toISOString(), s.world.last_novelty_tick || 0);
    for (const e of s.events) {
      logEvent(this.db, s.world.world_tick, e.type, e.payload, e.type === 'action' ? false : e.in_feed);
      if (e.type === 'action' && e.payload && typeof e.payload.stress_delta === 'number') {
        updateSomatic(this.db, s.pilot.id, e.payload.action, e.payload.stress_delta);
      }
    }
    for (const n of s.nerve) {
      this.db.prepare('INSERT INTO nerve_events (pilot_id, tick, kind, source, weight) VALUES (?,?,?,?,?)')
        .run(s.pilot.id ?? null, s.world.world_tick, n.kind, n.source, n.weight);
    }
    s.nerve = [];
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
    return whitelistFor(s.pilot, { recentActions: s.recentActions, entities: s.entities });
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
      const offene = s.entities.filter((x) => x.unfinished_thought).map((x) => x.name);
      const thema = offene.length
        ? `Neu entdeckt: ${offene.join(', ')} — was lässt sich damit wohl anfangen?`
        : waehleMusingThema(s.pilot, s.entities);
      const musing = offene.length ? thema
        : (((whitelist.includes('sinnieren') && Math.random() < 0.8) || Math.random() < 0.35)
          ? thema : null);

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

      const prompt = buildPrompt(s.pilot, {
        entities: s.entities, beliefs, whitelist, recentThoughts, musing, vorrat,
      });

      const res = await brain.decide({
        prompt, whitelist, recentThoughts, apiKey: this.apiKey,
        baseUrl: process.env.OPENROUTER_BASE_URL, model: process.env.AIQUARIUM_MODEL,
        musing: !!musing,
      });
      this.lastBrain = res;
      const tick = s.world.world_tick;

      if (!res.ok) {
        this.staleSince = this.staleSince || Date.now();
        logEvent(this.db, tick, 'stale', { reason: res.reason, failures: res.failures }, false);
        const fallback = this.fallbackAction(s, whitelist);
        this.applyAction(s, fallback, null, tick, 'fallback', whitelist);
        return { ...res, fallback };
      }

      this.staleSince = null;
      // Gedanke und Zusatzgedanke bleiben getrennt: der Feed-Text bricht sonst
      // das 14-Wörter-Limit, obwohl beide Teile einzeln geprüft sind.
      const gedanke = res.thought;
      const zusatz = res.musing || null;
      if (gedanke) {
        this.db.prepare('INSERT INTO thoughts (pilot_id, tick, text) VALUES (?,?,?)')
          .run(s.pilot.id, tick, gedanke);
        this.db.prepare('UPDATE pilots SET stress = MAX(0, stress - 0.5) WHERE id = ? AND stress > 40')
          .run(s.pilot.id);
      }
      this.applyAction(s, res.action, gedanke, tick, 'model', whitelist, zusatz);
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
    if (s.pilot.hunger > 60 && has('eat')) return 'eat';
    if (s.pilot.exhaustion > 70 && has('sleep')) return 'sleep';
    if (s.pilot.stress > 70 && has('sit_shade')) return 'sit_shade';
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
    }[action];
    if (names) {
      return eff.filter((e) => names.includes(e.type))
        .sort((a, b) => dist(s.pilot, a) - dist(s.pilot, b))[0] || null;
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

  applyAction(s, action, thought, tick, source = 'model', whitelist = [], musing = null) {
    const def = ACTIONS[action];
    const target = this.targetFor(s, action);
    logEvent(this.db, tick, 'decision', {
      action, source, thought: thought || null, musing: musing || null, target: target ? target.id : null,
      dur: def ? def.dur : 0, mind: s.pilot.mind_state,
      whitelist, auswahl: whitelist.length,
      hunger: Math.round(s.pilot.hunger * 10) / 10,
      exhaustion: Math.round(s.pilot.exhaustion * 10) / 10,
      stress: Math.round(s.pilot.stress * 10) / 10,
    }, false);
    this.db.prepare(`UPDATE pilots SET current_action=?, target_entity=?, action_started_tick=NULL,
      action_duration_s=?, stress_at_start=NULL WHERE id=?`)
      .run(action, target ? target.id : null, def ? def.dur : 0, s.pilot.id);
    logEvent(this.db, tick, 'thought', {
      action, thought, musing: musing || null, name: s.pilot.name, x: s.pilot.pos_x, z: s.pilot.pos_z,
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
        avgDelta: row.avg_stress_delta,
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
          text = `${fallbackText(row.action_key, row.avg_stress_delta < 0)} (${row.times_borne_out}x bestätigt)`;
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
      return { missed: 0, deaths: 0, spawned: 0, skew };
    }

    const missed = Math.max(0, Math.min(raw, CATCHUP_MAX_TICKS));
    if (!missed) return { missed: 0, deaths: 0, spawned: 0, skew: 0 };

    const before = { hunger: s.pilot.hunger, exhaustion: s.pilot.exhaustion, stress: s.pilot.stress, name: s.pilot.name };
    let deaths = 0;
    let spawned = 0;
    const fromTick = s.world.world_tick;

    for (let i = 0; i < missed; i += 1) {
      step(s, 1, { live: false, noRandom: i % 11 !== 0 });
      for (const e of s.events) {
        if (e.type === 'death') deaths += 1;
        if (e.type === 'spawn') spawned += 1;
        if (e.type === 'action' && e.payload && typeof e.payload.stress_delta === 'number') {
          updateSomatic(this.db, s.pilot.id, e.payload.action, e.payload.stress_delta);
        }
      }
      s.events = [];
      if (s.pilot.status === 'alive' && s.pilot.current_action === 'idle') {
        const wl = whitelistFor(s.pilot, { recentActions: s.recentActions, entities: s.entities });
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
    this.db.prepare('UPDATE world_state SET world_tick=?, last_tick_at=?, last_novelty_tick=? WHERE id=1')
      .run(s.world.world_tick, new Date(now).toISOString(), s.world.last_novelty_tick || 0);
    logEvent(this.db, s.world.world_tick, 'offline', {
      minutes: Math.round(missed / 60), from_tick: fromTick, to_tick: s.world.world_tick,
      deaths, spawned, before,
      after: { hunger: s.pilot.hunger, exhaustion: s.pilot.exhaustion, stress: s.pilot.stress, name: s.pilot.name },
    }, false);

    return { missed, deaths, spawned, fromTick, toTick: s.world.world_tick };
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
    return {
      world: { tick: s.world.world_tick, cycle: s.world.cycle, lastNovelty: s.world.last_novelty_tick || 0 },
      clock: {
        day: Math.floor(ageSeconds / 86400) + 1,
        ageSeconds,
        ageHours: Math.round(ageSeconds / 360) / 10,
      },
      pilot: {
        name: p.name, cycle_num: p.cycle_num, status: p.status, mind_state: p.mind_state,
        hunger: round(p.hunger), exhaustion: round(p.exhaustion), stress: round(p.stress),
        x: round(p.pos_x, 1), z: round(p.pos_z, 1),
        current_action: p.current_action, accent_hue: p.accent_hue,
        heading: p.heading ?? null,
        created_tick: p.created_tick || 0,
      },
      sicht: SICHT,
      beliefs: q.mind(this.db, p.id).filter((m) => m.belief_text).map((m) => ({
        text: m.belief_text, runs: m.times_borne_out,
      })),
      entities: s.entities.map((e) => {
        const a = ankerPos(e);   // Frontend zeigt das sichtbare Bauwerk, nicht den Logikpunkt
        return {
          id: e.id, type: e.type, name: e.name, x: a.pos_x, z: a.pos_z,
          stufe: sichtStufe(p, { pos_x: a.pos_x, pos_z: a.pos_z }),
          label: entityLabel(p, e), discovered: !!e.discovered,
        };
      }),
      feed: q.feed(this.db, 40),
      stale: this.staleMinutes > 0,
      staleMinutes: this.staleMinutes,
      model: { name: MODEL.name, last: this.lastBrain },
    };
  }

  statePayload() {
    const snap = this.snapshot();
    return {
      kind: 'state',
      world: snap.world, clock: snap.clock, pilot: snap.pilot, entities: snap.entities,
      sicht: snap.sicht,
      stale: snap.stale, staleMinutes: snap.staleMinutes, clockSkew: this.lastSkew || 0,
    };
  }
}

const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

module.exports = { Engine, step, spawn, loadState, savePilot, neuigkeit };

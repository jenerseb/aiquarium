'use strict';
// Simulation-Engine (§7 + M2): Echtzeit-Uhr (Europe/Berlin), komprimierte
// Aktions-Ticks, Multi-Step-Plan-Queue, Interrupts, Health-Chunks, Tod/Respawn.
// Die Engine rechnet – das Modell spürt nur Konsequenzen (natürliche Sätze).

const { AKTION, SEKUNDAER, ECONOMY, GESUND, chunkCapFuer } = require('./config');
const pf = require('./pathfinding');
const arbiter = require('./arbiter');
const checks = require('./checks');

function berlinJetzt(jetztMs) {
  return new Date(jetztMs || Date.now());
}

function hamburgStunde(jetztMs) {
  const fmt = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false });
  return Number(fmt.format(berlinJetzt(jetztMs)));
}

function istNacht(jetztMs) {
  const h = hamburgStunde(jetztMs);
  return h < 6 || h >= 22;
}

function tageszeitText(jetztMs) {
  const h = hamburgStunde(jetztMs);
  if (h >= 5 && h < 8) return 'Frühmorgens in Hamburg, die Stadt wacht gerade auf.';
  if (h >= 8 && h < 12) return 'Vormittags in Hamburg, der Kiez ist unterwegs.';
  if (h >= 12 && h < 14) return 'Mittags in Hamburg – Zeit für eine Pause.';
  if (h >= 14 && h < 18) return 'Nachmittags in Hamburg, das Licht wird weicher.';
  if (h >= 18 && h < 22) return 'Abends in Hamburg, die Lichter gehen an.';
  return 'Nachts in Hamburg – still, nur wenige Fenster sind noch hell.';
}

function ladeCharakter(db, characterId) {
  return db.prepare('SELECT * FROM character WHERE id = ?').get(characterId);
}

function speichereCharakter(db, ch) {
  db.prepare(`UPDATE character SET gesund = ?, gesund_chunk_cap = ?, froh = ?, hunger = ?, erschoepfung = ?,
    geld = ?, pos_x = ?, pos_z = ?, heading_rad = ?, inside_poi = ?, current_action = ?,
    action_started_tick = ?, action_duration_s = ?, action_target_poi = ?, action_meta_json = ?,
    why_here = ?, plan_queue_json = ?, plan_start_snapshot_json = ? WHERE id = ?`).run(
    ch.gesund, ch.gesund_chunk_cap, ch.froh, ch.hunger, ch.erschoepfung, ch.geld,
    ch.pos_x, ch.pos_z, ch.heading_rad, ch.inside_poi, ch.current_action,
    ch.action_started_tick, ch.action_duration_s, ch.action_target_poi, ch.action_meta_json,
    ch.why_here, ch.plan_queue_json, ch.plan_start_snapshot_json, ch.id);
}

function klammereCharakter(ch) {
  ch.gesund = Math.max(0, Math.min(100, Number(ch.gesund) || 0));
  ch.gesund_chunk_cap = Math.max(20, Math.min(100, Number(ch.gesund_chunk_cap) || 100));
  ch.froh = Math.max(-100, Math.min(100, Number(ch.froh) || 0));
  ch.hunger = Math.max(0, Math.min(100, Number(ch.hunger) || 0));
  ch.erschoepfung = Math.max(0, Math.min(100, Number(ch.erschoepfung) || 0));
  ch.geld = Math.max(0, Math.round((Number(ch.geld) || 0) * 100) / 100);
  return ch;
}

// Wahrnehmung: bekannte Orte (discovered) + was ist in Sichtweite (22 m)?
function bekannteOrte(db) {
  return db.prepare('SELECT id, name, category, pos_x, pos_z FROM pois WHERE discovered = 1 ORDER BY id').all();
}

function entdeckeUmgebung(db, ch) {
  const alle = db.prepare('SELECT id, name, pos_x, pos_z FROM pois').all();
  const neu = [];
  for (const p of alle) {
    if (p.id === ch.inside_poi) continue;
    const row = db.prepare('SELECT discovered FROM pois WHERE id = ?').get(p.id);
    if (row && row.discovered === 1) continue;
    const d = Math.hypot(Number(p.pos_x) - Number(ch.pos_x), Number(p.pos_z) - Number(ch.pos_z));
    if (d <= AKTION.entdeckenRadiusM) {
      db.prepare('UPDATE pois SET discovered = 1 WHERE id = ?').run(p.id);
      neu.push({ poi_id: p.id, name: p.name, distanzM: Math.round(d * 10) / 10 });
    }
  }
  for (const n of neu) {
    db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, 'poi_discovered', ?, 1)")
      .run(ch.id, JSON.stringify(n));
  }
  return neu;
}

function ereignisSeit(db, characterId, seitTick) {
  return db.prepare('SELECT type, payload_json, created_at FROM events WHERE character_id = ? AND id > ? ORDER BY id DESC LIMIT 5')
    .all(characterId, seitTick || 0);
}


// --- Aktionen: Dauer, Kosten, Wirkung ------------------------------------------------

function dauerFuer(schritt, wegM) {
  switch (schritt.action) {
    case 'walk_to': return Math.max(30, Math.ceil((Number(wegM) || 50) / AKTION.walkToSpeedMs));
    case 'explore_street': return AKTION.exploreStreetS;
    case 'consume': return AKTION.consumeS;
    case 'do_activity': return AKTION.doActivityS;
    case 'leave_note': return AKTION.leaveNoteS;
    case 'send_sms': case 'send_email': case 'web_search': return 120;
    case 'collect_deposit': return AKTION.collectPfandS;
    case 'return_deposit': return AKTION.returnPfandS;
    case 'buy_item': return AKTION.buyItemS;
    case 'look_for_work': return AKTION.doActivityS;
    case 'take_job': return AKTION.leaveNoteS;
    case 'work_shift': return AKTION.workShiftS;
    case 'quit_job': return 120;
    case 'rest': return AKTION.restS;
    case 'sleep': return AKTION.sleepS;
    case 'visit_doctor': return AKTION.visitDoctorS;
    case 'read_book': return AKTION.readBookS;
    case 'write_notebook': return AKTION.writeNotebookS;
    case 'work_on_project': return AKTION.workOnProjectS;
    default: return 300;
  }
}

function lasseZeitVergehen(ch, sekunden) {
  const stunden = sekunden / 3600;
  ch.hunger = Math.min(100, ch.hunger + stunden * SEKUNDAER.hunger.proStunde);
  if (ch.current_action === 'sleep') {
    ch.erschoepfung = Math.max(0, ch.erschoepfung - stunden * 60);
  } else if (ch.current_action === 'rest') {
    ch.erschoepfung = Math.max(0, ch.erschoepfung - stunden * 30);
  } else {
    ch.erschoepfung = Math.min(100, ch.erschoepfung + stunden * SEKUNDAER.erschoepfung.proStunde);
  }
  if (ch.hunger >= GESUND.hungerSchwelle || ch.erschoepfung >= GESUND.erschoepfungSchwelle) {
    ch.gesund = Math.max(0, ch.gesund - stunden * 4);
  }
  return ch;
}

function heileDurchSchlaf(ch) {
  const cap = chunkCapFuer(Number(ch.gesund));
  ch.gesund = Math.min(cap, Number(ch.gesund) + 30);
  ch.gesund_chunk_cap = cap;
  ch.erschoepfung = Math.max(0, Number(ch.erschoepfung) - 70);
  ch.hunger = Math.min(100, Number(ch.hunger) + 12);
  return ch;
}

// --- Schritt ausfuehren (Engine rechnet, Modell spuert nur Konsequenzen) ---------

async function fuehreSchrittAus(db, deps, characterId, schritt, jetztMs) {
  const karte = deps.karte;
  const brain = deps.brain;
  let ch = ladeCharakter(db, characterId);
  const notizen = [];
  const action = schritt.action;
  const detail = String(schritt.detail || '').slice(0, 280);
  const zielId = schritt.target || null;
  const poiVonId = (id) => (id ? db.prepare('SELECT * FROM pois WHERE id = ?').get(id) : null);

  if (action === 'walk_to') {
    const ziel = poiVonId(zielId);
    if (!ziel) return { ok: false, grund: 'ziel_unbekannt', notizen };
    const pois = db.prepare('SELECT id, pos_x, pos_z FROM pois').all();
    const startPoi = ch.inside_poi || 'apartment';
    let route = null;
    try { route = pf.findePoiRoute(karte.navGraph, pois, startPoi, ziel.id); } catch { route = null; }
    if (!route || !route.weg || route.weg.length === 0) {
      const d = Math.hypot(Number(ziel.pos_x) - Number(ch.pos_x), Number(ziel.pos_z) - Number(ch.pos_z));
      ch.pos_x = Number(ziel.pos_x); ch.pos_z = Number(ziel.pos_z);
      ch.inside_poi = ziel.id;
      lasseZeitVergehen(ch, dauerFuer(schritt, d));
      notizen.push(`Du bist zu ${ziel.name} gelaufen (${Math.round(d)} Meter).`);
    } else {
      const letzter = route.weg[route.weg.length - 1];
      ch.pos_x = letzter.x; ch.pos_z = letzter.z;
      ch.inside_poi = ziel.id;
      lasseZeitVergehen(ch, dauerFuer(schritt, route.distanzM));
      notizen.push(`Du bist zu ${ziel.name} gelaufen (${Math.round(route.distanzM)} Meter ueber Buergersteige).`);
    }
    const neu = entdeckeUmgebung(db, ch);
    for (const n of neu) notizen.push(`Neu entdeckt: ${n.name} (${n.distanzM} m).`);
    ch.current_action = 'idle';
  } else if (action === 'explore_street') {
    lasseZeitVergehen(ch, dauerFuer(schritt));
    ch.erschoepfung = Math.min(100, Number(ch.erschoepfung) + 6);
    ch.froh = Math.max(-100, Math.min(100, Number(ch.froh) + 3));
    notizen.push('Du bist ein Stueck durch die Strassen geschlendert und hast dich umgesehen.');
    const neu = entdeckeUmgebung(db, ch);
    for (const n of neu) notizen.push(`Neu entdeckt: ${n.name}.`);
    ch.current_action = 'idle';
  } else if (action === 'consume' || action === 'do_activity') {
    const ortId = zielId || ch.inside_poi;
    const poi = poiVonId(ortId);
    if (!poi) return { ok: false, grund: 'ort_unbekannt', notizen };
    const res = await arbiter.resolveIntent(db, brain, poi, action, detail || 'etwas Einfaches');
    const angebot = res.angebot;
    if (action === 'consume' && Number(ch.geld) < Number(angebot.price)) {
      return { ok: false, grund: 'geld_reicht_nicht', notizen, angebot };
    }
    ch.geld = Math.max(0, Math.round((Number(ch.geld) - Number(angebot.price)) * 100) / 100);
    ch.hunger = Math.max(0, Math.min(100, Number(ch.hunger) + Number(angebot.hunger_delta)));
    ch.erschoepfung = Math.max(0, Math.min(100, Number(ch.erschoepfung) + Number(angebot.erschoepfung_delta)));
    ch.froh = Math.max(-100, Math.min(100, Number(ch.froh) + Number(angebot.froh_delta)));
    lasseZeitVergehen(ch, dauerFuer(schritt));
    notizen.push(`${angebot.label}: ${angebot.narrative || ''}`.trim() + (res.neu ? ' (Neu im Kiez-Katalog!)' : ''));
    ch.current_action = 'idle';
  } else if (action === 'leave_note') {
    const ortId = zielId || ch.inside_poi;
    db.prepare("INSERT INTO messages_outbox (character_id, channel, target_poi, content, status, resolve_after_at) VALUES (?, 'leave_note', ?, ?, 'pending', datetime('now', '+2 hours'))")
      .run(characterId, ortId, detail || 'Hallo! Ich suche Arbeit als Spuelhilfe. Ich bin zuverlaessig.');
    lasseZeitVergehen(ch, dauerFuer(schritt));
    notizen.push('Du hast einen handgeschriebenen Zettel hinterlassen.');
    ch.current_action = 'idle';
  } else {
    lasseZeitVergehen(ch, 300);
    notizen.push('Ungewohnter Schritt (' + action + '): du hast etwas Zeit verbummelt.');
    ch.current_action = 'idle';
    klammereCharakter(ch);
    speichereCharakter(db, ch);
    return { ok: true, notizen, charakter: ch, vertagt: true };
  }

  klammereCharakter(ch);
  speichereCharakter(db, ch);
  db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, ?, ?, 1)")
    .run(characterId, 'aktion_' + action, JSON.stringify({ schritt, notizen }));
  return { ok: true, notizen, charakter: ch };
}


// --- Restliche Schritte: Pfand, Jobs, Ruhe, Arzt, Buecher --------------------------

async function fuehreSchrittAusTeil2(db, deps, characterId, schritt) {
  let ch = ladeCharakter(db, characterId);
  const notizen = [];
  const action = schritt.action;
  const detail = String(schritt.detail || '').slice(0, 280);

  if (action === 'collect_deposit') {
    const park = db.prepare("SELECT * FROM pois WHERE category = 'park' AND discovered = 1").get();
    if (park) { ch.pos_x = Number(park.pos_x); ch.pos_z = Number(park.pos_z); }
    const n = 1 + Math.floor(Math.random() * 3);
    const hat = db.prepare("SELECT count FROM inventory WHERE character_id = ? AND item_key = 'pfand'").get(characterId);
    if (hat) db.prepare("UPDATE inventory SET count = count + ? WHERE character_id = ? AND item_key = 'pfand'").run(n, characterId);
    else db.prepare("INSERT INTO inventory (character_id, item_key, label, count) VALUES (?, 'pfand', 'Pfandflaschen', ?)").run(characterId, n);
    lasseZeitVergehen(ch, dauerFuer(schritt));
    notizen.push(`Du hast ${n} leere Flaschen im Gebuesch gefunden und eingesteckt.`);
  } else if (action === 'return_deposit') {
    const hat = db.prepare("SELECT count FROM inventory WHERE character_id = ? AND item_key = 'pfand'").get(characterId);
    const n = hat ? Number(hat.count) : 0;
    if (n > 0) {
      const wert = Math.round(n * ECONOMY.pfandWert * 100) / 100;
      ch.geld = Math.round((Number(ch.geld) + wert) * 100) / 100;
      db.prepare("DELETE FROM inventory WHERE character_id = ? AND item_key = 'pfand'").run(characterId);
      notizen.push(`Du hast ${n} Flaschen am Kiosk abgegeben und ${wert.toFixed(2)} Euro bekommen.`);
    } else {
      notizen.push('Du hattest keine Pfandflaschen dabei.');
    }
    lasseZeitVergehen(ch, dauerFuer(schritt));
  } else if (action === 'look_for_work' || action === 'take_job') {
    const poi = schritt.target ? db.prepare('SELECT * FROM pois WHERE id = ?').get(schritt.target) : db.prepare('SELECT * FROM pois WHERE id = ?').get(ch.inside_poi);
    const job = arbiter.aktiverJob(db, characterId);
    if (job) {
      notizen.push(`Du hast schon Arbeit als ${job.role_title}.`);
    } else if (!poi) {
      return { ok: false, grund: 'ort_unbekannt', notizen };
    } else {
      const [lo, hi] = ECONOMY.wageBounds;
      const lohn = Math.round((lo + Math.random() * (hi - lo)) * 100) / 100;
      const res = arbiter.nimmJobAn(db, characterId, poi.id, 'Spülhilfe', lohn);
      if (res.ok) notizen.push(`Zusage! Du arbeitest als ${res.job.role_title} bei ${poi.name} (${res.job.wage_per_shift.toFixed(2)} Euro/Schicht).`);
      else notizen.push('Daraus wurde nichts: ' + res.grund);
    }
    lasseZeitVergehen(ch, dauerFuer(schritt));
  } else if (action === 'work_shift') {
    const job = arbiter.aktiverJob(db, characterId);
    if (!job) return { ok: false, grund: 'kein_job', notizen };
    const abrech = arbiter.rechneSchichtAb(db, characterId, job, klammereCharakter({ ...ch }));
    ch = ladeCharakter(db, characterId);
    ch.erschoepfung = Math.min(100, Number(ch.erschoepfung) + SEKUNDAER.erschoepfung.proSchicht);
    ch.hunger = Math.min(100, Number(ch.hunger) + SEKUNDAER.hunger.proSchicht);
    lasseZeitVergehen(ch, dauerFuer(schritt));
    if (abrech.abgebrochen) notizen.push(`Schicht abgebrochen: halber Lohn ${abrech.lohn.toFixed(2)} Euro, Strike ${abrech.strikes}.`);
    else notizen.push(`Schicht geschafft: ${abrech.lohn.toFixed(2)} Euro verdient.`);
    if (abrech.gekuendigt) notizen.push('Gekuendigt nach dem 2. Strike.');
  } else if (action === 'rest' || action === 'sleep') {
    ch.current_action = action;
    lasseZeitVergehen(ch, dauerFuer(schritt));
    if (action === 'sleep') {
      heileDurchSchlaf(ch);
      notizen.push('Du hast tief geschlafen und bist etwas erholt aufgewacht.');
    } else {
      notizen.push('Du hast dich ausgeruht.');
    }
  } else if (action === 'visit_doctor') {
    if (Number(ch.geld) < ECONOMY.arztKosten) return { ok: false, grund: 'geld_reicht_nicht', notizen };
    ch.geld = Math.round((Number(ch.geld) - ECONOMY.arztKosten) * 100) / 100;
    ch.gesund = Math.min(100, Number(ch.gesund) + 25);
    ch.gesund_chunk_cap = chunkCapFuer(Number(ch.gesund));
    lasseZeitVergehen(ch, dauerFuer(schritt));
    notizen.push('Der Arzt hat dich behandelt. Du fuehlst dich deutlich besser.');
  } else {
    return { ok: false, grund: 'unbekannt_teil2', notizen };
  }
  ch.current_action = 'idle';
  klammereCharakter(ch);
  speichereCharakter(db, ch);
  db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, ?, ?, 1)")
    .run(characterId, 'aktion_' + action, JSON.stringify({ schritt, notizen }));
  return { ok: true, notizen, charakter: ch };
}


// --- Buecher/Projekt/SMS + Dispatcher ------------------------------------------------

async function fuehreSchrittAusTeil3(db, deps, characterId, schritt) {
  let ch = ladeCharakter(db, characterId);
  const notizen = [];
  const action = schritt.action;
  const detail = String(schritt.detail || '').slice(0, 280);

  if (action === 'read_book') {
    if (ch.inside_poi !== 'apartment') return { ok: false, grund: 'nur_daheim', notizen };
    const buecher = db.prepare('SELECT * FROM books').all();
    const buch = buecher.find((b) => detail.toLowerCase().includes(b.id)) || buecher[0];
    if (buch) {
      let eintraege = [];
      try { eintraege = JSON.parse(buch.entries_json); } catch { eintraege = []; }
      const e = eintraege[0] || { title: 'Eintrag', content: '...' };
      const { speichereMemory } = require('./memory');
      speichereMemory(db, characterId, { tier: 'short', kind: 'read', text: `Gelesen: ${e.title} – ${String(e.content).slice(0, 120)}`, initial_weight: 3.5 });
      notizen.push(`Du hast gelesen: ${e.title}.`);
    }
    lasseZeitVergehen(ch, dauerFuer(schritt));
  } else if (action === 'write_notebook') {
    if (ch.inside_poi !== 'apartment') return { ok: false, grund: 'nur_daheim', notizen };
    const nb = db.prepare("SELECT * FROM books WHERE id = 'notizbuch'").get();
    if (nb) {
      let eintraege = [];
      try { eintraege = JSON.parse(nb.entries_json); } catch { eintraege = []; }
      eintraege.push({ topic: 'notiz_' + Date.now(), title: detail.slice(0, 60) || 'Notiz', content: detail });
      db.prepare("UPDATE books SET entries_json = ? WHERE id = 'notizbuch'").run(JSON.stringify(eintraege));
      notizen.push('Du hast etwas in dein Notizbuch geschrieben.');
    }
    lasseZeitVergehen(ch, dauerFuer(schritt));
  } else if (action === 'work_on_project') {
    const { speichereMemory } = require('./memory');
    speichereMemory(db, characterId, { tier: 'short', kind: 'work', text: 'Am Projekt gearbeitet: ' + detail.slice(0, 120), initial_weight: 3.5 });
    notizen.push('Du hast an deinem Projekt weitergearbeitet.');
    lasseZeitVergehen(ch, dauerFuer(schritt));
  } else if (action === 'send_sms' || action === 'send_email' || action === 'web_search' || action === 'quit_job' || action === 'buy_item') {
    if ((action === 'send_sms' || action === 'send_email' || action === 'web_search') && deps.telegram && typeof deps.telegram.sendeNachricht === 'function') {
      try { await deps.telegram.sendeNachricht(db, { character_id: characterId, channel: action, content: detail }); } catch { /* loggen, nicht crashen */ }
    }
    if (action === 'quit_job') {
      const job = arbiter.aktiverJob(db, characterId);
      if (job) {
        db.prepare("UPDATE jobs SET status = 'quit' WHERE id = ?").run(job.id);
        notizen.push(`Du hast als ${job.role_title} gekuendigt.`);
      } else notizen.push('Du hast gerade keinen Job zum Kuendigen.');
    } else {
      notizen.push(action === 'web_search' ? 'Du hast etwas nachgeschlagen.' : 'Nachricht abgeschickt – Antwort kommt vielleicht per Telegram.');
    }
    lasseZeitVergehen(ch, dauerFuer(schritt));
  } else {
    return { ok: false, grund: 'unbekannt', notizen };
  }
  ch.current_action = 'idle';
  klammereCharakter(ch);
  speichereCharakter(db, ch);
  db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, ?, ?, 1)")
    .run(characterId, 'aktion_' + action, JSON.stringify({ schritt, notizen }));
  return { ok: true, notizen, charakter: ch };
}

// Dispatcher: Teil 1 -> Teil 2 -> Teil 3 (sleep mit nightly läuft über Teil 2 + Engine-Tick)
async function schrittAusfuehren(db, deps, characterId, schritt, jetztMs) {
  const a = schritt.action;
  if (['walk_to', 'explore_street', 'consume', 'do_activity', 'leave_note'].includes(a)) {
    return fuehreSchrittAus(db, deps, characterId, schritt, jetztMs);
  }
  const r2 = await fuehreSchrittAusTeil2(db, deps, characterId, schritt);
  if (r2.ok || r2.grund !== 'unbekannt_teil2') return r2;
  return fuehreSchrittAusTeil3(db, deps, characterId, schritt);
}


// --- Planung: Multi-Step-Plan holen, Queue abarbeiten, Interrupts ---------------------

function ladeQueue(ch) {
  try {
    const q = JSON.parse(ch.plan_queue_json || '[]');
    return Array.isArray(q) ? q : [];
  } catch { return []; }
}

function speichereQueue(db, ch, queue, snapshot) {
  ch.plan_queue_json = JSON.stringify(queue || []);
  if (snapshot !== undefined) ch.plan_start_snapshot_json = snapshot ? JSON.stringify(snapshot) : null;
  db.prepare('UPDATE character SET plan_queue_json = ?, plan_start_snapshot_json = ? WHERE id = ?')
    .run(ch.plan_queue_json, ch.plan_start_snapshot_json, ch.id);
}

async function holeNeuenPlan(db, deps, characterId, jetztMs) {
  const brain = deps.brain;
  const promptMod = require('./prompt');
  const ch = ladeCharakter(db, characterId);
  const orte = bekannteOrte(db).map((o) => ({ id: o.id, name: o.name, category: o.category }));
  const letzterTick = 0;
  const ereignisse = ereignisSeit(db, characterId, letzterTick);
  const ctx = {
    orte,
    woName: ch.inside_poi ? (db.prepare('SELECT name FROM pois WHERE id = ?').get(ch.inside_poi) || {}).name || ch.inside_poi : 'draussen unterwegs',
    woText: ch.inside_poi ? `Du bist bei ${ch.inside_poi}.` : `Du bist draussen bei (${Number(ch.pos_x).toFixed(0)}, ${Number(ch.pos_z).toFixed(0)}).`,
    zeitText: tageszeitText(jetztMs),
    letztesEreignis: ereignisse.length > 0 ? `${ereignisse[0].type}: ${ereignisse[0].payload_json}` : null,
  };
  const gebaut = promptMod.buildPrompt(db, ch, ctx);
  // Ohne Brain: deterministischer Notfall-Plan (Engine läuft weiter).
  // Hinweis: ein gemocktes Brain (Tests) darf auch ohne API-Key entscheiden.
  if (!brain || typeof brain.decide !== 'function') {
    return { thought: 'Ohne Eingebung mache ich das Naheliegende.', retrospective: '',
      plan: [{ action: 'explore_street', target: null, detail: 'Umschauen' }, { action: 'rest', target: null, detail: 'Verschnaufen' }],
      fallback: true };
  }
  const antwort = await brain.decide({
    prompt: gebaut.prompt, whitelist: [], apiKey: process.env.OPENROUTER_API_KEY || 'mock',
    slot: undefined, musing: false, orte: orte.map((o) => o.name),
  });
  let obj = null;
  try { obj = JSON.parse(antwort.raw || '{}'); } catch { obj = null; }
  const geprueft = checks.validatePlan(obj, gebaut.whitelist);
  if (!geprueft.ok) {
    return { thought: geprueft.thought || 'Plan verworfen.', retrospective: geprueft.retrospective || '',
      plan: [{ action: 'rest', target: null, detail: 'Kurze Pause' }, { action: 'explore_street', target: null, detail: 'Umschauen' }],
      fallback: true, fehler: geprueft.failures };
  }
  return { thought: geprueft.thought, retrospective: geprueft.retrospective, plan: geprueft.plan, fallback: false, roh: antwort };
}

// Interrupt-Gründe: neuer Chunk unterschritten, Geld reicht nicht, Telegram neu, POI neu.
function interruptGrund(db, ch, snapshot, telegramNeu, neuEntdeckt) {
  if (chunkCapFuer(Number(ch.gesund)) < chunkCapFuer(Number(snapshot.gesund))) {
    return 'gesund_chunk_gefallen';
  }
  if (telegramNeu) return 'telegram_nachricht';
  if (neuEntdeckt && neuEntdeckt.length > 0) return 'poi_entdeckt';
  return null;
}


// --- Tod & Respawn (§7.5) ----------------------------------------------------------------

function pruefeTod(db, characterId) {
  const ch = ladeCharakter(db, characterId);
  if (!ch || ch.status === 'dead') return { tot: false, charakter: ch };
  if (Number(ch.gesund) > 0) return { tot: false, charakter: ch };
  const geboren = Date.parse(String(ch.created_at).replace(' ', 'T') + 'Z');
  const tage = Number.isFinite(geboren) ? (Date.now() - geboren) / 86400000 : 0;
  const sheet = db.prepare('SELECT category, text, written_by FROM character_sheet WHERE character_id = ?').all(characterId);
  const works = db.prepare('SELECT title, kind, progress, status FROM work_pieces WHERE character_id = ?').all(characterId);
  const entdeckt = db.prepare('SELECT COUNT(*) AS n FROM pois WHERE discovered = 1').get().n;
  db.prepare("UPDATE character SET status = 'dead', died_at = datetime('now'), cause_of_death = ? WHERE id = ?")
    .run('gesund auf 0 gefallen', characterId);
  db.prepare('INSERT INTO hall_of_fame (character_id, name, days_lived, summary_text, sheet_json, work_pieces_json, discovered_pois_json, cause_of_death) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(characterId, ch.name, Math.round(tage * 10) / 10, 'Lebte ' + Math.round(tage * 10) / 10 + ' Tage in St. Pauli.',
      JSON.stringify(sheet), JSON.stringify(works), JSON.stringify({ entdeckt }), 'gesund auf 0 gefallen');
  const apt = db.prepare("SELECT * FROM pois WHERE id = 'apartment'").get();
  const SEK = require('./config').SEKUNDAER;
  const r = db.prepare("INSERT INTO character (name, status, gesund, gesund_chunk_cap, froh, hunger, erschoepfung, geld, pos_x, pos_z, inside_poi, current_action) VALUES ('Kiezling', 'alive', 100, 100, 20, ?, ?, ?, ?, ?, 'apartment', 'idle')")
    .run(SEK.hunger.start, SEK.erschoepfung.start, SEK.geld.start, apt.pos_x, apt.pos_z);
  const neuId = Number(r.lastInsertRowid);
  for (const s of require('./db').SEED_SHEET) {
    db.prepare("INSERT INTO character_sheet (character_id, category, text, written_by) VALUES (?, ?, ?, 'creator')").run(neuId, s.category, s.text);
  }
  db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, 'respawn', ?, 1)")
    .run(neuId, JSON.stringify({ nach: characterId }));
  return { tot: true, altId: characterId, neuId };
}


// --- Tick: EIN Plan-Schritt pro Aufruf --------------------------------------------------

async function tick(db, deps, characterId, jetztMs) {
  const telegram = deps.telegram;
  let ch = ladeCharakter(db, characterId);
  if (!ch) return { ok: false, grund: 'kein_charakter' };
  if (ch.status === 'dead') {
    const r = pruefeTod(db, characterId);
    return { ok: true, respawn: true, neuId: r.neuId, notizen: ['Ein neuer Stadterkunder ist angekommen.'] };
  }
  let telegramNeu = false;
  if (telegram && typeof telegram.pollAntworten === 'function') {
    try {
      const res = await telegram.pollAntworten(db, characterId);
      telegramNeu = res && res.neu && res.neu.length > 0;
    } catch { telegramNeu = false; }
  }
  try { arbiter.bewerteBewerbungen(db, telegram); } catch { /* nie crashen */ }
  try { arbiter.pruefeInaktivitaet(db, characterId, jetztMs); } catch { /* nie crashen */ }

  let queue = ladeQueue(ch);
  let snapshot = null;
  try { snapshot = JSON.parse(ch.plan_start_snapshot_json || 'null'); } catch { snapshot = null; }
  if (queue.length > 0 && snapshot) {
    const grund = interruptGrund(db, ch, snapshot, telegramNeu, []);
    if (grund) {
      queue = [];
      speichereQueue(db, ch, queue, null);
      db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, 'interrupt', ?, 1)")
        .run(characterId, JSON.stringify({ grund }));
    }
  }
  let gedanke = '';
  if (queue.length === 0) {
    const neu = await holeNeuenPlan(db, deps, characterId, jetztMs);
    gedanke = neu.thought;
    queue = neu.plan || [];
    snapshot = { gesund: Number(ch.gesund), geld: Number(ch.geld), froh: Number(ch.froh), summary: neu.retrospective || '' };
    speichereQueue(db, ch, queue, snapshot);
    ch = ladeCharakter(db, characterId);
  }
  const schritt = queue.shift();
  if (!schritt) return { ok: false, grund: 'leerer_plan', notizen: [] };
  speichereQueue(db, ch, queue, snapshot);
  if (schritt.action === 'consume') {
    const frisch = ladeCharakter(db, characterId);
    const poi = schritt.target ? db.prepare('SELECT * FROM pois WHERE id = ?').get(schritt.target) : null;
    const kat = (poi && poi.category) || 'imbiss';
    const grenzen = require('./config').ECONOMY.priceBounds[kat] || [3.5, 10.0];
    if (Number(frisch.geld) < Number(grenzen[0])) {
      db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, 'interrupt', ?, 1)")
        .run(characterId, JSON.stringify({ grund: 'geld_reicht_nicht', schritt }));
      return { ok: true, schritt, ergebnis: { ok: false, grund: 'geld_reicht_nicht' }, notizen: ['Das Geld reicht nicht – Plan wird neu gemacht.'], interrupt: 'geld_reicht_nicht', gedanke };
    }
  }
  const ergebnis = await schrittAusfuehren(db, deps, characterId, schritt, jetztMs);
  ch = ladeCharakter(db, characterId);
  // Nächtliche Konsolidierung: schläft er daheim, läuft 1x/Tag der Nightly-Call
  let nightlyNotiz = null;
  if (ergebnis && ergebnis.ok && schritt.action === 'sleep' && ch.inside_poi === 'apartment' && deps.nightly !== false) {
    try {
      const log = ereignisSeit(db, characterId, 0).map((e) => `${e.type}: ${e.payload_json}`).join('\n').slice(0, 3000);
      const res = await arbiter.runNightlyConsolidation(db, deps.brain, characterId, log, jetztMs);
      if (res && res.ok) nightlyNotiz = 'Nachtsortierung: ' + res.headline;
    } catch { /* nightly darf nie crashen */ }
  }
  const tod = pruefeTod(db, characterId);
  if (tod.tot) {
    return { ok: true, schritt, ergebnis, notizen: (ergebnis.notizen || []).concat(['Der alte Stadterkunder ist gegangen. Ein neuer beginnt bei null.']), gestorben: true, neuId: tod.neuId, gedanke };
  }
  const neuEntdeckt = entdeckeUmgebung(db, ch);
  const notizen = (ergebnis.notizen || []).concat(neuEntdeckt.map((n) => `Neu entdeckt: ${n.name}.`));
  if (nightlyNotiz) notizen.push(nightlyNotiz);
  return { ok: true, schritt, ergebnis, notizen, gedanke, nightly: nightlyNotiz };
}

module.exports = {
  berlinJetzt, hamburgStunde, istNacht, tageszeitText,
  ladeCharakter, speichereCharakter, klammereCharakter,
  bekannteOrte, entdeckeUmgebung, ereignisSeit,
  dauerFuer, lasseZeitVergehen, heileDurchSchlaf,
  fuehreSchrittAus, fuehreSchrittAusTeil2, fuehreSchrittAusTeil3, schrittAusfuehren,
  ladeQueue, speichereQueue, holeNeuenPlan, interruptGrund,
  pruefeTod, tick,
};


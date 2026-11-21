'use strict';
// Simulation-Engine (§7 + M2): Echtzeit-Uhr (Europe/Berlin), komprimierte
// Aktions-Ticks, Multi-Step-Plan-Queue, Interrupts, Health-Chunks, Tod/Respawn.
// Die Engine rechnet – das Modell spürt nur Konsequenzen (natürliche Sätze).

const { AKTION, SEKUNDAER, ECONOMY, GESUND, FROH, chunkCapFuer } = require('./config');
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
  ch.froh = Math.max(FROH.min, Math.min(FROH.max, Number(ch.froh) || 0));
  ch.hunger = Math.max(0, Math.min(100, Number(ch.hunger) || 0));
  ch.erschoepfung = Math.max(0, Math.min(100, Number(ch.erschoepfung) || 0));
  ch.geld = Math.max(0, Math.round(Number(ch.geld) || 0));
  return ch;
}

// Wahrnehmung: bekannte Orte (discovered) + was ist in Sichtweite (22 m)?
function bekannteOrte(db) {
  return db.prepare('SELECT id, name, category, pos_x, pos_z, public_desc FROM pois WHERE discovered = 1 ORDER BY id').all();
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
    require('./memory').speichereMemory(db, ch.id, {
      tier: 'short', kind: 'fact', text: `Neuen Ort entdeckt: ${n.name}.`, initial_weight: 4.0,
    });
  }
  return neu;
}

function ereignisSeit(db, characterId, seitTick, limit = 5) {
  return db.prepare('SELECT type, payload_json, created_at FROM events WHERE character_id = ? AND id > ? ORDER BY id DESC LIMIT ?')
    .all(characterId, seitTick || 0, limit);
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

function addFroh(ch, delta) {
  let d = Number(delta) || 0;
  const f = Number(ch.froh) || 0;
  if (d > 0) {
    if (f >= 35) d = Math.min(1, d);
    else if (f >= 20) d = Math.max(1, Math.round(d * 0.5));
  }
  ch.froh = Math.max(FROH.min, Math.min(FROH.max, f + d));
  return ch.froh;
}

function lasseZeitVergehen(ch, sekunden) {
  const stunden = sekunden / 3600;
  ch.hunger = Math.min(100, ch.hunger + stunden * SEKUNDAER.hunger.proStunde);
  const muedFaktor = Number(ch.froh) < 0 ? 1.25 : 1.0;
  if (ch.current_action === 'sleep') {
    ch.erschoepfung = Math.max(0, ch.erschoepfung - stunden * 60);
  } else if (ch.current_action === 'rest') {
    ch.erschoepfung = Math.max(0, ch.erschoepfung - stunden * 90);
  } else {
    ch.erschoepfung = Math.min(100, ch.erschoepfung + stunden * SEKUNDAER.erschoepfung.proStunde * muedFaktor);
  }
  const frohRate = Number(ch.froh) > FROH.euphorieSchwelle ? FROH.euphorieProStunde : FROH.proStunde;
  ch.froh = Math.max(FROH.min, Math.min(FROH.max, Number(ch.froh) + stunden * frohRate));
  if (ch.hunger >= GESUND.hungerSchwelle || ch.erschoepfung >= GESUND.erschoepfungSchwelle) {
    ch.gesund = Math.max(0, ch.gesund - stunden * 4);
  }
  const aktuellerCap = chunkCapFuer(Number(ch.gesund));
  if (aktuellerCap < (Number(ch.gesund_chunk_cap) || 100)) {
    ch.gesund_chunk_cap = aktuellerCap;
  }
  return ch;
}

function heileDurchSchlaf(ch) {
  const cap = Math.min(Number(ch.gesund_chunk_cap) || 100, chunkCapFuer(Number(ch.gesund)));
  ch.gesund_chunk_cap = cap;
  ch.gesund = cap;
  ch.erschoepfung = 0;
  ch.hunger = Math.min(100, Number(ch.hunger) + 12);
  return ch;
}

// --- Schritt ausfuehren (Engine rechnet, Modell spuert nur Konsequenzen) ---------

// Feed-Dedup: identische in_feed-Nachricht nicht zweimal direkt hintereinander speichern.
function letzteFeedNachricht(db, characterId) {
  try {
    const r = db.prepare('SELECT payload_json FROM events WHERE character_id = ? AND in_feed = 1 ORDER BY id DESC LIMIT 1').get(characterId);
    return r ? String(r.payload_json || '') : '';
  } catch { return ''; }
}

function speichereFeed(db, characterId, typ, payload) {
  const text = JSON.stringify(payload);
  if (letzteFeedNachricht(db, characterId) === text) return false; // identisch → kein Spam
  db.prepare('INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, ?, ?, 1)')
    .run(characterId, typ, text);
  return true;
}

// --- Routen-State: schrittweises Laufen statt Teleport (Punkt 1) -------------------------------
// Aktive Route liegt in action_meta_json: { route: [{x,z}...], wegIndex, zielPoi, restM }.
// Pro Tick läuft die Figur SCHRITT_M (1.4 m/s * 20 s Tick = 28 m).
const SCHRITT_M = 28;
const ANKUNFT_M = 1.5; // < 1.5 m Rest = angekommen

function ladeRoute(ch) {
  try {
    const meta = JSON.parse(ch.action_meta_json || '{}');
    if (meta && Array.isArray(meta.route) && meta.route.length > 0) return meta;
  } catch { /* keine route */ }
  return null;
}

function speichereRoute(db, ch, meta) {
  ch.action_meta_json = meta ? JSON.stringify(meta) : null;
  db.prepare('UPDATE character SET action_meta_json = ? WHERE id = ?').run(ch.action_meta_json, ch.id);
}

function restDistanz(route, wegIndex, x, z) {
  let rest = 0;
  let px = x;
  let pz = z;
  for (let i = wegIndex; i < route.length; i += 1) {
    rest += Math.hypot(route[i].x - px, route[i].z - pz);
    px = route[i].x;
    pz = route[i].z;
  }
  return rest;
}

// Zielwahl für explore_street: 40–130 m entfernt, bevorzugt Richtung unentdeckter POIs.
// Mischt ab und an (max. 1x pro Kalendertag) gezielt eine unentdeckte Location ein.
function waehleExploreZiel(db, karte, ch) {
  const knoten = (karte.navGraph && karte.navGraph.nodes) || [];
  if (knoten.length === 0) return null;
  const unentdeckt = db.prepare('SELECT id, pos_x, pos_z FROM pois WHERE discovered = 0').all();
  if (unentdeckt.length > 0 && Math.random() < 0.25) {
    try {
      const datum = arbiter.berlinDatum(Date.now());
      const schonHeute = db.prepare(
        "SELECT payload_json FROM events WHERE character_id = ? AND type = 'explore_poi_hint' ORDER BY id DESC LIMIT 1"
      ).get(ch.id);
      const letztesDatum = schonHeute ? (JSON.parse(schonHeute.payload_json || '{}').datum || '') : '';
      if (letztesDatum !== datum) {
        const zielPoi = unentdeckt[Math.floor(Math.random() * unentdeckt.length)];
        db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, 'explore_poi_hint', ?, 0)")
          .run(ch.id, JSON.stringify({ datum, poi_id: zielPoi.id }));
        return { x: Number(zielPoi.pos_x), z: Number(zielPoi.pos_z), _mitZielPunkt: true };
      }
    } catch { /* normaler explore-fallback unten */ }
  }
  let richtung = null;
  if (unentdeckt.length > 0) {
    let best = null;
    let bestD = Infinity;
    for (const p of unentdeckt) {
      const d = Math.hypot(Number(p.pos_x) - Number(ch.pos_x), Number(p.pos_z) - Number(ch.pos_z));
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) richtung = { x: Number(best.pos_x) - Number(ch.pos_x), z: Number(best.pos_z) - Number(ch.pos_z) };
  }
  const kands = [];
  const punktWert = (px, pz, d) => {
    let bonus = 0;
    if (richtung) {
      const len = Math.hypot(richtung.x, richtung.z) || 1;
      bonus = ((px - Number(ch.pos_x)) * richtung.x + (pz - Number(ch.pos_z)) * richtung.z) / (len * (d || 1));
    }
    return d * 0.01 - bonus * 25 + Math.random() * 8;
  };
  for (const k of knoten) {
    const d = Math.hypot(Number(k.x) - Number(ch.pos_x), Number(k.z) - Number(ch.pos_z));
    if (d < 40 || d > 130) continue;
    kands.push({ k, d, wertung: punktWert(Number(k.x), Number(k.z), d) });
  }
  // Parkflächen komplett begehbar machen: auch Punkte in Park-Polygonen als Explore-Ziele zulassen
  for (const p of (karte.parks || [])) {
    const poly = p && p.polygon;
    if (!Array.isArray(poly) || poly.length < 3) continue;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, sx = 0, sz = 0;
    for (const [px, pz] of poly) {
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
      sx += px; sz += pz;
    }
    const proben = [[sx / poly.length, sz / poly.length]];
    for (let t = 0; t < 2; t += 1) {
      proben.push([minX + Math.random() * (maxX - minX), minZ + Math.random() * (maxZ - minZ)]);
    }
    for (const [px, pz] of proben) {
      if (!pf.punktInPolygon(px, pz, poly)) continue;
      const d = Math.hypot(px - Number(ch.pos_x), pz - Number(ch.pos_z));
      if (d < 20 || d > 130) continue;
      kands.push({ k: { x: Math.round(px * 10) / 10, z: Math.round(pz * 10) / 10 }, d, wertung: punktWert(px, pz, d) });
    }
  }
  if (kands.length === 0) {
    let best = null;
    let bestD = -1;
    for (const k of knoten) {
      const d = Math.hypot(Number(k.x) - Number(ch.pos_x), Number(k.z) - Number(ch.pos_z));
      if (d > bestD) { bestD = d; best = k; }
    }
    return best;
  }
  kands.sort((a, b) => a.wertung - b.wertung);
  return kands[0].k;
}

// Route starten: A* über die unsichtbaren Hauseingangspunkte auf der nächsten Strasse.
// So verlässt/betritt die Figur Gebäude immer über den nächsten Straßenpunkt,
// folgt allen Gehwegen/Ecken und läuft niemals diagonal durch Häuserblöcke.
function starteRoute(db, karte, ch, zielX, zielZ, zielPoi, erzwingeZielPunkt = false) {
  const navGraph = karte.navGraph;
  let tx = Number(zielX);
  let tz = Number(zielZ);
  let mitZielPunkt = Boolean(erzwingeZielPunkt);
  if (navGraph && zielPoi) {
    const ziel = db.prepare('SELECT id, pos_x, pos_z FROM pois WHERE id = ?').get(zielPoi);
    if (ziel) {
      tx = Number(ziel.pos_x);
      tz = Number(ziel.pos_z);
      mitZielPunkt = true;
    }
  }
  const parks = karte.parks || [];
  const imStartPark = Boolean(pf.parkFuerPunkt(parks, Number(ch.pos_x), Number(ch.pos_z)));
  const imZielPark = Boolean(pf.parkFuerPunkt(parks, tx, tz));
  const start = pf.findeRouteZwischenPunkten(
    navGraph, Number(ch.pos_x), Number(ch.pos_z), tx, tz,
    { mitStartPunkt: Boolean(ch.inside_poi) || imStartPark, mitZielPunkt: mitZielPunkt || imZielPark, parks }
  );
  const weg = (start && start.weg && !start.keineRoute) ? start.weg : [];
  if (weg.length < 2) return null;
  const meta = {
    route: weg.map((p) => ({ x: Math.round(Number(p.x) * 10) / 10, z: Math.round(Number(p.z) * 10) / 10 })),
    wegIndex: 0,
    zielPoi: zielPoi || null,
    restM: Math.round((start.distanzM || 0) * 10) / 10,
  };
  speichereRoute(db, ch, meta);
  return meta;
}

// Einen Schritt (SCHRITT_M) entlang der Route laufen.
function geheSchritt(db, ch, meta) {
  const route = meta.route;
  let budget = SCHRITT_M;
  let i = meta.wegIndex || 0;
  while (budget > 0.001 && i < route.length) {
    const ziel = route[i];
    const dx = ziel.x - Number(ch.pos_x);
    const dz = ziel.z - Number(ch.pos_z);
    const d = Math.hypot(dx, dz);
    if (d < 0.001) { i += 1; continue; }
    if (d <= budget) {
      ch.pos_x = ziel.x;
      ch.pos_z = ziel.z;
      budget -= d;
      i += 1;
    } else {
      ch.pos_x = Number(ch.pos_x) + (dx / d) * budget;
      ch.pos_z = Number(ch.pos_z) + (dz / d) * budget;
      budget = 0;
    }
    ch.heading_rad = Math.atan2(dx, dz);
  }
  meta.wegIndex = i;
  meta.restM = Math.round(restDistanz(route, i, Number(ch.pos_x), Number(ch.pos_z)) * 10) / 10;
  speichereRoute(db, ch, meta);
  const angekommen = i >= route.length || meta.restM < ANKUNFT_M;
  return { angekommen, restM: meta.restM };
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
    if (!ziel) {
      // Strukturierte Diagnose (Dev-/Debug-Modus): welches target, was wäre erlaubt
      try {
        const devAn = String(process.env.AIQUARIUM_DEV ?? '1') !== '0';
        if (devAn) {
          const alle = db.prepare('SELECT id FROM pois ORDER BY id').all().map((r) => r.id);
          const dbg = { code: 'whitelist', reason: `Whitelist-Verstoß: target "${String(zielId || '')}" unbekannt (erlaubt: ${alle.join(', ')}).`, feld: 'target', wert: String(zielId || ''), erlaubt: alle, rawResponse: JSON.stringify(schritt || {}), model: '', tier: 'engine' };
          console.log(`[not:whitelist] ${dbg.reason}`);
          console.log(`[rawResponse]\n${dbg.rawResponse}\n[/rawResponse]`);
        }
      } catch { /* Diagnose darf nie crashen */ }
      return { ok: false, grund: 'ziel_unbekannt', notizen };
    }
    // Route fortsetzen oder neu starten (kein Teleport mehr)
    let meta = (ch.current_action === 'walk_to' || ch.current_action === 'explore_street') ? ladeRoute(ch) : null;
    let routenStart = false;
    if (!meta || meta.zielPoi !== ziel.id) {
      meta = starteRoute(db, karte, ch, Number(ziel.pos_x), Number(ziel.pos_z), ziel.id);
      if (!meta) {
        // PATHFINDING-FIX: keine Luftlinie mehr – ohne Graph-Route bleibt
        // die Figur stehen statt quer durch Haeuser zu laufen.
        return { ok: false, grund: 'keine_route', notizen };
      }
      notizen.push(`Du machst dich auf den Weg zu ${ziel.name}.`);
      routenStart = true;
    }
    ch.current_action = 'walk_to';
    ch.action_target_poi = ziel.id;
    ch.inside_poi = null; // Unterwegs draußen auf den Wegen
    lasseZeitVergehen(ch, 20); // ein Tick = 20 s Aquarium-Zeit
    const schritt = geheSchritt(db, ch, meta);
    if (!schritt.angekommen) {
      // LAUF-SPAM-FIX: unterwegs nur Status weiterführen (pos/route persistiert),
      // KEINE Feed-Zeile, KEIN action-Event – Feed nur bei Start/Ankunft/Fehler.
      klammereCharakter(ch);
      speichereCharakter(db, ch);
      // Nur der echte Routen-Start erzeugt eine Feed-Notiz (einmalig), danach Stille.
      if (routenStart) speichereFeed(db, characterId, 'aktion_' + action, { schritt, notizen });
      else notizen.length = 0;
      return { ok: true, notizen, charakter: ch, unterwegs: true, restM: schritt.restM };
    } else {
      ch.pos_x = Number(ziel.pos_x); ch.pos_z = Number(ziel.pos_z);
      ch.inside_poi = ziel.id;
      speichereRoute(db, ch, null);
      ch.current_action = 'idle';
      ch.action_target_poi = null;
      const neu = entdeckeUmgebung(db, ch);
      for (const n of neu) notizen.push(`Neu entdeckt: ${n.name} (${n.distanzM} m).`);
      notizen.push(`Angekommen bei ${ziel.name}.`);
    }
  } else if (action === 'explore_street') {
    let meta = ch.current_action === 'explore_street' ? ladeRoute(ch) : null;
    if (!meta) {
      const ziel = waehleExploreZiel(db, karte, ch);
      if (!ziel) {
        lasseZeitVergehen(ch, dauerFuer(schritt));
        notizen.push('Du bist ein Stück durch die Straßen geschlendert.');
      } else {
        meta = starteRoute(db, karte, ch, Number(ziel.x), Number(ziel.z), null, Boolean(ziel._mitZielPunkt));
        if (!meta) {
          lasseZeitVergehen(ch, dauerFuer(schritt));
          notizen.push('Du bist ein Stück durch die Straßen geschlendert.');
        } else {
          notizen.push(`Du schlenderst los – Richtung ${Math.round(meta.restM)} m unbekannte Ecke.`);
        }
      }
    }
    if (meta) {
      ch.current_action = 'explore_street';
      ch.inside_poi = null; // Draußen unterwegs
      lasseZeitVergehen(ch, 20);
      const schritt2 = geheSchritt(db, ch, meta);
      const neu = entdeckeUmgebung(db, ch);
      // Echte Ereignisse → Feed (mit Dedup); reines Weiterlaufen → nur Status, kein Spam.
      let ereignis = false;
      for (const n of neu) { notizen.push(`Neu entdeckt: ${n.name}.`); ereignis = true; }
      if (schritt2.angekommen) {
        speichereRoute(db, ch, null);
        ch.current_action = 'idle';
        ch.erschoepfung = Math.min(100, Number(ch.erschoepfung) + 6);
        addFroh(ch, 3);
        notizen.push('Du hast dich umgesehen und atmest durch.');
        ereignis = true;
      } else {
        // LAUF-SPAM-FIX: kein „unterwegs (…)" in Feed/DB – Figur läuft lautlos weiter.
        klammereCharakter(ch);
        speichereCharakter(db, ch);
        return { ok: true, notizen, charakter: ch, unterwegs: true, restM: schritt2.restM };
      }
      if (ereignis) speichereFeed(db, characterId, 'aktion_' + action, { schritt, notizen });
      else {
        klammereCharakter(ch);
        speichereCharakter(db, ch);
        return { ok: true, notizen, charakter: ch, unterwegs: true, restM: schritt2.restM };
      }
    } else {
      ch.current_action = 'idle';
    }
  } else if (action === 'consume' || action === 'do_activity') {
    if (action === 'consume' && Number(ch.hunger) < 20) {
      return { ok: false, grund: 'nicht_hungrig', notizen: ['Du bist noch völlig satt und bekommst gerade keinen Bissen herunter.'] };
    }
    const ortId = zielId || ch.inside_poi;
    const poi = poiVonId(ortId);
    if (!poi) return { ok: false, grund: 'ort_unbekannt', notizen };
    const res = await arbiter.resolveIntent(db, brain, poi, action, detail || 'etwas Einfaches', characterId);
    const angebot = res.angebot;
    if (action === 'consume' && Number(ch.geld) < Number(angebot.price)) {
      return { ok: false, grund: 'geld_reicht_nicht', notizen, angebot };
    }
    const frohDelta = (action === 'consume' && Number(ch.hunger) < 40 && Number(angebot.froh_delta) > 0)
      ? Math.round(Number(angebot.froh_delta) * 0.5)
      : Number(angebot.froh_delta);
    ch.geld = Math.max(0, Math.round(Number(ch.geld) - Math.round(Number(angebot.price))));
    ch.hunger = Math.max(0, Math.min(100, Number(ch.hunger) + Number(angebot.hunger_delta)));
    ch.erschoepfung = Math.max(0, Math.min(100, Number(ch.erschoepfung) + Number(angebot.erschoepfung_delta)));
    addFroh(ch, frohDelta);
    lasseZeitVergehen(ch, dauerFuer(schritt));
    notizen.push(`${angebot.label}: ${angebot.narrative || ''}`.trim() + (res.neu ? ' (Neu im Kiez-Katalog!)' : ''));
    if (frohDelta >= 5 || res.neu) {
      require('./memory').speichereMemory(db, characterId, {
        tier: 'short', kind: 'moment',
        text: `${poi.name}: ${angebot.label}${angebot.narrative ? ' – ' + angebot.narrative : ''}`.slice(0, 180),
        initial_weight: 3.5,
      });
    }
    ch.current_action = 'idle';
  } else if (action === 'leave_note') {
    const ortId = zielId || ch.inside_poi;
    const zettelText = detail || 'Hallo! Ich suche Arbeit als Spuelhilfe. Ich bin zuverlaessig.';
    const tgAktiv = deps.telegram && typeof deps.telegram.istAktiv === 'function' && deps.telegram.istAktiv();
    const delay = tgAktiv ? '+15 minutes' : '+3 minutes';
    const ins = db.prepare("INSERT INTO messages_outbox (character_id, channel, target_poi, content, status, resolve_after_at) VALUES (?, 'leave_note', ?, ?, 'pending', datetime('now', ?))")
      .run(characterId, ortId, zettelText, delay);
    db.prepare("INSERT INTO open_loops (character_id, kind, text, urgency, related_poi, status) VALUES (?, 'question', ?, 0.6, ?, 'open')")
      .run(characterId, `Antwort auf Zettel bei ${ortId || 'unterwegs'}: ${zettelText.slice(0, 120)}`, ortId || null);
    if (deps.telegram && typeof deps.telegram.sendeNachricht === 'function') {
      try {
        await deps.telegram.sendeNachricht(db, {
          id: Number(ins.lastInsertRowid), character_id: characterId, channel: 'leave_note', content: zettelText, status: 'pending',
        });
      } catch { /* loggen, nicht crashen */ }
    }
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
  speichereFeed(db, characterId, 'aktion_' + action, { schritt, notizen });
  return { ok: true, notizen, charakter: ch };
}

// --- Restliche Schritte: Pfand, Jobs, Ruhe, Arzt, Buecher --------------------------

async function fuehreSchrittAusTeil2(db, deps, characterId, schritt) {
  let ch = ladeCharakter(db, characterId);
  const notizen = [];
  const action = schritt.action;
  const detail = String(schritt.detail || '').slice(0, 280);

  if (action === 'collect_deposit') {
    const ort = ch.inside_poi ? db.prepare('SELECT id, category FROM pois WHERE id = ?').get(ch.inside_poi) : null;
    if (ch.inside_poi && (!ort || ort.category !== 'park')) {
      return { ok: false, grund: 'falscher_ort', notizen: ['Pfandflaschen kannst du nur draußen auf den Straßen oder im Park sammeln.'] };
    }
    const n = Math.random() < 0.65 ? (1 + Math.floor(Math.random() * 2)) : 0;
    if (n > 0) {
      const hat = db.prepare("SELECT count FROM inventory WHERE character_id = ? AND item_key = 'pfand'").get(characterId);
      if (hat) db.prepare("UPDATE inventory SET count = count + ? WHERE character_id = ? AND item_key = 'pfand'").run(n, characterId);
      else db.prepare("INSERT INTO inventory (character_id, item_key, label, count) VALUES (?, 'pfand', 'Pfandflaschen', ?)").run(characterId, n);
      notizen.push(`Du hast ${n} ${n === 1 ? 'leere Flasche' : 'leere Flaschen'} ${ort ? 'im Gebuesch' : 'auf der Strasse'} gefunden und eingesteckt.`);
    } else {
      notizen.push('Du hast gesucht, aber diesmal keine Pfandflaschen gefunden.');
    }
    lasseZeitVergehen(ch, dauerFuer(schritt));
  } else if (action === 'return_deposit') {
    if (ch.inside_poi !== 'spaeti') {
      return { ok: false, grund: 'nur_am_spaeti', notizen: ['Pfandflaschen kannst du nur am Späti (spaeti) abgeben.'] };
    }
    const hat = db.prepare("SELECT count FROM inventory WHERE character_id = ? AND item_key = 'pfand'").get(characterId);
    const n = hat ? Number(hat.count) : 0;
    if (n > 0) {
      const wert = Math.max(1, Math.round(n * ECONOMY.pfandWert));
      ch.geld = Math.round(Number(ch.geld) + wert);
      db.prepare("DELETE FROM inventory WHERE character_id = ? AND item_key = 'pfand'").run(characterId);
      notizen.push(`Du hast ${n} Flaschen am Kiosk abgegeben und ${wert} Euro bekommen.`);
    } else {
      notizen.push('Du hattest keine Pfandflaschen dabei.');
    }
    lasseZeitVergehen(ch, dauerFuer(schritt));
  } else if (action === 'look_for_work' || action === 'take_job') {
    const job = arbiter.aktiverJob(db, characterId);
    if (job) {
      notizen.push(`Du hast schon Arbeit als ${job.role_title} bei ${job.poi_id}. Such nicht weiter – plane stattdessen work_shift bei ${job.poi_id}, wenn du Geld brauchst.`);
    } else {
      notizen.push('Du kannst nicht einfach so einen Job annehmen – hinterlasse mit leave_note einen Zettel bei einem Laden und warte auf Antwort.');
    }
    lasseZeitVergehen(ch, dauerFuer(schritt));
  } else if (action === 'work_shift') {
    const job = arbiter.aktiverJob(db, characterId);
    if (!job) return { ok: false, grund: 'kein_job', notizen };
    const abrech = arbiter.rechneSchichtAb(db, characterId, job, klammereCharakter({ ...ch }));
    ch = ladeCharakter(db, characterId);
    const schichtMued = Number(ch.froh) < 0
      ? Math.round(SEKUNDAER.erschoepfung.proSchicht * 1.2)
      : (Number(ch.froh) >= 20 ? Math.round(SEKUNDAER.erschoepfung.proSchicht * 0.9) : SEKUNDAER.erschoepfung.proSchicht);
    ch.erschoepfung = Math.min(100, Number(ch.erschoepfung) + schichtMued);
    ch.hunger = Math.min(100, Number(ch.hunger) + SEKUNDAER.hunger.proSchicht);
    addFroh(ch, -2);
    lasseZeitVergehen(ch, dauerFuer(schritt));
    if (abrech.abgebrochen) {
      notizen.push(`Schicht abgebrochen: halber Lohn ${Math.round(abrech.lohn)} Euro, Strike ${abrech.strikes}.`);
    } else {
      notizen.push(`Schicht geschafft: ${Math.round(abrech.lohn)} Euro verdient.`);
      require('./memory').speichereMemory(db, characterId, {
        tier: 'short', kind: 'work',
        text: `Schicht bei ${job.poi_id} geschafft (${Math.round(abrech.lohn)} Euro verdient).`,
        initial_weight: 3.5,
      });
    }
    if (abrech.gekuendigt) notizen.push('Gekuendigt nach dem 2. Strike.');
  } else if (action === 'rest' || action === 'sleep') {
    if (action === 'sleep') {
      if (ch.inside_poi !== 'apartment') {
        return { ok: false, grund: 'nur_daheim', notizen: ['Zum Schlafen musst du heim in deine Wohnung.'] };
      }
      if (Number(ch.erschoepfung) < 50) {
        return { ok: false, grund: 'nicht_muede', notizen: ['Du bist noch viel zu wach zum Schlafen und stehst wieder vom Bett auf.'] };
      }
    }
    ch.current_action = action;
    lasseZeitVergehen(ch, dauerFuer(schritt));
    if (action === 'sleep') {
      heileDurchSchlaf(ch);
      notizen.push('Du hast tief geschlafen und bist erholt aufgewacht.');
    } else {
      notizen.push('Du hast dich ausgeruht.');
    }
  } else if (action === 'visit_doctor') {
    if (Number(ch.geld) < ECONOMY.arztKosten) return { ok: false, grund: 'geld_reicht_nicht', notizen };
    ch.geld = Math.max(0, Math.round(Number(ch.geld) - ECONOMY.arztKosten));
    const neuesCap = Math.min(100, (Number(ch.gesund_chunk_cap) || chunkCapFuer(Number(ch.gesund))) + 20);
    ch.gesund_chunk_cap = neuesCap;
    ch.gesund = neuesCap;
    lasseZeitVergehen(ch, dauerFuer(schritt));
    notizen.push('Der Arzt hat dich behandelt. Du fuehlst dich deutlich besser.');
  } else {
    return { ok: false, grund: 'unbekannt_teil2', notizen };
  }
  ch.current_action = 'idle';
  klammereCharakter(ch);
  speichereCharakter(db, ch);
  speichereFeed(db, characterId, 'aktion_' + action, { schritt, notizen });
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
    const dLow = detail.toLowerCase();
    const buch = buecher.find((b) => dLow.includes(b.id.toLowerCase()) || dLow.includes(String(b.title || '').toLowerCase()))
      || buecher.find((b) => {
        try {
          const es = JSON.parse(b.entries_json || '[]');
          return es.some((x) => (x.topic && dLow.includes(String(x.topic).toLowerCase())) || (x.title && dLow.includes(String(x.title).toLowerCase())));
        } catch { return false; }
      })
      || buecher[0];
    if (buch) {
      let eintraege = [];
      try { eintraege = JSON.parse(buch.entries_json); } catch { eintraege = []; }
      let e;
      if (buch.id === 'stadtlexikon') {
        e = await arbiter.fragLexikon(db, deps.brain, detail);
        const liste = Array.isArray(eintraege) ? eintraege : [];
        liste.push(e);
        if (liste.length > 20) liste.splice(0, liste.length - 20);
        db.prepare("UPDATE books SET entries_json = ? WHERE id = 'stadtlexikon'").run(JSON.stringify(liste));
      } else {
        e = eintraege.find((x) =>
          (x.topic && dLow.includes(String(x.topic).toLowerCase())) ||
          (x.title && dLow.includes(String(x.title).toLowerCase()))
        ) || eintraege[0] || { title: 'Eintrag', content: '...' };
      }
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
      // Feedback-Loop-Fix ("Ankunft notieren" x1343): identische Einträge
      // (normalisierter Titel + Text) werden nicht doppelt ins Notizbuch geschrieben.
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();
      const titel = (detail.slice(0, 60) || 'Notiz').trim();
      const duplikat = eintraege.some((e) => norm(e.title) === norm(titel) && norm(e.content) === norm(detail));
      if (duplikat) {
        notizen.push('Das steht schon in deinem Notizbuch – du schreibst es nicht doppelt.');
      } else {
        eintraege.push({ topic: 'notiz_' + Date.now(), title: titel, content: detail });
        db.prepare("UPDATE books SET entries_json = ? WHERE id = 'notizbuch'").run(JSON.stringify(eintraege));
        notizen.push('Du hast etwas in dein Notizbuch geschrieben.');
      }
    }
    lasseZeitVergehen(ch, dauerFuer(schritt));
  } else if (action === 'work_on_project') {
    const ort = ch.inside_poi ? db.prepare('SELECT id, category FROM pois WHERE id = ?').get(ch.inside_poi) : null;
    if (!ort || (ort.id !== 'apartment' && ort.category !== 'park')) {
      return { ok: false, grund: 'falscher_ort', notizen: ['An deinem Projekt kannst du nur daheim (apartment) oder im Park arbeiten.'] };
    }
    let wp = db.prepare("SELECT * FROM work_pieces WHERE character_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1").get(characterId);
    const fragment = detail || 'Ein weiterer Gedanke über St. Pauli.';
    if (!wp) {
      const titel = String(schritt.title || 'Notizen aus St. Pauli').slice(0, 80);
      const frags = [{ added_at: new Date().toISOString(), text: fragment, source: ort.id }];
      const ins = db.prepare("INSERT INTO work_pieces (character_id, title, kind, poi_id, progress, fragments_json, status) VALUES (?, ?, 'zine', ?, 15, ?, 'in_progress')")
        .run(characterId, titel, ort.id, JSON.stringify(frags));
      wp = db.prepare('SELECT * FROM work_pieces WHERE id = ?').get(Number(ins.lastInsertRowid));
    } else {
      let frags = [];
      try { frags = JSON.parse(wp.fragments_json || '[]'); } catch { frags = []; }
      frags.push({ added_at: new Date().toISOString(), text: fragment, source: ort.id });
      const prog = Math.min(100, (Number(wp.progress) || 0) + 15);
      const st = prog >= 100 ? 'completed' : 'in_progress';
      db.prepare("UPDATE work_pieces SET progress = ?, fragments_json = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(prog, JSON.stringify(frags), st, wp.id);
      wp = db.prepare('SELECT * FROM work_pieces WHERE id = ?').get(wp.id);
    }
    addFroh(ch, 6);
    const { speichereMemory } = require('./memory');
    speichereMemory(db, characterId, { tier: 'short', kind: 'work', text: `Projekt „${wp.title}“ (${wp.progress} %): ${fragment.slice(0, 100)}`, initial_weight: 3.5 });
    notizen.push(`Du hast an „${wp.title}“ weitergearbeitet (${wp.progress} %).`);
    lasseZeitVergehen(ch, dauerFuer(schritt));
  } else if (action === 'buy_item') {
    if (ch.inside_poi !== 'spaeti') {
      return { ok: false, grund: 'nur_am_spaeti', notizen: ['Gebraucht-Elektronik bekommst du nur am Späti (spaeti).'] };
    }
    const preis = 50;
    if (Number(ch.geld) < preis) {
      return { ok: false, grund: 'geld_reicht_nicht', notizen: ['Ein gebrauchtes Smartphone kostet 50 Euro – so viel Geld hast du noch nicht.'] };
    }
    ch.geld = Math.max(0, Math.round(Number(ch.geld) - preis));
    const hat = db.prepare("SELECT id FROM inventory WHERE character_id = ? AND item_key = 'handy'").get(characterId);
    if (hat) db.prepare("UPDATE inventory SET count = count + 1 WHERE id = ?").run(hat.id);
    else db.prepare("INSERT INTO inventory (character_id, item_key, label, count) VALUES (?, 'handy', 'Gebrauchtes Smartphone', 1)").run(characterId);
    require('./memory').speichereMemory(db, characterId, {
      tier: 'short', kind: 'moment', text: 'Am Späti ein gebrauchtes Smartphone für 50 Euro gekauft.', initial_weight: 5.0,
    });
    notizen.push('Du hast dir am Späti ein gebrauchtes Smartphone für 50 Euro gekauft! Jetzt kannst du SMS und E-Mails schreiben.');
    lasseZeitVergehen(ch, dauerFuer(schritt));
  } else if (action === 'send_sms' || action === 'send_email' || action === 'web_search' || action === 'quit_job') {
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
  speichereFeed(db, characterId, 'aktion_' + action, { schritt, notizen });
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

function holeNeuenPlan(db, deps, characterId, jetztMs) {
  return holeNeuenPlanMitMeta(db, deps, characterId, jetztMs).then((r) => r);
}

// Interne Variante mit KI-Quellennachweis für den Feed (Punkt 7):
// { thought, retrospective, plan, fallback, fehler, quelle: { source, model, tokens, debug } }
// quelle.debug: { code, reason, rawResponse, model, tier } (Dev-/Debug-Modus)
async function holeNeuenPlanMitMeta(db, deps, characterId, jetztMs) {
  const META_FALLBACK = { source: 'fallback', model: '', tokens: 0 };
  const META_QUEUE = { source: 'queue', model: '', tokens: 0 };
  void META_QUEUE;
  const brain = deps.brain;
  const promptMod = require('./prompt');
  const ch = ladeCharakter(db, characterId);
  const orte = bekannteOrte(db).map((o) => ({ id: o.id, name: o.name, category: o.category, public_desc: o.public_desc || '' }));
  const devAn = String(process.env.AIQUARIUM_DEV ?? '1') !== '0';
  const recentThoughts = [];
  try {
    const tRows = db.prepare("SELECT payload_json FROM events WHERE character_id = ? AND type = 'plan' ORDER BY id DESC LIMIT 3").all(characterId);
    for (const r of tRows) {
      const p = JSON.parse(r.payload_json || '{}');
      if (p.thought) recentThoughts.push(String(p.thought));
    }
  } catch { /* egal */ }
  const letzterTick = 0;
  const ereignisse = ereignisSeit(db, characterId, letzterTick, 6);
  const letzteNotizen = [];
  for (const ev of ereignisse) {
    try {
      const p = JSON.parse(ev.payload_json || '{}');
      if (Array.isArray(p.notizen) && p.notizen.length > 0) letzteNotizen.push(p.notizen.join(' '));
      else if (p.name) letzteNotizen.push(`Neu entdeckt: ${p.name}`);
      else if (p.text) letzteNotizen.push(String(p.text));
      else if (p.rolle) letzteNotizen.push(`Job-Zusage: ${p.rolle}`);
      else if (p.grund) letzteNotizen.push(`Unterbrochen: ${p.grund}`);
    } catch { /* egal */ }
    if (letzteNotizen.length >= 4) break;
  }
  const ctx = {
    orte,
    woName: ch.inside_poi ? (db.prepare('SELECT name FROM pois WHERE id = ?').get(ch.inside_poi) || {}).name || ch.inside_poi : 'draussen unterwegs',
    woText: ch.inside_poi ? `Du bist bei ${ch.inside_poi}.` : 'Du bist draussen unterwegs.',
    zeitText: tageszeitText(jetztMs),
    letztesEreignis: letzteNotizen[0] || null,
    letzteNotizen,
    recentThoughts,
  };
  const gebaut = promptMod.buildPrompt(db, ch, ctx);
  // LLM-Input-Log (Debug): was die KI bei diesem Call als INPUT bekommt –
  // voller Prompt + Whitelist, als Event (in_feed = 0, nur fürs Gehirn-Log).
  if (devAn) {
    try {
      db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, 'llm_input', ?, 0)")
        .run(characterId, JSON.stringify({ role: 'alltag', schema: 'plan', whitelist: gebaut.whitelist, prompt: gebaut.prompt }));
    } catch { /* Gehirn-Log darf nie crashen */ }
  }
  // Ohne Brain: deterministischer Notfall-Plan (Engine läuft weiter).
  // Hinweis: ein gemocktes Brain (Tests) darf auch ohne API-Key entscheiden.
  if (!brain || typeof brain.decide !== 'function') {
    return { thought: 'Ohne Eingebung mache ich das Naheliegende.', retrospective: '',
      plan: [{ action: 'explore_street', target: null, detail: 'Umschauen' }, { action: 'rest', target: null, detail: 'Verschnaufen' }],
      fallback: true, quelle: META_FALLBACK };
  }
  const antwort = await brain.decide({
    prompt: gebaut.prompt, whitelist: gebaut.whitelist, recentThoughts, apiKey: process.env.OPENROUTER_API_KEY || 'mock',
    slot: undefined, musing: false, orte: orte.map((o) => o.id), role: 'alltag', schema: 'plan',
  });
  // KI-Quelle für den Dev-Feed: usedModel + Tokens + Soll-Modell aus decide-Antwort.
  // Bei Fallback: [not:soll:grund] [fallback] [modell] – sonst [modell] [free] [tok].
  const usage = (antwort && (antwort.usage || antwort.tokens)) || {};
  const debugEinzeln = antwort && antwort.debug && typeof antwort.debug === 'object' ? antwort.debug : null;
  const debugListe = Array.isArray(antwort && antwort.versuchDebug) ? antwort.versuchDebug.filter(Boolean) : [];
  if (!debugListe.length && debugEinzeln) debugListe.push(debugEinzeln);
  const quelle = {
    source: antwort && antwort.stale ? 'fallback' : 'llm',
    model: String((antwort && (antwort.usedModel || antwort.modell || antwort.model)) || ''),
    provider: String((antwort && (antwort.provider || '')) || ''),
    providerLabel: String((antwort && (antwort.providerLabel || '')) || ''),
    tokens: Number(antwort.tokens || usage.completion_tokens || usage.total_tokens || 0) || 0,
    tried: String((antwort && (antwort.tried || '')) || ''),
    grund: String((antwort && (antwort.grund || '')) || ''),
    grund2: String((antwort && (antwort.grund2 || '')) || ''),
    reason: String((antwort && (antwort.versuch === 'fallback' ? antwort.reason || '' : '')) || ''),
    debug: debugEinzeln || null,
    debugVersuche: debugListe.length > 0 ? debugListe : undefined,
  };
  const loggeDebug = (dbg) => {
    if (!dbg || !devAn) return;
    try {
      const tag = String(dbg.providerLabel || '') || (String(dbg.provider || '').startsWith('google') ? 'Google Direct' : '');
      console.log(`[${dbg.versuch === 'primary' ? 'primary' : `not:${dbg.code || '?'}`}]\u2009${dbg.model || '?'}${tag ? ` (${tag})` : ''} tier=${dbg.tier || '?'} – ${dbg.reason || ''}`);
      console.log(`[rawResponse:${dbg.model || '?'}]\n${String(dbg.rawResponse ?? '')}\n[/rawResponse]`);
    } catch { /* Logging darf nie crashen */ }
  };
  // Fix Doppelvalidierung: Brain hat bereits mit validatePlan geprüft (inkl. fehlerDetails
  // + versuchDebug-Kette). Engine parst NICHT neu, sondern übernimmt das Brain-Ergebnis –
  // keine doppelten thought_leer/plan_fehlend-Paare mehr, keine verworfenen Google-Debugs.
  // Nur wenn Brain KEIN Plan-Ergebnis lieferte (altes Mock/Arbiter-Format), einmalig nachprüfen.
  let geprueft = antwort && antwort.plan && Array.isArray(antwort.plan)
    ? { ok: !antwort.stale, failures: antwort.failures || [], fehlerDetails: [], thought: antwort.thought || '', why_here: antwort.why_here || '', retrospective: antwort.retrospective || '', plan: antwort.plan }
    : null;
  if (!geprueft) {
    let obj = null;
    try { obj = JSON.parse(antwort.raw || '{}'); } catch { obj = null; }
    // validatePlan mit raw: liefert fehlerDetails { code, reason, rawResponse, feld, wert, erlaubt }
    // orte (bekannte IDs) nur als Kontext fürs Debug mitgegeben – walk_to zu unentdeckten POIs
    // ist Discovery-Kernmechanik und bleibt valide (Fehler erst auf Ausführungsebene: ort_unbekannt).
    geprueft = checks.validatePlan(obj, {
      intents: gebaut.whitelist,
      raw: String(antwort.raw || ''),
      orte: orte.map((o) => o.id),
      hunger: Number(ch.hunger),
      erschoepfung: Number(ch.erschoepfung),
    });
  }
  if (!geprueft.ok) {
    let fehlerDebug = Array.isArray(geprueft.fehlerDetails) && geprueft.fehlerDetails.length > 0 ? geprueft.fehlerDetails : [];
    // Fix Tier-Anreicherung: checks-Details haben kein tier/provider – aus Brain-Debugs uebernehmen,
    // damit im UI nie mehr (?) ohne Roh-Antwort steht. Antwort-raw (inkl. leerGrund) ebenfalls.
    const stammDebug = debugEinzeln || (debugListe.length > 0 ? debugListe[0] : null);
    if (stammDebug) {
      fehlerDebug = fehlerDebug.map((d) => {
        const basis = (d && typeof d === 'object') ? d : {};
        return {
          ...basis,
          tier: basis.tier || stammDebug.tier || 'primary',
          versuch: basis.versuch || stammDebug.tier || stammDebug.versuch || 'primary',
          provider: basis.provider || stammDebug.provider || 'openrouter',
          providerLabel: basis.providerLabel || stammDebug.providerLabel,
          model: basis.model || stammDebug.model,
          rawResponse: basis.rawResponse || stammDebug.rawResponse || '',
        };
      });
    }
    // Fix Debug-Anhang: Engine-Checks an Brain-Kette ANHÄNGEN (primary/fallback-1 bleiben sichtbar),
    // statt sie zu überschreiben. Reihenfolge chronologisch, Duplikate raus.
    const _gesehen = new Set((debugListe || []).map((d) => `${d.model}|${d.code}|${d.reason}`));
    const _neu = (fehlerDebug || []).filter((d) => { const k = `${d.model}|${d.code}|${d.reason}`; if (_gesehen.has(k)) return false; _gesehen.add(k); return true; });
    const _kette = [...(debugListe || []), ..._neu];
    const fallbackQuelle = { ...quelle, source: 'fallback', debug: fehlerDebug[0] || debugEinzeln || null, debugVersuche: _kette.length > 0 ? _kette : undefined, fehlerDetails: fehlerDebug };
    for (const dbg of (fallbackQuelle.debugVersuche || [])) loggeDebug(dbg);
    if (devAn) {
      try {
        db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, 'llm_debug', ?, 1)")
          .run(characterId, JSON.stringify({ quelle: fallbackQuelle, fehler: geprueft.failures, prompt: gebaut.prompt }));
      } catch { /* Gehirn-Log darf nie crashen */ }
    }
    return { thought: geprueft.thought || 'Plan verworfen.', retrospective: geprueft.retrospective || '',
      plan: [{ action: 'rest', target: null, detail: 'Kurze Pause' }, { action: 'explore_street', target: null, detail: 'Umschauen' }],
      fallback: true, fehler: geprueft.failures, fehlerDetails: fehlerDebug, quelle: fallbackQuelle };
  }
  if (antwort && antwort.stale && debugEinzeln && devAn) {
    loggeDebug(debugEinzeln);
    try {
      db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, 'llm_debug', ?, 1)")
        .run(characterId, JSON.stringify({ quelle, fehler: [], prompt: gebaut.prompt }));
    } catch { /* Gehirn-Log darf nie crashen */ }
  }
  return { thought: geprueft.thought, why_here: geprueft.why_here || '', retrospective: geprueft.retrospective, plan: geprueft.plan, fallback: false, roh: antwort, quelle };
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


function zaehleStat24h(db, feld, jetztMs) {
  try {
    const datum = arbiter.berlinDatum(jetztMs);
    const r = db.prepare('SELECT stats_24h_json FROM world_state WHERE id = 1').get();
    const s = r ? JSON.parse(r.stats_24h_json || '{}') : {};
    if (s.date !== datum) {
      s.date = datum;
      s.big_model = 0;
      s.small_model = 0;
      s.queued = 0;
      s.autopilot = 0;
    }
    s[feld] = (Number(s[feld]) || 0) + 1;
    db.prepare('UPDATE world_state SET stats_24h_json = ? WHERE id = 1').run(JSON.stringify(s));
  } catch { /* stats duerfen nie crashen */ }
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
  try { await arbiter.bewerteBewerbungen(db, telegram, deps.brain); } catch { /* nie crashen */ }
  try { arbiter.pruefeInaktivitaet(db, characterId, jetztMs); } catch { /* nie crashen */ }

  // Stimmung (froh): zusätzlicher Malus bei akutem Mangel (kein automatisches Hochziehen).
  let frohDelta = 0;
  if (Number(ch.hunger) > 75) frohDelta -= 2;
  if (Number(ch.erschoepfung) > 80) frohDelta -= 2;
  if (Number(ch.geld) < 5) frohDelta -= 1;
  if (frohDelta !== 0) {
    addFroh(ch, frohDelta);
    db.prepare('UPDATE character SET froh = ? WHERE id = ?').run(ch.froh, characterId);
  }

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
  let planQuelle = null; // KI-Nachweis für den Feed (Punkt 7)
  if (queue.length > 0) {
    zaehleStat24h(db, 'queued', jetztMs);
  } else {
    // Laufende Route? Dann KEIN neuer Plan – Schritt wiederholt sich, bis angekommen.
    const laufendeRoute = (ch.current_action === 'walk_to' || ch.current_action === 'explore_street') ? ladeRoute(ch) : null;
    if (laufendeRoute) {
      const fort = laufendeRoute.zielPoi
        ? { action: 'walk_to', target: laufendeRoute.zielPoi, detail: '' }
        : { action: 'explore_street', target: null, detail: '' };
      queue = [fort];
      planQuelle = { source: 'queue', model: '', tokens: 0 };
      gedanke = 'Weiter geht\u2019s – ein Fuß vor den anderen.';
      zaehleStat24h(db, 'queued', jetztMs);
    } else {
      const neu = await holeNeuenPlanMitMeta(db, deps, characterId, jetztMs);
      gedanke = neu.thought;
      planQuelle = neu.quelle || null;
      queue = neu.plan || [];
      zaehleStat24h(db, planQuelle && planQuelle.source === 'llm' ? 'small_model' : 'autopilot', jetztMs);
      if (neu.why_here || neu.thought) {
        const grund = String(neu.why_here || neu.thought).slice(0, 200);
        ch.why_here = grund;
        db.prepare('UPDATE character SET why_here = ? WHERE id = ?').run(grund, characterId);
      }
      if (neu.retrospective && String(neu.retrospective).trim()) {
        try {
          db.prepare('UPDATE memories SET retrospective = ? WHERE id = (SELECT id FROM memories WHERE character_id = ? ORDER BY id DESC LIMIT 1)')
            .run(String(neu.retrospective).trim().slice(0, 280), characterId);
        } catch { /* egal */ }
      }
      // Plan-Event mit KI-Quelle in den Feed (Dev-Badges)
      try {
        db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, 'plan', ?, 1)").run(
          characterId,
          JSON.stringify({ thought: neu.thought, retrospective: neu.retrospective, plan: queue, quelle: neu.quelle || null }));
      } catch { /* feed darf nie crashen */ }
      snapshot = { gesund: Number(ch.gesund), geld: Number(ch.geld), froh: Number(ch.froh), summary: neu.retrospective || '' };
      speichereQueue(db, ch, queue, snapshot);
      ch = ladeCharakter(db, characterId);
    }
  }
  const schritt = queue.shift();
  if (!schritt) return { ok: false, grund: 'leerer_plan', notizen: [] };
  speichereQueue(db, ch, queue, snapshot);
  if (schritt.action === 'consume') {
    const frisch = ladeCharakter(db, characterId);
    const ortId = schritt.target || frisch.inside_poi;
    const poi = ortId ? db.prepare('SELECT * FROM pois WHERE id = ?').get(ortId) : null;
    const kat = (poi && poi.category) || 'imbiss';
    const grenzen = require('./config').ECONOMY.priceBounds[kat] || [3.5, 10.0];
    if (Number(frisch.geld) < Number(grenzen[0])) {
      db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, 'interrupt', ?, 1)")
        .run(characterId, JSON.stringify({ grund: 'geld_reicht_nicht', schritt }));
      // Job-Hint: mit aktivem Job ist die Antwort auf leere Tasche work_shift,
      // nicht wieder look_for_work (Fix "Hungerschleife", known-issues.md).
      const jHint = arbiter.aktiverJob(db, characterId);
      const notiz = ['Das Geld reicht nicht – Plan wird neu gemacht.']
        .concat(jHint ? [`Du hast einen Job als ${jHint.role_title} bei ${jHint.poi_id} – plane eine Schicht (work_shift), um wieder Geld zu bekommen.`] : []);
      return { ok: true, schritt, ergebnis: { ok: false, grund: 'geld_reicht_nicht' }, notizen: notiz, interrupt: 'geld_reicht_nicht', gedanke };
    }
  }
  const ergebnis = await schrittAusfuehren(db, deps, characterId, schritt, jetztMs);
  ch = ladeCharakter(db, characterId);
  // Weiter unterwegs? Dann Schritt vorn wieder einreihen (Rest-Queue bleibt dahinter).
  // Geprüft wird NACH der Ausführung – sonst ginge z. B. „consume“ nach „walk_to“ verloren.
  try {
    const nochUnterwegs = (ch.current_action === 'walk_to' || ch.current_action === 'explore_street') && ladeRoute(ch);
    if (nochUnterwegs && (schritt.action === 'walk_to' || schritt.action === 'explore_street')) {
      const q = ladeQueue(ch);
      q.unshift(schritt);
      let snap = null;
      try { snap = JSON.parse(ch.plan_start_snapshot_json || 'null'); } catch { snap = null; }
      speichereQueue(db, ch, q, snap);
    }
  } catch { /* queue bleibt wie sie ist */ }
  // Nächtliche Konsolidierung: schläft er daheim, läuft 1x/Tag der Nightly-Call
  let nightlyNotiz = null;
  if (ergebnis && ergebnis.ok && schritt.action === 'sleep' && ch.inside_poi === 'apartment' && deps.nightly !== false) {
    try {
      const log = ereignisSeit(db, characterId, 0, 80).map((e) => `${e.type}: ${e.payload_json}`).join('\n').slice(0, 3500);
      const res = await arbiter.runNightlyConsolidation(db, deps.brain, characterId, log, jetztMs);
      if (res && res.ok) {
        nightlyNotiz = 'Nachtsortierung: ' + res.headline;
        if (res.quelle && res.quelle.source === 'llm') zaehleStat24h(db, 'big_model', jetztMs);
      }
    } catch { /* nightly darf nie crashen */ }
  }
  const tod = pruefeTod(db, characterId);
  if (tod.tot) {
    return { ok: true, schritt, ergebnis, notizen: (ergebnis.notizen || []).concat(['Der alte Stadterkunder ist gegangen. Ein neuer beginnt bei null.']), gestorben: true, neuId: tod.neuId, gedanke };
  }
  const neuEntdeckt = entdeckeUmgebung(db, ch);
  const notizen = (ergebnis.notizen || []).concat(neuEntdeckt.map((n) => `Neu entdeckt: ${n.name}.`));
  if (nightlyNotiz) notizen.push(nightlyNotiz);
  // Aktive Route + Ziel für SSE/Frontend (Punkt 1): Waypoints + Rest + Zielpos
  let routeInfo = null;
  try {
    const meta = ladeRoute(ch);
    if (meta) {
      const route = meta.route || [];
      const idx = Math.min(meta.wegIndex || 0, Math.max(0, route.length - 1));
      routeInfo = {
        waypoints: route,
        wegIndex: meta.wegIndex || 0,
        restM: meta.restM || 0,
        zielPoi: meta.zielPoi || null,
        target_pos: route.length > 0 ? route[Math.min(idx + 1, route.length - 1)] : null,
      };
    }
  } catch { routeInfo = null; }
  // LAUF-SPAM-FIX: unterwegs nur Route/Status melden, kein Feed, kein Gedanke-Wiederholung.
  // Einzige Ausnahme: echte Start-/Ankunftsnotizen (genau einmal pro Ereignis).
  if (ergebnis && ergebnis.unterwegs) {
    const startNotizen = (ergebnis.notizen || []).filter((n) =>
      /auf den Weg|schlenderst los|Angekommen bei|durchatmest|Neu entdeckt/.test(String(n || '')));
    return { ok: true, schritt, ergebnis, notizen: startNotizen, gedanke: '', quelle: planQuelle, route: routeInfo,
      status: { currentStatus: 'walking', remainingMeters: Number(routeInfo ? routeInfo.restM || 0 : 0), targetPoi: String((routeInfo && routeInfo.zielPoi) || schritt.target || '') } };
  }
  return { ok: true, schritt, ergebnis, notizen, gedanke, nightly: nightlyNotiz, quelle: planQuelle, route: routeInfo };
}

module.exports = {
  berlinJetzt, hamburgStunde, istNacht, tageszeitText,
  ladeCharakter, speichereCharakter, klammereCharakter,
  bekannteOrte, entdeckeUmgebung, ereignisSeit,
  dauerFuer, lasseZeitVergehen, heileDurchSchlaf,
  SCHRITT_M, ANKUNFT_M, ladeRoute, speichereRoute, restDistanz,
  waehleExploreZiel, starteRoute, geheSchritt,
  fuehreSchrittAus, fuehreSchrittAusTeil2, fuehreSchrittAusTeil3, schrittAusfuehren,
  ladeQueue, speichereQueue, holeNeuenPlan, holeNeuenPlanMitMeta, interruptGrund,
  pruefeTod, tick,
};


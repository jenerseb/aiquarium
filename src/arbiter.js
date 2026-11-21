'use strict';
// Bounded World Arbiter (§4.5 + M2):
//  - resolveIntent: consume/do_activity gegen ECONOMY klammern, unbekannte
//    Wünsche per kleinem LLM-Call plausibilisieren, dauerhaft in poi_offers cachen.
//  - Jobs: take_job / work_shift mit Lohn, Strike-Regeln, Kündigung.
//  - bewerteBewerbungen: autonomer Ladenbesitzer-Evaluator für leave_note.
//  - runNightlyConsolidation: 1x/Tag per mimo-v2.6-pro beim Schlafen.

const { ECONOMY, MEMORY, getRoleSlots } = require('./config');

function klammere(wert, min, max) {
  return Math.max(min, Math.min(max, Number(wert) || 0));
}

function runde2(x) {
  return Math.round(Number(x) || 0);
}

function preisGrenzenFuer(kategorie) {
  if (ECONOMY.priceBounds[kategorie]) return ECONOMY.priceBounds[kategorie];
  return [1, 12];
}

// --- Angebote lesen / schreiben --------------------------------------------------

function findeAngebot(db, poiId, kind, intentKey) {
  return db.prepare('SELECT * FROM poi_offers WHERE poi_id = ? AND kind = ? AND intent_key = ?')
    .get(poiId, kind, intentKey) || null;
}

function speichereAngebot(db, angebot) {
  db.prepare(`INSERT INTO poi_offers (poi_id, kind, intent_key, label, price, hunger_delta, erschoepfung_delta, froh_delta, narrative)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(poi_id, kind, intent_key) DO UPDATE SET
      label = excluded.label, price = excluded.price,
      hunger_delta = excluded.hunger_delta, erschoepfung_delta = excluded.erschoepfung_delta,
      froh_delta = excluded.froh_delta, narrative = excluded.narrative`).run(
    angebot.poi_id, angebot.kind, angebot.intent_key, angebot.label || angebot.intent_key,
    angebot.price || 0, angebot.hunger_delta || 0, angebot.erschoepfung_delta || 0,
    angebot.froh_delta || 0, angebot.narrative || null);
  return findeAngebot(db, angebot.poi_id, angebot.kind, angebot.intent_key);
}

function normalisiereKey(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'wunsch';
}

// Deterministischer Fallback, wenn kein LLM erreichbar ist (auch für Tests):
// plausibel, aber strikt innerhalb der ECONOMY-Grenzen geklammert.
function deterministischesAngebot(poi, kind, wunschText) {
  const kat = poi ? poi.category : 'spaeti';
  const [pMin, pMax] = preisGrenzenFuer(kat);
  const key = normalisiereKey(wunschText);
  if (kind === 'consume') {
    const d = ECONOMY.deltaBounds;
    return {
      poi_id: poi.id, kind, intent_key: key,
      label: String(wunschText).slice(0, 80),
      price: runde2((pMin + pMax) / 2),
      hunger_delta: klammere(-25, d.consumeHunger[0], d.consumeHunger[1]),
      erschoepfung_delta: klammere(2, 0, 10),
      froh_delta: klammere(6, d.consumeFroh[0], d.consumeFroh[1]),
      narrative: 'Solide Hausmannskost – nichts Ausgefallenes, aber ehrlich.',
    };
  }
  const d = ECONOMY.deltaBounds;
  return {
    poi_id: poi.id, kind, intent_key: key,
    label: String(wunschText).slice(0, 80),
    price: 0,
    hunger_delta: 0,
    erschoepfung_delta: klammere(6, d.activityErschoepfung[0], d.activityErschoepfung[1]),
    froh_delta: klammere(5, d.activityFroh[0], d.activityFroh[1]),
    narrative: 'Man lässt dich mitmachen. Kostet nichts, bringt ein bisschen Freude.',
  };
}


// Kleiner LLM-Call (arbiter-Rolle): plausibilisiert Preis + Wirkung.
// Primary → Fallback via getRoleSlots('arbiter') (429/JSON-Fehler → Fallback).
// Gibt { obj, usedModel, tokens } zurück (für Dev-Feed-Transparenz).
async function arbiterLLM(brain, poi, kind, wunschText, db, characterId) {
  if (!brain || typeof brain.callModel !== 'function') return null;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const [pMin, pMax] = preisGrenzenFuer(poi ? poi.category : 'spaeti');
  const prompt = [
    'Du bist der nuechterne Welt-Arbiter eines Kiez-Spiels in Hamburg-St. Pauli.',
    `Ort: ${poi ? `${poi.name} (${poi.category})` : 'unbekannt'}: ${poi ? poi.public_desc : ''}`,
    `Spielerwunsch (${kind}): „${wunschText}“`,
    `Preisrahmen fuer diese Kategorie: ${pMin} bis ${pMax} Euro (nur ganze Euro-Betraege).`,
    'Antworte NUR als JSON: { "plausibel": true/false, "label": "kurzer Name", "price": zahl,',
    ' "hunger_delta": -50..-5 (nur consume, sonst 0), "erschoepfung_delta": 2..15 bei Aktivitaet,',
    ' "froh_delta": -6..12 (auch negativ bei enttaeuschendem/anstrengendem Erlebnis), "narrative": "ein Satz" }. Unplausibles -> plausibel:false.',
  ].join('\n');
  // LLM-Input-Log (Debug): was der Arbiter-Call als INPUT bekommt.
  if (db) {
    try {
      db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, 'llm_input', ?, 0)")
        .run(characterId ?? null, JSON.stringify({ role: 'arbiter', poi: poi ? poi.id : null, kind, wunschText, prompt }));
    } catch { /* Gehirn-Log darf nie crashen */ }
  }
  const pair = getRoleSlots('arbiter');
  for (const [idx, slot] of [pair.primary, pair.fallback].entries()) {
    if (!slot) continue;
    try {
      const r = await brain.callModel({
        prompt, apiKey, model: slot.model, reasoningExclude: slot.reasoningExclude,
        timeoutMs: 20000, temperature: 0.2, maxTokens: slot.maxTokens || 900,
      });
      const obj = JSON.parse(r.content);
      if (!obj || typeof obj !== 'object') continue; // ungültiges JSON → Fallback
      const tokens = Number((r.usage && (r.usage.completion_tokens || r.usage.total_tokens)) || 0) || 0;
      if (typeof brain.logLlmErfolg === 'function') {
        brain.logLlmErfolg({
          role: 'arbiter', versuch: idx === 0 ? 'primary' : 'fallback', provider: 'OpenRouter',
          model: r.usedModel || slot.model, prompt, response: r.content, tokens, latencyMs: r.latencyMs || 0,
        });
      }
      return { obj, usedModel: r.usedModel || slot.model, tokens };
    } catch {
      continue; // HTTP-Fehler (429 etc.) → Fallback
    }
  }
  return null;
}

function klammereAngebot(poi, kind, intentKey, vorschlag) {
  const [pMin, pMax] = preisGrenzenFuer(poi ? poi.category : 'spaeti');
  const d = ECONOMY.deltaBounds;
  const v = vorschlag || {};
  if (kind === 'consume') {
    return {
      poi_id: poi.id, kind, intent_key: intentKey,
      label: String(v.label || intentKey).slice(0, 80),
      price: runde2(klammere(Number(v.price) || (pMin + pMax) / 2, pMin, pMax)),
      hunger_delta: klammere(Number(v.hunger_delta) || -25, d.consumeHunger[0], d.consumeHunger[1]),
      erschoepfung_delta: klammere(Number(v.erschoepfung_delta) || 2, 0, 15),
      froh_delta: klammere(Number(v.froh_delta) || 6, d.consumeFroh[0], d.consumeFroh[1]),
      narrative: typeof v.narrative === 'string' ? v.narrative.slice(0, 280) : '',
    };
  }
  return {
    poi_id: poi.id, kind, intent_key: intentKey,
    label: String(v.label || intentKey).slice(0, 80),
    price: 0,
    hunger_delta: 0,
    erschoepfung_delta: klammere(Number(v.erschoepfung_delta) || 6, d.activityErschoepfung[0], d.activityErschoepfung[1]),
    froh_delta: klammere(Number(v.froh_delta) || 5, d.activityFroh[0], d.activityFroh[1]),
    narrative: typeof v.narrative === 'string' ? v.narrative.slice(0, 280) : '',
  };
}

const GRATIS_AKTIVITAET_KATS = new Set(['park', 'denkmal', 'home', 'arzt']);

async function resolveIntent(db, brain, poi, kind, wunschText, characterId) {
  const key = normalisiereKey(wunschText);
  const bekannt = findeAngebot(db, poi.id, kind, key);
  if (bekannt) return { angebot: bekannt, neu: false };
  // Park/Denkmal/Wohnung/Praxis: kostenlose Aktivitäten lokal abwickeln (0 LLM-Calls).
  // An Kultur-/Gastro-POIs (kino, club, kneipe, etc.) prüft der Arbiter einmalig per LLM & cached.
  if (kind === 'do_activity' && (!poi || GRATIS_AKTIVITAET_KATS.has(poi.category))) {
    const angebot = klammereAngebot(poi, kind, key, deterministischesAngebot(poi, kind, wunschText));
    const gespeichert = speichereAngebot(db, angebot);
    return { angebot: gespeichert, neu: true, quelle: { source: 'lokal', model: '', tokens: 0 } };
  }
  const llm = await arbiterLLM(brain, poi, kind, wunschText, db, characterId);
  const llmObj = llm && llm.obj ? llm.obj : null;
  let angebot;
  if (!llmObj || llmObj.plausibel === false) {
    angebot = klammereAngebot(poi, kind, key, deterministischesAngebot(poi, kind, wunschText));
  } else {
    angebot = klammereAngebot(poi, kind, key, llmObj);
  }
  const gespeichert = speichereAngebot(db, angebot);
  const quelle = llm
    ? { source: 'llm', model: llm.usedModel, tokens: llm.tokens }
    : { source: 'fallback', model: '', tokens: 0 };
  return { angebot: gespeichert, neu: true, quelle };
}

// --- Jobs ----------------------------------------------------------------------

function aktiverJob(db, characterId) {
  return db.prepare("SELECT * FROM jobs WHERE character_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(characterId) || null;
}

function nimmJobAn(db, characterId, poiId, rolle, lohn) {
  const lohnGeklammert = runde2(klammere(Number(lohn) || 10, ECONOMY.wageBounds[0], ECONOMY.wageBounds[1]));
  const alt = aktiverJob(db, characterId);
  if (alt) return { ok: false, grund: 'bereits_beschaeftigt', job: alt };
  const r = db.prepare(
    "INSERT INTO jobs (character_id, poi_id, role_title, wage_per_shift, strikes, shifts_completed, last_worked_at, status) VALUES (?, ?, ?, ?, 0, 0, NULL, 'active')"
  ).run(characterId, poiId, rolle, lohnGeklammert);
  return { ok: true, job: db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(r.lastInsertRowid)) };
}

function gebeStrike(db, jobId, grund) {
  db.prepare('UPDATE jobs SET strikes = strikes + 1 WHERE id = ?').run(jobId);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  return job;
}

function kuendige(db, jobId, grund) {
  db.prepare("UPDATE jobs SET status = 'fired' WHERE id = ?").run(jobId);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  return job;
}

// Nach 3 Tagen ohne Schicht automatisch kündigen (§7.4).
function pruefeInaktivitaet(db, characterId, jetztMs) {
  const job = aktiverJob(db, characterId);
  if (!job || !job.last_worked_at) return { job, gekuendigt: false };
  const letzte = Date.parse(String(job.last_worked_at).replace(' ', 'T') + 'Z');
  if (!Number.isFinite(letzte)) return { job, gekuendigt: false };
  const tage = ((jetztMs || Date.now()) - letzte) / 86400000;
  if (tage > 3) {
    const j = kuendige(db, job.id, 'inaktiv');
    return { job: j, gekuendigt: true, grund: 'inaktiv_seit_' + Math.floor(tage) + '_tagen' };
  }
  return { job, gekuendigt: false };
}

// Schicht abrechnen: krank/erschoepft -> Abbruch + halber Lohn + Strike,
// bei 2 Strikes -> Kuendigung + Erinnerung.
function rechneSchichtAb(db, characterId, job, ch) {
  const krank = Number(ch.gesund) < 20 || Number(ch.erschoepfung) > 90;
  const lohn = Number(job.wage_per_shift) || 10;
  if (krank) {
    const halber = Math.max(1, runde2(lohn / 2));
    db.prepare('UPDATE character SET geld = geld + ? WHERE id = ?').run(halber, characterId);
    const j = gebeStrike(db, job.id, 'krank_oder_erschoepft');
    db.prepare('UPDATE jobs SET shifts_completed = shifts_completed + 1, last_worked_at = datetime(\'now\') WHERE id = ?').run(job.id);
    if (Number(j.strikes) >= 2) {
      kuendige(db, job.id, 'strikes');
      require('./memory').speichereMemory(db, characterId, {
        tier: 'short', kind: 'moment',
        text: `Gekuendigt bei ${job.poi_id}: zu oft krank oder erschoepft zur Schicht erschienen. Das sitzt.`,
        initial_weight: 5.0,
      });
      return { abgebrochen: true, lohn: halber, strikes: Number(j.strikes), gekuendigt: true };
    }
    return { abgebrochen: true, lohn: halber, strikes: Number(j.strikes), gekuendigt: false };
  }
  db.prepare('UPDATE character SET geld = geld + ? WHERE id = ?').run(runde2(lohn), characterId);
  db.prepare('UPDATE jobs SET shifts_completed = shifts_completed + 1, last_worked_at = datetime(\'now\') WHERE id = ?').run(job.id);
  return { abgebrochen: false, lohn: runde2(lohn), strikes: Number(job.strikes) || 0, gekuendigt: false };
}


// --- Bewerbungs-Evaluator (autonomer Ladenbesitzer via Arbiter-LLM + Fallback) -------
// Laeuft automatisch nach Timer-Ablauf, falls keine Telegram-Antwort kam.
async function arbiterBewerbungLLM(brain, poi, zettelText) {
  if (!brain || typeof brain.callModel !== 'function') return null;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const [lo, hi] = ECONOMY.wageBounds;
  const prompt = [
    'Du bist der Ladenbesitzer / Chef dieses Kiez-Orts in Hamburg-St. Pauli.',
    `Ort: ${poi.name} (${poi.category}): ${poi.public_desc || ''}`,
    `Hinterlassener Zettel: „${String(zettelText || '').slice(0, 300)}“`,
    `Lohnrahmen pro 20-Min-Schicht: ${lo} bis ${hi} Euro (ganze Euro).`,
    'Entscheide realistisch, ob das eine Jobbewerbung ist und ob du sie annimmst.',
    'Antworte NUR als JSON: { "angenommen": true/false, "role_title": "kurze Rolle", "wage": zahl, "grund": "ein kurzer Satz" }.',
  ].join('\n');
  const pair = getRoleSlots('arbiter');
  for (const [idx, slot] of [pair.primary, pair.fallback].entries()) {
    if (!slot) continue;
    try {
      const r = await brain.callModel({
        prompt, apiKey, model: slot.model, reasoningExclude: slot.reasoningExclude,
        timeoutMs: 20000, temperature: 0.2, maxTokens: slot.maxTokens || 400,
      });
      const obj = JSON.parse(r.content);
      if (!obj || typeof obj !== 'object' || typeof obj.angenommen !== 'boolean') continue;
      const tokens = Number((r.usage && (r.usage.completion_tokens || r.usage.total_tokens)) || 0) || 0;
      if (typeof brain.logLlmErfolg === 'function') {
        brain.logLlmErfolg({
          role: 'arbiter', versuch: idx === 0 ? 'primary' : 'fallback', provider: 'OpenRouter',
          model: r.usedModel || slot.model, prompt, response: r.content, tokens, latencyMs: r.latencyMs || 0,
        });
      }
      return obj;
    } catch {
      continue;
    }
  }
  return null;
}

const JOB_KATEGORIEN = new Set(['kneipe', 'imbiss', 'club', 'kino', 'spaeti', 'restaurant', 'cafe', 'markt']);

async function bewerteBewerbungen(db, telegram, brain = null) {
  const faellige = db.prepare(
    "SELECT * FROM messages_outbox WHERE channel = 'leave_note' AND status = 'pending' AND (resolve_after_at IS NULL OR resolve_after_at <= datetime('now'))"
  ).all();
  const ergebnisse = [];
  for (const z of faellige) {
    if (telegram && typeof telegram.hatAntwortFuer === 'function' && telegram.hatAntwortFuer(db, z.id)) continue;
    const text = String(z.content || '').toLowerCase();
    const poi = z.target_poi ? db.prepare('SELECT * FROM pois WHERE id = ?').get(z.target_poi) : null;
    const hatJobOrt = Boolean(poi && JOB_KATEGORIEN.has(poi.category));
    const willJobRegex = /spuel|kueche|kellner|theke|putz|hilfe|arbeit|job|aushelfen|schicht|tresen|kasse/.test(text);

    let entscheidung = null;
    if (hatJobOrt && willJobRegex) {
      entscheidung = await arbiterBewerbungLLM(brain, poi, z.content);
    }

    const angenommen = entscheidung ? entscheidung.angenommen : (hatJobOrt && willJobRegex);
    if (angenommen && hatJobOrt) {
      const [lo, hi] = ECONOMY.wageBounds;
      const lohn = entscheidung && Number.isFinite(Number(entscheidung.wage))
        ? Math.round(klammere(Number(entscheidung.wage), lo, hi))
        : runde2(lo + Math.random() * (hi - lo));
      const rolle = (entscheidung && entscheidung.role_title ? String(entscheidung.role_title) : (/spuel/i.test(z.content) ? 'Spülhilfe' : 'Aushilfe')).slice(0, 60);
      const res = nimmJobAn(db, z.character_id, poi.id, rolle, lohn);
      if (res.ok) {
        db.prepare("UPDATE messages_outbox SET status = 'resolved' WHERE id = ?").run(z.id);
        db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, 'job_offer', ?, 1)")
          .run(z.character_id, JSON.stringify({ poi_id: poi.id, rolle, lohn }));
        require('./memory').speichereMemory(db, z.character_id, {
          tier: 'short', kind: 'moment',
          text: 'Zusage als ' + rolle + ' bei ' + poi.name + '. Der Zettel hat gewirkt.',
          initial_weight: 5.0,
        });
        ergebnisse.push({ zettelId: z.id, angenommen: true, rolle, lohn });
      } else {
        db.prepare("UPDATE messages_outbox SET status = 'resolved' WHERE id = ?").run(z.id);
        ergebnisse.push({ zettelId: z.id, angenommen: false, grund: res.grund });
      }
    } else {
      db.prepare("UPDATE messages_outbox SET status = 'noticed' WHERE id = ?").run(z.id);
      ergebnisse.push({ zettelId: z.id, angenommen: false, grund: entscheidung && entscheidung.grund ? entscheidung.grund : 'kein_job_wunsch' });
    }
  }
  return ergebnisse;
}


// --- Nacht-Konsolidierung (mimo-v2.6-pro, 1x/Tag) ----------------------------------

function berlinDatum(jetztMs) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date(jetztMs || Date.now()));
}

function schonKonsolidiert(db, datumStr) {
  const ws = db.prepare('SELECT last_nightly_date FROM world_state WHERE id = 1').get();
  return ws && ws.last_nightly_date === datumStr;
}

function markiereKonsolidiert(db, datumStr) {
  db.prepare('INSERT INTO world_state (id, last_nightly_date) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_nightly_date = excluded.last_nightly_date').run(datumStr);
}


async function runNightlyConsolidation(db, brain, characterId, tagesLog, jetztMs) {
  const datum = berlinDatum(jetztMs);
  if (schonKonsolidiert(db, datum)) return { ok: false, grund: 'bereits_konsolidiert', datum };
  const mem = require('./memory');
  const alleMems = mem.ladeMemories(db, characterId);
  const short = alleMems.filter((m) => m.tier === 'short');
  const sheet = db.prepare('SELECT id, category, text, written_by FROM character_sheet WHERE character_id = ? AND active = 1').all(characterId);
  const loops = db.prepare("SELECT id, kind, text FROM open_loops WHERE character_id = ? AND status = 'open'").all(characterId);
  const prompt = [
    'Du bist das naechtliche Gedaechtnis eines jungen Stadterkunders in Hamburg-St. Pauli.',
    'Fasse den Tag in EINEM Satz zusammen, erkenne EINE Gewohnheit (oder keine), und pflege das Gedaechtnis.',
    '', 'TAG:', String(tagesLog || '(kein Log)').slice(0, 4000), '',
    'SHEET:', sheet.map((s) => `#${s.id} [${s.category}/${s.written_by}] ${s.text}`).join('\n') || '(leer)',
    'SHORT:', short.map((m) => `#${m.id} (worth ${Number(m.worth).toFixed(1)}) ${m.text}`).join('\n') || '(leer)',
    'LOOPS:', loops.map((l) => `#${l.id} [${l.kind}] ${l.text}`).join('\n') || '(keine)', '',
    'NUR JSON: { "headline": "ein Satz", "sheet_add": {"category":"like|cares|fears|small_things","text":"...","reason":"..."} oder null,',
    ' "sheet_confirm_ids": [ids], "promote_memory_ids": [ids], "drop_memory_ids": [ids],',
    ' "open_loops_update": {"close_ids": [ids], "new_loops": [{"kind":"question|want|work","text":"...","urgency":0..1}]} }',
  ].join('\n');
  // LLM-Input-Log (Debug): was der Nacht-Call als INPUT bekommt.
  try {
    db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, 'llm_input', ?, 0)")
      .run(characterId, JSON.stringify({ role: 'nightly', datum, prompt }));
  } catch { /* Gehirn-Log darf nie crashen */ }
  let out = null;
  const apiKey = process.env.OPENROUTER_API_KEY;
  let nightlyQuelle = { source: 'fallback', model: '', tokens: 0 };
  if (brain && typeof brain.callModel === 'function' && apiKey) {
    // Nightly-Rolle: primary → fallback (getRoleSlots('nightly'))
    const pair = getRoleSlots('nightly');
    for (const [idx, slot] of [pair.primary, pair.fallback].entries()) {
      if (!slot) continue;
      try {
        const r = await brain.callModel({
          prompt, apiKey, model: slot.model, reasoningExclude: slot.reasoningExclude,
          timeoutMs: 90000, temperature: 0.5, maxTokens: slot.maxTokens || 1400,
        });
        out = JSON.parse(r.content);
        if (out && typeof out === 'object') {
          const tokens = Number((r.usage && (r.usage.completion_tokens || r.usage.total_tokens)) || 0) || 0;
          nightlyQuelle = { source: 'llm', model: r.usedModel || slot.model, tokens };
          if (typeof brain.logLlmErfolg === 'function') {
            brain.logLlmErfolg({
              role: 'nightly', versuch: idx === 0 ? 'primary' : 'fallback', provider: 'OpenRouter',
              model: r.usedModel || slot.model, prompt, response: r.content, tokens, latencyMs: r.latencyMs || 0,
            });
          }
          break;
        }
        out = null; // ungültiges JSON → Fallback-Slot
      } catch { out = null; } // HTTP-Fehler (429 etc.) → Fallback-Slot
    }
  }
  if (!out || typeof out !== 'object') {
    out = {
      headline: 'Ein ruhiger Tag im Kiez: unterwegs gewesen, etwas gelernt, wieder daheim.',
      sheet_add: null, sheet_confirm_ids: [], promote_memory_ids: [],
      drop_memory_ids: [], open_loops_update: { close_ids: [], new_loops: [] },
    };
  }
  const headline = String(out.headline || 'Ein Tag im Kiez.').slice(0, 280);
  db.prepare('INSERT INTO day_summaries (character_id, date_str, headline, sheet_changes_json, moves_count) VALUES (?, ?, ?, ?, 0)')
    .run(characterId, datum, headline, JSON.stringify(out.sheet_add ? [out.sheet_add] : []));
  if (out.sheet_add && out.sheet_add.text) {
    const kat = ['like', 'cares', 'fears', 'small_things'].includes(out.sheet_add.category) ? out.sheet_add.category : 'small_things';
    db.prepare("INSERT INTO character_sheet (character_id, category, text, written_by, source_reason) VALUES (?, ?, ?, 'self', ?)")
      .run(characterId, kat, String(out.sheet_add.text).slice(0, 280), String(out.sheet_add.reason || datum).slice(0, 200));
  }
  for (const id of (out.sheet_confirm_ids || [])) {
    db.prepare("UPDATE character_sheet SET times_confirmed = times_confirmed + 1, last_confirmed_at = datetime('now') WHERE id = ? AND character_id = ?").run(Number(id), characterId);
  }
  db.prepare("UPDATE character_sheet SET active = 0 WHERE character_id = ? AND written_by = 'self' AND active = 1 AND julianday('now') - julianday(last_confirmed_at) > 21").run(characterId);
  for (const id of (out.promote_memory_ids || [])) {
    db.prepare("UPDATE memories SET tier = 'long', worth = worth + 1.0 WHERE id = ? AND character_id = ?").run(Number(id), characterId);
  }
  for (const id of (out.drop_memory_ids || [])) {
    db.prepare('DELETE FROM memories WHERE id = ? AND character_id = ?').run(Number(id), characterId);
  }
  const rest = mem.ladeMemories(db, characterId);
  const jetzt = jetztMs || Date.now();
  const upd = db.prepare('UPDATE memories SET worth = ? WHERE id = ?');
  for (const m of rest) upd.run(mem.berechneWorth(m, jetzt), m.id);
  for (const tier of ['short', 'long']) {
    const max = tier === 'long' ? MEMORY.maxLong : MEMORY.maxShort;
    const imTier = rest.filter((m) => m.tier === tier).sort((a, b) => Number(a.worth) - Number(b.worth));
    while (imTier.length > max) {
      const opfer = imTier.shift();
      db.prepare('DELETE FROM memories WHERE id = ?').run(opfer.id);
    }
  }
  const olu = out.open_loops_update || {};
  for (const id of (olu.close_ids || [])) {
    db.prepare("UPDATE open_loops SET status = 'done', resolved_at = datetime('now') WHERE id = ? AND character_id = ?").run(Number(id), characterId);
  }
  for (const nl of (olu.new_loops || [])) {
    if (nl && nl.text) {
      const kind = ['question', 'want', 'work'].includes(nl.kind) ? nl.kind : 'want';
      const urg = Math.max(0, Math.min(1, Number(nl.urgency) || 0.5));
      db.prepare("INSERT INTO open_loops (character_id, kind, text, urgency, related_poi, status) VALUES (?, ?, ?, ?, ?, 'open')")
        .run(characterId, kind, String(nl.text).slice(0, 280), urg, nl.related_poi || null);
    }
  }
  markiereKonsolidiert(db, datum);
  db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, 'nightly', ?, 1)")
    .run(characterId, JSON.stringify({ datum, headline, quelle: { ...nightlyQuelle, source: nightlyQuelle.source === 'llm' ? 'nightly' : 'fallback' } }));
  return { ok: true, datum, headline, roh: out, quelle: nightlyQuelle };
}

module.exports = {
  klammere, runde2, preisGrenzenFuer,
  findeAngebot, speichereAngebot, normalisiereKey, deterministischesAngebot,
  arbiterLLM, klammereAngebot, resolveIntent,
  aktiverJob, nimmJobAn, gebeStrike, kuendige, pruefeInaktivitaet, rechneSchichtAb,
  bewerteBewerbungen,
  berlinDatum, schonKonsolidiert, markiereKonsolidiert, runNightlyConsolidation,
};



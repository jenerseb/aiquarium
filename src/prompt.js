'use strict';
// Prompt-Bau (§7.1 + M2-Auftrag): Wahrnehmung, Wesen, Gedächtnis, Bücher,
// Kommunikationsgrenze, Whitelist und Multi-Step-Plan-Format.
// Der Prompt enthält NIEMALS rohe Prozentzahlen – nur Körper- und Alltagsgefühle.

const { GESUND, FROH, SEKUNDAER, chunkCapFuer, AKTION } = require('./config');

// --- Körper- und Alltagsgefühle --------------------------------------------

function gesundGefuehl(gesund) {
  const g = Number(gesund);
  if (g >= 80) return 'Körper kräftig und verlässlich.';
  if (g >= 60) return 'Körper okay, nur leichtes Zwicken.';
  if (g >= 40) return 'Angeschlagen und schneller außer Atem.';
  if (g >= 20) return 'Schwindelig und fahrig – bald zum Arzt oder ausruhen.';
  return 'Sehr schwach – sofort zum Arzt oder ausruhen!';
}

function frohGefuehl(froh) {
  const f = Number(froh);
  if (f >= 35) return 'Richtig euphorisch und glücklich – genieße den Moment und widme dich deinen anderen Zielen.';
  if (f >= 10) return 'Zufrieden und ausgeglichen.';
  if (f >= 0) return 'Okay, aber etwas eintönig – eine kleine Abwechslung wäre nett.';
  if (f >= -25) return 'Stimmung im Keller – unternimm etwas Schönes im Kiez, bevor es schlimmer wird.';
  return 'Antriebslos und tief unten – geh raus und tu dir dringend etwas Gutes.';
}

function hungerGefuehl(hunger) {
  const h = Number(hunger);
  if (h < 20) return 'Pappsatt – kein Essen nötig.';
  if (h < 45) return 'Satt, Kopf frei.';
  if (h < 70) return 'Leichter Appetit, eilt aber nicht.';
  if (h < 85) return 'Deutlicher Hunger – bald etwas essen.';
  return 'Ausgehungert – sofort etwas essen!';
}

function erschoepfungGefuehl(wert) {
  const e = Number(wert);
  if (e < 30) return 'Hellwach und voller Tatendrang.';
  if (e < 50) return 'Wach und fit, noch nicht müde.';
  if (e < 75) return 'Leichte Müdigkeit in den Knochen.';
  if (e < 90) return 'Richtig müde – bald daheim schlafen.';
  return 'Völlig übermüdet – sofort heim und schlafen!';
}

function geldGefuehl(geld) {
  const g = Math.round(Number(geld) || 0);
  if (g >= 50) return `${g} Euro dabei (solides Polster, reicht sogar für ein gebrauchtes Handy am Späti).`;
  if (g >= 25) return `${g} Euro dabei (ordentliches Polster).`;
  if (g >= 10) return `${g} Euro dabei (kleines Polster, haushalten).`;
  if (g >= 1) return `Nur noch ${g} Euro dabei – knapp, jede Ausgabe zählt.`;
  return 'Praktisch kein Geld mehr – erst verdienen oder Pfand abgeben.';
}

function koerperSaetze(ch) {
  const cap = chunkCapFuer(Number(ch.gesund));
  return [
    `${gesundGefuehl(ch.gesund)} (Belastungsgrenze: ${cap})`,
    frohGefuehl(ch.froh),
    hungerGefuehl(ch.hunger),
    erschoepfungGefuehl(ch.erschoepfung),
    geldGefuehl(ch.geld),
  ];
}


// --- Wesen + Character Sheet ------------------------------------------------

function sheetText(db, characterId) {
  const zeilen = db.prepare(
    "SELECT category, text, written_by FROM character_sheet WHERE character_id = ? AND active = 1 ORDER BY category, id"
  ).all(characterId);
  const fest = zeilen.filter((z) => z.written_by === 'creator');
  const gelernt = zeilen.filter((z) => z.written_by === 'self');
  const fmt = (z) => `- [${z.category}] ${z.text}`;
  const a = ['Dein Wesen:'];
  for (const z of fest) a.push(fmt(z));
  if (gelernt.length > 0) {
    a.push('Über dich gelernt:');
    for (const z of gelernt) a.push(fmt(z));
  }
  return a.join('\n');
}

// --- Gedaechtnis, Loops, Inventar, Buecher ------------------------------------

function memoriesText(topMems) {
  if (!topMems || topMems.length === 0) return 'Gedächtnis: gerade leer.';
  const gezählt = [];
  const idxMap = new Map();
  for (const m of topMems) {
    const key = String(m.text || '').trim();
    if (idxMap.has(key)) {
      gezählt[idxMap.get(key)].n += 1;
    } else {
      idxMap.set(key, gezählt.length);
      gezählt.push({ m, n: 1 });
    }
  }
  const a = ['Was dir im Kopf herumgeht:'];
  for (const { m, n } of gezählt) {
    a.push(`- (${m.tier}, ${m.kind}) ${m.text}${n > 1 ? ` (×${n})` : ''}`);
  }
  return a.join('\n');
}

function loopsText(db, characterId) {
  const loops = db.prepare(
    "SELECT kind, text, urgency, related_poi FROM open_loops WHERE character_id = ? AND status = 'open' ORDER BY urgency DESC LIMIT 6"
  ).all(characterId);
  if (loops.length === 0) return 'Offene Vorhaben: keine.';
  const a = ['Offene Fragen und Vorhaben:'];
  for (const l of loops) a.push(`- [${l.kind}] ${l.text}${l.related_poi ? ` (bei ${l.related_poi})` : ''}`);
  return a.join('\n');
}

function inventarText(db, characterId) {
  const items = db.prepare('SELECT item_key, label, count FROM inventory WHERE character_id = ?').all(characterId);
  if (items.length === 0) return 'Taschen: leer.';
  return 'Taschen: ' + items.map((i) => `${i.label} (${i.count}x)`).join(', ') + '.';
}

function hatHandy(db, characterId) {
  const r = db.prepare("SELECT count FROM inventory WHERE character_id = ? AND item_key = 'handy'").get(characterId);
  return r && Number(r.count) > 0;
}

function tagesLimitsFuer(db, characterId, jetztMs = Date.now()) {
  try {
    const arbiter = require('./arbiter');
    return {
      webSearchHeute: arbiter.hatTagesLimit(db, characterId, 'web_search', jetztMs),
      lexikonHeute: arbiter.hatTagesLimit(db, characterId, 'stadtlexikon', jetztMs),
    };
  } catch { return { webSearchHeute: false, lexikonHeute: false }; }
}

function buecherText(db, daheim = true, lexikonHeute = false) {
  let buecher = [];
  try {
    buecher = db.prepare('SELECT id, title, kind, entries_json FROM books').all();
  } catch { buecher = []; }
  if (buecher.length === 0) return 'Regal daheim: leer.';
  if (!daheim) return `Regal daheim: ${buecher.length} Bücher (nur in apartment lesbar).`;
  const a = ['Regal daheim (nur in apartment):'];
  for (const b of buecher) {
    if (b.id === 'stadtlexikon') {
      if (lexikonHeute) {
        a.push(`- „${b.title}“ (stadtlexikon – heute schon gelesen, erst morgen wieder)`);
      } else {
        a.push(`- „${b.title}“ (stadtlexikon – liefert bei read_book mit Thema/detail immer frische Infos zu Orten & Unternehmungen)`);
      }
      continue;
    }
    let eintraege = [];
    try { eintraege = JSON.parse(b.entries_json); } catch { eintraege = []; }
    const themen = eintraege
      .map((e) => (e.topic && !/^notiz_\d+$/.test(e.topic) ? e.topic : e.title))
      .filter(Boolean)
      .slice(-4);
    const themenTxt = themen.length > 0 ? `: ${themen.join(', ')}` : '';
    a.push(`- „${b.title}“ (${b.id}, ${eintraege.length} Eintr.${themenTxt})`);
  }
  return a.join('\n');
}

// --- Whitelist, Orte, Plan-Format ----------------------------------------------

const OFFENE_INTENTS = [
  'walk_to', 'explore_street', 'consume', 'do_activity', 'leave_note',
  'send_sms', 'send_email', 'web_search', 'collect_deposit', 'return_deposit', 'buy_item',
  'work_shift', 'quit_job', 'rest', 'sleep',
  'visit_doctor', 'read_book', 'write_notebook', 'work_on_project',
];

function hatPfand(db, characterId) {
  const r = db.prepare("SELECT count FROM inventory WHERE character_id = ? AND item_key = 'pfand'").get(characterId);
  return r && Number(r.count) > 0;
}

function hatAktivenJob(db, characterId) {
  try {
    const arbiter = require('./arbiter');
    return Boolean(arbiter.aktiverJob(db, characterId));
  } catch { return false; }
}

function whitelistFuer(db, characterId, orte, ch = null, jetztMs = Date.now()) {
  const { webSearchHeute, lexikonHeute } = tagesLimitsFuer(db, characterId, jetztMs);
  let liste = OFFENE_INTENTS.filter((a) => !['send_sms', 'send_email', 'web_search'].includes(a));
  if (hatHandy(db, characterId)) {
    liste.push('send_sms', 'send_email');
    if (!webSearchHeute) liste.push('web_search');
  }
  if (lexikonHeute) liste = liste.filter((a) => a !== 'read_book');
  if (ch) {
    const hatJob = hatAktivenJob(db, characterId);
    const pfand = hatPfand(db, characterId);
    liste = liste.filter((a) => {
      if (a === 'return_deposit') return pfand;
      if (a === 'work_shift' || a === 'quit_job') return hatJob;
      return true;
    });
  }
  return { intents: liste, orte: orte || [] };
}

function orteText(orte, db = null) {
  if (!orte || orte.length === 0) return 'Bekannte Orte: nur deine Wohnung – alles andere musst du erst entdecken.';
  const a = ['Bekannte Orte (nur dorthin kannst du direkt gehen):'];
  let qOffers = null;
  if (db) {
    try { qOffers = db.prepare('SELECT label FROM poi_offers WHERE poi_id = ? ORDER BY id DESC LIMIT 4'); } catch { qOffers = null; }
  }
  for (const o of orte) {
    const desc = o.public_desc ? ` – ${String(o.public_desc).slice(0, 70)}` : '';
    let ang = '';
    if (qOffers) {
      try {
        const rows = qOffers.all(o.id);
        if (rows.length > 0) ang = ` [bekannt: ${rows.map((r) => r.label).join(', ')}]`;
      } catch { /* egal */ }
    }
    a.push(`- ${o.id}: ${o.name} (${o.category})${desc}${ang}`);
  }
  return a.join('\n');
}

function kommunikationsRegel(mitHandy, webSearchHeute = false) {
  const basis = 'WICHTIG: Du kannst mit keinem Menschen sprechen – niemand hoert dich. '
    + 'Deine einzige Stimme nach aussen sind geschriebene Zettel: lege mit leave_note einen Zettel an einem Ort ab '
    + '(z. B. eine Bewerbung als Spuelhilfe im Otzentreff).';
  if (mitHandy) {
    if (webSearchHeute) {
      return basis + ' Du hast ein Handy: damit darfst du send_sms und send_email schreiben (web_search heute schon genutzt, erst morgen wieder).';
    }
    return basis + ' Du hast ein Handy: damit darfst du auch send_sms und send_email schreiben sowie per web_search etwas nachschlagen.';
  }
  return basis + ' SMS, E-Mail und Websuche gehen erst, wenn du irgendwo ein Handy findest oder kaufst – bis dahin nur Zettel.';
}

// --- Prompt-Bau ------------------------------------------------------------------

// --- Aktiver Job als Prompt-Block (Fix "Hungerschleife") ---------------------------
// known-issues.md: Der Arbiter nimmt Jobs an, aber das Modell weiß nichts davon
// und plant endlos look_for_work. Deshalb: wenn ein aktiver Job existiert,
// bekommt das Modell einen "DEIN JOB"-Block – OHNE Zahlen (Welt-Regel: die
// Engine rechnet Lohn/Abrechnung, das Modell spürt nur Konsequenzen).
function jobText(db, characterId) {
  try {
    const arbiter = require('./arbiter');
    const job = arbiter.aktiverJob(db, characterId);
    if (!job) return null;
    const poiRow = db.prepare('SELECT name FROM pois WHERE id = ?').get(job.poi_id);
    const ort = poiRow ? poiRow.name : job.poi_id;
    const n = Number(job.shifts_completed) || 0;
    const schichten = n > 0 ? ` (${n} Schichten)` : '';
    return `DEIN JOB: ${job.role_title} bei ${ort}${schichten} – für Geld plane work_shift.`;
  } catch { return null; }
}

function buildPrompt(db, ch, ctx) {
  const c = ctx || {};
  const mem = require('./memory');
  // Top-Memories einbinden + come-back-Zähler gezielt erhöhen (§6.2)
  const top = mem.einbindenUndZaehlen(db, ch.id, 10, Date.now(), {
    insidePoi: ch.inside_poi,
    woName: c.woName,
    action: ch.current_action,
  });
  const handy = hatHandy(db, ch.id);
  const daheim = ch.inside_poi === 'apartment';
  const jetztMs = c.jetztMs || Date.now();
  const { webSearchHeute, lexikonHeute } = tagesLimitsFuer(db, ch.id, jetztMs);
  const wl = whitelistFuer(db, ch.id, c.orte, ch, jetztMs);
  const wo = c.woText || `Du bist ${c.woName || 'unterwegs'}.`;
  const zeit = c.zeitText || 'Es ist Tag in Hamburg.';
  const wetter = c.wetterText || '';
  const notizenListe = Array.isArray(c.letzteNotizen) && c.letzteNotizen.length > 0
    ? ['Zuletzt:', ...c.letzteNotizen.map((n) => `- ${n}`)]
    : [c.letztesEreignis ? `Zuletzt: ${c.letztesEreignis}` : 'Zuletzt: nichts Besonderes.'];
  const regelnExtra = [];
  if (Number(ch.hunger) < 20) regelnExtra.push('Noch völlig satt: consume nicht als ersten Schritt planen.');
  if (Number(ch.hunger) < 55 && Number(ch.erschoepfung) < 50) {
    regelnExtra.push('Du bist fit: geh raus, erkunde neue Ecken (explore_street) oder unternimm an einem Ort etwas Konkretes (do_activity, z. B. passend zur Ortsbeschreibung).');
  }
  if (lexikonHeute) regelnExtra.push('Das Stadtlexikon hast du heute schon gelesen – erst morgen wieder.');
  if (webSearchHeute) regelnExtra.push('Du hast heute schon einmal gegoogelt (web_search) – erst morgen wieder.');
  const letzteGedanken = Array.isArray(c.recentThoughts) && c.recentThoughts.length > 0
    ? ['Letzte Gedanken (NICHT wiederholen, denk an neue Handlungen/Ziele):', ...c.recentThoughts.map((t) => `- ${t}`), '']
    : [];

  let ortDetail = '';
  if (ch.inside_poi) {
    try {
      const pRow = db.prepare('SELECT name, category, public_desc FROM pois WHERE id = ?').get(ch.inside_poi);
      if (pRow) {
        const off = db.prepare('SELECT label FROM poi_offers WHERE poi_id = ? ORDER BY id DESC LIMIT 5').all(ch.inside_poi).map((r) => r.label);
        ortDetail = `Vor Ort (${pRow.name}, ${pRow.category}): ${pRow.public_desc || ''}${off.length ? ` [bekannt: ${off.join(', ')}]` : ''}`;
      }
    } catch { /* egal */ }
  }

  const jobLine = jobText(db, ch.id);
  const linien = [
    'Du bist ein junger Stadterkunder in St. Pauli (Ich-Form, heute, hier).',
    '',
    'KÖRPER & GEFÜHL:',
    ...koerperSaetze(ch),
    '',
    ...(jobLine ? [jobLine, ''] : []),
    sheetText(db, ch.id),
    '',
    memoriesText(top),
    '',
    ...letzteGedanken,
    loopsText(db, ch.id),
    '',
    inventarText(db, ch.id),
    buecherText(db, daheim, lexikonHeute),
    '',
    'ORT & ZEIT:',
    wo,
    ...(ortDetail ? [ortDetail] : []),
    zeit,
    ...(wetter ? [wetter] : []),
    ...notizenListe,
    '',
    orteText(wl.orte, db),
    '',
    kommunikationsRegel(handy, webSearchHeute),
    'Keine Beträge oder Prozentwerte nennen – die rechnet die Welt.',
    ...regelnExtra,
    '',
    'ANTWORTE NUR ALS JSON:',
    '{ "thought": "1 aktiver, abwechslungsreicher Impuls oder Vorhaben (keine Zustandsbeschreibung wie \'hier ist es still\' oder \'ich bin satt\', max. 20 Wörter)", "why_here": "kurzer Handlungs-Grund", "retrospective": "kurzer Rückblick",',
    '  "plan": [ {"action": "intent", "target": "poi_id|null", "detail": "konkreter Wunschtext"} x 1..4 ] }',
    'Erlaubte intents: ' + wl.intents.join(', ') + '.',
    'walk_to braucht immer target (poi_id); nie zwei walk_to direkt hintereinander. Du kannst auch nur [walk_to] planen, um dort erst zu schauen, was los ist – oder vor Ort 1–2 Aktionen dranhängen.',
    'Max. 1 leave_note pro Plan.',
  ];
  return { prompt: linien.join('\n'), whitelist: wl.intents, orte: wl.orte, memories: top };
}

module.exports = {
  gesundGefuehl, frohGefuehl, hungerGefuehl, erschoepfungGefuehl, geldGefuehl, koerperSaetze,
  sheetText, memoriesText, loopsText, inventarText, hatHandy, buecherText,
  OFFENE_INTENTS, whitelistFuer, orteText, kommunikationsRegel, buildPrompt, jobText,
};


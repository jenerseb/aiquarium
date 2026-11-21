'use strict';
// Prompt-Bau (§7.1 + M2-Auftrag): Wahrnehmung, Wesen, Gedächtnis, Bücher,
// Kommunikationsgrenze, Whitelist und Multi-Step-Plan-Format.
// Der Prompt enthält NIEMALS rohe Prozentzahlen – nur Körper- und Alltagsgefühle.

const { GESUND, FROH, SEKUNDAER, chunkCapFuer, AKTION } = require('./config');

// --- Körper- und Alltagsgefühle --------------------------------------------

function gesundGefuehl(gesund) {
  const g = Number(gesund);
  if (g >= 80) return 'Dein Körper fühlt sich kräftig und verlässlich an. Du kannst Treppen nehmen, ohne nachzudenken.';
  if (g >= 60) return 'Dein Körper ist weitgehend in Ordnung, nur gelegentlich zwickt etwas.';
  if (g >= 40) return 'Du fühlst dich angeschlagen: schnell außer Atem, alles strengt mehr an als sonst.';
  if (g >= 20) return 'Dir geht es sichtlich schlecht: schwindelig, fahrig, jeder Weg ist weit. Du solltest dich schonen und bald zum Arzt.';
  return 'Dir geht es sehr schlecht: kaum noch auf den Beinen. Geh zum Arzt oder ruh dich sofort aus.';
}

function frohGefuehl(froh) {
  const f = Number(froh);
  if (f >= 60) return 'Dir ist leicht und hell zumute. Du lächelst fremde Leute fast automatisch an.';
  if (f >= 20) return 'Deine Stimmung ist ruhig und einigermaßen zuversichtlich.';
  if (f >= -20) return 'Deine Stimmung ist grau und gedrückt. Kleinigkeiten nerven dich.';
  if (f >= -60) return 'Du fühlst dich niedergeschlagen und einsam. Alles wirkt anstrengend und fern.';
  return 'Du bist tief unten: traurig, mutlos, am liebsten würdest du dich verkriechen.';
}

function hungerGefuehl(hunger) {
  const h = Number(hunger);
  if (h < 20) return 'Du bist pappsatt. Allein der Gedanke an Essen oder Trinken widerstrebt dir – du bekommst gerade keinen Bissen herunter. Nutze die Zeit zum Erkunden, Lesen, Schreiben oder Arbeiten.';
  if (h < 45) return 'Du bist satt und brauchst kein Essen. Dein Kopf ist frei für den Kiez, deine Projekte oder Erledigungen.';
  if (h < 70) return 'Langsam bekommst du Appetit – bei Gelegenheit wäre ein Imbiss oder Snack nett, aber es eilt noch nicht.';
  if (h < 85) return 'Du hast deutlich Hunger: der Magen knurrt, lange solltest du das Essen nicht mehr aufschieben.';
  return 'Du bist ausgehungert: dir ist flau und schwindelig vor Hunger. Iss sofort etwas!';
}

function erschoepfungGefuehl(wert) {
  const e = Number(wert);
  if (e < 30) return 'Du bist hellwach und voller Tatendrang. Ans Schlafen oder Ausruhen ist überhaupt nicht zu denken.';
  if (e < 50) return 'Du bist wach und aufnahmefähig. Fürs Bett bist du noch viel zu fit – du könntest jetzt unmöglich einschlafen.';
  if (e < 75) return 'Du merkst langsam die Anstrengung in den Knochen. Du hältst noch gut durch, könntest dich aber auch schon ausruhen oder schlafen legen.';
  if (e < 90) return 'Du bist richtig müde: schwere Lider, das Denken wird zäh. Geh bald heim in deine Wohnung zum Schlafen.';
  return 'Du bist völlig übermüdet und hältst dich kaum noch auf den Beinen. Geh sofort in deine Wohnung und schlaf!';
}

function geldGefuehl(geld) {
  const g = Math.round(Number(geld) || 0);
  if (g >= 50) return `Du hast ${g} Euro in der Tasche – ein solides Polster (damit könntest du dir am Späti sogar ein gebrauchtes Handy kaufen).`;
  if (g >= 25) return `Du hast ${g} Euro in der Tasche – ein ordentliches Polster für den Kiez, mit dem du gut haushalten kannst.`;
  if (g >= 10) return `Du hast ${g} Euro in der Tasche – ein kleines Polster für den Kiez, mit dem du aber haushalten musst.`;
  if (g >= 1) return `Du hast nur noch ${g} Euro in der Tasche – das ist knapp, jede Ausgabe zählt doppelt.`;
  return 'Du hast praktisch kein Geld mehr. Du musst erst etwas verdienen oder Pfand abgeben.';
}

function koerperSaetze(ch) {
  const cap = chunkCapFuer(Number(ch.gesund));
  const saetze = [
    gesundGefuehl(ch.gesund) + ` (Dein Körper erholt sich derzeit höchstens bis zu dieser Belastungsgrenze von ${cap}.)`,
    frohGefuehl(ch.froh),
    hungerGefuehl(ch.hunger),
    erschoepfungGefuehl(ch.erschoepfung),
    geldGefuehl(ch.geld),
  ];
  return saetze;
}


// --- Wesen + Character Sheet ------------------------------------------------

function sheetText(db, characterId) {
  const zeilen = db.prepare(
    "SELECT category, text, written_by, source_reason FROM character_sheet WHERE character_id = ? AND active = 1 ORDER BY category, id"
  ).all(characterId);
  const fest = zeilen.filter((z) => z.written_by === 'creator');
  const gelernt = zeilen.filter((z) => z.written_by === 'self');
  const fmt = (z) => `- [${z.category}] ${z.text}${z.source_reason ? ` (Ausloeser: ${z.source_reason})` : ''}`;
  const a = ['Dein unveraenderliches Wesen (das bleibt, wer du bist):'];
  for (const z of fest) a.push(fmt(z));
  if (gelernt.length > 0) {
    a.push('Was du ueber dich selbst gelernt hast (darfst du hinterfragen, aber nicht loeschen):');
    for (const z of gelernt) a.push(fmt(z));
  }
  return a.join('\n');
}

// --- Gedaechtnis, Loops, Inventar, Buecher ------------------------------------

function memoriesText(topMems) {
  if (!topMems || topMems.length === 0) return 'An besondere Momente erinnerst du dich gerade kaum – der Kopf ist leer.';
  const a = ['Was dir gerade im Kopf herumgeht (das Wichtigste zuerst):'];
  for (const m of topMems) a.push(`- (${m.tier}, ${m.kind}) ${m.text}`);
  return a.join('\n');
}

function loopsText(db, characterId) {
  const loops = db.prepare(
    "SELECT kind, text, urgency, related_poi FROM open_loops WHERE character_id = ? AND status = 'open' ORDER BY urgency DESC LIMIT 8"
  ).all(characterId);
  if (loops.length === 0) return 'Offene Fragen und Vorhaben: gerade keine – du bist frei fuer Neues.';
  const a = ['Offene Fragen und Vorhaben (Fragen an die Welt, Wuensche an dich, angefangene Arbeit):'];
  for (const l of loops) a.push(`- [${l.kind}] ${l.text}${l.related_poi ? ` (bei ${l.related_poi})` : ''}`);
  return a.join('\n');
}

function inventarText(db, characterId) {
  const items = db.prepare('SELECT item_key, label, count FROM inventory WHERE character_id = ?').all(characterId);
  if (items.length === 0) return 'In deinen Taschen: nichts ausser Kruemeln.';
  return 'In deinen Taschen: ' + items.map((i) => `${i.label} (${i.count}x)`).join(', ') + '.';
}

function hatHandy(db, characterId) {
  const r = db.prepare("SELECT count FROM inventory WHERE character_id = ? AND item_key = 'handy'").get(characterId);
  return r && Number(r.count) > 0;
}

function buecherText(db) {
  let buecher = [];
  try {
    buecher = db.prepare('SELECT id, title, kind, entries_json FROM books').all();
  } catch { buecher = []; }
  if (buecher.length === 0) return 'In deinem Regal daheim: gerade nichts – das Regal ist leer.';
  const a = ['In deinem Regal daheim stehen (nur hier in der Wohnung kannst du darin lesen):'];
  for (const b of buecher) {
    let eintraege = [];
    try { eintraege = JSON.parse(b.entries_json); } catch { eintraege = []; }
    const themen = eintraege.map((e) => e.topic || e.title).filter(Boolean).slice(0, 8);
    const themenTxt = themen.length > 0 ? `: ${themen.join(', ')}` : '';
    a.push(`- „${b.title}“ (id: ${b.id}, ${b.kind}, ${eintraege.length} Eintraege${themenTxt})`);
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

function whitelistFuer(db, characterId, orte) {
  const liste = OFFENE_INTENTS.filter((a) => !['send_sms', 'send_email', 'web_search'].includes(a));
  if (hatHandy(db, characterId)) liste.push('send_sms', 'send_email', 'web_search');
  return { intents: liste, orte: orte || [] };
}

function orteText(orte) {
  if (!orte || orte.length === 0) return 'Bekannte Orte: nur deine Wohnung – alles andere musst du erst entdecken.';
  const a = ['Bekannte Orte (nur dorthin kannst du direkt gehen):'];
  for (const o of orte) a.push(`- ${o.id}: ${o.name} (${o.category})`);
  return a.join('\n');
}

function kommunikationsRegel(mitHandy) {
  const basis = 'WICHTIG: Du kannst mit keinem Menschen sprechen – niemand hoert dich. '
    + 'Deine einzige Stimme nach aussen sind geschriebene Zettel: lege mit leave_note einen Zettel an einem Ort ab '
    + '(z. B. eine Bewerbung als Spuelhilfe im Otzentreff).';
  if (mitHandy) {
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
    const schichten = n === 1 ? 'Du hast dort schon eine Schicht geschafft.' : (n > 1 ? `Du hast dort schon ${n} Schichten geschafft.` : '');
    return 'DEIN JOB: Du hast eine Zusage als ' + job.role_title + ' bei ' + ort + '. ' + schichten
      + ' Eine Schicht dort macht hungrig und müde, aber danach hast du wieder Geld in der Tasche. '
      + 'Du musst NICHT mehr nach Arbeit suchen – look_for_work und take_job sind jetzt sinnlos. '
      + 'Wenn du Geld brauchst, plane stattdessen work_shift bei ' + ort + '.';
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
  const wl = whitelistFuer(db, ch.id, c.orte);
  const wo = c.woText || `Du bist ${c.woName || 'unterwegs'}.`;
  const zeit = c.zeitText || 'Es ist Tag in Hamburg.';
  const wetter = c.wetterText || '';
  const notizenListe = Array.isArray(c.letzteNotizen) && c.letzteNotizen.length > 0
    ? ['Was zuletzt passiert ist:', ...c.letzteNotizen.map((n) => `- ${n}`)]
    : [c.letztesEreignis ? `Zuletzt ist passiert: ${c.letztesEreignis}` : 'Zuletzt ist nichts Besonderes passiert.'];
  const regelnExtra = [];
  if (Number(ch.hunger) < 20) regelnExtra.push('Du bist noch völlig satt: plane consume NICHT als ersten Schritt (höchstens nach einer Arbeitsschicht).');
  if (Number(ch.erschoepfung) < 50) regelnExtra.push('Du bist noch zu wach zum Schlafen: plane sleep NICHT (höchstens nach einer Arbeitsschicht), und geschlafen wird nur in apartment.');

  const linien = [
    'Du bist ein junger Stadterkunder, frisch in St. Pauli angekommen. Du erlebst alles in der Ich-Form, heute, hier.',
    '',
    'SO FÜHLT SICH DEIN KÖRPER AN (keine Zahlen, nur Gefühl):',
    ...koerperSaetze(ch),
    '',
    ...(jobText(db, ch.id) ? [jobText(db, ch.id), ''] : []),
    sheetText(db, ch.id),
    '',
    memoriesText(top),
    '',
    loopsText(db, ch.id),
    '',
    inventarText(db, ch.id),
    buecherText(db),
    '',
    'WO DU BIST:',
    wo,
    zeit,
    wetter,
    ...notizenListe,
    '',
    orteText(wl.orte),
    '',
    kommunikationsRegel(handy),
    'Geld, Zeit und Gesundheit rechnet die Welt für dich – du beschreibst nur Wünsche und Gedanken, nie Beträge oder Prozentwerte.',
    ...regelnExtra,
    '',
    'ANTWORTE AUSSCHLIESSLICH ALS JSON (kein anderer Text):',
    '{ "thought": "ein Satz, was dir gerade durch den Kopf geht (max. 20 Wörter)",',
    '  "why_here": "kurzer Grund für diesen Plan (was du gerade vorhast)",',
    '  "retrospective": "ein kurzer Rückblick auf deinen letzten Plan (was geklappt hat, was nicht)",',
    '  "plan": [ {"action": "intent", "target": "poi_id oder null", "detail": "freier Wunschtext"} x 2 bis 4 Schritte ] }',
    'Erlaubte intents: ' + wl.intents.join(', ') + '.',
    'Schritte mit "walk_to" brauchen immer ein "target" (poi_id).',
    'Lege höchstens einen "leave_note"-Schritt pro Plan ab.',
  ];
  return { prompt: linien.join('\n'), whitelist: wl.intents, orte: wl.orte, memories: top };
}

module.exports = {
  gesundGefuehl, frohGefuehl, hungerGefuehl, erschoepfungGefuehl, geldGefuehl, koerperSaetze,
  sheetText, memoriesText, loopsText, inventarText, hatHandy, buecherText,
  OFFENE_INTENTS, whitelistFuer, orteText, kommunikationsRegel, buildPrompt, jobText,
};


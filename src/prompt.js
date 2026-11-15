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
  if (h < 25) return 'Du bist angenehm satt und musst an Essen gerade nicht denken.';
  if (h < 50) return 'Dein Magen meldet sich leise: bald wäre eine Kleinigkeit gut.';
  if (h < 75) return 'Du hast deutlich Hunger: der Magen knurrt, du wirst unkonzentriert.';
  if (h < 90) return 'Du hast starken Hunger: zittrige Hände, flau im Magen. Iss bald etwas Richtiges.';
  return 'Du bist ausgehungert: dir ist flau und schwindelig vor Hunger. Iss sofort etwas.';
}

function erschoepfungGefuehl(wert) {
  const e = Number(wert);
  if (e < 25) return 'Du bist wach und ausgeruht.';
  if (e < 50) return 'Du merkst erste Müdigkeit: Gähnen, schwere Lider ab und zu.';
  if (e < 75) return 'Du bist müde: das Denken wird zäh, du sehnst dich nach einer Pause.';
  if (e < 90) return 'Du bist stark erschöpft: alles verschwimmt, du machst Fehler. Ruh dich bald aus.';
  return 'Du bist völlig übermüdet: kaum noch wach zu halten. Leg dich sofort hin.';
}

function geldGefuehl(geld) {
  const g = Number(geld);
  if (g >= 50) return `Du hast ${g.toFixed(2)} Euro dabei – das reicht für eine entspannte Mahlzeit und noch etwas obendrauf.`;
  if (g >= 25) return `Du hast ${g.toFixed(2)} Euro dabei – das reicht für eine ordentliche warme Mahlzeit oder zwei kleine Einkäufe.`;
  if (g >= 12) return `Du hast ${g.toFixed(2)} Euro dabei – das reicht für eine einfache Mahlzeit beim Imbiss oder ein Getränk in der Kneipe, aber nicht für viel mehr.`;
  if (g >= 5) return `Du hast ${g.toFixed(2)} Euro dabei – das reicht höchstens für einen Kaffee oder einen kleinen Snack am Kiosk.`;
  if (g >= 1) return `Du hast ${g.toFixed(2)} Euro dabei – das reicht kaum für das Nötigste. Jede Ausgabe zählt doppelt.`;
  return 'Du hast praktisch kein Geld mehr. Du musst sparsam über jeden Cent nachdenken oder erst etwas verdienen bzw. Pfand abgeben.';
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
    let n = 0;
    try { n = JSON.parse(b.entries_json).length; } catch { n = 0; }
    a.push(`- „${b.title}“ (${b.kind}, ${n} Eintraege)`);
  }
  return a.join('\n');
}

// --- Whitelist, Orte, Plan-Format ----------------------------------------------

const OFFENE_INTENTS = [
  'walk_to', 'explore_street', 'consume', 'do_activity', 'leave_note',
  'send_sms', 'send_email', 'web_search', 'collect_deposit', 'return_deposit', 'buy_item',
  'look_for_work', 'take_job', 'work_shift', 'quit_job', 'rest', 'sleep',
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

function buildPrompt(db, ch, ctx) {
  const c = ctx || {};
  const mem = require('./memory');
  // Top-Memories einbinden + come-back-Zähler erhöhen (§6.2)
  const top = mem.einbindenUndZaehlen(db, ch.id, 10);
  const handy = hatHandy(db, ch.id);
  const wl = whitelistFuer(db, ch.id, c.orte);
  const wo = c.woText || `Du bist ${c.woName || 'unterwegs'}.`;
  const zeit = c.zeitText || 'Es ist Tag in Hamburg.';
  const wetter = c.wetterText || '';
  const ereignis = c.letztesEreignis ? `Zuletzt ist passiert: ${c.letztesEreignis}` : 'Zuletzt ist nichts Besonderes passiert.';

  const linien = [
    'Du bist ein junger Stadterkunder, frisch in St. Pauli angekommen. Du erlebst alles in der Ich-Form, heute, hier.',
    '',
    'SO FÜHLT SICH DEIN KÖRPER AN (keine Zahlen, nur Gefühl):',
    ...koerperSaetze(ch),
    '',
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
    ereignis,
    '',
    orteText(wl.orte),
    '',
    kommunikationsRegel(handy),
    'Geld, Zeit und Gesundheit rechnet die Welt für dich – du beschreibst nur Wünsche und Gedanken, nie Beträge oder Prozentwerte.',
    '',
    'ANTWORTE AUSSCHLIESSLICH ALS JSON (kein anderer Text):',
    '{ "thought": "ein Satz, was dir gerade durch den Kopf geht (max. 20 Wörter)",',
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
  OFFENE_INTENTS, whitelistFuer, orteText, kommunikationsRegel, buildPrompt,
};


'use strict';
// Prompt-Bau: Wesen (Gewichte), Körpergefühl, Glaube, Objekte, Whitelist, Musings.
const { ACTIONS, STRESS, NOVELTY, VAGUE_HINTS, sichtStufe, richtungWort, ankerPos } = require('./config');

const INSTINCTS = [
  'Sitzen hilft nur, wenn du erschöpft bist. Bist du ausgeruht, wird dir langweilig und der Stress steigt.',
  'Stille und unregelmäßiges Klopfen treiben deinen Stress hoch. Etwas Neues senkt ihn.',
  'Ab Hunger 60 denkst du an wenig anderes; ab 80 nur noch ans Fressen.',
  'Ab Erschöpfung 70 wird jeder Schritt doppelt so teuer.',
  'Dreimal dieselbe Handlung hintereinander macht dich gereizt.',
  'Ordnung beruhigt dich: etwas an seinen Platz legen hilft.',
  'Geräusche im Funk machen dich neugierig, nicht ängstlich.',
  'Du traust Dingen nicht, die ohne Grund glänzen.',
  'Du sammelst, was klein ist und in eine Tasche passt.',
  'Wenn du lange allein bist, redest du mit Gegenständen.',
  'Du magst die Kapsel, weil sie schattig ist, nicht weil sie sicher ist.',
  'Wenn der Stress steigt, zählst du Dinge: Muttern, Schritte, Atemzüge.',
  'Die Erde am Himmel ist für dich kein Ort, sondern ein Versprechen.',
  'Du isst, wenn du Futter siehst, nicht wenn du Hunger hast.',
  'Nach drei Fehlversuchen gibst du auf — aber erst nach dem dritten.',
];

const OBJECT_HINTS = {
  capsule: 'Die Kapsel: Schatten, ein Vorrat, ein Surren.',
  shade: 'Ein Blech, das Schatten wirft. Darunter ist es kühl.',
  wreck: 'Ein Wrack, halb im Rost versunken. Es riecht nach Öl.',
  field: 'Ein Feld mit Karotten, die im Boden stecken.',
  mast: 'Ein Funkmast. Ab und zu klickt es darin.',
  note: 'Ein Notizzettel, an einen Stein geklemmt. Du kannst die Schrift nicht lesen.',
  kuppel: 'Eine Gewächskuppel. Darin stehen Karotten in Reih und Glied.',
  bake: 'Eine Notfunkbake. Sie rauscht nur.',
};

// Motive, die sich in Gedanken zu leicht wiederholen
const MOTIVE = ['kopf', 'erde', 'schatten', 'wrack', 'glänzt', 'leicht', 'schwer',
  'bauch', 'öl', 'blau', 'still', 'kalt'];

// Werte -> Körpersprache. Hoch = schlecht.
function sensory(pilot) {
  const out = [];
  if (pilot.hunger > 80) out.push('Dein Magen brennt. Du schwankst beim Gehen.');
  else if (pilot.hunger > 60) out.push('Dein Magen knurrt laut.');
  else if (pilot.hunger > 40) out.push('Du hast Hunger, aber es ist auszuhalten.');
  else out.push('Du hast keinen Hunger.');

  if (pilot.exhaustion > 80) out.push('Deine Beine zittern. Du musst dich hinlegen.');
  else if (pilot.exhaustion > 60) out.push('Deine Pfoten sind schwer wie Blei.');
  else if (pilot.exhaustion > 40) out.push('Du bist ein wenig müde.');
  else out.push('Du bist ausgeruht.');

  if (pilot.stress > 80) out.push('Alles klingt zu laut. Du zählst schon wieder.');
  else if (pilot.stress > 60) out.push('Du bist gereizt und müde im Kopf.');
  else if (pilot.stress > 40) out.push('Etwas nagt an dir, du weißt nicht was.');
  else out.push('Du bist ruhig und klar im Kopf.');

  return out.join(' ');
}

// Wann eine Aktion angeboten wird: nur wenn der Körper sie braucht.
const AVAIL = {
  eat: (p) => p.hunger > 25,
  // Sitzen ist keine Freizeitbeschäftigung: erst wenn die Beine schwer sind
  sit_shade: (p) => p.exhaustion > 35 || p.stress > 45,
  sleep: (p) => p.exhaustion > 45 || p.stress > 55,
  look_earth: (p) => p.stress > 30,
  inspect: () => true,
  dig: () => true,
  search_wrack: () => true,
  read_note: (p) => p.stress > 35,
  check_stock: (p) => p.hunger > 35,
  tend_dome: (p) => p.hunger > 25 || p.stress > 40,
  call_bake: () => true,   // die schlechte Option bleibt absichtlich wählbar
  streifen: () => true,    // ehrliche Alternative bei Langeweile: kostet Beine, bringt Neuigkeit
  sinnieren: () => true,   // freies Denken, jederzeit; Monotonie-Bremse fängt Spam
};

const RUHE = ['sit_shade', 'look_earth', 'sinnieren'];

function whitelistFor(pilot, opts = {}) {
  const { recentActions = [] } = opts;
  let list;
  if (pilot.mind_state === 'stupor') list = ['sit_shade', 'sleep'];
  else if (pilot.mind_state === 'wahn') list = ['run_wild', 'sleep'];
  else if (pilot.stress > STRESS.low) list = ['eat', 'sleep', 'sit_shade', 'inspect'];
  else list = Object.keys(ACTIONS).filter((k) => k !== 'run_wild');

  if (pilot.mind_state === 'klar') {
    const gefiltert = list.filter((a) => !AVAIL[a] || AVAIL[a](pilot));
    if (gefiltert.length) list = gefiltert;

    // Ruhe-Quote: zwei ruhige Aktionen in den letzten drei -> Ruhe eine Runde gesperrt
    const ruhige = recentActions.slice(-3).filter((a) => RUHE.includes(a)).length;
    if (ruhige >= 2) {
      const ohneRuhe = list.filter((a) => !RUHE.includes(a));
      list = ohneRuhe.length ? ohneRuhe : ['inspect'];
    }

    // Wiederholungs-Bremse: zweimal dieselbe Aktion in den letzten drei
    const letzte = recentActions.slice(-3);
    const zuoft = new Set(letzte.filter((a) => letzte.filter((b) => b === a).length >= 2));
    if (zuoft.size) {
      const ohne = list.filter((a) => !zuoft.has(a));
      if (ohne.length) list = ohne;
    }

    // Zickzack-Bremse: A,B,A,B in den letzten vier -> A setzt eine Runde aus.
    // Fängt das Pendel, das die Wiederholungs-Bremse erzeugt (sie sperrt nur B).
    // Nicht im Notfall: Hunger/Exhaustion > 80 könnten sonst Fressen/Schlafen sperren.
    const letzte4 = recentActions.slice(-4);
    if (letzte4.length === 4 && letzte4[0] === letzte4[2] && letzte4[1] === letzte4[3]
        && letzte4[0] !== letzte4[1] && pilot.hunger <= 80 && pilot.exhaustion <= 80) {
      const ohneZick = list.filter((a) => a !== letzte4[0]);
      if (ohneZick.length) list = ohneZick;
    }
  }

  if (recentActions.length >= 3 && recentActions.slice(-3).every((a) => a === recentActions.at(-1))) {
    const banned = recentActions.at(-1);
    const filtered = list.filter((a) => a !== banned);
    if (filtered.length) list = filtered;
  }

  return list.length ? list : ['sleep'];
}

// Welche Motive in den letzten Gedanken zu oft vorkamen
function uebernutzteMotive(recentThoughts = [], grenze = 3) {
  const text = recentThoughts.slice(0, 12).join(' ').toLowerCase();
  return MOTIVE.filter((m) => (text.split(m).length - 1) >= grenze);
}

function nearbyObjects(pilot, entities, max = 5) {
  return entities
    .map((e) => ({ ...e, ...ankerPos(e) }))   // Entfernungen zum sichtbaren Bauwerk, nicht zum Logikpunkt
    .map((e) => ({ ...e, dist: Math.hypot(e.pos_x - pilot.pos_x, e.pos_z - pilot.pos_z) }))
    .map((e) => ({ ...e, stufe: sichtStufe(pilot, e) }))
    .filter((e) => e.stufe !== 'ungesehen')   // Paket I: Ungesehenes fehlt im Prompt
    .sort((a, b) => a.dist - b.dist)
    .slice(0, max);
}

// Richtung für einen freien Gedanken — nie den Text. Den schreibt das Modell.
function waehleMusingThema(pilot) {
  const themen = [];
  if (pilot.hunger > 55) themen.push('Erinnerung ans Essen: Kaffee, Kantine, Vorräte');
  if (pilot.stress > 60) themen.push('Furcht: Klopfen, wer da draußen ist, das Alleinsein');
  if (pilot.exhaustion > 55) themen.push('Müdigkeit: Schlafplätze, Träume, wie sich Wärme anfühlt');
  if (pilot.stress < NOVELTY.boredBelow) {
    themen.push('Neugier: was auf der Erde wohl gerade los ist');
    themen.push('Einsamkeit: lange keine Tiere mehr gesehen, wie es auf der Akademie war');
    themen.push('Handwerk: was man aus Schrott bauen könnte');
  }
  themen.push('Kleinigkeit: ein Geräusch, ein Geruch, eine Erinnerung ohne Grund');
  return themen[Math.floor(Math.random() * themen.length)];
}

function buildPrompt(pilot, ctx = {}) {
  const { entities = [], beliefs = [], whitelist = [], words = [], recentThoughts = [], musing = null, vorrat = null } = ctx;

  // Paket I: Klare Orte mit Namen, Vermutete mit „Vermutung: …", Bemerkte nur
  // als „etwas Unbekanntes", Ungesehene fehlen (Filter oben)
  const sichtbaren = nearbyObjects(pilot, entities);
  const zeilen = sichtbaren
    .filter((e) => e.stufe === 'klar')
    .map((e) => `- ${OBJECT_HINTS[e.type] || e.name} (${Math.round(e.dist)} Schritte entfernt)`);
  for (const e of sichtbaren.filter((e) => e.stufe === 'vermutet')) {
    const was = VAGUE_HINTS[e.type] ? `Vermutung: ${VAGUE_HINTS[e.type]}` : 'etwas Unbekanntes';
    zeilen.push(`- Vage: ${was} (${Math.round(e.dist)} Schritte ${richtungWort(pilot, e)})`);
  }
  for (const e of sichtbaren.filter((e) => e.stufe === 'bemerkt')) {
    zeilen.push(`- Fern: etwas Unbekanntes (${Math.round(e.dist)} Schritte ${richtungWort(pilot, e)})`);
  }
  const nahBlock = zeilen.length ? zeilen.join('\n') : '- Nichts zu erkennen. Nur Mondstaub.';

  const beliefLine = beliefs.length
    ? beliefs.map((b) => `- ${b.text || b}`).join('\n')
    : '- Noch nichts gelernt.';

  const wordLine = words.length ? words.join(', ') : 'keine';
  const motive = uebernutzteMotive(recentThoughts);
  const motivZeile = motive.length
    ? `\nVermeide diese Wörter, sie kamen zuletzt zu oft: ${motive.join(', ')}.`
    : '';

  const musingBlock = musing
    ? `\nZusatz: Du hast gerade einen freien Gedanken. Richtung: ${musing}.\nFormuliere ihn als zweiten, kurzen Satz (höchstens 10 Wörter) im Feld "musing".`
    : '\nLass "musing" weg.';

  return `Du bist ein rundliches Wesen im Raumanzug, gestrandet auf einem kleinen Mond. Du weißt nicht, was Prozentwerte sind, und sprichst nie in Zahlen.

Dein Wesen (unveränderlich):
${INSTINCTS.map((i) => `- ${i}`).join('\n')}

Körpergefühl: ${sensory(pilot)}
${vorrat ? `Vorratskontrolle vor ${vorrat.minuten} Minuten: dein Bauch reicht noch für etwa ${vorrat.stunden} Stunden.` : ''}

Was du über die Welt glaubst:
${beliefLine}

In deiner Nähe:
${nahBlock}

Wörter, die dir nicht aus dem Kopf gehen: ${wordLine}${motivZeile}

Verfügbare Aktionen: ${JSON.stringify(whitelist)}

Schreibe den Gedanken so: erst was du siehst, dann was du fühlst, dann was du tun willst.
Höchstens 14 Wörter, Deutsch, höchstens ein Ausrufezeichen, keine Emojis, keine Zahlen.${musingBlock}

Antworte STRIKT in diesem JSON, nichts davor, nichts danach:
{"action": "eine der Aktionen", "thought": "dein Gedanke"${musing ? ', "musing": "dein freier Gedanke"' : ''}}`;
}

module.exports = {
  INSTINCTS, OBJECT_HINTS, MOTIVE, AVAIL, sensory, whitelistFor,
  nearbyObjects, buildPrompt, uebernutzteMotive, waehleMusingThema,
};

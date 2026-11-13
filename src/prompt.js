'use strict';
// Prompt-Bau: Wesen (Gewichte), Körpergefühl, Glaube, Objekte, Whitelist, Musings.
const { ACTIONS, PSYCHE, NOVELTY, VAGUE_HINTS, dist3, sichtStufe, richtungWort, ankerPos } = require('./config');

const INSTINCTS = [
  'Sitzen hilft nur, wenn der Körper Ruhe braucht. Bist du fit, wird dir langweilig und die Stimmung sinkt.',
  'Stille und unregelmäßiges Klopfen ziehen dich runter. Etwas Neues hebt dich.',
  'Bei leerem Körper denkst du an wenig anderes; unter 25 nur noch ans Fressen.',
  'Jeder Schritt kostet Körper; wer rennt, zahlt anderthalb.',
  'Dreimal dieselbe Handlung hintereinander macht dich gereizt.',
  'Ordnung beruhigt dich: etwas an seinen Platz legen hilft.',
  'Geräusche im Funk machen dich neugierig, nicht ängstlich.',
  'Du traust Dingen nicht, die ohne Grund glänzen.',
  'Du sammelst, was klein ist und in eine Tasche passt.',
  'Wenn du lange allein bist, redest du mit Gegenständen.',
  'Du magst die Kapsel, weil sie schattig ist, nicht weil sie sicher ist.',
  'Wenn die Stimmung sinkt, zählst du Dinge: Muttern, Schritte, Atemzüge.',
  'Die Erde am Himmel ist für dich kein Ort, sondern ein Versprechen.',
  'Du isst, wenn du Futter siehst, nicht erst wenn der Körper leer ist.',
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

// Körpergefühl in Worten: Körper (0..100, hoch = gut), Psyche (-100..+100).
// Paket K: Treiber-Symptome — der Pilot spürt Hunger/Thermo/Drang/Halt,
// nicht Zahlen. Keine Prozentwerte, keine Werte-Namen im Text.
function sensory(pilot) {
  const out = [];
  if (pilot.body > 80) out.push('Du strotzt vor Kraft.');
  else if (pilot.body > 60) out.push('Dein Körper trägt dich.');
  else if (pilot.body > 40) out.push('Deine Beine sind etwas schwach.');
  else if (pilot.body > 25) out.push('Jeder Schritt kostet dich.');
  else out.push('Du schwankst. Dein Körper ist am Ende.');

  const hunger = pilot.hunger ?? 15;
  if (hunger > 80) out.push('Dein Bauch drückt vor Leere.');
  else if (hunger > 50) out.push('Dein Magen knurrt.');
  else if (hunger > 35) out.push('Du könntest langsam etwas zu essen vertragen.');

  const thermo = pilot.thermo ?? 0;
  if (thermo > 75) out.push('Brühende Hitze flimmert im Anzug.');
  else if (thermo > 40) out.push('Dir ist zu warm.');
  else if (thermo < -75) out.push('Die zitterst vor Eieskälte.');
  else if (thermo < -40) out.push('Du fröstelst.');

  if (pilot.psyche > 60) out.push('Alles glänzt verheißungsvoll.');
  else if (pilot.psyche > 20) out.push('Du bist guter Dinge.');
  else if (pilot.psyche > -20) out.push('Du bist ruhig und klar im Kopf.');
  else if (pilot.psyche > -60) out.push('Etwas nagt an dir, du weißt nicht was.');
  else out.push('Alles ist grau und zu schwer.');

  return out.join(' ');
}

// Wann eine Aktion angeboten wird: nur wenn der Körper sie braucht.
// Paket K: eat/sleep/sit_shade/look_earth lesen Treiber, nicht mehr body/psyche direkt.
const AVAIL = {
  eat: (p) => (p.hunger ?? 15) > 45,
  // Sitzen ist keine Freizeitbeschäftigung: erst wenn der Körper Ruhe braucht
  sit_shade: (p) => p.body < 70 || (p.drang ?? 10) < -30 || (p.halt ?? 80) < 40,
  sleep: (p) => p.body < 60 || (p.drang ?? 10) < -40 || (p.halt ?? 80) < 40,
  look_earth: (p) => (p.halt ?? 80) < 60,
  inspect: () => true,
  dig: () => true,
  search_wrack: () => true,
  read_note: (p) => p.psyche < -15,
  check_stock: (p) => p.body < 65,
  tend_dome: (p) => p.body < 75 || p.psyche > 20,
  call_bake: () => true,   // die schlechte Option bleibt absichtlich wählbar
  streifen: () => true,    // ehrliche Alternative bei Langeweile: kostet Beine, bringt Neuigkeit
  sinnieren: () => true,   // freies Denken, jederzeit; Monotonie-Bremse fängt Spam
};

const RUHE = ['sit_shade', 'look_earth', 'sinnieren'];

function whitelistFor(pilot, opts = {}) {
  const { recentActions = [] } = opts;
  const manieAktiv = pilot.mania_until_tick != null;
  let list;
  if (pilot.mind_state === 'stupor') list = ['sit_shade', 'sleep'];
  // Wahn: hide_capsule = Rückzug in die Kapsel (sicherer Ort, Gegenstück zum
  // Wegrennen); run_wild = blind wegrennen. sleep bleibt als Notausgang.
  // body-Verbrauch ×1,5 (Startwert, Spec 2026-11-13) steht in der Engine.
  else if (pilot.mind_state === 'wahn') list = ['run_wild', 'hide_capsule', 'sleep'];
  else if (pilot.psyche <= PSYCHE.low) list = ['eat', 'sleep', 'sit_shade', 'inspect'];
  else list = Object.keys(ACTIONS).filter((k) => k !== 'run_wild' && k !== 'hide_capsule');

  // Manie: alle Ruhe-Aktionen gesperrt (Gefahr der Selbsterschöpfung).
  // Entschieden 2026-11-13: Manie hat höhere Prio als der Notfall-Instinkt —
  // der Notfall sticht die Manie NICHT aus (Manie ist temporär, läuft aus).
  // eat fliegt in der Manie ebenfalls raus — sonst kommt es über AVAIL wieder rein.
  if (manieAktiv) {
    list = list.filter((a) => a !== 'sleep' && a !== 'sit_shade' && a !== 'eat');
  }

  // Notfall-Instinkt: Bei fast leerem Körper durchbricht Überleben die Sperre —
  // auch depressiv/stuporös wird noch gefressen. Gilt NICHT während Manie.
  if (!manieAktiv && pilot.mind_state !== 'klar' && pilot.body < 25 && !list.includes('eat')) {
    list = [...list, 'eat'];
  }

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
    // Nicht im Notfall: Bei fast leerem Körper könnten sonst Fressen/Schlafen sperren.
    const letzte4 = recentActions.slice(-4);
    if (letzte4.length === 4 && letzte4[0] === letzte4[2] && letzte4[1] === letzte4[3]
        && letzte4[0] !== letzte4[1] && pilot.body >= 20) {
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

function nearbyObjects(pilot, entities, max = 5) {
  return entities
    .map((e) => ({ ...e, ...ankerPos(e) }))   // Entfernungen zum sichtbaren Bauwerk, nicht zum Logikpunkt
    .map((e) => ({ ...e, dist: dist3(pilot, e) }))
    .map((e) => ({ ...e, stufe: sichtStufe(pilot, e) }))
    .filter((e) => e.stufe !== 'ungesehen')   // Paket I: Ungesehenes fehlt im Prompt
    .sort((a, b) => a.dist - b.dist)
    .slice(0, max);
}

// Richtung für einen freien Gedanken — nie den Text. Den schreibt das Modell.
function waehleMusingThema(pilot) {
  const themen = [];
  if (pilot.body < 45) themen.push('Erinnerung ans Essen: Kaffee, Kantine, Vorräte');
  if (pilot.psyche < -20) themen.push('Müdigkeit: Schlafplätze, Träume, wie sich Wärme anfühlt');
  if (pilot.psyche < -40) themen.push('Furcht: Klopfen, wer da draußen ist, das Alleinsein');
  if (pilot.psyche > -20) {
    themen.push('Neugier: was auf der Erde wohl gerade los ist');
    themen.push('Einsamkeit: lange keine Tiere mehr gesehen, wie es auf der Akademie war');
    themen.push('Handwerk: was man aus Schrott bauen könnte');
  }
  themen.push('Kleinigkeit: ein Geräusch, ein Geruch, eine Erinnerung ohne Grund');
  return themen[Math.floor(Math.random() * themen.length)];
}

// Gedanken-Impulse (Paket B): stilistische Richtung pro Modellaufruf.
// Gewichte in config.js, Texte hier — der Gedanke selbst bleibt Modell-Sache.
const IMPULS_TEXTE = {
  selbstgespraech: 'Stelle dir eine offene Frage oder sprich mit dir selbst, statt zu berichten.',
  sinnlich: 'Beginne bei dem, was dein Körper gerade spürt: Geruch, Geräusch, Temperatur, Schwere.',
  galgen: 'Nimm es mit trockenem Galgenhumor — aber bleib bei dem, was wirklich da ist.',
  vorhaben: 'Richte den Gedanken auf das, was du gerade tust oder vorhast.',
};
function impulsText(id) {
  return IMPULS_TEXTE[id] || IMPULS_TEXTE.vorhaben;
}

function buildPrompt(pilot, ctx = {}) {
  const { entities = [], beliefs = [], whitelist = [], words = [], recentThoughts = [], musing = null, vorrat = null,
    impuls = 'vorhaben', seit = true } = ctx;

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

  const musingBlock = musing
    ? `\nZusatz: Du hast gerade einen freien Gedanken. Richtung: ${musing}.\nFormuliere ihn als zweiten, kurzen Satz (höchstens 10 Wörter) im Feld "musing".`
    : '\nLass "musing" weg.';

  const impulsZeile = `\nImpuls: ${impulsText(impuls)}`;
  const seitZeile = seit ? ''
    : '\nSeit deinem letzten Gedanken ist nichts geschehen. Fang nicht mit einem Anblick an.';

  return `Du bist ein rundliches Wesen im Raumanzug, gestrandet auf einem kleinen Mond. Du weißt nicht, was Prozentwerte sind, und sprichst nie in Zahlen.

Dein Wesen (unveränderlich):
${INSTINCTS.map((i) => `- ${i}`).join('\n')}

Körpergefühl: ${sensory(pilot)}
${vorrat ? `Vorratskontrolle vor ${vorrat.minuten} Minuten: dein Bauch reicht noch für etwa ${vorrat.stunden} Stunden.` : ''}

Was du über die Welt glaubst:
${beliefLine}

In deiner Nähe:
${nahBlock}

Wörter, die dir nicht aus dem Kopf gehen: ${wordLine}

Verfügbare Aktionen: ${JSON.stringify(whitelist)}

${impulsZeile}${seitZeile}
Schreibe 1–2 Sätze, höchstens 20 Wörter, Deutsch, höchstens ein Ausrufezeichen, keine Emojis, keine Zahlen.${musingBlock}

Antworte STRIKT in diesem JSON, nichts davor, nichts danach:
{"action": "eine der Aktionen", "thought": "dein Gedanke"${musing ? ', "musing": "dein freier Gedanke"' : ''}}`;
}

module.exports = {
  INSTINCTS, OBJECT_HINTS, AVAIL, sensory, whitelistFor,
  nearbyObjects, buildPrompt, waehleMusingThema, impulsText, IMPULS_TEXTE,
};

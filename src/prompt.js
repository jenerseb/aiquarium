'use strict';
// Prompt-Bau: Wesen (Gewichte), Körpergefühl, Glaube, Objekte, Whitelist, Musings.
const { ACTIONS, PSYCHE, NOVELTY, VAGUE_HINTS, dist3, sichtStufe, richtungWort, ankerPos } = require('./config');

// Lichtfaktor aus Phasenwort (Engine rechnet, Prompt verbraucht nur).
// licht 1, daemmer 0,75, nacht 0,5 — passt zum sichtStufe-Vertrag.
// Finsternis: Stufe 3 → Nacht-Sicht (0,5), Stufe 2 → Dämmer-Sicht (0,75).
function lichtFaktorAusPhase(phase, finsternis = 0) {
  if (finsternis >= 3) return 0.5;
  if (finsternis >= 2) return 0.75;
  if (phase === 'nacht') return 0.5;
  if (phase === 'daemmer') return 0.75;
  return 1;
}

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
  else if (pilot.body > 40) out.push('Du spürst deine Beine.');
  else if (pilot.body > 25) out.push('Jeder Schritt kostet dich.');
  else out.push('Du schwankst. Dein Körper ist am Ende.');

  const hunger = pilot.hunger ?? 15;
  if (hunger > 80) out.push('Dein Bauch brennt vor Leere.');
  else if (hunger > 50) out.push('Dein Magen knurrt.');
  else if (hunger > 35) out.push('Du könntest etwas vertragen.');

  // Tag/Nacht: ein Satz zum Licht, keine Zahlen. Der Phasen-Satz steht immer,
  // thermo-Sätze feuern jetzt öfter (die Sonne bewegt den Wert rhythmisch).
  const phase = pilot.phase || 'licht';
  if (phase === 'licht') out.push('Die Sonne steht hoch.');
  else if (phase === 'nacht') out.push('Es ist Nacht.');
  else out.push('Das Licht kippt.');

  const thermo = pilot.thermo ?? 0;
  if (thermo > 75) out.push('Die Hitze flimmert im Anzug.');
  else if (thermo > 40) out.push('Dir ist zu warm.');
  else if (thermo < -75) out.push('Die Kälte kriecht durch jede Naht.');
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
// Tag/Nacht: opts { phase, erde } vom Tick — Schlaf bei Licht nur im Schatten/in der
// Kapsel (er verkriecht sich), bei Nacht überall. call_bake nur bei sichtbarer Erde.
const AVAIL = {
  eat: (p) => (p.hunger ?? 15) > 45,
  // Sitzen ist keine Freizeitbeschäftigung: erst wenn der Körper Ruhe braucht
  sit_shade: (p) => p.body < 70 || (p.drang ?? 10) < -30 || (p.halt ?? 80) < 40,
  sleep: (p, o = {}) => {
    const basis = p.body < 60 || (p.drang ?? 10) < -40 || (p.halt ?? 80) < 40;
    if (!basis) return false;
    if ((o.phase || 'licht') === 'licht') {
      const nah = o.nah || [];
      return nah.includes('shade') || nah.includes('capsule');
    }
    return true;
  },
  look_earth: (p) => (p.halt ?? 80) < 60,
  inspect: () => true,
  dig: () => true,
  search_wrack: () => true,
  read_note: (p) => p.psyche < -15,
  check_stock: (p) => p.body < 65,
  tend_dome: (p) => p.body < 75 || p.psyche > 20,
  // Tag/Nacht (Erde-Tor): Notruf nur bei sichtbarer Erde — sonst gar nicht angeboten.
  // Kein Verbot durch Strafe, sondern durch Nicht-Angebot. Default: sichtbar (Tests
  // ohne Erde-Kontext laufen weiter — die Engine übergibt immer den echten Wert).
  call_bake: (p, o = {}) => (o.erde ?? true),   // die schlechte Option bleibt absichtlich wählbar
  streifen: () => true,    // ehrliche Alternative bei Langeweile: kostet Beine, bringt Neuigkeit
  sinnieren: () => true,   // freies Denken, jederzeit; Monotonie-Bremse fängt Spam
};

const RUHE = ['sit_shade', 'look_earth', 'sinnieren'];

function whitelistFor(pilot, opts = {}) {
  // opts: recentActions + Tag/Nacht (phase, erde, nah) — die Engine übergibt
  // echte Werte, Tests ohne Kontext bekommen Tag-Defaults (Licht, Erde sichtbar).
  const { recentActions = [], phase = 'licht', erde = true, nah = [] } = opts;
  const tagNacht = { phase, erde, nah };
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
    const gefiltert = list.filter((a) => !AVAIL[a] || AVAIL[a](pilot, tagNacht));
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

function nearbyObjects(pilot, entities, max = 5, lichtFaktor = 1) {
  return entities
    .map((e) => ({ ...e, ...ankerPos(e) }))   // Entfernungen zum sichtbaren Bauwerk, nicht zum Logikpunkt
    .map((e) => ({ ...e, dist: dist3(pilot, e) }))
    .map((e) => ({ ...e, stufe: sichtStufe(pilot, e, lichtFaktor) }))
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
    impuls = 'vorhaben', seit = true, vorhaben = null, weg = null, phase = 'licht', erde = true, finsternis = 0 } = ctx;

  // Tag/Nacht: Sicht stutzt mit dem Licht (Nacht halbiert), Erde-Zeile im Lage-Block.
  // Finsternis: Stufe 3 schrumpft die Sicht auf Nacht, Stufe 2 auf Dämmerung —
  // plus ein Satz im Lage-Block (Phase bleibt licht: die Sonne steht ja oben).
  const lichtFaktor = lichtFaktorAusPhase(phase, finsternis);
  const sichtbaren = nearbyObjects(pilot, entities, 5, lichtFaktor);
  const erdeZeile = erde ? 'Die Erde steht am Himmel.' : 'Die Erde ist untergegangen.';
  const finsternisSatz = [null,
    'Die Erde schiebt sich vor die Sonne.',
    'Die Sonne ist halb bedeckt.',
    'Finsternis — es ist dunkel am hellen Tag.'][finsternis] || null;
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
  // Paket A: Vorhaben + Weg — steht das Vorhaben, ist „ich muss etwas essen"
  // erledigt. Erzähl, was auf dem Weg passiert.
  const vorhabenZeile = vorhaben
    ? `\n${vorhaben}${weg ? `\n${weg} Steht das Vorhaben, ist der Satz „ich muss etwas essen" erledigt — erzähl, was auf dem Weg passiert.` : ''}`
    : '';

  return `Du bist ein rundliches Wesen im Raumanzug, gestrandet auf einem kleinen Mond. Du weißt nicht, was Prozentwerte sind, und sprichst nie in Zahlen.

Dein Wesen (unveränderlich):
${INSTINCTS.map((i) => `- ${i}`).join('\n')}

Körpergefühl: ${sensory(pilot)}
${vorrat ? `Vorratskontrolle vor ${vorrat.minuten} Minuten: dein Bauch reicht noch für etwa ${vorrat.stunden} Stunden.` : ''}${vorhabenZeile}

Was du über die Welt glaubst:
${beliefLine}

In deiner Nähe:
${nahBlock}
${erdeZeile}${finsternisSatz ? `\n${finsternisSatz}` : ''}

Wörter, die dir nicht aus dem Kopf gehen: ${wordLine}

Verfügbare Aktionen: ${JSON.stringify(whitelist)}

${impulsZeile}${seitZeile}
Schreibe 1–2 Sätze, höchstens 20 Wörter, Deutsch, höchstens ein Ausrufezeichen, keine Emojis, keine Zahlen.${musingBlock}

Antworte STRIKT in diesem JSON, nichts davor, nichts danach:
{"action": "eine der Aktionen", "thought": "dein Gedanke"${musing ? ', "musing": "dein freier Gedanke"' : ''}}`;
}

// Nacht-Anzeige für HUD und Prompt: Tag-Nummer global, Phase lokal.
// „Tag 3 · Nacht" = der Planet hat sich 3× gedreht, hier ist es Nacht.
function tagText(nr, phase) {
  const wort = phase === 'licht' ? 'Tag' : phase === 'nacht' ? 'Nacht' : 'Dämmerung';
  return `Tag ${nr} · ${wort}`;
}

// Hook für Paket D (nachdenken): Aktion nur anbieten, wenn Licht herrscht.
// Steht hier, damit D nur noch aufruft — kein D-Code in diesem Punkt.
function darfNachdenken(phase) {
  return (phase || 'licht') === 'licht';
}

module.exports = {
  INSTINCTS, OBJECT_HINTS, AVAIL, sensory, whitelistFor, tagText, darfNachdenken,
  nearbyObjects, buildPrompt, waehleMusingThema, impulsText, IMPULS_TEXTE, lichtFaktorAusPhase,
};

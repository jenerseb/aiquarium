// Prüft die Glaubenssatz-Formulierung gegen das echte Modell (1 Call).
const { open, q } = require('../src/db');
const { Engine } = require('../src/engine');

const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('kein Key'); process.exit(1); }

(async () => {
  const db = open(':memory:');
  const e = new Engine(db, { apiKey: key });
  const s0 = e.state();

  // dreimal im Schatten sitzen, obwohl ausgeruht -> Delta klar negativ
  for (let i = 0; i < 3; i += 1) {
    db.prepare("UPDATE pilots SET current_action='sit_shade', target_entity=NULL, " +
      'action_started_tick=NULL, sanity=50, sanity_at_start=NULL, energy=85 WHERE id=?').run(s0.pilot.id);
    for (let t = 0; t < 121; t += 1) e.tick();
  }
  // ein paar Gedanken als Stimmprobe
  for (const t of ['Der Rost knirscht unter meinen Füßen.', 'Ich zähle die Muttern im Schatten.']) {
    db.prepare('INSERT INTO thoughts (pilot_id, tick, text) VALUES (?,?,?)').run(s0.pilot.id, 900, t);
  }

  const vorher = db.prepare("SELECT * FROM pilot_mind WHERE action_key='sit_shade'").get();
  console.log('Messung:', { runs: vorher.times_borne_out, avg: vorher.avg_sanity_delta.toFixed(3), needs_text: vorher.needs_text });

  const texte = await e.phrasePendingBeliefs();
  const nachher = db.prepare("SELECT * FROM pilot_mind WHERE action_key='sit_shade'").get();
  console.log('Modell-Satz:', texte[0] || '(keiner)');
  console.log('gespeichert:', nachher.belief_text);
  console.log('Kosten:', (e.lastBrain && e.lastBrain.beliefCost) || 0);
  console.log('Feed:', db.prepare("SELECT payload_json FROM events WHERE type='belief'").all().map((r) => r.payload_json));
})();

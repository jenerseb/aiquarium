// Messung: welche Aktionen waehlt das Modell mit den neuen Wirkungen?
// 8 Entscheidungen mit unterschiedlichen Werten, je ein echter Call.
const { open, q } = require('../src/db');
const { Engine } = require('../src/engine');

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error('kein Key');
  process.exit(1);
}

const FAELLE = [
  ['ausgeruht & satt', { food: 85, energy: 85, sanity: 80 }],
  ['ausgeruht & satt', { food: 80, energy: 78, sanity: 70 }],
  ['hungrig', { food: 25, energy: 70, sanity: 70 }],
  ['muede', { food: 70, energy: 22, sanity: 60 }],
  ['erschoepft & hungrig', { food: 20, energy: 15, sanity: 55 }],
  ['nervoes', { food: 60, energy: 60, sanity: 35 }],
  ['ausgeruht & satt', { food: 90, energy: 90, sanity: 90 }],
  ['mittendrin', { food: 55, energy: 45, sanity: 50 }],
];

(async () => {
  const db = open(':memory:');
  const e = new Engine(db, { apiKey: key });
  const s0 = e.state();
  const zaehlung = {};
  let kosten = 0;

  for (const fall of FAELLE) {
    const name = fall[0];
    const w = fall[1];
    db.prepare('UPDATE pilots SET current_action=? , target_entity=NULL, action_started_tick=NULL, ' +
      'food=?, energy=?, sanity=?, sanity_at_start=NULL WHERE id=?')
      .run('idle', w.food, w.energy, w.sanity, s0.pilot.id);

    const wl = e.whitelist(e.state());
    const res = await e.decide();
    zaehlung[res.action] = (zaehlung[res.action] || 0) + 1;
    kosten += res.cost || 0;

    const werte = 'F' + w.food + ' K' + w.energy + ' N' + w.sanity;
    const tail = res.ok ? '' : '  [STALE: ' + res.reason + ']';
    console.log(name.padEnd(20) + ' ' + werte.padEnd(14) + ' Liste: ' + wl.join(','));
    console.log(' '.repeat(21) + '-> ' + res.action + '  "' + res.thought + '"' + tail);
  }

  console.log('\n=== Verteilung ===');
  console.log(zaehlung);
  console.log('Kosten: $' + kosten.toFixed(5) + ' fuer 8 Entscheidungen');
})();

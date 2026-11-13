'use strict';
// Glaubenssätze formuliert die Figur selbst. Die Engine liefert nur die Messung
// (Aktion, Anzahl, Richtung des Nerven-Deltas), den Satz schreibt das Modell.
// Fällt es aus, greift ein knapper Ersatzsatz — aber erst nach mehreren Versuchen.
const { wordCount, hasCJK, englishHits } = require('./checks');
const { MODEL } = require('./config');

const FALLBACK = {
  sit_shade: { pos: 'Im Schatten zu sitzen beruhigt mich', neg: 'Sitzen im Schatten, wenn ich wach bin, macht mich kribbelig' },
  sleep: { pos: 'Schlaf nimmt mir die Schwere aus den Beinen', neg: 'Schlafen, wenn ich hellwach bin, hilft nicht' },
  eat: { pos: 'Fressen beruhigt meinen Magen und meinen Kopf', neg: 'Fressen, wenn ich satt bin, macht mich träge' },
  inspect: { pos: 'Das Wrack anzusehen beruhigt mich', neg: 'Das Wrack anzusehen macht mich unruhig' },
  search_wrack: { pos: 'Im Wrack zu wühlen beruhigt mich', neg: 'Im Wrack zu wühlen macht mich unruhig' },
  read_note: { pos: 'Den Zettel zu lesen beruhigt mich', neg: 'Den Zettel zu lesen wühlt mich auf' },
  check_stock: { pos: 'Zu wissen, was ich noch habe, beruhigt mich', neg: 'Nachzuzählen macht mich nervös' },
  tend_dome: { pos: 'Beete zu pflegen erdet mich', neg: 'Beete zu pflegen zehrt an mir' },
  call_bake: { pos: 'Einen Notruf zu senden erleichtert mich', neg: 'Ins Rauschen zu rufen macht mich hoffnungslos' },
  streifen: { pos: 'Umherzustreifen lüftet mir den Kopf', neg: 'Zielloses Laufen macht mich kribbelig' },
  sinnieren: { pos: 'Nachdenken ordnet meine Gedanken', neg: 'Grübeln zieht mich runter' },
  dig: { pos: 'Graben tut mir gut', neg: 'Graben zehrt an mir' },
  look_earth: { pos: 'Zur Erde zu schauen beruhigt mich', neg: 'Zur Erde zu schauen macht mich sehnsüchtig' },
  run_wild: { pos: 'Rennen macht den Kopf leer', neg: 'Rennen macht alles schlimmer' },
};

const HANDLUNG = {
  sit_shade: 'im Schatten sitzen',
  sleep: 'schlafen',
  eat: 'fressen',
  inspect: 'das Wrack ansehen',
  search_wrack: 'im Wrack wühlen',
  read_note: 'den Zettel lesen',
  check_stock: 'den Vorrat prüfen',
  tend_dome: 'das Beet pflegen',
  call_bake: 'einen Notruf senden',
  streifen: 'umherstreifen',
  sinnieren: 'nachdenken',
  dig: 'graben',
  look_earth: 'zur Erde schauen',
  run_wild: 'rennen',
};

function fallbackText(action, positive) {
  const t = FALLBACK[action];
  if (!t) return '';
  return `${positive ? t.pos : t.neg}`;
}

/**
 * Fragt das Modell nach einem Satz. Gibt { text, ok, raw, cost } zurück.
 * Kein Wurf: bei Problemen kommt ok:false und die Engine entscheidet über den Ersatzsatz.
 */
async function phraseBelief(opts) {
  const { action, runs, avgDelta, recentThoughts = [], apiKey, baseUrl, model, timeline, timeoutMs } = opts;
  if (!apiKey) return { ok: false, reason: 'no_key' };

  const besser = avgDelta > 0;
  const prompt = `Du bist ein rundliches Wesen im Raumanzug auf einem kleinen Mond. Du sprichst nie in Zahlen.

Du hast gerade bemerkt: Wenn du ${HANDLUNG[action] || action}, geht es dir danach ${besser ? 'besser' : 'schlechter'}. Du hast es ${runs} Mal erlebt.

Deine letzten Gedanken waren:
${recentThoughts.slice(0, 3).map((t) => `- ${t}`).join('\n') || '- noch keine'}

Formuliere daraus EINEN Glaubenssatz in deiner Stimme: kurz, konkret, höchstens 12 Wörter, Deutsch.
Keine Zahlen, keine Emojis, kein Ausrufezeichen. Es soll klingen wie eine eigene Erfahrung, nicht wie eine Regel.

Antworte STRIKT in diesem JSON, nichts davor, nichts danach:
{"belief": "dein Satz"}`;

  try {
    const res = await fetch(baseUrl || MODEL.baseUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || MODEL.name,
        temperature: 0.8,
        max_tokens: 120,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs || MODEL.timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content ?? '';
    const usage = data?.usage || {};
    const cost = (usage.prompt_tokens || 0) * 0.08e-6 + (usage.completion_tokens || 0) * 0.10e-6;
    let text = '';
    try { text = String(JSON.parse(raw).belief || '').trim(); } catch { return { ok: false, reason: 'json', raw }; }

    if (!text || wordCount(text) > 12) return { ok: false, reason: 'words', raw, text };
    if (hasCJK(text)) return { ok: false, reason: 'cjk', raw, text };
    if (englishHits(text).length) return { ok: false, reason: 'english', raw, text };
    if (/\d/.test(text)) return { ok: false, reason: 'numbers', raw, text };
    if (/\p{Extended_Pictographic}/u.test(text)) return { ok: false, reason: 'emoji', raw, text };

    return { ok: true, text, raw, cost };
  } catch (err) {
    return { ok: false, reason: `request: ${err.message}` };
  }
}

module.exports = { phraseBelief, fallbackText, FALLBACK, HANDLUNG };

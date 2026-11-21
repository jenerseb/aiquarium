'use strict';
// 404-Verifikation: prüft JEDE URL, die index.html / scene.js anfordern.
// Der Server muss BEREITS laufen (z. B. `PORT=3079 npm start` in 2. Shell).
// Aufruf: node scripts/test-m3-urls.js [port]   (Default 3077)

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const PORT = Number(process.argv[2]) || 3077;

// curl statt fetch: funktioniert in dieser Umgebung zuverlässig (kein Hängen)
// Trennzeichen „|||STATUS “ am Ende (kein \n-Parsing nötig). stderr wird
// mitgelesen, damit curl-Fehler sichtbar sind statt „Command failed“.
function hole(pfad, methode, maxZeit) {
  const args = ['-sS', '--max-time', maxZeit || '10', '-w', '|||STATUS %{http_code} %{content_type}', '-X', methode || 'GET', `http://127.0.0.1:${PORT}${pfad}`];
  let out;
  try {
    out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    out = (e.stdout || '') + '\n[CURL-STDERR] ' + (e.stderr || e.message);
  }
  const m = out.match(/\|\|\|STATUS (\d{3}) ([^\n]*)\s*$/);
  const status = m ? Number(m[1]) : 0;
  const typ = m ? m[2].trim() : '';
  const text = m ? out.slice(0, m.index) : out;
  return { status, typ, text };
}

async function main() {
  // 1) Frontend-URLs: explizit + per einfacher Suche (kein Monster-Regex)
  const dir = path.join(__dirname, '..', 'public');
  const index = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const szene = fs.readFileSync(path.join(dir, 'scene.js'), 'utf8');
  const gefunden = new Set();
  for (const u of ['/scene.js', '/engine/three.module.js', '/api/map', '/api/state', '/api/stream', '/api/brain', '/api/dev/tick', '/api/dev/nightly']) {
    if (index.includes(u) || szene.includes(u)) gefunden.add(u);
  }
  const urls = [...gefunden, '/favicon.ico', '/kiez-map.json', '/kiez_map.json', '/'];
  console.log('[urls] geprüft: ' + urls.join(', '));

  // 2) Jede URL laden (Server läuft bereits)
  // Hinweis: /api/stream ist ein Endlos-Stream → nur Header prüfen (Schritt 3).
  // /api/dev/* akzeptiert nur POST → GET-404 ist korrekt, geprüft wird per POST (Schritt 3).
  const nurPost = new Set(['/api/dev/tick', '/api/dev/nightly', '/api/stream']);
  const fehler = [];
  for (const u of urls) {
    if (nurPost.has(u)) {
      console.log(`[urls] ${u} -> (nur POST/SSE, siehe unten)`);
      continue;
    }
    let r;
    try {
      r = await hole(u);
    } catch (err) {
      console.log(`[urls] ${u} -> FEHLER (${err.message})`);
      fehler.push(`${u}: ${err.message}`);
      continue;
    }
    const erwartet = u === '/favicon.ico' ? 204 : 200;
    const ok = r.status === erwartet;
    console.log(`[urls] ${u} -> ${r.status} (${r.typ || 'kein-typ'}, ${r.text.length} zeichen)${ok ? '' : ' FEHLER!'}`);
    if (!ok) { fehler.push(`${u}: ${r.status} statt ${erwartet}`); continue; }
    if (u === '/api/map') {
      const j = JSON.parse(r.text);
      const erwartet = require('../src/db').SEED_POIS.length;
      assert.ok(j.buildings.length > 100 && j.pois.length === erwartet, '/api/map unvollständig');
    }
    if (u === '/api/state') {
      const j = JSON.parse(r.text);
      assert.ok(j.charakter && j.pois, '/api/state unvollständig');
    }
  }
  // 3) SSE (nur Header, kein Body – Stream ist endlos; curl-Timeout ist ERWARTET,
  //     weil der Server den Stream offen hält. Entscheidend: Header kamen an.)
  try {
    const args = ['-s', '--max-time', '3', '-D', '-', '-o', '/dev/null', `http://127.0.0.1:${PORT}/api/stream`];
    let out = '';
    try {
      out = execFileSync('curl', args, { encoding: 'utf8' });
    } catch (e) {
      out = (e.stdout || '') + (e.stderr || '');
    }
    const ok = out.includes('200') && out.includes('text/event-stream');
    console.log(`[urls] /api/stream -> ${ok ? '200 text/event-stream' : 'FEHLER'}`);
    if (!ok) fehler.push('/api/stream: kein event-stream. Header: ' + String(out).slice(0, 200));
  } catch (err) {
    fehler.push('/api/stream: ' + err.message);
  }
  // Dev-Ticks: nightly wartet LLM-Timeouts ab (~6 s ohne Key) → großzügiges Limit
  const devLimit = { '/api/dev/tick': '15', '/api/dev/nightly': '60' };
  for (const dev of ['/api/dev/tick', '/api/dev/nightly']) {
    try {
      const tick = hole(dev, 'POST', devLimit[dev]);
      console.log(`[urls] POST ${dev} -> ${tick.status}`);
      if (tick.status !== 200) fehler.push('POST ' + dev + ': ' + tick.status);
    } catch (err) {
      fehler.push('POST ' + dev + ': ' + err.message);
    }
  }
  assert.strictEqual(fehler.length, 0, 'fehler: ' + fehler.join(' | '));
  console.log('[urls] ALLES OK – kein 404, favicon 204');
}

main().catch((err) => { console.error('[urls] FEHLER:', err.message); process.exit(1); });


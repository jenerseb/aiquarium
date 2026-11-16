'use strict';
// Meilenstein-3-Check: Server starten, alle M3-Endpunkte + Dateien prüfen.
// Aufruf: node scripts/test-m3.js [port]
// Erwartet: 200 für index, scene.js, three, /api/map, /api/state, /api/brain, SSE.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.argv[2]) || 3098;
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aiq-m3-')), 'world.sqlite');

function start() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(PORT), AIQUARIUM_DB: DB, OPENROUTER_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bereit = false;
    const timer = setTimeout(() => { if (!bereit) { p.kill(); reject(new Error('server startet nicht')); } }, 15000);
    p.stdout.on('data', (d) => { if (String(d).includes('http://localhost:' + PORT)) { bereit = true; clearTimeout(timer); resolve(p); } });
    p.stderr.on('data', () => {});
    p.on('exit', () => { if (!bereit) { clearTimeout(timer); reject(new Error('server sofort beendet')); } });
  });
}

async function hole(pfad, text) {
  const r = await fetch(`http://127.0.0.1:${PORT}${pfad}`);
  if (!r.ok) throw new Error(`${pfad}: HTTP ${r.status}`);
  return text ? r.text() : r.json();
}

async function main() {
  console.log('[m3] db:', DB, '| port:', PORT);
  const server = await start();
  try {
    const index = await hole('/', true);
    if (!index.includes('/scene.js')) throw new Error('index bindet scene.js nicht ein');
    if (!index.includes('id="gehirn"')) throw new Error('index ohne gehirn-modal');
    if (!index.includes('id="blase"')) throw new Error('index ohne gedankenblase');
    console.log('[m3] index ok (' + index.length + ' zeichen)');

    const szene = await hole('/scene.js', true);
    for (const stich of ['ExtrudeGeometry', 'pilotPose', 'overPose', 'smootherstep', 'EventSource', '/api/map', '/api/brain']) {
      if (!szene.includes(stich)) throw new Error('scene.js ohne ' + stich);
    }
    console.log('[m3] scene.js ok (' + szene.length + ' zeichen, extrude+kamera+sse drin)');

    const three = await hole('/engine/three.module.js', true);
    if (three.length < 100000) throw new Error('three.module.js zu klein: ' + three.length);
    console.log('[m3] three ok (' + three.length + ' zeichen, lokal, kein cdn)');

    const karte = await hole('/api/map');
    for (const k of ['buildings', 'streets', 'parks', 'pois', 'meta']) {
      if (!(k in karte)) throw new Error('/api/map ohne ' + k);
    }
    if (karte.buildings.length < 100) throw new Error('zu wenige gebaeude: ' + karte.buildings.length);
    if (karte.pois.length !== 17) throw new Error('pois != 17: ' + karte.pois.length);
    console.log('[m3] /api/map ok (' + karte.buildings.length + ' gebaeude, ' + karte.streets.length + ' strassen, ' + karte.pois.length + ' pois)');

    const staat = await hole('/api/state');
    for (const k of ['charakter', 'pois', 'plan', 'feed', 'world', 'zeit']) {
      if (!(k in staat)) throw new Error('/api/state ohne ' + k);
    }
    console.log('[m3] /api/state ok (charakter ' + staat.charakter.name + ' @' + staat.charakter.inside_poi + ')');

    const gehirn = await hole('/api/brain');
    for (const k of ['sheet', 'loops', 'works', 'fame', 'summaries', 'memories', 'buecher']) {
      if (!(k in gehirn)) throw new Error('/api/brain ohne ' + k);
    }
    if (!gehirn.memories.firstToGoShort && gehirn.memories.short.length > 0) throw new Error('firstToGo fehlt');
    console.log('[m3] /api/brain ok (sheet ' + gehirn.sheet.length + ', tabs abgedeckt)');

    const sse = await fetch(`http://127.0.0.1:${PORT}/api/stream`);
    if (!sse.ok || !(sse.headers.get('content-type') || '').includes('text/event-stream')) {
      throw new Error('sse kein event-stream');
    }
    await sse.body.cancel();
    console.log('[m3] /api/stream ok (event-stream)');

    console.log('[m3] ALLES OK');
  } finally {
    server.kill();
  }
}

main().catch((err) => { console.error('[m3] FEHLER:', err.message); process.exit(1); });

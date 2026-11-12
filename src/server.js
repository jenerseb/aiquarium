'use strict';
// Die .env zuerst laden: config.js liest Variablen schon beim Import aus.
const envInfo = require('./env').load();
if (envInfo.geladen) {
  console.log(`[env] ${envInfo.datei} geladen (${envInfo.keys.length} gesetzt)`
    + (envInfo.fehlend.length ? `, leer: ${envInfo.fehlend.join(', ')}` : ''));
} else {
  console.log('[env] keine .env gefunden — Variablen müssen aus der Umgebung kommen');
}

// HTTP: statische Oberfläche, JSON-API, SSE-Strom. Die Schleife ist sequenziell,
// damit sich Ticks und Modellaufrufe nie überlappen.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open, logEvent } = require('./db');
const { Engine } = require('./engine');
const { TICK_MS } = require('./config');
const PORT = Number(process.env.PORT || 3077);
// Dev-Zeitraffer: wie viele Simulationssekunden pro echter Sekunde laufen
let speed = Math.max(1, Math.min(20, Number(process.env.AIQUARIUM_SPEED || 1) || 1));
const IST_LOKAL = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
// Die Datenbank liegt bewusst AUSSERHALB des Projektordners: der Ordner wird über
// Syncthing gespiegelt, und eine lebende SQLite-Datei (mit WAL) im Sync-Ordner
// führt zu Konflikten und beschädigten Datenbanken.
const DB_FILE = process.env.AIQUARIUM_DB
  || path.join(require('node:os').homedir(), '.local', 'share', 'aiquarium', 'world.sqlite');

const db = open(DB_FILE);
const engine = new Engine(db);

const clients = new Set();
function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch { clients.delete(res); }
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.glb': 'model/gltf-binary', '.png': 'image/png',
  '.svg': 'image/svg+xml' };

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Snapshot darf den Server nie mitreißen: Fehler als 500-JSON, statische
// Dateien (Szene) laden trotzdem — dann steht „verbinde …" statt Schwarz.
function snapshotSicher() {
  try {
    return { ok: true, snap: engine.snapshot() };
  } catch (err) {
    console.error('[api] snapshot kaputt:', err && err.message);
    return { ok: false, fehler: String((err && err.message) || err) };
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/state') {
    const r = snapshotSicher();
    return r.ok ? sendJson(res, 200, { ...r.snap, speed }) : sendJson(res, 500, r);
  }

  if (url.pathname === '/api/feed') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
    const r = snapshotSicher();
    return r.ok ? sendJson(res, 200, { feed: r.snap.feed.slice(0, limit) }) : sendJson(res, 500, r);
  }

  // Dev: Zeitfaktor und Werte setzen — nur von localhost, jede Änderung wird protokolliert
  if (url.pathname.startsWith('/api/dev/')) {
    if (!IST_LOKAL(req)) return sendJson(res, 403, { error: 'dev nur von localhost' });

    if (url.pathname === '/api/dev/speed') {
      const x = Number(url.searchParams.get('x') || 1);
      speed = Math.max(1, Math.min(20, Number.isFinite(x) ? x : 1));
      console.log(`[dev] Zeitfaktor ×${speed}`);
      return sendJson(res, 200, { speed });
    }

    if (url.pathname === '/api/dev/set') {
      const s = engine.state();
      const felder = ['hunger', 'exhaustion', 'stress'];
      const aenderung = {};
      for (const f of felder) {
        const v = url.searchParams.get(f);
        if (v === null) continue;
        const zahl = Math.max(0, Math.min(100, Number(v)));
        if (!Number.isFinite(zahl)) continue;
        aenderung[f] = zahl;
      }
      if (!Object.keys(aenderung).length) return sendJson(res, 400, { error: 'keine Werte' });
      const set = Object.keys(aenderung).map((f) => `${f}=?`).join(', ');
      db.prepare(`UPDATE pilots SET ${set} WHERE id=?`).run(...Object.values(aenderung), s.pilot.id);
      logEvent(db, s.world.world_tick, 'dev_set', aenderung, false);
      return sendJson(res, 200, { gesetzt: aenderung, pilot: engine.snapshot().pilot });
    }

    return sendJson(res, 404, { error: 'unbekannt' });
  }

  // Debug-Log: alles außer reinem Tick-Rauschen, aufsteigend ab `since`
  if (url.pathname === '/api/debug') {
    const since = Number(url.searchParams.get('since') || 0);
    const limit = Math.min(Number(url.searchParams.get('limit') || 200), 500);
    const rows = db.prepare(`SELECT id, tick, type, payload_json, in_feed FROM events
      WHERE id > ? AND type NOT IN ('tick')
      ORDER BY id ASC LIMIT ?`).all(since, limit);
    return sendJson(res, 200, { events: rows, last: rows.length ? rows[rows.length - 1].id : since });
  }

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    const r = snapshotSicher();
    if (r.ok) res.write(`data: ${JSON.stringify(r.snap)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return undefined;
  }

  // statisch
  const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const safe = path.normalize(path.join(PUBLIC, file));
  if (!safe.startsWith(PUBLIC)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(safe, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('nicht gefunden');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(safe)] || 'application/octet-stream' });
    return res.end(buf);
  });
  return undefined;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ereignisse, die im Feed sofort erscheinen müssen (nicht erst im Minutentakt)
const FEED_TYPES = new Set(['thought', 'death', 'spawn', 'discovery', 'mind', 'belief']);

function broadcastState() {
  const r = snapshotSicher();
  if (r.ok) broadcast({ ...engine.statePayload(), speed });
}

function broadcastFeed() {
  const r = snapshotSicher();
  if (r.ok) broadcast({ kind: 'feed', feed: r.snap.feed, beliefs: r.snap.beliefs });
}

let running = true;

async function loop() {
  const cu = engine.catchup();
  if (cu.missed) {
    console.log(`[catchup] ${Math.round(cu.missed / 60)} min nachsimuliert, Tode: ${cu.deaths}, Neustarts: ${cu.spawned}`);
  }
  if (cu.skew) console.warn(`[clock] Uhr stand ${cu.skew}s in der Zukunft — korrigiert`);

  // Feste Zeitachse: der Tick läuft an der Wanduhr, nicht an der Zählung der Schleife.
  // Damit verliert ein 1,3-s-Modellaufruf keine Simulationszeit mehr.
  let next = Date.now() + TICK_MS;
  while (running) {
    const now = Date.now();
    let steps = 0;
    let last = null;
    let feedChanged = false;

    while (next <= now && steps < 60 * speed) {
      // Zeitraffer: mehrere Simulationsschritte pro echter Sekunde
      for (let k = 0; k < speed; k += 1) {
        last = engine.tick();
        steps += 1;
        if (last.needDecide) break;
      }
      next += TICK_MS;
      if (last.events.some((e) => FEED_TYPES.has(e.type))) feedChanged = true;
      if (last.needDecide) break;          // erst entscheiden lassen, dann weiterrechnen
    }

    if (steps) {
      broadcastState();
      if (feedChanged) broadcastFeed();
    }

    if (last && last.needDecide) {
      const d = await engine.decide();
      if (d && !d.ok) console.warn(`[brain] stale: ${d.reason || d.failures}`);
      // Der Gedanke entsteht im Entscheidungsaufruf, nicht im Tick — deshalb hier Feed nachlegen
      if (d) broadcastFeed();
      broadcastState();
    }

    // Fällige Glaubenssätze nebenbei formulieren lassen (nur wenn es welche gibt)
    const neue = await engine.phrasePendingBeliefs();
    if (neue.length) broadcastFeed();

    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
  }
}

server.listen(PORT, () => {
  console.log(`AIquarium läuft auf http://127.0.0.1:${PORT} (DB: ${DB_FILE})`);
  loop().catch((e) => { console.error('Schleife gestorben:', e); process.exit(1); });
});

function shutdown() {
  running = false;
  for (const c of clients) { try { c.end(); } catch { /* egal */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

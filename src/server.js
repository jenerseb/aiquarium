'use strict';
// HTTP/SSE-API (§8 + M2): /api/state, /api/stream (SSE), /api/brain,
// /api/dev/* (nur localhost), statische Dateien aus public/.
// Keine npm-Abhängigkeiten: node:http + node:fs + node:path.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./env');

load();

const dbMod = require('./db');
const engine = require('./engine');
const promptMod = require('./prompt');
const arbiter = require('./arbiter');
const telegram = require('./telegram');
const { istNacht } = require('./engine');

const PORT = Number(process.env.PORT) || 3077;

let ZUSTAND = null; // { db, dbPfad, characterId, karte, sseClients:Set, letzterTick }

function initZustand(dbPfad) {
  const karte = dbMod.ladeKiezKarte();
  const { db, characterId } = dbMod.init(dbPfad, karte);
  ZUSTAND = { db, dbPfad, characterId, karte, sseClients: new Set(), letzterTick: 0 };
  return ZUSTAND;
}

function json(res, code, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function istLocalhost(req) {
  const host = String(req.socket.remoteAddress || '');
  return host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1';
}


// --- API-Helfer --------------------------------------------------------------------

function apiState() {
  const { db, characterId } = ZUSTAND;
  const ch = engine.ladeCharakter(db, characterId);
  const feed = db.prepare('SELECT id, type, payload_json, created_at FROM events WHERE character_id = ? ORDER BY id DESC LIMIT 30').all(characterId);
  const ws = db.prepare('SELECT tick, last_nightly_date, weather, temperature_c FROM world_state WHERE id = 1').get();
  const pois = db.prepare('SELECT id, name, category, pos_x, pos_z, discovered FROM pois ORDER BY id').all();
  let plan = [];
  try { plan = JSON.parse(ch.plan_queue_json || '[]'); } catch { plan = []; }
  // Aktive Route fürs Frontend (Punkt 1): Waypoints + Fortschritt + Zielpos
  let route = null;
  try {
    const meta = engine.ladeRoute(ch);
    if (meta && Array.isArray(meta.route) && meta.route.length > 0) {
      const idx = Math.min(meta.wegIndex || 0, Math.max(0, meta.route.length - 1));
      route = {
        waypoints: meta.route,
        wegIndex: meta.wegIndex || 0,
        restM: meta.restM || 0,
        zielPoi: meta.zielPoi || null,
        target_pos: meta.route[Math.min(idx + 1, meta.route.length - 1)],
      };
    }
  } catch { route = null; }
  return { charakter: ch, feed, world: ws, pois, plan, route, zeit: { berlin: new Date().toISOString(), nacht: istNacht(Date.now()) } };
}

// GET /api/map: statische Kiez-Geometrie (buildings, streets, parks, pois + meta).
// Parks: kiez_map.json hat keine parks-Key – wir leiten Grünflächen aus
// park-POIs + Umkreis ab (MVP), echte OSM-leisure-Polygone wären Phase 2.
function apiMap() {
  const karte = (ZUSTAND && ZUSTAND.karte) || dbMod.ladeKiezKarte() || { buildings: [], streets: [] };
  const pois = dbMod && ZUSTAND ? ZUSTAND.db.prepare('SELECT id, name, category, pos_x, pos_z, discovered FROM pois ORDER BY id').all() : [];
  const parks = (karte.parks && Array.isArray(karte.parks)) ? karte.parks : pois
    .filter((p) => p.category === 'park')
    .map((p) => ({ id: 'park_' + p.id, name: p.name, kreis: { x: Number(p.pos_x), z: Number(p.pos_z), r: 18 } }));
  return {
    meta: karte.meta || null,
    buildings: karte.buildings || [],
    streets: karte.streets || [],
    parks,
    pois,
  };
}

function apiBrain() {
  const { db, characterId } = ZUSTAND;
  const mem = require('./memory');
  const alle = mem.ladeMemories(db, characterId);
  const jetzt = Date.now();
  const mitWorth = alle.map((m) => ({ ...m, worth: mem.berechneWorth(m, jetzt) }));
  const kurz = mitWorth.filter((m) => m.tier === 'short').sort((a, b) => b.worth - a.worth);
  const langzeit = mitWorth.filter((m) => m.tier === 'long').sort((a, b) => b.worth - a.worth);
  const sheet = db.prepare('SELECT * FROM character_sheet WHERE character_id = ? AND active = 1 ORDER BY category, id').all(characterId);
  const loops = db.prepare("SELECT * FROM open_loops WHERE character_id = ? AND status = 'open' ORDER BY urgency DESC").all(characterId);
  const works = db.prepare('SELECT * FROM work_pieces WHERE character_id = ?').all(characterId);
  const fame = db.prepare('SELECT * FROM hall_of_fame ORDER BY id DESC LIMIT 10').all();
  const summ = db.prepare('SELECT * FROM day_summaries WHERE character_id = ? ORDER BY date_str DESC LIMIT 7').all(characterId);
  let buecher = [];
  try {
    buecher = db.prepare('SELECT id, title, kind, entries_json FROM books').all().map((b) => {
      let n = 0;
      try { n = JSON.parse(b.entries_json).length; } catch { n = 0; }
      return { id: b.id, title: b.title, kind: b.kind, eintraege: n };
    });
  } catch { buecher = []; }
  return {
    sheet, loops, works, fame, summaries: summ,
    memories: {
      short: kurz, long: langzeit,
      firstToGoShort: kurz.length > 0 ? kurz[kurz.length - 1] : null,
      firstToGoLong: langzeit.length > 0 ? langzeit[langzeit.length - 1] : null,
    },
    buecher,
  };
}

function sendeSSE(ereignis) {
  const text = `data: ${JSON.stringify(ereignis)}\n\n`;
  for (const res of ZUSTAND.sseClients) {
    try { res.write(text); } catch { /* client weg */ }
  }
}

// --- Tick-Loop (alle 20 s ein Plan-Schritt) --------------------------------------------

let tickLaeuft = false;

async function loopTick() {
  if (tickLaeuft || !ZUSTAND) return;
  tickLaeuft = true;
  try {
    const { db, characterId, karte } = ZUSTAND;
    const brain = require('./brain');
    const res = await engine.tick(db, { karte, brain, telegram, nightly: true }, characterId, Date.now());
    if (res && res.ok) {
      sendeSSE({ typ: 'tick', schritt: res.schritt, notizen: res.notizen, gedanke: res.gedanke || '', quelle: res.quelle || null, route: res.route || null });
    }
  } catch (err) {
    console.log('[tick:fehler] ' + err.message);
  } finally {
    tickLaeuft = false;
  }
}

// --- HTTP-Server ------------------------------------------------------------------------

function statischeDatei(reqUrl, res) {
  const pubDir = path.join(__dirname, '..', 'public');
  let rel = decodeURIComponent(String(reqUrl).split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const datei = path.normalize(path.join(pubDir, rel));
  if (!datei.startsWith(pubDir) || !fs.existsSync(datei) || fs.statSync(datei).isDirectory()) return false;
  const ext = path.extname(datei).toLowerCase();
  const typen = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const kopf = { 'Content-Type': typen[ext] || 'application/octet-stream' };
  // Dev-Komfort: HTML/JS nie aus dem Browser-Cache (harter Reload nicht nötig)
  if (ext === '.html' || ext === '.js') kopf['Cache-Control'] = 'no-store';
  res.writeHead(200, kopf);
  fs.createReadStream(datei).pipe(res);
  return true;
}

function erstelleServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, apiState());
      if (url.pathname === '/api/brain' && req.method === 'GET') return json(res, 200, apiBrain());
      if ((url.pathname === '/api/map' || url.pathname === '/kiez-map.json' || url.pathname === '/kiez_map.json') && req.method === 'GET') return json(res, 200, apiMap());
      if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (url.pathname === '/api/stream' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(': verbunden\n\n');
        ZUSTAND.sseClients.add(res);
        req.on('close', () => ZUSTAND.sseClients.delete(res));
        return;
      }
      if (url.pathname === '/api/decide' && req.method === 'POST') {
        if (!istLocalhost(req)) return json(res, 403, { ok: false, grund: 'nur_localhost' });
        await loopTick();
        return json(res, 200, { ok: true, state: apiState() });
      }
      if (url.pathname === '/api/dev/tick' && req.method === 'POST') {
        if (!istLocalhost(req)) return json(res, 403, { ok: false, grund: 'nur_localhost' });
        await loopTick();
        return json(res, 200, { ok: true, state: apiState() });
      }
      if (url.pathname === '/api/dev/nightly' && req.method === 'POST') {
        if (!istLocalhost(req)) return json(res, 403, { ok: false, grund: 'nur_localhost' });
        const { db, characterId } = ZUSTAND;
        const brain = require('./brain');
        const r = await arbiter.runNightlyConsolidation(db, brain, characterId, 'manueller dev-aufruf', Date.now());
        return json(res, 200, r);
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { ok: false, grund: 'unbekannt' });
      if (statischeDatei(url.pathname, res)) return;
      return json(res, 404, { ok: false, grund: 'nicht_gefunden' });
    } catch (err) {
      return json(res, 500, { ok: false, grund: err.message });
    }
  });
}

if (require.main === module) {
  const cfg = require('./config');
  initZustand(cfg.DB.defaultPfad);
  const server = erstelleServer();
  server.listen(PORT, () => console.log(`[server] http://localhost:${PORT} (db: ${ZUSTAND.dbPfad})`));
  setInterval(loopTick, 20000);
}

module.exports = { initZustand, erstelleServer, apiState, apiBrain, apiMap, loopTick, sendeSSE };


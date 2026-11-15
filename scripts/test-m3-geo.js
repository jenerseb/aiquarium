'use strict';
// Koordinaten-Check (M3-Fix): Gebäude stehen exakt auf y = 0 (kein Schweben),
// kein Spiegeln (shapeY = -worldZ), POI-Marker decken Gebäude-Mittelpunkte.
// Reine Mathe-Nachbildung der Three.js-Kette (ohne three-Import, headless):
//   shape(x, -z) + extrude(0..h) + rotateX(-90°)  =>  welt(x, 0..h, z).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const dbMod = require('../src/db');

// rotateX(-90°): (x, y, z) -> (x, z, -y). Für Extrude-Punkte:
// shape-Punkt (sx, sy) mit Tiefe t wird zu (sx, sy, t) und danach zu (sx, t, -sy).
// Mit Pflicht-Mapping sx = wx, sy = -wz ergibt das (wx, t, wz) mit t in 0..h. QED.
function extrudeRotiert(fp, h) {
  const welt = [];
  for (const [wx, wz] of fp) {
    const sx = wx;
    const sy = -wz;
    welt.push([sx, 0, -sy]); // t = 0 (Unterkante)
    welt.push([sx, h, -sy]); // t = h (Oberkante)
  }
  return welt;
}

function bbox(punkte) {
  const xs = punkte.map((p) => p[0]);
  const ys = punkte.map((p) => p[1]);
  const zs = punkte.map((p) => p[2]);
  return { min: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) },
           max: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) } };
}

function main() {
  const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aiq-m3geo-')), 'world.sqlite');
  const karte = dbMod.ladeKiezKarte();
  assert.ok(karte && karte.buildings.length > 100, 'karte mit gebaeuden erwartet');
  const { db } = dbMod.init(tmpDb, karte);

  // --- 1) Alle Gebäude: min.y = 0, max.y = height, Ecken exakt (kein Spiegel) ---
  // Hinweis: AABB-Mitte != Polygon-Schwerpunkt bei schrägen Footprints –
  // geprüft wird Ecken-Treue: jede (x, z)-Ecke steht exakt in der rotierten Box.
  const abweichungen = [];
  for (const b of karte.buildings) {
    const fp = b.footprint;
    if (!Array.isArray(fp) || fp.length < 3) continue;
    const h = Math.max(3, Math.min(30, Number(b.height) || 12));
    const bb = bbox(extrudeRotiert(fp, h));
    if (Math.abs(bb.min.y) > 0.0001) abweichungen.push(`${b.id}: min.y=${bb.min.y}`);
    if (Math.abs(bb.max.y - h) > 0.0001) abweichungen.push(`${b.id}: max.y=${bb.max.y} vs h=${h}`);
    // Ecken: min/max in x und z müssen exakt den Footprint-Extremen entsprechen
    const fxs = fp.map(([x]) => x);
    const fzs = fp.map(([, z]) => z);
    if (Math.abs(bb.min.x - Math.min(...fxs)) > 0.05) abweichungen.push(`${b.id}: min.x ${bb.min.x} vs ${Math.min(...fxs)}`);
    if (Math.abs(bb.max.x - Math.max(...fxs)) > 0.05) abweichungen.push(`${b.id}: max.x ${bb.max.x} vs ${Math.max(...fxs)}`);
    if (Math.abs(bb.min.z - Math.min(...fzs)) > 0.05) abweichungen.push(`${b.id}: min.z ${bb.min.z} vs ${Math.min(...fzs)}`);
    if (Math.abs(bb.max.z - Math.max(...fzs)) > 0.05) abweichungen.push(`${b.id}: max.z ${bb.max.z} vs ${Math.max(...fzs)}`);
    if (abweichungen.length > 10) break;
  }
  assert.strictEqual(abweichungen.length, 0, 'bbox-abweichungen: ' + abweichungen.slice(0, 5).join(' | '));
  console.log(`[m3geo] ${karte.buildings.length} gebäude: min.y=0, max.y=height, ecken exakt (kein spiegel, kein schweben)`);

  // --- 2) POI-Deckung: otzentreff + apartment vs. nächstes Gebäude ---
  const pois = db.prepare('SELECT id, pos_x, pos_z FROM pois').all();
  for (const zielId of ['otzentreff', 'apartment']) {
    const poi = pois.find((p) => p.id === zielId);
    assert.ok(poi, 'poi fehlt: ' + zielId);
    let bestD = Infinity;
    let bestId = null;
    for (const b of karte.buildings) {
      if (!Array.isArray(b.footprint) || b.footprint.length < 3) continue;
      let sx = 0;
      let sz = 0;
      for (const [x, z] of b.footprint) { sx += x; sz += z; }
      const d = Math.hypot(sx / b.footprint.length - Number(poi.pos_x), sz / b.footprint.length - Number(poi.pos_z));
      if (d < bestD) { bestD = d; bestId = b.id; }
    }
    console.log(`[m3geo] ${zielId} @(${poi.pos_x},${poi.pos_z}): naechstes gebaeude ${bestId} ${bestD.toFixed(1)} m`);
    assert.ok(bestD < 60, `${zielId}: kein gebaeude in der naehe (${bestD.toFixed(1)} m)`);
  }

  // --- 3) scene.js enthält das Pflicht-Mapping (keine Regression) ---
  const szene = fs.readFileSync(path.join(__dirname, '..', 'public', 'scene.js'), 'utf8');
  for (const stich of ['-fp[0][1]', 'fp[i][0], -fp[i][1]', 'mesh.position.set(0, 0, 0)', 'bb.min.y']) {
    assert.ok(szene.includes(stich), 'scene.js ohne pflicht-fix: ' + stich);
  }
  assert.ok(!szene.includes('mesh.position.y = h'), 'regression: mesh.position.y = h ist zurueck!');
  console.log('[m3geo] scene.js enthaelt pflicht-mapping, kein y-versatz');

  db.close();
  console.log('[m3geo] ALLES OK');
}

try {
  main();
} catch (err) {
  console.error('[m3geo] FEHLER:', err.message);
  process.exit(1);
}


'use strict';
// POI-Verifikation AUS DEM OSM-LAYER (Test: alle importieren):
// Jeder Seed mit match muss seinen OSM-Eintrag treffen (Distanz 0,0 m);
// + alle 11 per Route vom Apartment erreichbar (< 1500 m).
// Aufruf: node scripts/test-poi-snap.js
const assert = require('node:assert');
const db = require('../src/db');
const pf = require('../src/pathfinding');

function main() {
  const k = db.ladeKiezKarte();
  assert.ok(k && k.streets.length > 100, 'karte erwartet');
  assert.ok(Array.isArray(k.osmPois) && k.osmPois.length > 50, 'osmPois-layer erwartet, gefunden: ' + ((k.osmPois || []).length));
  console.log(`[snap] osmPois-layer: ${k.osmPois.length} eintraege (${k.osmPois.filter((o) => o.name).length} mit namen)`);
  let maxD = 0;
  for (const p of db.SEED_POIS) {
    let bd = 1e9;
    let name = '';
    for (const s of k.streets) {
      for (const pt of s.points) {
        const d = Math.hypot(pt[0] - p.pos_x, pt[1] - p.pos_z);
        if (d < bd) { bd = d; name = s.name || s.kind; }
      }
    }
    maxD = Math.max(maxD, bd);
    // Match-Pruefung: Seed-Position == OSM-Layer-Position?
    let matchTxt = 'hand (kein match)';
    if (p.match && p.match.osm) {
      const o = (k.osmPois || []).find((q) => q.osm === p.match.osm);
      assert.ok(o, `${p.id}: osm-match ${p.match.osm} fehlt im layer`);
      const d = Math.hypot(o.pos[0] - p.pos_x, o.pos[1] - p.pos_z);
      matchTxt = `osm ${o.name || o.osm} abw ${d.toFixed(1)} m`;
      assert.ok(d < 1.0, `${p.id}: seed weicht ${d.toFixed(1)} m vom osm-layer ab`);
    }
    if (p.match && p.match.building) {
      const b = (k.buildings || []).find((q) => q.id === p.match.building);
      assert.ok(b, `${p.id}: building-match ${p.match.building} fehlt`);
      matchTxt = `building ${b.name || b.id} ok`;
    }
    const r = p.id === 'apartment' ? null : pf.findePoiRoute(k.navGraph, db.SEED_POIS, 'apartment', p.id);
    const rTxt = r ? `${r.pfad.length} knoten, ${r.distanzM} m` : 'START';
    console.log(`[snap] ${p.id} @(${p.pos_x},${p.pos_z}): ${bd.toFixed(1)} m neben ${name} | ${matchTxt} | route: ${rTxt}`);
    assert.ok(bd <= 60, `${p.id} zu weit ab (${bd.toFixed(1)} m)`);
    if (r) assert.ok(r.distanzM < 2000, `${p.id} route zu lang (${r.distanzM} m)`);
  }
  console.log(`[snap] ALLES OK (max ${maxD.toFixed(1)} m)`);
}

try {
  main();
} catch (err) {
  console.error('[snap] FEHLER:', err.message);
  process.exit(1);
}

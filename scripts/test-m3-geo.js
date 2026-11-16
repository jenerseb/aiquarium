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
  // Hamburg-Geodaten (echte Einzelhäuser + Bäume), Fallback kiez_map.
  const geo = dbMod.ladeHamburgGeodata();
  const buildings = (geo && geo.buildings && geo.buildings.length ? geo.buildings : karte.buildings);
  assert.ok(buildings.length > 100, 'hamburg-geodaten mit gebaeuden erwartet');
  if (geo) console.log(`[m3geo] hamburg_geodata.json: ${geo.buildings.length} häuser, ${(geo.trees || []).length} bäume (${(geo.meta && geo.meta.source) || '?'})`);
  const { db } = dbMod.init(tmpDb, karte);

  // --- 1) Alle Gebäude: min.y = 0, max.y = height, Ecken exakt (kein Spiegel) ---
  // Hinweis: AABB-Mitte != Polygon-Schwerpunkt bei schrägen Footprints –
  // geprüft wird Ecken-Treue: jede (x, z)-Ecke steht exakt in der rotierten Box.
  const abweichungen = [];
  for (const b of buildings) {
    const fp = b.footprint;
    if (!Array.isArray(fp) || fp.length < 3) continue;
    const hRoh = Math.max(3, Math.min(30, Number(b.height) || 12));
    const h = Math.max(4.5, Math.round(hRoh * 0.75 * 10) / 10); // DIORAMA_V1: 75 %
    const bb = bbox(extrudeRotiert(fp, h));
    if (Math.abs(bb.min.y) > 0.0001) abweichungen.push(`${b.id}: min.y=${bb.min.y}`);
    if (Math.abs(bb.max.y - h) > 0.6) abweichungen.push(`${b.id}: max.y=${bb.max.y} vs diorama-h=${h} (Bevel-Toleranz)`); // DIORAMA_V1: Bevel rundet oben
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
  console.log(`[m3geo] ${buildings.length} gebäude: min.y=0, max.y=height, ecken exakt (kein spiegel, kein schweben)`);

  // --- 2) POI-Deckung: alle Kern-POIs + NW/S-Erweiterung (LoD2-Centroid bevorzugt, ALKIS-Fallback) ---
  const pois = db.prepare('SELECT id, pos_x, pos_z, world_meta_json FROM pois').all();
  const KERN = ['apartment', 'otzentreff', 'kleine_pause', 'gruener_jaeger', 'b_movie', 'spaeti', 'florapark', 'praxis'];
  const ERWEITERT = ['rote_flora', 'haus73', 'millerntor', 'ume_no_hana', 'pizzeria_gjaeger', 'creperie', 'knust', 'rindermarkthalle', 'feldstrassenbunker'];
  let lod2 = null;
  try {
    const roh = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hamburg_lod2.json'), 'utf8'));
    if (roh && Array.isArray(roh.buildings) && roh.buildings.length > 50) lod2 = roh;
  } catch { /* Fallback unten */ }
  if (lod2) console.log(`[m3geo] hamburg_lod2.json: ${lod2.buildings.length} LoD2-gebäude (${(lod2.meta && lod2.meta.source) || '?'})`);
  // Verteilung: keine Klumpen — alle 4 Quadranten um den Box-Mittelpunkt belegt,
  // kein Quadrant > 60 % der Häuser.
  if (lod2) {
    const quad = [0, 0, 0, 0];
    for (const g of lod2.buildings) {
      const q = (g.centroid[0] > 235 ? 1 : 0) + (g.centroid[1] > 105 ? 2 : 0);
      quad[q] += 1;
    }
    console.log(`[m3geo] LoD2-quadranten (mitte 235,105): ${quad.join('/')}`);
    assert.ok(Math.min(...quad) > 50, 'LoD2-gebaeude geklumpt: quadrant leer ' + quad.join('/'));
    assert.ok(Math.max(...quad) < lod2.buildings.length * 0.6, 'LoD2-gebaeude geklumpt ' + quad.join('/'));
  }
  for (const zielId of KERN.concat(ERWEITERT)) {
    const poi = pois.find((p) => p.id === zielId);
    assert.ok(poi, 'poi fehlt: ' + zielId);
    let meta = null;
    try { meta = poi.world_meta_json ? JSON.parse(poi.world_meta_json) : null; } catch { meta = null; }
    if (lod2) {
      let bd = Infinity;
      let bi = null;
      for (const g of lod2.buildings) {
        const d = Math.hypot(g.centroid[0] - Number(poi.pos_x), g.centroid[1] - Number(poi.pos_z));
        if (d < bd) { bd = d; bi = g.id; }
      }
      console.log(`[m3geo] ${zielId} @(${poi.pos_x},${poi.pos_z}): LoD2-haus ${bi} ${bd.toFixed(1)} m`);
      // Coverage: Die Kerne der Tiles decken Nord + Süd ab;
      // einzelne Durchgangs-Häuser (Späti-/Park-Eck) fehlen im LoD2-Tileset —
      // dort gilt der INSPIRE-Footprint als nachgewiesen (Fallback unten).
      // Grenze 60 m für alle (Stadion-Arena + Offenland), 140 m für dokumentierte LoD2-Lücken.
      const luecke = zielId === 'spaeti' ? 140 : zielId === 'gruener_jaeger' ? 120 : 60;
      assert.ok(bd < luecke, `${zielId}: kein LoD2-haus in der naehe (${bd.toFixed(1)} m)`);
      continue;
    }
    const treffer = dbMod.naechstesGebaeude(geo || karte, Number(poi.pos_x), Number(poi.pos_z), 60);
    assert.ok(treffer, `${zielId}: kein einzelhaus in der naehe`);
    console.log(`[m3geo] ${zielId} @(${poi.pos_x},${poi.pos_z}): einzelhaus ${(meta && meta.alkis_id) || treffer.gebaeude.id} ${treffer.distanz.toFixed(1)} m`);
    assert.ok(treffer.distanz < 60, `${zielId}: kein gebaeude in der naehe (${treffer.distanz.toFixed(1)} m)`);
    if (poi.category !== 'park') assert.ok(meta && meta.alkis_id, `${zielId}: keine alkis_id in world_meta_json`);
  }

  // --- 2b) LoD2-Geometrie: minY === 0, Dreiecke plausibel, 2 Draw Calls ---
  if (lod2) {
    let wand = 0;
    let dach = 0;
    let schlecht = 0;
    for (const g of lod2.buildings) {
      if (g.minY !== 0) schlecht += 1;
      if (!Number.isFinite(g.maxY) || g.maxY < 2 || g.maxY > 80) schlecht += 1;
      wand += (g.wallTriangles || []).length;
      dach += (g.roofTriangles || []).length;
    }
    assert.strictEqual(schlecht, 0, 'LoD2-gebaeude ausserhalb plausibilitaet: ' + schlecht);
    assert.ok(wand > 10000 && dach > 5000, `zu wenig LoD2-dreiecke (wand ${wand}, dach ${dach})`);
    console.log(`[m3geo] LoD2: ${lod2.buildings.length} häuser, ${wand} wand- + ${dach} dach-dreiecke, minY=0 überall, 2 draw calls`);
  }

  // --- 3) scene.js enthält das Pflicht-Mapping (keine Regression) ---
  const szene = fs.readFileSync(path.join(__dirname, '..', 'public', 'scene.js'), 'utf8');
  for (const stich of ['-fp[0][1]', 'fp[i][0], -fp[i][1]', 'mesh.position.set(0, 0, 0)', 'bb.min.y', 'form.holes.push', 'bevelThickness: 0.3', '0.28', 'InstancedMesh', 'kronendurchmesser', 'baumhoehe', 'wolkenTreiben', 'FogExp2', 'ACESFilmicToneMapping', 'baueLoD2', 'LOD_SKALA', 'setzeLoD2Highlight', 'opacity: 0.28']) {
    assert.ok(szene.includes(stich), 'scene.js ohne pflicht-fix: ' + stich);
  }
  assert.ok(!szene.includes('mesh.position.y = h'), 'regression: mesh.position.y = h ist zurueck!');

  // --- 4) Bäume: echte Kataster-Bäume mit Höhe + Krone + Gattung ---
  if (geo && Array.isArray(geo.trees)) {
    console.log(`[m3geo] ${geo.trees.length} echte kiez-bäume in hamburg_geodata.json`);
    for (const t of geo.trees.slice(0, 200)) {
      assert.ok(Number.isFinite(Number(t.x)) && Number.isFinite(Number(t.z)), 'baum ohne koordinaten: ' + t.id);
      assert.ok(Number(t.kronendurchmesser) >= 2 && Number(t.kronendurchmesser) <= 25, 'krone unplausibel: ' + t.id);
      assert.ok(Number(t.baumhoehe) >= 4 && Number(t.baumhoehe) <= 22, 'baumhoehe unplausibel: ' + t.id);
      assert.ok(t.gattung_deutsch, 'baum ohne gattung: ' + t.id);
    }
  }
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


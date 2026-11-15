#!/usr/bin/env node
'use strict';
/**
 * Einmal-Skript zum Abrufen der echten OpenStreetMap-Gebäude, Straßen und
 * Fußweg-Knoten für das St.-Pauli-Dreieck (Lerchenstraße / Otzenstraße /
 * Beim Grünen Jäger / Stresemannstraße / Brigittenstraße).
 *
 * Aufruf: node scripts/fetch-osm.js
 * Schreibt: data/kiez_map.json
 */

const fs = require('node:fs');
const path = require('node:path');

// Ursprung (0, 0): Kreuzung Lerchenstraße / Otzenstraße
const ORIGIN = { lat: 53.5588, lon: 9.9612 };

// Bounding Box rund um den markierten St.-Pauli-Kiez
const BBOX = {
  south: 53.5562,
  west: 9.9578,
  north: 53.5622,
  east: 9.9650,
};

const OUT_FILE = path.join(__dirname, '..', 'data', 'kiez_map.json');

// GPS (lat, lon) -> lokale Meter (x = Ost, z = Süd, -z = Nord)
function toLocalMeters(lat, lon) {
  const cosLat = Math.cos((ORIGIN.lat * Math.PI) / 180);
  const x = (lon - ORIGIN.lon) * 111320 * cosLat;
  const z = -(lat - ORIGIN.lat) * 111320;
  return [Math.round(x * 10) / 10, Math.round(z * 10) / 10];
}

const OVERPASS_QUERY = `
[out:json][timeout:25];
(
  way["building"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  way["highway"~"^(primary|secondary|tertiary|residential|living_street|pedestrian|footway|path|service)$"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
);
out body;
>;
out skel qt;
`.trim();

async function fetchOverpass() {
  const url = 'https://overpass-api.de/api/interpreter';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(OVERPASS_QUERY)}`,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return res.json();
}

function buildMapFromOsm(osm) {
  const nodesById = new Map();
  for (const el of osm.elements || []) {
    if (el.type === 'node') {
      const [x, z] = toLocalMeters(el.lat, el.lon);
      nodesById.set(el.id, { id: el.id, x, z });
    }
  }

  const buildings = [];
  const streets = [];
  const navNodesMap = new Map();
  const navEdges = [];

  for (const el of osm.elements || []) {
    if (el.type !== 'way' || !Array.isArray(el.nodes)) continue;
    const pts = el.nodes.map((id) => nodesById.get(id)).filter(Boolean);
    if (pts.length < 2) continue;
    const tags = el.tags || {};

    // 1. Gebäude-Polygone
    if (tags.building && pts.length >= 3) {
      const levels = Number(tags['building:levels']) || (tags.building === 'apartments' ? 5 : 4);
      buildings.push({
        id: `b_${el.id}`,
        name: tags.name || null,
        type: tags.amenity || tags.shop || tags.building,
        levels: Math.max(1, Math.min(8, levels)),
        height: Math.round(levels * 3.5 * 10) / 10,
        footprint: pts.map((p) => [p.x, p.z]),
      });
      continue;
    }

    // 2. Straßen & Gehwege für Rendering + Pathfinding-Graph
    if (tags.highway) {
      streets.push({
        id: `w_${el.id}`,
        name: tags.name || null,
        kind: tags.highway,
        points: pts.map((p) => [p.x, p.z]),
      });

      for (let i = 0; i < pts.length; i += 1) {
        const p = pts[i];
        if (!navNodesMap.has(p.id)) {
          navNodesMap.set(p.id, { id: String(p.id), x: p.x, z: p.z });
        }
        if (i > 0) {
          const prev = pts[i - 1];
          navEdges.push([String(prev.id), String(p.id)]);
        }
      }
    }
  }

  return {
    meta: {
      origin: ORIGIN,
      bbox: BBOX,
      generatedAt: new Date().toISOString(),
      source: 'OpenStreetMap Overpass API',
    },
    buildings,
    streets,
    navGraph: {
      nodes: [...navNodesMap.values()],
      edges: navEdges,
    },
  };
}

// Fallback-Geometrie für das St.-Pauli-Dreieck, falls kein Internet/Overpass verfügbar ist
function buildFallbackMap() {
  const nodes = [
    { id: 'n_origin', x: 0, z: 0 },           // Kreuzung Lerchenstraße / Otzenstraße
    { id: 'n_lerche_n', x: 18, z: -140 },     // Lerchenstraße Nord (Stresemannstr.)
    { id: 'n_lerche_m', x: 8, z: -70 },       // Lerchenstraße Mitte (Kleine Pause / Wohnung)
    { id: 'n_lerche_s', x: -35, z: 95 },      // Brunnenhofstraße Süd
    { id: 'n_otzen_e', x: 95, z: 15 },        // Otzenstraße Ost -> Beim Grünen Jäger
    { id: 'n_jaeger_n', x: 115, z: -110 },    // Beim Grünen Jäger Nord
    { id: 'n_jaeger_s', x: 85, z: 130 },      // Beim Grünen Jäger Süd
    { id: 'n_brigitten', x: 20, z: 120 },     // Brigittenstraße (B-Movie)
    { id: 'n_park', x: -25, z: -25 },         // Durchgang Grünfläche
  ];
  const edges = [
    ['n_lerche_n', 'n_lerche_m'],
    ['n_lerche_m', 'n_origin'],
    ['n_origin', 'n_lerche_s'],
    ['n_origin', 'n_otzen_e'],
    ['n_lerche_m', 'n_otzen_e'],
    ['n_jaeger_n', 'n_otzen_e'],
    ['n_otzen_e', 'n_jaeger_s'],
    ['n_jaeger_s', 'n_brigitten'],
    ['n_brigitten', 'n_lerche_s'],
    ['n_origin', 'n_park'],
    ['n_lerche_n', 'n_jaeger_n'],
  ];
  const buildings = [
    { id: 'b_home', name: 'Wohnhaus Lerchenstraße', type: 'apartments', levels: 5, height: 17.5, footprint: [[-14, -78], [2, -78], [2, -58], [-14, -58]] },
    { id: 'b_otzen', name: 'Eckhaus Otzentreff', type: 'pub', levels: 4, height: 14.0, footprint: [[28, 4], [52, 4], [52, 24], [28, 24]] },
    { id: 'b_pause', name: 'Kleine Pause Block', type: 'fast_food', levels: 4, height: 14.0, footprint: [[16, -52], [42, -52], [42, -32], [16, -32]] },
    { id: 'b_jaeger', name: 'Grüner Jäger', type: 'nightclub', levels: 3, height: 10.5, footprint: [[98, -35], [122, -35], [122, -10], [98, -10]] },
    { id: 'b_bmovie', name: 'B-Movie Block', type: 'cinema', levels: 5, height: 17.5, footprint: [[8, 98], [44, 98], [44, 116], [8, 116]] },
  ];
  return {
    meta: { origin: ORIGIN, bbox: BBOX, generatedAt: new Date().toISOString(), source: 'fallback' },
    buildings,
    streets: [],
    navGraph: { nodes, edges },
  };
}

async function main() {
  const dir = path.dirname(OUT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  try {
    console.log('[osm] Lade St.-Pauli-Ausschnitt von Overpass API ...');
    const raw = await fetchOverpass();
    const map = buildMapFromOsm(raw);
    fs.writeFileSync(OUT_FILE, JSON.stringify(map, null, 2), 'utf8');
    console.log(`[osm] Gespeichert in ${OUT_FILE}: ${map.buildings.length} Gebäude, ${map.navGraph.nodes.length} Wegknoten.`);
  } catch (err) {
    console.warn(`[osm] Overpass nicht erreichbar (${err.message}) — schreibe Fallback-Karte.`);
    const map = buildFallbackMap();
    fs.writeFileSync(OUT_FILE, JSON.stringify(map, null, 2), 'utf8');
  }
}

main();
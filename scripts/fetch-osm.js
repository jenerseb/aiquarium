/* Fußweg-Knoten für das St.-Pauli-Dreieck (Lerchenstraße / Otzenstraße /
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
// (GROSS 2026-11-16: Sued bis B-Movie, Ost bis Neuer Kamp 30;
//  NORD+OST 2026-11-16: Flora/Haus73/Bunker drin;
//  NW/S 2026-11-17: West bis Max-Brauer-Allee, Nord bis Florapark, Sued bis Stadion)
const BBOX = {
  south: 53.5500,
  west: 9.9560,
  north: 53.5640,
  east: 9.9725,
};

const OUT_FILE = path.join(__dirname, '..', 'data', 'kiez_map.json');

// GPS (lat, lon) -> lokale Meter (x = Ost, z = Süd, -z = Nord).
// BEWUSST alte Projektion (Stand Bild 2, Referenz): z OHNE cos-Skalierung.
// Der cos-Fix (beide Achsen) hat Nord-Süd auf 0,594 gestaucht → revertiert 2026-11-16.
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
  node["amenity"~"^(bar|pub|restaurant|fast_food|cafe|cinema|nightclub|arts_centre|community_centre|theatre)$"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  way["amenity"~"^(bar|pub|restaurant|fast_food|cafe|cinema|nightclub|arts_centre|community_centre|theatre)$"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  node["historic"~"^(bunker|memorial|monument)$"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  way["historic"~"^(bunker|memorial|monument)$"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  way["leisure"~"^(park|garden|pitch|common|playground|dog_park)$"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  way["landuse"~"^(grass|meadow|cemetery|recreation_ground|village_green)$"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
);
out body;
>;
out skel qt;
`.trim();

async function fetchOverpass() {
  // Mirror-Kette (2026-11-17): mail.ru timeoutet/502t häufig — overpass-api.de zuerst.
  const mirrors = [
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];
  let letzterFehler = null;
  for (const url of mirrors) {
    try {
      console.log('[osm] Mirror: ' + url);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'User-Agent': 'AIquarium-Hamburg-MVP/0.1 (local-dev)',
        },
        body: `data=${encodeURIComponent(OVERPASS_QUERY)}`,
        signal: AbortSignal.timeout(150000), // 150 s: Overpass braucht bei großen Queries länger
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      return res.json();
    } catch (err) {
      letzterFehler = err;
      console.warn('[osm] Mirror fehlgeschlagen: ' + err.message);
    }
  }
  throw letzterFehler || new Error('Kein Overpass-Mirror erreichbar');
}

function buildMapFromOsm(osm) {
  const nodesById = new Map();
  const nodesTags = new Map();
  for (const el of osm.elements || []) {
    if (el.type === 'node') {
      const [x, z] = toLocalMeters(el.lat, el.lon);
      nodesById.set(el.id, { id: el.id, x, z }); // Key = NODE-ID (nicht Way-ID)
      if (el.tags && (el.tags.amenity || el.tags.historic)) nodesTags.set(el.id, el.tags);
    }
  }

  const buildings = [];
  const streets = [];
  const parks = [];
  const osmPois = []; // ALLE Amenity/Historic-Nodes+Ways (Test: ungefiltert importieren)
  for (const [nid, tags] of nodesTags) {
    const p = nodesById.get(nid);
    if (!p) continue;
    osmPois.push({
      osm: `n_${nid}`,
      name: tags.name || null,
      amenity: tags.amenity || null,
      historic: tags.historic || null,
      category: null, // Mapping in db.js
      pos: [p.x, p.z],
    });
  }
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
        colour: tags['building:colour'] || tags['building:color'] || null,
        roofColour: tags['roof:colour'] || tags['roof:color'] || null,
        roofShape: tags['roof:shape'] || null,
        surface: tags['building:surface'] || tags.surface || null,
      });
      continue;
    }
    // 1b. Grünflächen (Parks/Gärten/Wiesen/Friedhöfe) als Polygone (Bugfix:
    // parks fehlten komplett -> server.js zeichnete nur einen POI-Kreis).
    if (!tags.highway && pts.length >= 3 && (tags.leisure || tags.landuse)) {
      const isGruen = /^(park|garden|pitch|common|playground|dog_park)$/.test(String(tags.leisure || ''))
        || /^(grass|meadow|cemetery|recreation_ground|village_green)$/.test(String(tags.landuse || ''));
      if (isGruen) {
        parks.push({
          id: `p_${el.id}`,
          name: tags.name || null,
          polygon: pts.map((p) => [p.x, p.z]),
        });
        continue;
      }
    }
    // 2. Straßen & Gehwege für Rendering + Pathfinding-Graph
    // 2. Straßen & Gehwege für Rendering + Pathfinding-Graph
    if (tags.highway) {
      streets.push({
        id: `w_${el.id}`,
        name: tags.name || null,
        kind: tags.highway,
        points: pts.map((p) => [p.x, p.z]),
      });

      // 2a. POI-Layer: Amenity/Historic am Way (Name+Kategorie+Schwerpunkt)
      if ((tags.amenity || tags.historic) && pts.length) {
        let sx = 0;
        let sz = 0;
        for (const p of pts) { sx += p.x; sz += p.z; }
        osmPois.push({
          osm: `w_${el.id}`,
          name: tags.name || null,
          amenity: tags.amenity || null,
          historic: tags.historic || null,
          category: null, // Mapping in db.js
          pos: [Math.round((sx / pts.length) * 10) / 10, Math.round((sz / pts.length) * 10) / 10],
        });
      }

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

  // 2b. Zusammenhang naehen: gleiche Koordinate (10-cm-Raster) = ein Knoten.
  // Overpass liefert Ways unverbunden; ohne Naht zerfaellt der Graph.
  const raster = new Map();
  const alias = new Map();
  for (const n of navNodesMap.values()) {
    const key = `${Math.round(n.x * 10)},${Math.round(n.z * 10)}`;
    if (raster.has(key)) alias.set(String(n.id), raster.get(key));
    else raster.set(key, String(n.id));
  }
  const kanon = (id) => alias.get(String(id)) || String(id);
  const genaeht = navEdges.map(([a, b]) => [kanon(a), kanon(b)]).filter(([a, b]) => a !== b);
  navEdges.length = 0;
  const gesehen = new Set();
  for (const [a, b] of genaeht) {
    const key = a < b ? a + '|' + b : b + '|' + a;
    if (gesehen.has(key)) continue;
    gesehen.add(key);
    navEdges.push([a, b]);
  }
  // Knotenliste auf kanonische IDs schrumpfen (Aliase raus, sonst Geisterknoten)
  for (const altId of alias.keys()) navNodesMap.delete(altId);

  // OST-BRUECKE (2026-11-16): Hauptgraph (Comp mit Apartment) mit Bunker-Insel
  // (Comp mit Feldstrassenbunker) verbinden – 3 kuerzeste Buergersteig-Paare.
  const ADJ = new Map();
  for (const n of navNodesMap.values()) ADJ.set(String(n.id), []);
  for (const [a, b] of navEdges) {
    const A = String(a);
    const B = String(b);
    if (ADJ.has(A) && ADJ.has(B)) { ADJ.get(A).push(B); ADJ.get(B).push(A); }
  }
  const COMP = new Map();
  let CID = 0;
  for (const n of navNodesMap.values()) {
    const id = String(n.id);
    if (COMP.has(id)) continue;
    CID++;
    const QQ = [id];
    COMP.set(id, CID);
    while (QQ.length) {
      const c = QQ.pop();
      for (const m of (ADJ.get(c) || [])) {
        if (COMP.has(m)) continue;
        COMP.set(m, CID);
        QQ.push(m);
      }
    }
  }
  const bunkerRef = { x: 585.7, z: 263.8 }; // Flakbunker (alte Projektion, Bild 2)
  const aptRef = { x: -3, z: -114 };
  const compVon = (rx, rz) => {
    let bd = 1e18;
    let bn = null;
    for (const n of navNodesMap.values()) {
      const d = (n.x - rx) * (n.x - rx) + (n.z - rz) * (n.z - rz);
      if (d < bd) { bd = d; bn = n; }
    }
    return bn ? COMP.get(String(bn.id)) : null;
  };
  const cApt = compVon(aptRef.x, aptRef.z);
  const cBun = compVon(bunkerRef.x, bunkerRef.z);
  if (cApt && cBun && cApt !== cBun) {
    const paare = [];
    for (const a of navNodesMap.values()) {
      if (COMP.get(String(a.id)) !== cApt) continue;
      for (const b of navNodesMap.values()) {
        if (COMP.get(String(b.id)) !== cBun) continue;
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        paare.push({ d2: dx * dx + dz * dz, a: String(a.id), b: String(b.id) });
      }
    }
    paare.sort((p, q) => p.d2 - q.d2);
    let added = 0;
    for (const p of paare.slice(0, 3)) {
      navEdges.push([p.a, p.b]);
      added++;
      console.log(`[osm] ost-bruecke ${added}: ${p.a} <-> ${p.b} (${Math.sqrt(p.d2).toFixed(1)} m)`);
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
    parks,
    osmPois, // Test: ALLE Amenities/Historics der Box (Namen teils null)
    streets,
    osmPois, // Test: ALLE Amenities/Historics der Box (Namen teils null)
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
    if (!map.buildings.length || !map.navGraph.nodes.length) {
      throw new Error(`Overpass lieferte leere Karte (${map.buildings.length} Gebaeude) – behalte alte Datei`);
    }
    console.log(`[osm] Gespeichert in ${OUT_FILE}: ${map.buildings.length} Gebäude, ${map.navGraph.nodes.length} Wegknoten, ${(map.parks || []).length} Grünflächen.`);
    fs.writeFileSync(OUT_FILE, JSON.stringify(map, null, 2), 'utf8');
    console.log(`[osm] Gespeichert in ${OUT_FILE}: ${map.buildings.length} Gebäude, ${map.navGraph.nodes.length} Wegknoten.`);
  } catch (err) {
    if (fs.existsSync(OUT_FILE)) {
      console.warn(`[osm] Overpass nicht erreichbar (${err.message}) — BEHALTE bestehende Karte.`);
      return;
    }
    console.warn(`[osm] Overpass nicht erreichbar (${err.message}) — schreibe Fallback-Karte.`);
    const map = buildFallbackMap();
    fs.writeFileSync(OUT_FILE, JSON.stringify(map, null, 2), 'utf8');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[osm] FEHLER: ' + err.message);
    process.exit(1);
  });
}

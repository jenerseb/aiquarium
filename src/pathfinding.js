'use strict';
// A*-Wegfindung auf dem OSM-Fussweg-Graphen (navGraph aus data/kiez_map.json).
// Der Charakter laeuft nur auf Buergersteigen (Graph-Kanten), nie durch Haeuser.

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function baueAdjazenz(navGraph) {
  const knoten = new Map();
  for (const n of navGraph.nodes) knoten.set(String(n.id), { id: String(n.id), x: n.x, z: n.z });
  const adj = new Map();
  for (const id of knoten.keys()) adj.set(id, []);
  for (const [a, b] of navGraph.edges) {
    const A = String(a);
    const B = String(b);
    if (!knoten.has(A) || !knoten.has(B)) continue;
    const d = dist(knoten.get(A), knoten.get(B));
    adj.get(A).push({ nach: B, kosten: d });
    adj.get(B).push({ nach: A, kosten: d });
  }
  return { knoten, adj };
}

function naechsterKnoten(knotenMap, x, z) {
  let best = null;
  let bestD = Infinity;
  for (const k of knotenMap.values()) {
    const d = Math.hypot(k.x - x, k.z - z);
    if (d < bestD) { bestD = d; best = k; }
  }
  return { knoten: best, distanzM: bestD };
}

// A* von startId nach zielId. Gibt { pfad, weg, distanzM } zurueck.
function findeRoute(navGraph, startId, zielId) {
  const { knoten, adj } = baueAdjazenz(navGraph);
  const start = String(startId);
  const ziel = String(zielId);
  if (!knoten.has(start)) throw new Error('Startknoten unbekannt: ' + start);
  if (!knoten.has(ziel)) throw new Error('Zielknoten unbekannt: ' + ziel);
  if (start === ziel) {
    const k = knoten.get(start);
    return { pfad: [start], weg: [{ x: k.x, z: k.z }], distanzM: 0 };
  }
  const h = (id) => dist(knoten.get(id), knoten.get(ziel));
  const offen = [{ id: start, f: h(start) }];
  const gWert = new Map([[start, 0]]);
  const herkunft = new Map();
  const geschlossen = new Set();

  while (offen.length > 0) {
    let bi = 0;
    for (let i = 1; i < offen.length; i += 1) {
      if (offen[i].f < offen[bi].f) bi = i;
    }
    const akt = offen.splice(bi, 1)[0].id;
    if (akt === ziel) {
      const pfad = [ziel];
      let c = ziel;
      while (herkunft.has(c)) { c = herkunft.get(c); pfad.unshift(c); }
      const weg = pfad.map((id) => ({ x: knoten.get(id).x, z: knoten.get(id).z }));
      let d = 0;
      for (let i = 1; i < weg.length; i += 1) d += Math.hypot(weg[i].x - weg[i - 1].x, weg[i].z - weg[i - 1].z);
      return { pfad, weg, distanzM: Math.round(d * 10) / 10 };
    }
    if (geschlossen.has(akt)) continue;
    geschlossen.add(akt);
    for (const kante of adj.get(akt)) {
      if (geschlossen.has(kante.nach)) continue;
      const gNeu = gWert.get(akt) + kante.kosten;
      if (gNeu < (gWert.get(kante.nach) ?? Infinity)) {
        gWert.set(kante.nach, gNeu);
        herkunft.set(kante.nach, akt);
        offen.push({ id: kante.nach, f: gNeu + h(kante.nach) });
      }
    }
  }
  return { pfad: [], weg: [], distanzM: Infinity, keineRoute: true };
}

// Bequem: Koordinaten -> naechste Knoten -> A*-Route.
function findeWegFuerKoordinaten(navGraph, startX, startZ, zielX, zielZ) {
  const { knoten } = baueAdjazenz(navGraph);
  const s = naechsterKnoten(knoten, startX, startZ);
  const z = naechsterKnoten(knoten, zielX, zielZ);
  const r = findeRoute(navGraph, s.knoten.id, z.knoten.id);
  return { startKnoten: s, zielKnoten: z, ...r };
}

// POI-Snap: jeder POI bekommt seinen naechsten Strassenknoten (entryNodeId).
// Laufzeit-Cache (navGraph ist statisch aus data/kiez_map.json) – kein DB-Umbau.
// Rueckgabe: Map poiId -> { knotenId, x, z, distanzM }.
const _snapCache = new Map();
function _cacheSchluessel(navGraph) {
  const n = (navGraph && navGraph.nodes && navGraph.nodes.length) || 0;
  const e = (navGraph && navGraph.edges && navGraph.edges.length) || 0;
  const erst = (navGraph && navGraph.nodes && navGraph.nodes[0]) || {};
  return n + '/' + e + '/' + erst.id + '/' + erst.x + '/' + erst.z;
}
function snappePois(navGraph, pois) {
  const key = _cacheSchluessel(navGraph) + '#' + pois.map((p) => p.id).join(',');
  if (_snapCache.has(key)) return _snapCache.get(key);
  const { knoten } = baueAdjazenz(navGraph);
  const snap = new Map();
  for (const p of pois) {
    const s = naechsterKnoten(knoten, Number(p.pos_x), Number(p.pos_z));
    snap.set(p.id, { knotenId: s.knoten.id, x: s.knoten.x, z: s.knoten.z, distanzM: Math.round(s.distanzM * 10) / 10 });
  }
  _snapCache.set(key, snap);
  return snap;
}

// POI-zu-POI-Route (liest Koordinaten aus Seed oder DB-Zeilen).
function findePoiRoute(navGraph, pois, startPoiId, zielPoiId) {
  const idx = new Map(pois.map((p) => [p.id, p]));
  const s = idx.get(startPoiId);
  const z = idx.get(zielPoiId);
  if (!s) throw new Error('Start-POI unbekannt: ' + startPoiId);
  if (!z) throw new Error('Ziel-POI unbekannt: ' + zielPoiId);
  // PATHFINDING-FIX: POIs liegen teils in Gebaeude-Footprints – Route immer
  // Knoten -> entryNodeId rechnen, damit niemand quer durch Waende abkuerzt.
  const snap = snappePois(navGraph, [s, z]);
  const sNode = snap.get(s.id);
  const zNode = snap.get(z.id);
  const r = findeRoute(navGraph, sNode.knotenId, zNode.knotenId);
  return { startPoi: s, zielPoi: z, startKnoten: { knoten: sNode, distanzM: sNode.distanzM }, zielKnoten: { knoten: zNode, distanzM: zNode.distanzM }, ...r };
}

module.exports = { dist, baueAdjazenz, naechsterKnoten, findeRoute, findeWegFuerKoordinaten, findePoiRoute, snappePois };

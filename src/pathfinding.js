'use strict';
// A*-Wegfindung auf dem OSM-Fussweg-Graphen (navGraph aus data/kiez_map.json).
// Der Charakter laeuft nur auf Buergersteigen (Graph-Kanten), nie durch Haeuser.

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function punktInPolygon(x, z, poly) {
  if (!Array.isArray(poly) || poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1];
    const xj = poly[j][0], zj = poly[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function parkFuerPunkt(parks, x, z) {
  if (!Array.isArray(parks) || parks.length === 0) return null;
  for (const p of parks) {
    if (p && Array.isArray(p.polygon) && punktInPolygon(x, z, p.polygon)) return p;
  }
  return null;
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

// Orthogonal-Projektion von (x, z) auf das naechste Strassen-Segment in navGraph.edges.
// Liefert den unsichtbaren Hauseingangspunkt direkt auf der naechstgelegenen Strasse.
function naechsterStrassenPunkt(navGraph, x, z) {
  const { knoten } = baueAdjazenz(navGraph);
  let best = null;
  let bestD = Infinity;
  for (const [aId, bId] of (navGraph && navGraph.edges) || []) {
    const A = knoten.get(String(aId));
    const B = knoten.get(String(bId));
    if (!A || !B) continue;
    const dx = B.x - A.x;
    const dz = B.z - A.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-6 ? Math.max(0, Math.min(1, ((x - A.x) * dx + (z - A.z) * dz) / len2)) : 0;
    const px = A.x + t * dx;
    const pz = A.z + t * dz;
    const d = Math.hypot(px - x, pz - z);
    if (d < bestD) {
      bestD = d;
      const dA = Math.hypot(px - A.x, pz - A.z);
      const dB = Math.hypot(px - B.x, pz - B.z);
      best = {
        x: Math.round(px * 10) / 10,
        z: Math.round(pz * 10) / 10,
        edgeA: A.id,
        edgeB: B.id,
        knotenId: dA <= dB ? A.id : B.id,
        distanzM: Math.round(d * 10) / 10,
      };
    }
  }
  if (!best) {
    const nk = naechsterKnoten(knoten, x, z);
    if (!nk.knoten) return null;
    return { x: nk.knoten.x, z: nk.knoten.z, edgeA: nk.knoten.id, edgeB: nk.knoten.id, knotenId: nk.knoten.id, distanzM: Math.round(nk.distanzM * 10) / 10 };
  }
  return best;
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

// A* zwischen beliebigen Koordinaten über ihre Strassen-Projektionen (Hauseingangspunkte).
// Kein diagonales Querfeldein-Laufen durch Haeuserbloecke!
function findeRouteZwischenPunkten(navGraph, startX, startZ, zielX, zielZ, opts = {}) {
  const parks = opts.parks || (navGraph && navGraph.parks) || null;
  if (parks) {
    const startPark = parkFuerPunkt(parks, startX, startZ);
    const zielPark = parkFuerPunkt(parks, zielX, zielZ);
    if (startPark && zielPark && startPark.id === zielPark.id) {
      const sx = Math.round(startX * 10) / 10;
      const sz = Math.round(startZ * 10) / 10;
      const zx = Math.round(zielX * 10) / 10;
      const zz = Math.round(zielZ * 10) / 10;
      return {
        startKnoten: { knoten: { x: sx, z: sz }, distanzM: 0 },
        zielKnoten: { knoten: { x: zx, z: zz }, distanzM: 0 },
        pfad: ['__park_start', '__park_ziel'],
        weg: [{ x: sx, z: sz }, { x: zx, z: zz }],
        distanzM: Math.round(Math.hypot(zx - sx, zz - sz) * 10) / 10,
      };
    }
  }
  const { knoten, adj } = baueAdjazenz(navGraph);
  const sEnt = naechsterStrassenPunkt(navGraph, startX, startZ);
  const zEnt = naechsterStrassenPunkt(navGraph, zielX, zielZ);
  if (!sEnt || !zEnt) return { startKnoten: null, zielKnoten: null, pfad: [], weg: [], distanzM: Infinity, keineRoute: true };

  const sId = '__start_ent';
  const zId = '__ziel_ent';
  knoten.set(sId, { id: sId, x: sEnt.x, z: sEnt.z });
  knoten.set(zId, { id: zId, x: zEnt.x, z: zEnt.z });
  adj.set(sId, []);
  adj.set(zId, []);

  const verbinde = (u, v) => {
    const ku = knoten.get(u);
    const kv = knoten.get(v);
    if (!ku || !kv || u === v) return;
    const d = dist(ku, kv);
    adj.get(u).push({ nach: v, kosten: d });
    adj.get(v).push({ nach: u, kosten: d });
  };
  verbinde(sId, sEnt.edgeA);
  verbinde(sId, sEnt.edgeB);
  verbinde(zId, zEnt.edgeA);
  verbinde(zId, zEnt.edgeB);
  // Gleiches Strassensegment? Direkte Verbindung entlang der Strasse erlauben.
  if ((sEnt.edgeA === zEnt.edgeA && sEnt.edgeB === zEnt.edgeB) || (sEnt.edgeA === zEnt.edgeB && sEnt.edgeB === zEnt.edgeA)) {
    verbinde(sId, zId);
  }

  const h = (id) => dist(knoten.get(id), knoten.get(zId));
  const offen = [{ id: sId, f: h(sId) }];
  const gWert = new Map([[sId, 0]]);
  const herkunft = new Map();
  const geschlossen = new Set();

  while (offen.length > 0) {
    let bi = 0;
    for (let i = 1; i < offen.length; i += 1) {
      if (offen[i].f < offen[bi].f) bi = i;
    }
    const akt = offen.splice(bi, 1)[0].id;
    if (akt === zId) {
      const pfad = [zId];
      let c = zId;
      while (herkunft.has(c)) { c = herkunft.get(c); pfad.unshift(c); }
      const weg = pfad.map((id) => ({ x: knoten.get(id).x, z: knoten.get(id).z }));
      if (opts.mitStartPunkt && Math.hypot(startX - sEnt.x, startZ - sEnt.z) > 0.5) {
        weg.unshift({ x: Math.round(startX * 10) / 10, z: Math.round(startZ * 10) / 10 });
      }
      if (opts.mitZielPunkt && Math.hypot(zielX - zEnt.x, zielZ - zEnt.z) > 0.5) {
        weg.push({ x: Math.round(zielX * 10) / 10, z: Math.round(zielZ * 10) / 10 });
      }
      let d = 0;
      for (let i = 1; i < weg.length; i += 1) d += Math.hypot(weg[i].x - weg[i - 1].x, weg[i].z - weg[i - 1].z);
      return {
        startKnoten: { knoten: sEnt, distanzM: sEnt.distanzM },
        zielKnoten: { knoten: zEnt, distanzM: zEnt.distanzM },
        pfad: pfad.filter((id) => id !== sId && id !== zId),
        weg,
        distanzM: Math.round(d * 10) / 10,
      };
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
  return { startKnoten: { knoten: sEnt, distanzM: sEnt.distanzM }, zielKnoten: { knoten: zEnt, distanzM: zEnt.distanzM }, pfad: [], weg: [], distanzM: Infinity, keineRoute: true };
}

// Bequem: Koordinaten -> Strassen-Eingangspunkte -> A*-Route.
function findeWegFuerKoordinaten(navGraph, startX, startZ, zielX, zielZ, opts) {
  return findeRouteZwischenPunkten(navGraph, startX, startZ, zielX, zielZ, opts);
}

// POI-Snap: jeder POI bekommt seinen unsichtbaren Hauseingangspunkt direkt auf
// der naechstgelegenen Strassen-Kante (Orthogonal-Projektion).
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
  const snap = new Map();
  for (const p of pois) {
    const s = naechsterStrassenPunkt(navGraph, Number(p.pos_x), Number(p.pos_z));
    if (s) snap.set(p.id, s);
  }
  _snapCache.set(key, snap);
  return snap;
}

// POI-zu-POI-Route (mit unsichtbaren Hauseingangspunkten an der naechstgelegenen Strasse).
function findePoiRoute(navGraph, pois, startPoiId, zielPoiId) {
  const idx = new Map(pois.map((p) => [p.id, p]));
  const s = idx.get(startPoiId);
  const z = idx.get(zielPoiId);
  if (!s) throw new Error('Start-POI unbekannt: ' + startPoiId);
  if (!z) throw new Error('Ziel-POI unbekannt: ' + zielPoiId);
  return findeRouteZwischenPunkten(navGraph, Number(s.pos_x), Number(s.pos_z), Number(z.pos_x), Number(z.pos_z), {
    mitStartPunkt: true,
    mitZielPunkt: true,
  });
}

module.exports = { dist, baueAdjazenz, naechsterKnoten, naechsterStrassenPunkt, findeRoute, findeRouteZwischenPunkten, findeWegFuerKoordinaten, findePoiRoute, snappePois, punktInPolygon, parkFuerPunkt };

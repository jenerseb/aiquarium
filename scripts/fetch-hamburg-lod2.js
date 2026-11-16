/* Hamburg LoD2-Fetcher: echte 3D-Geometrie (Waende + Daechern) aus dem
 * 3D-Stadtmodell LoD2-DE (3D-Tiles/b3dm, daten-hamburg.de).
 *
 * Warum b3dm statt CityGML-Bulk: Der CityGML-Komplettdatensatz ist
 * 400-660 MB gross; die 3D-Tiles liefern dieselben Gebaeude als kleine
 * Kacheln (je ~1 MB) mit ALKIS-ID + Dachform im Batch-Table.
 *
 * Ablauf: tileset.json -> Kacheln in St.-Pauli-Box -> b3dm laden ->
 * glTF-Payload (POSITION + NORMAL + _BATCHID + INDEX) -> ECEF(+RTC) ->
 * WGS84 -> toLocalMeters -> pro Gebaeude minY auf 0 -> Wand/Dach split
 * per Normalen-y (|ny|<0.5 Wand, sonst Dach).
 *
 * Output: data/hamburg_lod2.json ({id, centroid, minY:0, maxY,
 *   wallTriangles, roofTriangles} flach als [x,y,z]-Arrays).
 * Lizenz: Datenlizenz Deutschland - Namensnennung - 2.0 (FHH, LGV).
 * Aufruf: node scripts/fetch-hamburg-lod2.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ORIGIN = { lat: 53.5588, lon: 9.9612 };
const OUT_FILE = path.join(__dirname, '..', 'data', 'hamburg_lod2.json');
const TILESET = 'https://daten-hamburg.de/gdi3d/datasource-data/LoD2/tileset.json';
const BASIS = 'https://daten-hamburg.de/gdi3d/datasource-data/LoD2/';
const LIZENZ = 'Datenlizenz Deutschland \u2013 Namensnennung \u2013 2.0 (Quelle: Freie und Hansestadt Hamburg, LGV)';
// Testfleck „Grüner Jäger" (LOD2_TEST=1): 320x320 m = ~10 % der Kiez-Box.
// Zentrum Grüner Jäger (163, 232) — Referenz mit guter LoD2-Abdeckung.
const TEST_MODUS = process.env.LOD2_TEST === '1';
const TEST_BOX = { minX: -7, maxX: 313, minZ: 72, maxZ: 392 };
const OUT_DATEI = TEST_MODUS
  ? path.join(__dirname, '..', 'data', 'hamburg_lod2_test.json')
  : OUT_FILE;
function toLocalMeters(lat, lon) {
  const c = Math.cos((ORIGIN.lat * Math.PI) / 180);
  return [Math.round((lon - ORIGIN.lon) * 111320 * c * 10) / 10, Math.round(-(lat - ORIGIN.lat) * 111320 * 10) / 10];
}
// Lokale Meter -> Lon/Lat (fuer den Tileset-Region-Schnitt im Test-Modus).
function lokaleNachWgs(x, z) {
  const c = Math.cos((ORIGIN.lat * Math.PI) / 180);
  return [ORIGIN.lat - z / 111320, ORIGIN.lon + x / (111320 * c)];
}
// glTF Y-up -> Z-up (Tileset/ECEF-Konvention): [x, -z, y]. Positionen UND Normalen.
function yUpZuZUp(v) {
  return [v[0], -v[2], v[1]];
}
function ecefZuWgs84(x, y, z) {
  const a = 6378137.0, e2 = 0.00669437999014;
  const lon = Math.atan2(y, x) * 180 / Math.PI;
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2)) * 180 / Math.PI;
  for (let i = 0; i < 4; i++) {
    const N = a / Math.sqrt(1 - e2 * Math.sin(lat * Math.PI / 180) ** 2);
    lat = Math.atan2(z + e2 * N * Math.sin(lat * Math.PI / 180), p) * 180 / Math.PI;
  }
  const N = a / Math.sqrt(1 - e2 * Math.sin(lat * Math.PI / 180) ** 2);
  const h = p / Math.cos(lat * Math.PI / 180) - N;
  return [lat, lon, h];
}
async function holeJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function holeBin(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}
function mat4Mal(a, b) {
  // 4x4 Column-Major Multiplikation (3D-Tiles-Tilesets): c = a * b.
  const c = new Array(16).fill(0);
  for (let s = 0; s < 4; s++) {
    for (let z = 0; z < 4; z++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + z] * b[s * 4 + k];
      c[s * 4 + z] = sum;
    }
  }
  return c;
}
const IDENTITAET = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mat4Punkt(m, p) {
  const x = p[0], y = p[1], z = p[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const s = w === 0 ? 1 : w;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / s,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / s,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / s,
  ];
}
function mat3Richtung(m, v) {
  // Nur Rotation/Scale (keine Translation) — fuer Normalen.
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ];
}
// ECEF-Ursprung P0 fuer ORIGIN (WGS84 a, e2) — einmalig berechnet.
function ecefAusWgs84(lat, lon, h) {
  const a = 6378137.0, e2 = 0.00669437999014;
  const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(la) * Math.sin(la));
  return [(N + (h || 0)) * Math.cos(la) * Math.cos(lo), (N + (h || 0)) * Math.cos(la) * Math.sin(lo), (N * (1 - e2) + (h || 0)) * Math.sin(la)];
}
const P0 = ecefAusWgs84(ORIGIN.lat, ORIGIN.lon, 0);
const PHI0 = ORIGIN.lat * Math.PI / 180;
const LAM0 = ORIGIN.lon * Math.PI / 180;
function ecefZuEnu(X, Y, Z) {
  const dX = X - P0[0], dY = Y - P0[1], dZ = Z - P0[2];
  const sLa = Math.sin(PHI0), cLa = Math.cos(PHI0);
  const sLo = Math.sin(LAM0), cLo = Math.cos(LAM0);
  const east = -sLo * dX + cLo * dY;
  const north = -sLa * cLo * dX - sLa * sLo * dY + cLa * dZ;
  const up = cLa * cLo * dX + cLa * sLo * dY + sLa * dZ;
  return [east, up, -north]; // x = east, y = up, z = -north
}
function nodeMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
  // TRS-Fallback (glTF): M = T * R * S.
  let m = IDENTITAET.slice();
  if (Array.isArray(node.scale)) {
    const s = node.scale;
    m = mat4Mal([s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1], m);
  }
  if (Array.isArray(node.rotation) && node.rotation.length === 4) {
    const q = node.rotation;
    const x = q[0], y = q[1], z = q[2], w = q[3];
    m = mat4Mal([1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0, 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0, 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, 0, 0, 0, 1], m);
  }
  if (Array.isArray(node.translation)) {
    const t = node.translation;
    m = mat4Mal([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1], m);
  }
  return m;
}
function gltfWeltmatrix(js) {
  // Node-Hierarchie: Welt = Eltern * ... * Kind (Szenen-Wurzeln zuerst).
  const nodes = js.nodes || [];
  if (!nodes.length) return IDENTITAET.slice();
  const kinder = new Set();
  nodes.forEach((n) => (n.children || []).forEach((k) => kinder.add(k)));
  const wurzeln = nodes.map((_, i) => i).filter((i) => !kinder.has(i));
  const start = (js.scenes && js.scenes[0] && js.scenes[0].nodes) || wurzeln;
  const welt = new Array(nodes.length).fill(null);
  function absteigend(idx, eltern) {
    const m = mat4Mal(eltern, nodeMatrix(nodes[idx] || {}));
    welt[idx] = m;
    ((nodes[idx] || {}).children || []).forEach((k) => absteigend(k, m));
  }
  start.forEach((i) => absteigend(i, IDENTITAET.slice()));
  // Mesh tragende Nodes kombinieren — hier: erster Mesh-Knoten.
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i] && nodes[i].mesh !== undefined && welt[i]) return welt[i];
  }
  return (welt[0] || IDENTITAET.slice());
}
async function alleKachelUris() {
  const ts = await holeJson(TILESET);
  const aufloesung = [];
  // Hierarchische Matrix-Kette: tileWorldMatrix = parent * (tile.transform || I).
  // Column-Major, von oben nach unten durchmultipliziert (Eltern -> Kind).
  (function walk(n, tiefe, eltern) {
    const r = n.boundingVolume && n.boundingVolume.region, c = n.content && n.content.uri;
    const eigen = Array.isArray(n.transform) && n.transform.length === 16 ? n.transform : IDENTITAET;
    const welt = mat4Mal(eltern, eigen);
    if (r && !n.children) aufloesung.push({ uri: c, region: r, tiefe, matrix: welt });
    (n.children || []).forEach((k) => walk(k, tiefe + 1, welt));
  })(ts.root, 0, IDENTITAET.slice());
  const box = [];
  for (const k of aufloesung) {
    if (!k.uri) continue;
    try {
      const sub = await holeJson(BASIS + k.uri);
      const uris = [];
      (function w2(n, eltern) {
        const r = n.boundingVolume && n.boundingVolume.region, c = n.content && n.content.uri;
        const eigen = Array.isArray(n.transform) && n.transform.length === 16 ? n.transform : IDENTITAET;
        const welt = mat4Mal(eltern, eigen);
        if (r && c) {
          const w = r[0] * 180 / Math.PI, s = r[1] * 180 / Math.PI, e = r[2] * 180 / Math.PI, nn = r[3] * 180 / Math.PI;
          // Kiez-Box: lon 9.9578..9.9725, lat 53.5525..53.5637 (mit Puffer).
          // TEST_MODUS: nur Testfleck (aus x/z zurueckgerechnet) — ~10 % der Fläche.
          let drin = e > 9.94 && w < 10.0 && nn > 53.545 && s < 53.575;
          if (TEST_MODUS) {
            const sw = lokaleNachWgs(TEST_BOX.minX, TEST_BOX.maxZ);
            const no = lokaleNachWgs(TEST_BOX.maxX, TEST_BOX.minZ);
            drin = e > sw[1] - 0.004 && w < no[1] + 0.004 && nn > sw[0] - 0.004 && s < no[0] + 0.004;
          }
          if (drin) uris.push({ uri: c, tileMatrix: mat4Mal(k.matrix, welt) });
        }
        (n.children || []).forEach((kk) => w2(kk, welt));
      })(sub.root, IDENTITAET.slice());
      for (const u of uris) {
        const basisOrdner = k.uri.split('/').slice(0, -1).join('/');
        // b3dm-Pfade sind relativ zur DATEN-Wurzel (15/xxxxx/YYYY.b3dm),
        // NICHT relativ zum Sub-Tileset-Ordner — '../../'-Prefixe abstreifen.
        // ABER: manche URIs (z. B. 12/...) sind relativ zum Sub-Tileset —
        // beide Varianten laden, erste erfolgreiche gewinnt (Fallback unten).
        const pfad = u.uri.replace(/^(\.\.\/)+/, '').replace(/^\//, '');
        const kandidaten = u.uri.startsWith('http') ? [u.uri] : [BASIS + pfad, BASIS + (basisOrdner ? basisOrdner + '/' : '') + pfad];
        box.push({ uris: kandidaten, tileMatrix: u.tileMatrix });
      }
    } catch (e) { /* Kachel ueberspringen */ }
  }
  // Doppelte URIs: erste Matrix gewinnt.
  const gesehen = new Map();
  for (const b of box) {
    const schluessel = b.uris[0];
    if (!gesehen.has(schluessel)) gesehen.set(schluessel, b);
  }
  return [...gesehen.values()];
}
function parseB3dm(buf) {
  const ft = buf.readUInt32LE(12), fb = buf.readUInt32LE(16), btj = buf.readUInt32LE(20), btb = buf.readUInt32LE(24);
  const feat = JSON.parse(buf.subarray(28, 28 + ft).toString('utf8'));
  const rtc = feat.RTC_CENTER;
  const batch = btj ? JSON.parse(buf.subarray(28 + ft + fb, 28 + ft + fb + btj).toString('utf8')) : null;
  const ids = batch && Array.isArray(batch.id) ? batch.id : [];
  const gstart = 28 + ft + fb + btj + btb;
  const jslen = buf.readUInt32LE(gstart + 12);
  const js = JSON.parse(buf.subarray(gstart + 20, gstart + 20 + jslen).toString('utf8').replace(/[^\x20-\x7e\u00a0-\uFFFF]/g, ''));
  const bin0 = gstart + 20 + jslen + 8;
  // WICHTIG: bufferViews sind relativ zum GLB-BIN-Start (nicht b3dm-Start)!
  // Interleaved: POSITION+VEC3-NORMAL teilen sich View 0 (Stride 24, POS off 12, NRM off 0).
  const glbBin0 = gstart + 20 + jslen;
  const binDaten = (bvOff) => glbBin0 + 8 + bvOff;
  const leser = (acc) => {
    const bv = js.bufferViews[acc.bufferView];
    const n = acc.count, out = [];
    const stride = bv.byteStride || 0;
    const basis = binDaten(bv.byteOffset || 0) + (acc.byteOffset || 0);
    const schritt = stride || (acc.type === 'VEC3' ? 12 : acc.componentType === 5126 ? 4 : acc.componentType === 5123 ? 2 : 4);
    if (acc.componentType === 5126) { for (let i = 0; i < n; i++) for (let k = 0; k < (acc.type === 'VEC3' ? 3 : 1); k++) out.push(buf.readFloatLE(basis + i * schritt + k * 4)); }
    else if (acc.componentType === 5123) { for (let i = 0; i < n; i++) out.push(buf.readUInt16LE(basis + i * schritt)); }
    else if (acc.componentType === 5125) { for (let i = 0; i < n; i++) out.push(buf.readUInt32LE(basis + i * schritt)); }
    return out;
  };
  const prim = js.meshes[0].primitives[0];
  const pos = leser(js.accessors[prim.attributes.POSITION]);
  const nor = leser(js.accessors[prim.attributes.NORMAL]);
  const bid = leser(js.accessors[prim.attributes._BATCHID]);
  const idx = leser(js.accessors[prim.indices]);
  // glTF-Node-Hierarchie (matrix bzw. TRS) als Weltmatrix, Column-Major.
  const nodeWelt = gltfWeltmatrix(js);
  return { rtc, ids, pos, nor, bid, idx, nodeWelt };
}
async function main() {
  console.log('[lod2] Tileset lesen ...');
  const uris = await alleKachelUris();
  console.log('[lod2] Kacheln in St.-Pauli-Box: ' + uris.length);
  if (!uris.length) throw new Error('keine Kacheln gefunden');
  const geb = new Map();
  let dreiecke = 0;
  // Skalen-Check: ENU-Meter vs. toLocalMeters() an der Lerchenstrasse.
  // Einmalig loggen, damit LoD2 deckungsgleich auf OSM-Strassen steht.
  let skalencheck = false;
  let kachelDbg = 0;
  for (let i = 0; i < uris.length; i++) {
    const eintrag = uris[i];
    const kandidaten = typeof eintrag === 'string' ? [eintrag.startsWith('http') ? eintrag : BASIS + eintrag.replace(/^\//, '')] : eintrag.uris;
    const tileMatrix = (eintrag && eintrag.tileMatrix) || IDENTITAET;
    let buf = null;
    let url = kandidaten[0];
    for (const k of kandidaten) {
      try {
        buf = await holeBin(k);
        url = k;
        break;
      } catch (e) { /* naechster Kandidat */ }
    }
    if (!buf) { console.warn('[lod2] Kachel ' + (i + 1) + ' unerreichbar: ' + kandidaten[0]); continue; }
    const { rtc, ids, pos, nor, bid, idx, nodeWelt } = parseB3dm(buf);
    if (kachelDbg < 3) {
      kachelDbg += 1;
      const nanpos = pos.filter((v) => !Number.isFinite(v)).length;
      console.log('[lod2] dbg kachel ' + (i + 1) + ': node=' + JSON.stringify(nodeWelt.slice(12).map((v) => Math.round(v * 10) / 10)) + ' rtc=[' + rtc.map((v) => Math.round(v)) + '] nan=' + nanpos + ' n=' + pos.length);
    }
    // Volle Kette: Vertex -> glTF-Node -> +RTC -> Tile-Matrix -> ECEF.
    const weltMatrix = mat4Mal(tileMatrix, nodeWelt || IDENTITAET);
// Kachel-Ueberlappung: dieselbe ALKIS-ID kann in 2 Kacheln stecken.
    // Nur uebernehmen, wenn Centroid in Box (+Puffer) liegt ODER neu ist.
    const VORHANDEN = new Set([...geb.keys()].filter((id) => {
      const g = geb.get(id);
      return g && g.sx / Math.max(1, g.n) > -505 && g.sx / Math.max(1, g.n) < 975;
    }));
    for (let t = 0; t < idx.length; t += 3) {
      const b = bid[idx[t]];
      const id = ids[b] || ('lod2_' + b + '_' + i);
      if (VORHANDEN.has(id)) continue; // Duplikat aus Nachbarkachel
      let g = geb.get(id);
      if (!g) { g = { id, wall: [], roof: [], minY: Infinity, maxY: -Infinity, sx: 0, sz: 0, n: 0, cnt: 0 }; geb.set(id, g); }
      if (g.cnt > 400) continue; // Kachel-Duplikat: ID schon reichlich belegt
      const tri = [];
      let ok = true;
      // Rotierte Normalen: glTF-3x3 -> Y-up→Z-up -> Tile-3x3, normiert.
      const en = [];
      const nMat = [
        tileMatrix[0], tileMatrix[1], tileMatrix[2],
        tileMatrix[4], tileMatrix[5], tileMatrix[6],
        tileMatrix[8], tileMatrix[9], tileMatrix[10],
      ];
      void nMat;
      for (let k = 0; k < 3; k++) {
        const ni = idx[t + k] * 3;
        const nNode = mat3Richtung(nodeWelt || IDENTITAET, [nor[ni], nor[ni + 1], nor[ni + 2]]);
        const nZ = yUpZuZUp(nNode);
        const r = mat3Richtung(tileMatrix, nZ);
        const l = Math.hypot(r[0], r[1], r[2]) || 1;
        en.push([r[0] / l, r[1] / l, r[2] / l]);
      }
      // ENU-Basis aus ECEF-Ableitung (numerisch, robust gegen Konventionen).
      const eps = 1.0;
      const eP = mat4Punkt(weltMatrix, [rtc[0] + eps, rtc[1], rtc[2]]);
      const e0 = mat4Punkt(weltMatrix, rtc);
      void eP; void e0;
      for (let k = 0; k < 3; k++) {
        const vi = idx[t + k] * 3;
        // Zwingende Reihenfolge: glTF-Node -> Y-up→Z-up -> +RTC -> ×tileMatrix.
        const zUp = yUpZuZUp(mat4Punkt(nodeWelt || IDENTITAET, [pos[vi], pos[vi + 1], pos[vi + 2]]));
        const mitRtc = [zUp[0] + rtc[0], zUp[1] + rtc[1], zUp[2] + rtc[2]];
        const ecef = mat4Punkt(tileMatrix, mitRtc);
        const enu = ecefZuEnu(ecef[0], ecef[1], ecef[2]);
        if (!Number.isFinite(enu[0]) || !Number.isFinite(enu[1]) || !Number.isFinite(enu[2])) { ok = false; break; }
        tri.push([enu[0], enu[1], enu[2]]);
        if (enu[1] < g.minY) g.minY = enu[1];
        if (enu[1] > g.maxY) g.maxY = enu[1];
        g.sx += enu[0]; g.sz += enu[2]; g.n++;
        if (!skalencheck && Math.abs(enu[0]) < 50 && Math.abs(enu[2]) < 50) {
          const wgs = ecefZuWgs84(ecef[0], ecef[1], ecef[2]);
          const m = toLocalMeters(wgs[0], wgs[1]);
          console.log('[lod2] skalencheck ENU=(' + enu[0].toFixed(1) + ',' + enu[2].toFixed(1) + ') vs OSM=(' + m[0].toFixed(1) + ',' + m[1].toFixed(1) + ')');
          skalencheck = true;
        }
      }
      if (!ok) continue;
      // ENU-Normalen: ECEF-Normale (rotiert) durch ENU-Basis am Ursprung.
      // Naeherung: Basisvektoren aus P0-Ableitungen (analytisch).
      const sLa = Math.sin(PHI0), cLa = Math.cos(PHI0), sLo = Math.sin(LAM0), cLo = Math.cos(LAM0);
      const basis = [[-sLo, cLo, 0], [-sLa * cLo, -sLa * sLo, cLa], [cLa * cLo, cLa * sLo, sLa]];
      let nySum = 0;
      for (let k = 0; k < 3; k++) {
        const n = en[k];
        const e = n[0] * basis[0][0] + n[1] * basis[0][1] + n[2] * basis[0][2];
        const nn = n[0] * basis[1][0] + n[1] * basis[1][1] + n[2] * basis[1][2];
        const u = n[0] * basis[2][0] + n[1] * basis[2][1] + n[2] * basis[2][2];
        void e; void nn;
        nySum += u;
      }
      (Math.abs(nySum / 3) < 0.5 ? g.wall : g.roof).push(tri);
      g.cnt += 1;
      dreiecke++;
    }
    console.log('[lod2] Kachel ' + (i + 1) + '/' + uris.length + ': ' + ids.length + ' Gebaeude');
  }
  const buildings = [];
  for (const g of geb.values()) {
    if (!g.n || !Number.isFinite(g.minY) || !Number.isFinite(g.maxY)) continue;
    // Plausibilitaet: Kiez-Box + 60 m Puffer (TEST_MODUS: nur Testfleck),
    // Hoehe 2..80 m (Ausreisser wie Fernmeldeturm fallen raus).
    const cx = g.sx / g.n;
    const cz = g.sz / g.n;
    if (TEST_MODUS) {
      if (cx < TEST_BOX.minX || cx > TEST_BOX.maxX || cz < TEST_BOX.minZ || cz > TEST_BOX.maxZ) continue;
    } else if (cx < -505 || cx > 975 || cz < -337 || cz > 546) continue;
    const h = g.maxY - g.minY;
    if (!(h >= 2 && h <= 80)) continue;
    const base = g.minY;
    const norm = (arr) => arr.map((tri) => tri.map((p) => [Math.round(p[0] * 10) / 10, Math.round((p[1] - base) * 10) / 10, Math.round(p[2] * 10) / 10]));
    const hh = Math.round(h * 10) / 10;
    buildings.push({ id: g.id, centroid: [Math.round(cx * 10) / 10, Math.round(cz * 10) / 10], minY: 0, maxY: hh, wallTriangles: norm(g.wall), roofTriangles: norm(g.roof) });
  }
  const daten = { meta: { origin: ORIGIN, testModus: TEST_MODUS || undefined, testBox: TEST_MODUS ? TEST_BOX : undefined, generatedAt: new Date().toISOString(), source: 'daten-hamburg.de 3D-Tiles LoD2 (b3dm) + 3D-Stadtmodell LoD2-DE', lizenz: LIZENZ, zaehlung: { buildings: buildings.length, dreiecke } }, buildings };
  fs.mkdirSync(path.dirname(OUT_DATEI), { recursive: true });
  fs.writeFileSync(OUT_DATEI, JSON.stringify(daten), 'utf8');
  console.log('[lod2]' + (TEST_MODUS ? '[testfleck]' : '') + ' Gespeichert: ' + OUT_DATEI + ': ' + buildings.length + ' LoD2-Gebaeude, ' + dreiecke + ' Dreiecke.');
}
if (require.main === module) { main().catch((e) => { console.error('[lod2] FEHLER: ' + e.message); process.exit(1); }); }
module.exports = { toLocalMeters, lokaleNachWgs, yUpZuZUp, ecefZuWgs84, ecefZuEnu, mat4Mal, mat4Punkt, nodeMatrix, gltfWeltmatrix, parseB3dm, TEST_BOX };

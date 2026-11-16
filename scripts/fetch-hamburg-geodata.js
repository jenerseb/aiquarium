/* Hamburg-Geodaten-Fetcher: Baeume + Einzelhaeuser fuers Cozy-Diorama.
 *
 *  1. Strassenbaumkataster-WFS (geodienste.hamburg.de,
 *     Layer de.hh.up:strassenbaumkataster, Lizenz dl-de/by-2.0) in unserer
 *     St.-Pauli-Box (GML, nativ EPSG:25832).
 *  2. ALKIS-Einzelhaeuser per GetCapabilities-Discovery; scheitert das,
 *     werden OSM-Gebaeude aus data/kiez_map.json uebernommen (holes=[]).
 *  3. Alles ins flache System von fetch-osm.js (+x Ost, -z Nord) und nach
 *     data/hamburg_geodata.json.
 *
 * Aufruf: node scripts/fetch-hamburg-geodata.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ORIGIN = { lat: 53.5588, lon: 9.9612 };
const BBOX = { south: 53.5525, west: 9.9578, north: 53.5637, east: 9.9725 };
const OUT_FILE = path.join(__dirname, '..', 'data', 'hamburg_geodata.json');
const KIEZ_FALLBACK = path.join(__dirname, '..', 'data', 'kiez_map.json');

const BAUM_WFS = 'https://geodienste.hamburg.de/HH_WFS_Strassenbaumkataster';
const BAUM_TYPENAME = 'de.hh.up:strassenbaumkataster';
// Echte ALKIS-Einzelhäuser: INSPIRE-WFS (exakte Layer aus GetCapabilities,
// verifiziert 2026-11-16). Lizenz: dl-de/by-2.0, FHH / LGV.
const ALKIS_WFS = 'https://geodienste.hamburg.de/HH_WFS_INSPIRE_Gebaeude_2D_ALKIS';
const ALKIS_TYPENAME = 'bu-core2d:Building';
const LIZENZ_GEB = 'Datenlizenz Deutschland – Namensnennung – 2.0 (Quelle: Freie und Hansestadt Hamburg, LGV)';
const ALKIS_KANDIDATEN = [
  ALKIS_WFS,
  'https://geodienste.hamburg.de/HH_WFS_ALKIS_vereinfacht',
  'https://geodienste.hamburg.de/HH_WFS_ALKIS',
  'https://geodienste.hamburg.de/HH_WFS_Gebaeude',
];

// GPS -> lokale Meter (+x Ost, -z Nord). 1:1 wie fetch-osm.js (alte Projektion).
function toLocalMeters(lat, lon) {
  const cosLat = Math.cos((ORIGIN.lat * Math.PI) / 180);
  const x = (lon - ORIGIN.lon) * 111320 * cosLat;
  const z = -(lat - ORIGIN.lat) * 111320;
  return [Math.round(x * 10) / 10, Math.round(z * 10) / 10];
}

// EPSG:25832 (UTM 32N) -> WGS84 (fuer Baumkoordinaten).
function utm32ZuWgs84(e, n) {
  const a = 6378137.0;
  const eccSq = 0.00669438;
  const k0 = 0.9996;
  const e1 = (1 - Math.sqrt(1 - eccSq)) / (1 + Math.sqrt(1 - eccSq));
  const m = n / k0;
  const mu = m / (a * (1 - eccSq / 4 - (3 * eccSq * eccSq) / 64 - (5 * eccSq * eccSq * eccSq) / 256));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 * e1 * e1) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 * e1 * e1 * e1) / 32) * Math.sin(4 * mu) +
    ((151 * e1 * e1 * e1) / 96) * Math.sin(6 * mu);
  const n1 = a / Math.sqrt(1 - eccSq * Math.sin(phi1) * Math.sin(phi1));
  const t1 = Math.tan(phi1) * Math.tan(phi1);
  const c1 = (eccSq / (1 - eccSq)) * Math.cos(phi1) * Math.cos(phi1);
  const r1 = (a * (1 - eccSq)) / Math.pow(1 - eccSq * Math.sin(phi1) * Math.sin(phi1), 1.5);
  const d = (e - 500000) / (n1 * k0);
  let lat = phi1 - ((n1 * Math.tan(phi1)) / r1) * ((d * d) / 2 - ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1) * d * d * d * d) / 24 + ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * c1 * c1) * d * d * d * d * d * d) / 720);
  lat = (lat * 180) / Math.PI;
  let lon = (d - ((1 + 2 * t1 + c1) * d * d * d) / 6 + ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 24) * d * d * d * d * d) / 120) / Math.cos(phi1);
  lon = 9 + (lon * 180) / Math.PI; // Zone 32N: Zentralmeridian 9 Grad Ost
  return [lat, lon];
}

// WGS84 -> EPSG:25832 (UTM 32N). Fuer die BBOX des Baum-WFS.
// Referenz: Lerchenstr./Otzenstr. (53.5588, 9.9612) liegt bei ca. E 564300, N 5935000.
function wgs84ZuUtm32(lat, lon) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const e2 = 2 * f - f * f;
  const ep2 = e2 / (1 - e2);
  const k0 = 0.9996;
  const lon0 = 9 * Math.PI / 180;
  const latR = lat * Math.PI / 180;
  const lonR = lon * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(latR) * Math.sin(latR));
  const T = Math.tan(latR) * Math.tan(latR);
  const C = ep2 * Math.cos(latR) * Math.cos(latR);
  const A = Math.cos(latR) * (lonR - lon0);
  const M = a * ((1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256) * latR
    - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 * e2 * e2 / 1024) * Math.sin(2 * latR)
    + (15 * e2 * e2 / 256 + 45 * e2 * e2 * e2 / 1024) * Math.sin(4 * latR)
    - (35 * e2 * e2 * e2 / 3072) * Math.sin(6 * latR));
  const e = k0 * N * (A + (1 - T + C) * A * A * A / 6
    + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A * A * A * A * A / 120) + 500000;
  const nn = k0 * (M + N * Math.tan(latR) * (A * A / 2
    + (5 - T + 9 * C + 4 * C * C) * A * A * A * A / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A * A * A * A * A * A / 720));
  return [Math.round(e * 10) / 10, Math.round(nn * 10) / 10];
}

// UTM32-BBOX aus der WGS84-Box (Baum-WFS spricht nativ 25832).
function bboxUtm32() {
  const ecken = [
    wgs84ZuUtm32(BBOX.south, BBOX.west),
    wgs84ZuUtm32(BBOX.south, BBOX.east),
    wgs84ZuUtm32(BBOX.north, BBOX.west),
    wgs84ZuUtm32(BBOX.north, BBOX.east),
  ];
  const es = ecken.map((p) => p[0]);
  const ns = ecken.map((p) => p[1]);
  return { minE: Math.min(...es), minN: Math.min(...ns), maxE: Math.max(...es), maxN: Math.max(...ns) };
}

async function holeText(url, ms) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AIquarium-Hamburg-MVP/0.2 (local-dev)', Accept: 'text/xml, */*' },
    signal: AbortSignal.timeout(ms || 60000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// --- Baeume: GML parsen (der WFS kann kein GeoJSON) ---
function parseBaeumeGml(gml) {
  const baeume = [];
  const teile = gml.split(/<wfs:member>|<gml:featureMember>/).slice(1);
  for (const t of teile) {
    const nimm = (re) => {
      const m = t.match(re);
      return m ? m[1].trim() : null;
    };
    const pos = nimm(/<gml:pos>\s*([^<]+?)\s*<\/gml:pos>/);
    if (!pos) continue;
    const nums = pos.split(/\s+/).map(Number);
    if (nums.length < 2 || !Number.isFinite(nums[0]) || !Number.isFinite(nums[1])) continue;
    const [lat, lon] = utm32ZuWgs84(nums[0], nums[1]);
    if (lat < BBOX.south - 0.01 || lat > BBOX.north + 0.01 || lon < BBOX.west - 0.01 || lon > BBOX.east + 0.01) continue;
    const [x, z] = toLocalMeters(lat, lon);
    const krone = Number(nimm(/kronendurchmesser>\s*([^<]+?)\s*</) || 5) || 5;
    const stamm = Number(nimm(/stammumfang>\s*([^<]+?)\s*</) || 0) || 0;
    // Der Kataster speichert KEINE Baumhoehe: Schaetzung aus
    // Kronendurchmesser + Stammumfang (Pappel 1959: 13m Krone, 271cm Stamm -> ~19m).
    const hoehe = Math.min(22, Math.max(4, Math.round((krone * 0.9 + stamm / 28) * 10) / 10)) || 8;
    baeume.push({
      id: nimm(/baumid>\s*([^<]+?)\s*</) || ('baum_' + baeume.length),
      x, z,
      kronendurchmesser: Math.max(2, Math.min(25, krone)),
      baumhoehe: hoehe,
      gattung_deutsch: nimm(/gattung_deutsch>\s*([^<]+?)\s*</) || nimm(/gattung>\s*([^<]+?)\s*</) || 'Laubbaum',
    });
  }
  return baeume;
}

async function ladeBaeume() {
  // Hinweis: WFS 2.0 mit EPSG:4326 erwartet Achsenfolge lat,lon.
  const bbox = BBOX.south + ',' + BBOX.west + ',' + BBOX.north + ',' + BBOX.east + ',urn:ogc:def:crs:EPSG::4326';
  const url = BAUM_WFS + '?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=' + encodeURIComponent(BAUM_TYPENAME) + '&BBOX=' + bbox;
  const gml = await holeText(url, 90000);
  if (gml.includes('ExceptionReport')) throw new Error('Baum-WFS meldet Exception');
  return parseBaeumeGml(gml);
}

// --- ALKIS: GetCapabilities-Discovery, dann GML-Geometrien ---
async function findeAlkisLayer() {
  for (const basis of ALKIS_KANDIDATEN) {
    try {
      const xml = await holeText(basis + '?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetCapabilities', 20000);
      if (xml.includes('Exception') || xml.includes('dataport-errorpages')) continue;
      const namen = [...xml.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1].trim());
      const treffer = namen.find((n) => /gebaeude|alkis|haus/i.test(n) && !/verwaltungs|flurstueck|grenze/i.test(n));
      if (treffer) return { basis, typename: treffer };
    } catch (e) { /* naechster Kandidat */ }
  }
  return null;
}

function gmlRingeZuFootprint(ringeGml) {
  const ringe = [];
  const ringTexte = [...ringeGml.matchAll(/<(?:gml:)?LinearRing>([\s\S]*?)<\/(?:gml:)?LinearRing>/g)];
  const quelle = ringTexte.length ? ringTexte.map((m) => m[1]) : [ringeGml];
  for (const rt of quelle) {
    const posList = rt.match(/<(?:gml:)?posList[^>]*>([^<]+)<\/(?:gml:)?posList>/);
    let coords = [];
    if (posList) {
      const nums = posList[1].trim().split(/\s+/).map(Number);
      for (let i = 0; i + 1 < nums.length; i += 2) coords.push([nums[i], nums[i + 1]]);
    } else {
      const poss = [...rt.matchAll(/<(?:gml:)?pos>\s*([^<]+?)\s*<\/(?:gml:)?pos>/g)];
      for (const m of poss) {
        const ab = m[1].trim().split(/\s+/).map(Number);
        if (Number.isFinite(ab[0]) && Number.isFinite(ab[1])) coords.push([ab[0], ab[1]]);
      }
    }
    const ring = coords.map(([a, b]) => {
      if (Math.abs(a) > 1000) {
        const ll = utm32ZuWgs84(a, b);
        return toLocalMeters(ll[0], ll[1]);
      }
      if (Math.abs(a) > 45 && Math.abs(a) < 60 && Math.abs(b) < 20) return toLocalMeters(a, b);
      return toLocalMeters(b, a);
    });
    if (ring.length > 1) {
      const e0 = ring[0];
      const e1 = ring[ring.length - 1];
      if (Math.hypot(e0[0] - e1[0], e0[1] - e1[1]) < 0.01) ring.pop();
    }
    if (ring.length >= 3) ringe.push(ring);
  }
  return ringe;
}

function parseAlkisGml(gml) {
  // INSPIRE 2D-Gebäude (bu-core2d:Building): MultiSurface/footPrint +
  // bu-base:numberOfFloorsAboveGround + currentUse-HREF (z. B. .../office).
  const buildings = [];
  const teile = gml.split(/<wfs:member>|<gml:featureMember>/).slice(1);
  for (const t of teile) {
    const nimm = (re) => {
      const m = t.match(re);
      return m ? m[1].trim() : null;
    };
    const surf = t.match(/<(?:gml:)?MultiSurface[\s>][\s\S]*?<\/(?:gml:)?MultiSurface>|<(?:gml:)?Polygon[\s>][\s\S]*?<\/(?:gml:)?Polygon>|<Polygon[\s>][\s\S]*?<\/Polygon>|<Surface[\s>][\s\S]*?<\/Surface>/);
    if (!surf) continue;
    // Innenhöfe: exterior = footprint, interior = holes.
    const ext = surf[0].match(/<(?:gml:)?exterior>[\s\S]*?<\/(?:gml:)?exterior>|<exterior>[\s\S]*?<\/exterior>/);
    const ints = [...surf[0].matchAll(/<(?:gml:)?interior>[\s\S]*?<\/(?:gml:)?interior>|<interior>[\s\S]*?<\/interior>/g)].map((m) => m[0]);
    const ringe = gmlRingeZuFootprint(ext ? ext[0] : surf[0]);
    const loecher = [];
    for (const im of ints) {
      for (const r of gmlRingeZuFootprint(im)) loecher.push(r);
    }
    if (!ringe.length) continue;
    const aogTxt = nimm(/numberOfFloorsAboveGround[^>]*>\s*([^<]+?)\s*</);
    const aog = Number(aogTxt || 0) || 0;
    const gemessen = Number(nimm(/(?:measuredHeight|gebaeudehoehe|hoehe)>\s*([^<]+?)\s*</i) || 0) || 0;
    const height = gemessen > 0 ? Math.min(40, gemessen) : aog > 0 ? Math.min(40, aog * 3.2) : 11;
    const gid = t.match(/gml:id="([^"]+)"/);
    const useHref = t.match(/currentUse[^>]*href="([^"]+)"/);
    const funk = useHref ? useHref[1].split('/').pop() : (nimm(/(?:funktion|nutzung|gebaeudefunktion)>\s*([^<]+?)\s*</i) || null);
    buildings.push({
      id: (gid && gid[1]) || nimm(/objektid>\s*([^<]+?)\s*</) || ('alkis_' + buildings.length),
      footprint: ringe[0],
      holes: loecher.length ? loecher : ringe.slice(1),
      height: Math.round(height * 10) / 10,
      function: funk,
    });
  }
  return buildings;
}

// INSPIRE-WFS: BBOX-Filter ist serverseitig kaputt (mixed SRID) -> Paging
// ohne BBOX, danach lokaler Box-Schnitt (der Dienst liefert nur Hamburg).
async function ladeAlkisPaging() {
  const alle = [];
  const gesehen = new Set();
  let start = 0;
  const SCHRITT = 3000;
  for (let seite = 0; seite < 60; seite += 1) {
    const url = ALKIS_WFS + '?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=' +
      encodeURIComponent(ALKIS_TYPENAME) + '&COUNT=' + SCHRITT + '&STARTINDEX=' + start;
    const gml = await holeText(url, 120000);
    if (gml.includes('ExceptionReport')) throw new Error('ALKIS-WFS meldet Exception (Paging)');
    const part = parseAlkisGml(gml);
    if (!part.length) break;
    let neu = 0;
    for (const b of part) {
      if (gesehen.has(b.id)) continue;
      gesehen.add(b.id);
      alle.push(b);
      neu += 1;
    }
    // Box-Abdeckung prüfen (lokale Meter: x -445..915, z -277..486 + Puffer).
    let inBox = 0;
    for (const b of alle) {
      let sx = 0;
      let sz = 0;
      for (const q of b.footprint) { sx += q[0]; sz += q[1]; }
      const cx = sx / b.footprint.length;
      const cz = sz / b.footprint.length;
      if (cx > -505 && cx < 975 && cz > -337 && cz < 546) inBox += 1;
    }
    console.log('[hamburg-geodata] ALKIS seite ' + (seite + 1) + ': +' + neu + ' (gesamt ' + alle.length + ', in zielbox ' + inBox + ')');
    if (inBox > 400 && seite >= 4) break; // Zielbox gut abgedeckt
    if (neu === 0) break;
    start += SCHRITT;
  }
  // Lokaler Box-Schnitt: St.-Pauli-Box (x -445..915, z -277..486) + 60 m Puffer.
  const inBox = alle.filter((b) => {
    let sx = 0;
    let sz = 0;
    for (const q of b.footprint) { sx += q[0]; sz += q[1]; }
    const cx = sx / b.footprint.length;
    const cz = sz / b.footprint.length;
    return cx > -445 - 60 && cx < 915 + 60 && cz > -277 - 60 && cz < 486 + 60;
  });
  // Echte lokale Umrechnung: aus UTM32 direkt nach (x, z).
  return { alle, inBox };
}

async function ladeAlkis() {
  // Primär: INSPIRE-WFS mit Paging (echte ALKIS-Einzelhäuser).
  try {
    const pg = await ladeAlkisPaging();
    if (pg.inBox.length > 100) {
      console.log('[hamburg-geodata] ALKIS-Paging: ' + pg.inBox.length + ' Einzelhäuser in Zielbox (aus ' + pg.alle.length + ' geladen).');
      return { buildings: pg.inBox, typename: ALKIS_TYPENAME };
    }
    console.warn('[hamburg-geodata] ALKIS-Paging zu dünn (' + pg.inBox.length + ') – versuche BBOX direkt.');
  } catch (err) {
    console.warn('[hamburg-geodata] ALKIS-Paging: ' + err.message + ' – versuche BBOX direkt.');
  }
  const info = await findeAlkisLayer();
  if (!info) throw new Error('kein ALKIS-WFS erreichbar (alle Kandidaten 404)');
  const bbox = BBOX.west + ',' + BBOX.south + ',' + BBOX.east + ',' + BBOX.north + ',urn:ogc:def:crs:EPSG::4326';
  const url = info.basis + '?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=' + encodeURIComponent(info.typename) + '&SRSNAME=urn:ogc:def:crs:EPSG::25832&BBOX=' + bbox;
  const gml = await holeText(url, 90000);
  if (gml.includes('ExceptionReport')) throw new Error('ALKIS-WFS meldet Exception');
  const buildings = parseAlkisGml(gml);
  if (!buildings.length) throw new Error('ALKIS-WFS lieferte 0 Gebaeude');
  return { buildings, typename: info.typename };
}

// --- Fallback: OSM-Bloecke als Einzelhaeuser ---
function fallbackAusKiezMap() {
  try {
    const m = JSON.parse(fs.readFileSync(KIEZ_FALLBACK, 'utf8'));
    const buildings = (m.buildings || [])
      .filter((b) => Array.isArray(b.footprint) && b.footprint.length >= 3)
      .map((b) => ({
        id: b.id,
        footprint: b.footprint,
        holes: [],
        height: Math.max(6, Math.min(30, Number(b.height) || (Number(b.levels) || 3) * 3.2 || 11)),
        function: b.type || null,
      }));
    return { buildings, quelle: 'kiez_map-fallback' };
  } catch (e) {
    return { buildings: [], quelle: 'leer' };
  }
}

async function main() {
  console.log('[hamburg-geodata] Box: ' + JSON.stringify(BBOX));
  let baeume = [];
  try {
    baeume = await ladeBaeume();
    console.log('[hamburg-geodata] Baeume: ' + baeume.length + ' echte Kiez-Baeume geladen.');
  } catch (err) {
    console.warn('[hamburg-geodata] Baum-WFS unerreichbar (' + err.message + ') - Baeume [].');
  }
  let buildings = [];
  let quelle = 'hamburg-wfs';
  let typename = null;
  try {
    const r = await ladeAlkis();
    buildings = r.buildings;
    typename = r.typename;
    quelle = 'hamburg-inspire-alkis';
    console.log('[hamburg-geodata] ALKIS: ' + buildings.length + ' Einzelhaeuser (' + typename + ').');
  } catch (err) {
    console.warn('[hamburg-geodata] ALKIS unerreichbar (' + err.message + ') - Fallback kiez_map.json.');
    const fb = fallbackAusKiezMap();
    buildings = fb.buildings;
    quelle = fb.quelle;
    console.log('[hamburg-geodata] Fallback: ' + buildings.length + ' Gebaeude aus kiez_map.json.');
  }
  const gebLizenz = quelle === 'hamburg-inspire-alkis' ? LIZENZ_GEB : 'Gebäude-Fallback: © OpenStreetMap contributors (ODbL)';
  const daten = {
    meta: {
      origin: ORIGIN,
      bbox: BBOX,
      generatedAt: new Date().toISOString(),
      source: quelle === 'hamburg-inspire-alkis' ? 'geodienste.hamburg.de INSPIRE-ALKIS (bu-core2d:Building) + Baumkataster' : 'geodienste.hamburg.de Baumkataster + OSM-Fallback (kiez_map.json)',
      alkisTypename: typename,
      lizenz: 'Bäume: Datenlizenz Deutschland - Namensnennung - 2.0 (Quelle: Freie und Hansestadt Hamburg, BUKA); ' + gebLizenz,
      zaehlung: { buildings: buildings.length, trees: baeume.length },
    },
    buildings,
    trees: baeume,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(daten, null, 2), 'utf8');
  console.log('[hamburg-geodata] Gespeichert: ' + OUT_FILE + ': ' + buildings.length + ' Einzelhaeuser, ' + baeume.length + ' echte Kiez-Baeume.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[hamburg-geodata] FEHLER: ' + err.message);
    try {
      const fb = fallbackAusKiezMap();
      fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
      fs.writeFileSync(OUT_FILE, JSON.stringify({ meta: { origin: ORIGIN, bbox: BBOX, generatedAt: new Date().toISOString(), source: 'notfall-fallback', lizenz: '(C) OpenStreetMap contributors (ODbL)', zaehlung: { buildings: fb.buildings.length, trees: 0 } }, buildings: fb.buildings, trees: [] }, null, 2), 'utf8');
    } catch (e) { /* egal */ }
    process.exit(1);
  });
}

module.exports = { toLocalMeters, bboxUtm32, parseBaeumeGml, parseAlkisGml, ORIGIN, BBOX };

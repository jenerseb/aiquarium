// fetch-luftbild.js — holt das DOP-Luftbild vom Hamburger WMS und schreibt
// public/kiez-aerial.jpg exakt passend zur Diorama-Scheibe.
//
// Quelle: HH WMS "dop_zeitreihe_belaubt" (Freie und Hansestadt Hamburg,
// Landesbetrieb Geoinformation und Vermessung, dl-de/by-2.0).
//   Service: https://geodienste.hamburg.de/wms_dop_zeitreihe_belaubt
//   Layer:   dop_zeitreihe_belaubt  (Zeitdimension 2005/2024/P1Y, default 2024)
//   SRS:     EPSG:4326 (GetMap akzeptiert minLon,minLat,maxLon,maxLat)
//
// Geometrie: identische Diorama-Mathematik wie src/server.js dioramaFuer() –
// Zentrum/Radius aus den POIs der Welt-DB (Fallback: SEED_POIS). Das Bild
// deckt exakt die 2r x 2r-Meter-Scheibe ab (Norden oben, quadratisch).
//
// Nutzung: node scripts/fetch-luftbild.js   (nach npm start mind. 1x gelaufen,
// damit die Welt-DB mit POIs existiert; funktioniert auch ohne DB via Seeds).

const fs = require('fs');
const path = require('path');

const ORIGIN = { lat: 53.5588, lon: 9.9612 }; // identisch zu scripts/fetch-osm.js
const DB_PFAD = '/home/node/.local/share/aiquarium/world.sqlite'; // = cfg.DB.defaultPfad
const WMS = 'https://geodienste.hamburg.de/wms_dop_zeitreihe_belaubt';
const LAYER = 'dop_zeitreihe_belaubt';
const JAHR = 2024; // neuester verfügbacher Jahrgang (Zeitreihe 2005..2024)
const PX = 2048;   // Auflösung: 2048 px auf ~1160 m => ~0.57 m/px
const OUT = path.join(__dirname, '..', 'public', 'kiez-aerial.jpg');

function dioramaFuer(pois) {
  const liste = (pois || []).filter((p) => Number.isFinite(Number(p.pos_x)) && Number.isFinite(Number(p.pos_z)));
  if (!liste.length) return { cx: 235, cz: 105, r: 560 };
  const xs = liste.map((p) => Number(p.pos_x));
  const zs = liste.map((p) => Number(p.pos_z));
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const maxD = Math.max(...liste.map((p) => Math.hypot(Number(p.pos_x) - cx, Number(p.pos_z) - cz)));
  let r = maxD + 90; // +90 statt +65: identisch zu server.js dioramaFuer
  if (cx - r < -290) r = cx + 290; // Westkante: Kappe auf -290, sonst klemmt das +90
  return { cx: Math.round(cx * 10) / 10, cz: Math.round(cz * 10) / 10, r: Math.round(Math.min(660, Math.max(400, r))) };
}

function poisAusDb() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PFAD, { readOnly: true });
    const rows = db.prepare('SELECT id, name, category, pos_x, pos_z FROM pois ORDER BY id').all();
    db.close();
    if (!rows.length) return null;
    return rows;
  } catch (err) {
    console.warn('[luftbild] Keine Welt-DB (' + err.message + ') — nutze SEED_POIS.');
    return null;
  }
}

function seedPois() {
  const db = require('../src/db.js');
  return db.SEED_POIS;
}

// Umkehrung von toLocalMeters() aus scripts/fetch-osm.js
function nachWgs84(x, z) {
  const cosLat = Math.cos((ORIGIN.lat * Math.PI) / 180);
  const lon = ORIGIN.lon + x / (111320 * cosLat);
  const lat = ORIGIN.lat - z / 111320;
  return { lat, lon };
}

async function main() {
  const pois = poisAusDb() || seedPois();
  const d = dioramaFuer(pois);
  console.log('[luftbild] Diorama: cx=' + d.cx + ' cz=' + d.cz + ' r=' + d.r + ' (' + pois.length + ' POIs)');
  const mitte = nachWgs84(d.cx, d.cz);
  const cosLat = Math.cos((ORIGIN.lat * Math.PI) / 180);
  const latSpan = d.r / 111320;
  const lonSpan = d.r / (111320 * cosLat);
  const bbox = [mitte.lon - lonSpan, mitte.lat - latSpan, mitte.lon + lonSpan, mitte.lat + latSpan].map((v) => v.toFixed(6)).join(',');
  console.log('[luftbild] BBox: ' + bbox);

  const url = WMS + '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=' + LAYER +
    '&STYLES=&FORMAT=image/jpeg&SRS=EPSG:4326&BBOX=' + bbox +
    '&WIDTH=' + PX + '&HEIGHT=' + PX + '&TIME=' + JAHR;
  console.log('[luftbild] Hole DOP ' + JAHR + ' (' + PX + 'x' + PX + ' px) ...');
  const res = await fetch(url, { signal: AbortSignal.timeout(150000) });
  if (!res.ok) throw new Error('WMS HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 10000) throw new Error('WMS-Antwort zu klein (' + buf.length + ' B) — vermutlich Fehlerbild');
  fs.writeFileSync(OUT, buf);
  console.log('[luftbild] Fertig: ' + OUT + ' (' + (buf.length / 1024).toFixed(0) + ' KiB, ' + PX + 'x' + PX + ')');
  console.log('[luftbild] Quelle: DOP ' + JAHR + ' belaubt, © Freie und Hansestadt Hamburg, LGV (dl-de/by-2.0)');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[luftbild] FEHLER: ' + err.message);
    process.exit(1);
  });
}

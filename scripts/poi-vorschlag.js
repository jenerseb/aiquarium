'use strict';
// POI-Vorschlaege aus dem OSM-Layer (lesend, kein Netz, kein DB-Schreibzugriff):
// Schlaegt die naechsten N benannten Amenities vor, die noch kein POI sind –
// mit Diorama-/Gebaeude-Filter (nur Pins zwischen echten 3D-Gebaeuden,
// westlich max. bis Max-Brauer-Allee, innerhalb des Diorama-Radius).
// Aufruf: node scripts/poi-vorschlag.js [N] [--kategorie kneipe,club]
// Ausgabe: Tabelle + kopierbarer SEED_POIS-Block fuer src/db.js.
// Danach: test-poi-snap -> Count in test-m1/test-m3 mitziehen -> reseed-pois -> npm test.
//
// Filter (Auftrag 17.11.2026):
//  - ausserhalb LoD2-Gebaeude-BBOX -> raus (kein 3D-Haus in der Naehe)
//  - x < -260 (westlich Max-Brauer-Allee) -> raus
//  - ausserhalb Diorama-Radius (Mitte + maxDist + 65, Westkante >= -260) -> raus
//  - < 40 m zum naechsten bestehenden POI -> raus (kein Doppel-Pin)
//  - unbenannt / bereits geseedet -> raus

const fs = require('node:fs');
const path = require('node:path');

const dbMod = require('../src/db');

// OSM-amenity -> unsere POI-Kategorie (muss in ECONOMY.priceBounds existieren)
const KATEGORIE_FUER = {
  bar: 'kneipe',
  pub: 'kneipe',
  restaurant: 'restaurant',
  fast_food: 'restaurant',
  cafe: 'cafe',
  cinema: 'kino',
  nightclub: 'club',
  arts_centre: 'club',
  community_centre: 'club',
  theatre: 'club',
  marketplace: 'markt',
};

// Spielwert: Gastro/Kultur zuerst, Gedenksteine nur als Lückenfüller
// (Stolpersteine sind wichtig, aber 10× Denkmal am Stück ist kein guter Batch).
const GEWICHT_FUER = {
  kneipe: 100, club: 95, restaurant: 90, cafe: 85, kino: 80, markt: 70, denkmal: 10,
};

function kategorieFuer(o) {
  if (o.amenity && KATEGORIE_FUER[o.amenity]) return KATEGORIE_FUER[o.amenity];
  if (o.historic === 'bunker' || o.historic === 'memorial' || o.historic === 'monument') return 'denkmal';
  return null;
}

function idVorschlag(name) {
  return String(name || '')
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28) || 'poi_neu';
}

function lod2Bbox(lod2) {
  const xs = lod2.buildings.map((b) => b.centroid[0]);
  const zs = lod2.buildings.map((b) => b.centroid[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

function dioramaFuer(pois) {
  const xs = pois.map((p) => Number(p.pos_x));
  const zs = pois.map((p) => Number(p.pos_z));
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const maxD = Math.max(...pois.map((p) => Math.hypot(Number(p.pos_x) - cx, Number(p.pos_z) - cz)));
  let r = maxD + 65;
  if (cx - r < -260) r = cx + 260;
  return { cx, cz, r: Math.min(580, Math.max(400, r)) };
}

function main() {
  const args = process.argv.slice(2).map((a) => String(a).trim());
  const n = Math.max(1, Math.min(50, Number(args.find((a) => /^\d+$/.test(a))) || 10));
  const katParam = args.find((a) => a.startsWith('--kategorie'));
  const katWert = katParam && katParam.includes('=') ? katParam.split('=')[1] : '';
  const katFilter = katWert ? new Set(katWert.split(',').map((s) => s.trim()).filter(Boolean)) : null;

  const karte = dbMod.ladeKiezKarte();
  if (!karte || !Array.isArray(karte.osmPois)) throw new Error('kiez_map.json mit osmPois-layer erwartet');
  let lod2 = null;
  try {
    const roh = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hamburg_lod2.json'), 'utf8'));
    if (roh && Array.isArray(roh.buildings) && roh.buildings.length > 50) lod2 = roh;
  } catch { /* ohne LoD2 kein Filter */ }
  const box = lod2 ? lod2Bbox(lod2) : null;
  const scheibe = dioramaFuer(dbMod.SEED_POIS);
  console.log(`[poi] filter: lod2-box ${box ? `${box.minX}/${box.minZ}..${box.maxX}/${box.maxZ}` : 'ohne'} | scheibe mitte (${scheibe.cx.toFixed(0)},${scheibe.cz.toFixed(0)}) r=${scheibe.r.toFixed(0)} | allee-grenze x>=-260`);

  const vergeben = new Set(dbMod.SEED_POIS.flatMap((p) => [p.id, p.match && p.match.osm].filter(Boolean)));
  const kriterien = [];
  for (const o of karte.osmPois) {
    const name = String(o.name || '').trim();
    if (!name) continue; // unbenannt -> raus
    if (vergeben.has(o.osm)) continue; // bereits geseedet -> raus
    const kat = kategorieFuer(o);
    if (!kat) continue;
    if (katFilter && !katFilter.has(kat)) continue;
    const [x, z] = o.pos;
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    if (x < -260) continue; // westlich Max-Brauer-Allee -> raus
    if (box && (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ)) continue; // kein 3D-Haus -> raus
    if (Math.hypot(x - scheibe.cx, z - scheibe.cz) > scheibe.r - 4) continue; // ausserhalb Scheibe -> raus
    const nah = Math.min(...dbMod.SEED_POIS.map((p) => Math.hypot(Number(p.pos_x) - x, Number(p.pos_z) - z)));
    if (nah < 40) continue; // Doppel-Pin -> raus
    const apt = Math.hypot(x - (-3), z - (-114));
    kriterien.push({ o, name, kat, x, z, nah, apt });
  }
  // Ranking: Spielwert (Gastro/Kultur vor Denkmal) -> nah am Apartment -> weit weg vom naechsten POI
  kriterien.sort((a, b) => ((GEWICHT_FUER[b.kat] || 0) - (GEWICHT_FUER[a.kat] || 0)) || (a.apt - b.apt) || (b.nah - a.nah));
  const top = kriterien.slice(0, n);
  console.log(`[poi] ${kriterien.length} kandidaten, top ${top.length}:`);
  for (const [i, k] of top.entries()) {
    console.log(`  ${i + 1}. ${k.name} [${k.kat}] @(${k.x},${k.z}) osm=${k.o.osm} apt=${k.apt.toFixed(0)}m naechster-poi=${k.nah.toFixed(0)}m`);
  }
  console.log('\n--- SEED_POIS-Block (in src/db.js ans Ende, vor spaeti/praxis) ---');
  for (const k of top) {
    const id = idVorschlag(k.name);
    console.log(`  { id: '${id}', name: '${k.name.replace(/'/g, "\\'")}', category: '${k.kat}',`);
    console.log(`    match: { osm: '${k.o.osm}' }, pos_x: ${k.x}, pos_z: ${k.z}, discovered: 0,`);
    console.log(`    public_desc: '${k.name.replace(/'/g, "\\'")} – TODO: 1 Satz Atmosphaere.' },`);
  }
  console.log('--- danach: test-poi-snap -> counts -> reseed-pois -> npm test ---');
}

try {
  main();
} catch (err) {
  console.error('[poi] FEHLER:', err.message);
  process.exit(1);
}

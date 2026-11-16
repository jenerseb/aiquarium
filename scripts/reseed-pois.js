'use strict';
// POI-Reseed AUS DEM OSM-LAYER: matcht SEED_POIS.match gegen kiez_map.json
// (osmPois/buildings), bewahrt discovered/Charakter/Memories. Backup: /tmp/world-backup-vor-reseed.sqlite
// Aufruf: node scripts/reseed-pois.js [db-pfad]   (Default: Live-DB aus config)

const { DatabaseSync } = require('node:sqlite');
const { DB } = require('../src/config');
const dbMod = require('../src/db');

function main() {
  const pfad = process.argv[2] || DB.defaultPfad;
  const k = dbMod.ladeKiezKarte();
  const db = new DatabaseSync(pfad);
  db.exec('PRAGMA journal_mode = WAL;');
  const upd = db.prepare('UPDATE pois SET pos_x = ?, pos_z = ?, name = ? WHERE id = ?');
  const neu = db.prepare('INSERT OR IGNORE INTO pois (id, name, category, pos_x, pos_z, public_desc, discovered) VALUES (?, ?, ?, ?, ?, ?, 0)');
  for (const p of dbMod.SEED_POIS) {
    let mx = p.pos_x;
    let mz = p.pos_z;
    if (p.match && p.match.osm && k && Array.isArray(k.osmPois)) {
      const o = k.osmPois.find((q) => q.osm === p.match.osm);
      if (o && Array.isArray(o.pos)) { mx = o.pos[0]; mz = o.pos[1]; }
    }
    if (p.match && p.match.building && k && Array.isArray(k.buildings)) {
      const b = k.buildings.find((q) => q.id === p.match.building);
      if (b && Array.isArray(b.footprint) && b.footprint.length) {
        let sx = 0;
        let sz = 0;
        for (const q of b.footprint) { sx += q[0]; sz += q[1]; }
        mx = Math.round((sx / b.footprint.length) * 10) / 10;
        mz = Math.round((sz / b.footprint.length) * 10) / 10;
      }
    }
    neu.run(p.id, p.name, p.category, mx, mz, p.public_desc);
    const r = upd.run(mx, mz, p.name, p.id);
    console.log(`${p.id}: @(${mx},${mz}) (zeilen: ${r.changes})`);
  }
  // Charakter-Fußpunkt auf Apartment zurücksetzen, falls er im Nichts steht
  const ch = db.prepare('SELECT pos_x, pos_z FROM character WHERE status = ? ORDER BY id LIMIT 1').get('alive');
  if (ch) {
    let bd = 1e9;
    const k = require('../src/db').ladeKiezKarte();
    for (const s of k.streets) for (const pt of s.points) bd = Math.min(bd, Math.hypot(pt[0] - ch.pos_x, pt[1] - ch.pos_z));
    console.log(`charakter @(${ch.pos_x},${ch.pos_z}): ${bd.toFixed(1)} m zum Netz${bd > 15 ? ' → auf apartment gesetzt' : ''}`);
    if (bd > 15) db.prepare("UPDATE character SET pos_x = -3, pos_z = -68, inside_poi = 'apartment' WHERE status = 'alive'").run();
  }
  console.log('POIS nachher:');
  for (const p of db.prepare('SELECT id, pos_x, pos_z, discovered, name FROM pois').all()) {
    console.log(`  ${p.id} @(${p.pos_x},${p.pos_z}) disc=${p.discovered} :: ${p.name}`);
  }
  db.close();
  console.log('RESEED OK (Backup: /tmp/world-backup-vor-reseed.sqlite)');
}

try {
  main();
} catch (err) {
  console.error('[reseed] FEHLER:', err.message);
  process.exit(1);
}

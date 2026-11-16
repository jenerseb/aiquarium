'use strict';
// Welt-Reset: Welt-DB löschen, damit beim nächsten npm start von Null gestartet wird.
// Standardpfad: ~/.local/share/aiquarium/world.sqlite (per AIQUARIUM_DB in .env änderbar).
// Aufruf:
//   node scripts/reset-world.js            → Backup nach world.sqlite.bak-<Zeit> + DB löschen
//   node scripts/reset-world.js --hard     → ohne Backup direkt löschen
//   node scripts/reset-world.js --pfad=/p/w.sqlite → anderen Pfad
const fs = require('node:fs');
const path = require('node:path');
require('../src/env').load();
const cfg = require('../src/config');

function main() {
  const args = process.argv.slice(2);
  const hard = args.includes('--hard');
  const pfadArg = (args.find((a) => a.startsWith('--pfad=')) || '').split('=')[1];
  const pfad = pfadArg || cfg.DB.defaultPfad;
  const dateien = [pfad, `${pfad}-wal`, `${pfad}-shm`].filter((f) => fs.existsSync(f));
  if (dateien.length === 0) {
    console.log('[reset] Keine Welt-DB gefunden unter', pfad, '– nichts zu tun (wird beim Start neu angelegt).');
    return;
  }
  const laeuft = () => {
    try {
      const out = require('node:child_process').execSync('curl -s -m 2 http://localhost:3077/api/health', { encoding: 'utf8' });
      return out.includes('ok') || out.includes('aiquarium');
    } catch { return false; }
  };
  // Guard nur, wenn die Ziel-Datei genau die ist, die der Server auf Port 3077
  // (Standard- oder AIQUARIUM_DB-Pfad) geöffnet haben könnte. Fremde Test-Pfade
  // dürfen immer gelöscht werden.
  if (laeuft() && path.resolve(pfad) === path.resolve(cfg.DB.defaultPfad)) {
    console.error('[reset] ACHTUNG: Der Server scheint gerade zu laufen (Port 3077).');
    console.error('          Erst stoppen (Ctrl+C), dann wieder ausführen – sonst schreibt er die DB neu.');
    process.exit(1);
  }
  if (!hard) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = `${pfad}.bak-${stamp}`;
    fs.copyFileSync(pfad, bak);
    console.log('[reset] Backup angelegt:', bak);
  }
  for (const f of dateien) {
    fs.rmSync(f, { force: true });
    console.log('[reset] Gelöscht:', f);
  }
  console.log('[reset] Fertig. Jetzt starten mit: npm start');
}

main();
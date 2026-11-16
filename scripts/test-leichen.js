'use strict';
const fs = require('node:fs');
const assert = require('node:assert');
const src = '/workspaces/seb-dev/aiquarium/aiquarium-app/public/scene.js';
const code = fs.readFileSync(src, 'utf8');
for (const d of ['const lichtStufe', 'function berechneLicht', 'import { TEXTUR_FAKTOR', 'dioramaFarbe', 'const nx = -dz']) {
  assert.ok(code.indexOf(d) >= 0, 'Referenz fehlt: ' + d);
}
const mod = fs.readFileSync('/workspaces/seb-dev/aiquarium/aiquarium-app/public/engine/diorama.js', 'utf8');
for (const d of ['export const TEXTUR_FAKTOR', 'export function dioramaFarbe']) {
  assert.ok(mod.indexOf(d) >= 0, 'Modul-Export fehlt: ' + d);
// TDZ-Ordnung: const-Deklaration muss VOR erster Verwendung in derselben Funktion stehen.
const lines = code.split('\n');
function zeileVon(muster, ab) {
  for (let i = ab || 0; i < lines.length; i++) if (lines[i].indexOf(muster) >= 0) return i;
  return -1;
}
for (const [def, use] of [['const farbe = grundFarbe', 'const key = `Fx'], ['import { TEXTUR_FAKTOR', 'TEXTUR_FAKTOR}_'], ['const lichtStufe', 'lichtStufe *']]) {
  const di = zeileVon(def, 0);
  const ui = zeileVon(use, 0);
  assert.ok(di >= 0 && ui >= 0 && di < ui, 'TDZ-Reihenfolge verletzt: ' + def + ' (Z' + (di + 1) + ') muss vor ' + use + ' (Z' + (ui + 1) + ') stehen');
}

}
console.log('[leichen] ALLES OK');

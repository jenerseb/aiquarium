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
}
console.log('[leichen] ALLES OK');

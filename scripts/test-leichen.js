'use strict';
const fs = require('node:fs');
const assert = require('node:assert');
const SZ = '/workspaces/seb-dev/aiquarium/aiquarium-app/public/scene.js';
const code = fs.readFileSync(SZ, 'utf8');
for (const d of ['const licht', 'function berechneLicht', 'import { TEXTUR_FAKTOR', 'dioramaFarbe', 'const nx = -dz']) {
  assert.ok(code.indexOf(d) >= 0, 'Referenz fehlt: ' + d);
}
const lines = code.split('\n');
const fz = lines.findIndex((l) => l.indexOf('function fassadenTextur(') >= 0);
const posAb = (frag) => { for (let i = fz; i < lines.length; i++) if (lines[i].indexOf(frag) >= 0) return i + 1; return -1; };
const pFarbe = posAb('const farbe = grundFarbe');
const pKey = posAb('Fx${bR}_H${hR}');
const pG = posAb('const g = c.getContext');
const pGNutz = posAb('g.fillStyle = farbe');
assert.ok(pFarbe > 0 && pKey > 0 && pG > 0 && pGNutz > 0, 'Deklarationen fehlen');
assert.ok(pFarbe < pKey, 'TDZ: farbe (' + pFarbe + ') nach key (' + pKey + ')');
assert.ok(pG < pGNutz, 'TDZ: g (' + pG + ') nach Nutzung (' + pGNutz + ')');
console.log('[leichen] ALLES OK (farbe@' + pFarbe + ' key@' + pKey + ' g@' + pG + ')');

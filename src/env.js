'use strict';
// Minimaler .env-Leser: kein npm-Paket nötig. Wird ganz am Anfang von server.js geladen,
// weil config.js Variablen schon beim Import ausliest.
const fs = require('node:fs');
const path = require('node:path');

const ZEILE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function parse(text) {
  const out = {};
  for (const roh of String(text).split(/\r?\n/)) {
    const zeile = roh.trim();
    if (!zeile || zeile.startsWith('#')) continue;
    const m = zeile.match(ZEILE);
    if (!m) continue;
    let wert = m[2].trim();
    // Anführungszeichen entfernen, Rest bleibt wie er ist (Keys enthalten keine Leerzeichen)
    if ((wert.startsWith('"') && wert.endsWith('"')) || (wert.startsWith("'") && wert.endsWith("'"))) {
      wert = wert.slice(1, -1).trim();
    }
    out[m[1]] = wert;
  }
  return out;
}

/**
 * Liest die .env und setzt fehlende Umgebungsvariablen.
 * Vorhandene Variablen (z. B. aus systemd oder der Shell) haben Vorrang.
 */
function load(file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return { geladen: false, datei: file, keys: [], fehlend: [] };
  const vars = parse(fs.readFileSync(file, 'utf8'));
  const gesetzt = [];
  const leer = [];
  for (const [k, v] of Object.entries(vars)) {
    if (v === '') { leer.push(k); continue; }
    if (process.env[k] === undefined) {
      process.env[k] = v;
      gesetzt.push(k);
    }
  }
  return { geladen: true, datei: file, keys: gesetzt, fehlend: leer };
}

module.exports = { load, parse };

'use strict';
// Namensgenerator: Vorname + Komposit-Nachname, bei Dopplung römische Ziffer.
const FIRST = [
  'Wanda', 'Emil', 'Frida', 'Robert', 'Hilde', 'Gustav', 'Lotte', 'Bruno', 'Otto', 'Konrad',
  'Marta', 'Anton', 'Rosa', 'Erwin', 'Ilse', 'Kurt', 'Elsa', 'Wilhelm', 'Grete', 'Heinz',
  'Sepp', 'Resi', 'Kuno', 'Hedi', 'Bernd', 'Gerda', 'Paul', 'Mina', 'Tino', 'Alma',
];
const A = [
  'Krumm', 'Rost', 'Zangen', 'Blech', 'Klump', 'Funken', 'Schrumm', 'Wackel', 'Muff', 'Rauh',
  'Zink', 'Quetsch', 'Zappel', 'Knarz', 'Kantig', 'Kratz', 'Schief', 'Mürb', 'Torkel', 'Rappel',
  'Gries', 'Flick', 'Wucht', 'Stotter', 'Nörgel', 'Hoppel', 'Filz', 'Klemm', 'Brumm', 'Splitter',
];
const B = [
  'hand', 'bart', 'fuß', 'kelle', 'maul', 'kopf', 'bauch', 'nacken', 'zahn', 'kralle',
  'nase', 'wange', 'rippe', 'schädel', 'ohr', 'kinn', 'zehe', 'feder', 'kragen', 'stiefel',
];

function pick(arr, rnd) {
  return arr[Math.floor(rnd() * arr.length)];
}

// 1 -> I, 2 -> II, 4 -> IV ... bis 20 reicht, danach Zahl
function roman(n) {
  const map = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  if (n < 1 || n > 20) return String(n);
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}

function baseName(rnd = Math.random) {
  return `${pick(FIRST, rnd)} ${pick(A, rnd)}${pick(B, rnd)}`;
}

// Eindeutiger Name: bei Kollision römische Ziffer anhängen (Martin Kraftschwein II)
function uniqueName(existing = [], rnd = Math.random) {
  const used = new Set(existing);
  const base = baseName(rnd);
  if (!used.has(base)) return base;
  for (let i = 2; i <= 20; i += 1) {
    const cand = `${base} ${roman(i)}`;
    if (!used.has(cand)) return cand;
  }
  return `${base} ${Date.now() % 1000}`;
}

function randomHue(rnd = Math.random, base = 200, spread = 25) {
  return Math.round(base + (rnd() * 2 - 1) * spread);
}

module.exports = { baseName, uniqueName, roman, randomHue, FIRST, A, B };

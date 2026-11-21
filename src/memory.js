'use strict';
// Gedächtnis-Mathe (§6.2): worth-Berechnung, First-to-go, Slot-Limits.
// Reine Funktionen + kleine DB-Helfer, damit alles ohne Modell testbar ist.

const { MEMORY } = require('./config');

const MAX_SHORT = (MEMORY && MEMORY.maxShort) || 25;
const MAX_LONG = (MEMORY && MEMORY.maxLong) || 25;
const DECAY_SHORT = (MEMORY && MEMORY.decayShort) || 0.25;
const DECAY_LONG = (MEMORY && MEMORY.decayLong) || 0.03;

function tageSeit(datumIso, jetztMs) {
  if (!datumIso) return 0;
  const dann = Date.parse(String(datumIso).replace(' ', 'T') + 'Z');
  if (!Number.isFinite(dann)) return 0;
  const jetzt = jetztMs || Date.now();
  return Math.max(0, (jetzt - dann) / 86400000);
}

function berechneWorth(mem, jetztMs) {
  const w0 = Number(mem.initial_weight) || 0;
  const cb = Number(mem.come_back_count) || 0;
  const alter = tageSeit(mem.created_at, jetztMs);
  const decay = mem.tier === 'long' ? DECAY_LONG : DECAY_SHORT;
  return w0 + Math.log(1 + cb) * 1.5 - alter * decay;
}

function firstToGo(memories, jetztMs) {
  if (!memories || memories.length === 0) return null;
  let schlechteste = memories[0];
  let minWorth = berechneWorth(schlechteste, jetztMs);
  for (const m of memories.slice(1)) {
    const w = berechneWorth(m, jetztMs);
    if (w < minWorth) { minWorth = w; schlechteste = m; }
  }
  return { memory: schlechteste, worth: minWorth };
}

// Neue Erinnerung nur aufnehmen, wenn Platz ist oder ihr Startgewicht
// das worth des schwächsten Eintrags übertrifft (§6.2-Verdrängung).
function darfAufnehmen(memories, tier, startGewicht, jetztMs) {
  const max = tier === 'long' ? MAX_LONG : MAX_SHORT;
  const imTier = (memories || []).filter((m) => m.tier === tier);
  if (imTier.length < max) return { ok: true, grund: 'platz_frei' };
  const f = firstToGo(imTier, jetztMs);
  if (!f) return { ok: true, grund: 'platz_frei' };
  if (Number(startGewicht) > f.worth) return { ok: true, grund: 'verdraengt', ersetztId: f.memory.id };
  return { ok: false, grund: 'zu_leicht', firstToGoId: f.memory.id, firstToGoWorth: f.worth };
}

function topMemories(memories, limit, jetztMs) {
  const n = limit == null ? 10 : limit;
  return (memories || [])
    .map((m) => ({ ...m, worth: berechneWorth(m, jetztMs) }))
    .sort((a, b) => b.worth - a.worth)
    .slice(0, n);
}

// DB-Helfer ---------------------------------------------------------------

function ladeMemories(db, characterId) {
  return db.prepare('SELECT * FROM memories WHERE character_id = ?').all(characterId);
}

function passtZuKontext(m, kontext) {
  if (!kontext) return true;
  const txt = String(m.text || '').toLowerCase();
  const poi = String(kontext.insidePoi || '').toLowerCase();
  const wo = String(kontext.woName || '').toLowerCase();
  if (poi && txt.includes(poi)) return true;
  if (wo && wo.length >= 4 && txt.includes(wo.slice(0, 6))) return true;
  if (poi === 'apartment' && (txt.includes('wohnung') || txt.includes('beckstrasse') || m.kind === 'read' || m.kind === 'work')) return true;
  if (kontext.action === 'work_shift' && m.kind === 'work') return true;
  return false;
}

// Come-back-Zähler erhöhen + worth neu berechnen (beim Einbinden in Prompt).
// Steigert come_back_count nur noch bei Kontext-Bezug (oder ohne Kontext für Rückwärtskompatibilität).
function einbindenUndZaehlen(db, characterId, limit, jetztMs, kontext) {
  const alle = ladeMemories(db, characterId);
  const jetzt = jetztMs || Date.now();
  const top = topMemories(alle, limit == null ? 10 : limit, jetzt);
  const upd = db.prepare("UPDATE memories SET come_back_count = come_back_count + 1, worth = ?, last_recalled_at = datetime('now') WHERE id = ?");
  for (const m of top) {
    if (!passtZuKontext(m, kontext)) continue;
    const neu = berechneWorth({ ...m, come_back_count: (Number(m.come_back_count) || 0) + 1 }, jetzt);
    upd.run(neu, m.id);
    m.worth = neu;
    m.come_back_count = (Number(m.come_back_count) || 0) + 1;
  }
  return top;
}

function speichereMemory(db, characterId, daten) {
  const alle = ladeMemories(db, characterId);
  const tier = daten.tier || 'short';
  const start = daten.initial_weight != null ? Number(daten.initial_weight) : 3.0;
  const check = darfAufnehmen(alle, tier, start);
  if (!check.ok) return { aufgenommen: false, ...check };
  let ersetzt = null;
  if (check.grund === 'verdraengt') {
    ersetzt = check.ersetztId;
    db.prepare('DELETE FROM memories WHERE id = ?').run(ersetzt);
  }
  const r = db.prepare(
    'INSERT INTO memories (character_id, tier, kind, text, retrospective, initial_weight, come_back_count, worth) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(characterId, tier, daten.kind || 'moment', daten.text || '',
    daten.retrospective || null, start, daten.come_back_count || 1, start);
  return { aufgenommen: true, id: Number(r.lastInsertRowid), ersetztId: ersetzt };
}

module.exports = {
  MAX_SHORT, MAX_LONG, DECAY_SHORT, DECAY_LONG,
  tageSeit, berechneWorth, firstToGo, darfAufnehmen, topMemories,
  ladeMemories, einbindenUndZaehlen, speichereMemory,
};

'use strict';
// Telegram-Bridge (§8 + M2): ausgehende Zettel/SMS/Mail an Bot+Chat senden,
// Antworten per getUpdates einspeisen (Job-Zusagen, Notizen).
// Ohne .env-Keys: sauberer Log-Fallback, kein Absturz.

function konfig() {
  return {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  };
}

function istAktiv() {
  const k = konfig();
  return Boolean(k.token && k.chatId);
}

async function sendeAnTelegram(text) {
  const k = konfig();
  if (!istAktiv()) {
    console.log('[telegram:aus] ' + String(text).slice(0, 300));
    return { ok: false, grund: 'nicht_konfiguriert', fallback: 'log' };
  }
  try {
    const url = `https://api.telegram.org/bot${k.token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: k.chatId, text: String(text).slice(0, 4000) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const daten = await res.json();
    return { ok: true, message_id: daten && daten.result ? daten.result.message_id : null };
  } catch (err) {
    console.log('[telegram:fehler] ' + err.message);
    return { ok: false, grund: err.message, fallback: 'log' };
  }
}

// Ausgehende Nachricht aus der Outbox versenden (vom Tick aufgerufen).
async function sendeNachricht(db, nachricht) {
  const text = `[${nachricht.channel}] ${nachricht.content || ''}`.slice(0, 4000);
  const res = await sendeAnTelegram(text);
  if (res.ok && res.message_id) {
    try {
      db.prepare('UPDATE messages_outbox SET telegram_msg_id = ?, status = ? WHERE id = ?')
        .run(res.message_id, 'sent', nachricht.id);
    } catch { /* outbox-eintrag evtl. nur virtuell */ }
  }
  return res;
}


// Eingehende Antworten abholen: getUpdates, als Ereignisse/Jobs einspeisen.
// Antwort-Format aus dem Plan: "JA <Kiezling> Spuelhilfe <Lohn>" oder freier Text.
async function pollAntworten(db, characterId) {
  const k = konfig();
  if (!istAktiv()) return { ok: false, grund: 'nicht_konfiguriert', neu: [] };
  let offset = 0;
  try {
    const r = db.prepare("SELECT stats_24h_json FROM world_state WHERE id = 1").get();
    const s = r ? JSON.parse(r.stats_24h_json || '{}') : {};
    offset = Number(s.tg_offset) || 0;
  } catch { offset = 0; }
  try {
    const url = `https://api.telegram.org/bot${k.token}/getUpdates?timeout=5&offset=${offset + 1}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const daten = await res.json();
    const neu = [];
    let maxId = offset;
    for (const u of (daten.result || [])) {
      maxId = Math.max(maxId, Number(u.update_id) || 0);
      const text = String((u.message && u.message.text) || '').trim();
      if (!text) continue;
      neu.push({ update_id: u.update_id, text });
      verarbeiteAntwort(db, characterId, text);
    }
    try {
      const r = db.prepare('SELECT stats_24h_json FROM world_state WHERE id = 1').get();
      const s = r ? JSON.parse(r.stats_24h_json || '{}') : {};
      s.tg_offset = maxId;
      db.prepare('UPDATE world_state SET stats_24h_json = ? WHERE id = 1').run(JSON.stringify(s));
    } catch { /* offset egal */ }
    return { ok: true, neu };
  } catch (err) {
    return { ok: false, grund: err.message, neu: [] };
  }
}

function verarbeiteAntwort(db, characterId, text) {
  const m = String(text).match(/^ja\s+(.+?)\s+(.+?)\s+([\d.,]+)/i);
  if (m) {
    const rolle = m[2].trim().slice(0, 60);
    const lohn = Math.max(8, Math.min(18, Number(String(m[3]).replace(',', '.')) || 10));
    const arbiter = require('./arbiter');
    const job = arbiter.aktiverJob(db, characterId);
    const poiId = (job && job.poi_id) || 'otzentreff';
    const res = arbiter.nimmJobAn(db, characterId, poiId, rolle, lohn);
    if (res.ok) {
      db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, 'job_offer', ?, 1)")
        .run(characterId, JSON.stringify({ quelle: 'telegram', rolle, lohn }));
      return { typ: 'job_zusage', rolle, lohn };
    }
    return { typ: 'job_bereits', rolle };
  }
  db.prepare("INSERT INTO open_loops (character_id, kind, text, urgency, status) VALUES (?, 'question', ?, 0.8, 'open')")
    .run(characterId, 'Nachricht von draussen: ' + String(text).slice(0, 200));
  db.prepare("INSERT INTO events (character_id, tick, type, payload_json, in_feed) VALUES (?, 0, 'telegram_msg', ?, 1)")
    .run(characterId, JSON.stringify({ text: String(text).slice(0, 280) }));
  return { typ: 'notiz', text: String(text).slice(0, 80) };
}

function hatAntwortFuer(db, zettelId) {
  try {
    const z = db.prepare('SELECT * FROM messages_outbox WHERE id = ?').get(zettelId);
    if (!z || !z.telegram_msg_id) return false;
    const treffer = db.prepare("SELECT id FROM events WHERE type = 'telegram_msg' AND id > ? LIMIT 1").get(z.id);
    return Boolean(treffer);
  } catch {
    return false;
  }
}

module.exports = { konfig, istAktiv, sendeAnTelegram, sendeNachricht, pollAntworten, verarbeiteAntwort, hatAntwortFuer };

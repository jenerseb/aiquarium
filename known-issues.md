# Bekannte Probleme, offene Bugs & TODOs

Abgleich zwischen [masterplan_aiquarium_hamburg_mvp.md](./masterplan_aiquarium_hamburg_mvp.md) und dem aktuellen Stand in `aiquarium-app/`.
*(Stand: 21.11.2026 — behobene Punkte wie Ganzzahl-Euro-Wirtschaft, `read_book`-Themenwahl, `look_for_work`/`take_job`-Absicherung, `why_here`/`retrospective`/`stats_24h_json` und Health-Chunk-/Schlaf-/Arzt-Heilung wurden entfernt.)*

---

## 1. Offene Bugs & fehlende Mechaniken (Ist vs. Masterplan)

- **`work_on_project` nutzt `work_pieces` nicht (`src/engine.js`):**
  Speichert aktuell nur eine Kurzzeit-Erinnerung. Es wird kein Eintrag in `work_pieces` angelegt/aktualisiert (`fragments_json`, `progress +15 %`, `status = 'completed'` ab `100 %`), es gibt keinen `+6 froh`-Bonus und keine Ortsprüfung (`apartment` / Park). Im Gehirn-Overlay bleibt „Werkstücke“ deshalb immer leer.

- **`buy_item` (Smartphone-Freischaltung) ist nur ein Dummy (`src/engine.js`):**
  Fällt aktuell in denselben `else if`-Zweig wie `send_sms`, zieht kein Geld ab und legt kein Item ins `inventory`. Da `hatHandy()` (`src/prompt.js`) auf `item_key = 'handy'` prüft, kann der Charakter im Spielverlauf aktuell niemals ein Handy kaufen (`50 €` am `spaeti`), um `send_sms`, `send_email` und `web_search` freizuschalten.

- **`practised` (Übungs-Tracking) wird nirgends verwendet (`src/db.js`, `src/engine.js`):**
  Die Tabelle existiert, wird aber bei `work_shift`, `work_on_project` oder `collect_deposit` nie hochgezählt, reduziert nicht die Schicht-Erschöpfung (bis `-30 %` laut §7.1) und fehlt in `/api/brain` sowie im Gehirn-Overlay.

- **Fehlende `arbiter.initPoi()` & Telegram-`/fire`-Logik (`src/arbiter.js`, `src/telegram.js`):**
  - `world_meta_json` in `pois` enthält aktuell nur `{ alkis_id, distanz_m }`, aber keine POI-spezifischen Lohn-/Rollen-/Nachfrage-Metadaten für `bewerteBewerbungen()`.
  - `bewerteBewerbungen()` akzeptiert als Job-POIs nur `['kneipe', 'imbiss', 'club', 'kino', 'spaeti']` (neuere Gastro-POIs wie `restaurant`, `cafe`, `markt` fehlen in der Liste).
  - Der Telegram-Befehl `/fire <poi_id>` zum Beenden aktiver Jobs fehlt in `telegram.verarbeiteAntwort()`.
  - `resolve_after_at` bei `leave_note` steht in `src/engine.js` auf `+2 hours` statt `+30 minutes` (§8.3).
  - `send_sms` und `send_email` in `src/engine.js` senden zwar per Telegram, schreiben aber nichts in `messages_outbox`.
  - `day_summaries.moves_count` bleibt immer `0`.

---

## 2. Struktur- & Aufräum-TODOs

- **Redundante Tabelle `books` vs. `home_library` (`src/db.js`):**
  Im Schema existieren beide Tabellen mit identischem Inhalt; `engine.js`, `prompt.js` und `server.js` lesen/schreiben nur `books`, während der Masterplan `home_library` vorsieht. Sollte auf eine Tabelle vereinheitlicht werden.
- **Park & Bäume (`public/scene.js` Z. 11):**
  `const ZEIGE_GRUEN = false;` — Grünflächen und Straßenbäume sind bewusst testweise deaktiviert und sollen vorerst aus bleiben.
- **Konfiguration & Dateien:**
  `.env.example` fehlt im Projekt-Root (im Masterplan §3 vorgesehen).

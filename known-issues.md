# Bekannte Probleme, offene Bugs & TODOs

Abgleich zwischen [masterplan_aiquarium_hamburg_mvp.md](./masterplan_aiquarium_hamburg_mvp.md) und dem aktuellen Stand in `aiquarium-app/`.
*(Stand: 21.11.2026 — umgesetzt wurden u. a. `consume`/`sleep`-Hard-Limits & Deincentivierung, Erlebnis-Memories, `come_back_count`-Kontextfilter, `froh`-Dynamik, `rest -15`, Zettel-Timer 15/3 Min., `work_pieces`, `buy_item` Handy.)*

---

## 1. Offene Bugs & fehlende Mechaniken (Ist vs. Masterplan)

- **`practised` (Übungs-Tracking) wird nirgends verwendet (`src/db.js`, `src/engine.js`):**
  Die Tabelle existiert, wird aber bei `work_shift`, `work_on_project` oder `collect_deposit` nie hochgezählt, reduziert nicht die Schicht-Erschöpfung (bis `-30 %` laut §7.1) und fehlt in `/api/brain` sowie im Gehirn-Overlay.

- **Fehlende `arbiter.initPoi()` & Telegram-`/fire`-Logik (`src/arbiter.js`, `src/telegram.js`):**
  - `world_meta_json` in `pois` enthält aktuell nur `{ alkis_id, distanz_m }`, aber keine POI-spezifischen Lohn-/Rollen-/Nachfrage-Metadaten für `bewerteBewerbungen()`.
  - `bewerteBewerbungen()` akzeptiert als Job-POIs nur `['kneipe', 'imbiss', 'club', 'kino', 'spaeti']` (neuere Gastro-POIs wie `restaurant`, `cafe`, `markt` fehlen in der Liste).
  - Der Telegram-Befehl `/fire <poi_id>` zum Beenden aktiver Jobs fehlt in `telegram.verarbeiteAntwort()`.
  - `send_sms` und `send_email` in `src/engine.js` senden zwar per Telegram, schreiben aber nichts in `messages_outbox`.
  - `day_summaries.moves_count` bleibt immer `0`.

- **Pfand-Ortsbindung (`src/engine.js`):**
  - `collect_deposit` teleportiert die Figur noch hart auf die Koordinaten des ersten entdeckten Parks und findet immer zu 100 % Flaschen; `return_deposit` prüft nicht, ob die Figur am `spaeti` steht.

---

## 2. Struktur- & Aufräum-TODOs

- **Redundante Tabelle `books` vs. `home_library` (`src/db.js`):**
  Im Schema existieren beide Tabellen mit identischem Inhalt; `engine.js`, `prompt.js` und `server.js` lesen/schreiben nur `books`, während der Masterplan `home_library` vorsieht. Sollte auf eine Tabelle vereinheitlicht werden.
- **Park & Bäume (`public/scene.js` Z. 11):**
  `const ZEIGE_GRUEN = false;` — Grünflächen und Straßenbäume sind bewusst testweise deaktiviert und sollen vorerst aus bleiben.
- **Konfiguration & Dateien:**
  `.env.example` fehlt im Projekt-Root (im Masterplan §3 vorgesehen).

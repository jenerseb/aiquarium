# Bekannte Probleme, offene Bugs & TODOs

Abgleich zwischen [masterplan_aiquarium_hamburg_mvp.md](./masterplan_aiquarium_hamburg_mvp.md) und dem aktuellen Stand in `aiquarium-app/`.
*(Stand: 21.11.2026 — umgesetzt wurden u. a. `consume`/`sleep`-Hard-Limits & Deincentivierung, Erlebnis-Memories, `come_back_count`-Kontextfilter, `froh`-Dynamik, `rest -15`, Zettel-Timer 15/3 Min., `work_pieces`, `buy_item` Handy.)*

---

## seb issues:

### poi activities
müssen von arbiter dedupliziert werden bei anfrage. also "plakate checken" und "plakate an haus73 ansehen" muss in 1 zusammengefassst werdn oder eben auf anfrage dann das bereits bestehende ausgeben anstatt neues anzuelegen.

### timer von activity
startet schon beim hingehen, nicht erst vor ort- activity startet zu früh?

### bekanntschafts bias
charakter wählt wohl sitzen im park so oft, weil es kleine boni verspricht, aber sollte eigentlich lieber in bekannte pois gehen und dort aktivitäten machen. aber die müsste er sich erst ausdenken und mit arbiter usmachen. das tut er scheinabr ungern.



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
- **Abgerundete 3D-Gebäudekanten bei LoD2 (`public/scene.js`):**
  Im aktiven LoD2-Modus (`data/hamburg_lod2.json`, 1.402 Gebäude als rohe Dreieckssuppe) bleiben Gebäudeecken und Silhouetten spitz; `rundeGebaeudeNormalen` (`GEBAEUDE_ABRUNDUNG` / `?round=0..100`) glättet dort nur die Beleuchtungs-Normalen, was mit `MeshLambertMaterial` + Fassadentextur/`bumpMap` kaum sichtbar ist. Echten 3D-Bevel (`ExtrudeGeometry` mit `bevelEnabled: true`) nutzt bisher nur der Non-LoD2-Fallback (`hamburg_geodata.json`). Mögliche spätere Optionen:
  1. **Option 1 – Umschalter auf ALKIS-`ExtrudeGeometry` (z. B. `?lod=0`):** Echte abgerundete 3D-Kanten über `GEBAEUDE_ABRUNDUNG`, allerdings nur Flachdächer statt LoD2-Giebeldächer und ohne LoD2-Dachluftbild.
  2. **Option 2 – Echtes Mesh-Beveling auf LoD2-Dreiecken:** Half-Edge-Topologie/Edge-Beveling auf `wallTriangles`/`roofTriangles` aufbauen, damit auch Giebeldächer und Gauben ohne Risse oder Löcher abgerundet werden können.

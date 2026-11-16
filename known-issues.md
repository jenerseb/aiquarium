

Bitte ergänze in `public/scene.js` noch diese kleine Animation für die POI-Pins:

## POI-Pins wie Bojen auf und ab schweben lassen (`public/scene.js`)
- Speichere beim Erstellen der 3D-POI-Pins deren jeweilige Basis-Höhe (`baseY`) sowie einen individuellen Phasenversatz (`phase = index * 0.9`, damit sie nicht unnatürlich synchron wackeln).
- Animiere im 30-FPS-Render-Loop eine sanfte, ruhige Auf-und-Ab-Bewegung wie bei einer Boje auf dem Wasser:
  - Standard-Pins: `pin.position.y = baseY + Math.sin(now * 0.0022 + phase) * 0.6` (ca. ±0,6 m sanftes Schweben).
  - Aktiver POI-Pin (der Ort, an dem sich der Charakter gerade aufhält oder zu dem er unterwegs ist): etwas prägnanteres Schweben (`±1.1 m`, `now * 0.0032`), damit man auf der Diorama-Scheibe sofort sieht, welcher Pin gerade aktiv ist.


Bitte ergänze in `public/scene.js` noch einen visuellen Dev-Marker für die Spielfigur:

## Senkrechte 25-m-Dev-Linie am Charakter (`public/scene.js`)
- Erstelle beim Initialisieren des Charakter-Meshes eine dünne, gut sichtbare senkrechte Linie (`THREE.Line` mit `BufferGeometry` von `(0, 0, 0)` bis `(0, 25, 0)`, Farbe z. B. `#00e5ff` / Cyan, `transparent: true`, `opacity: 0.85`) und hänge sie **direkt als Child an die Charakter-Gruppe** (damit sie sich automatisch ohne extra Update-Code exakt mit seinen Füßen mitbewegt – auch wenn er gerade in einem Gebäude steht).
- Kopple `devLine.visible` direkt an den aktiven **Dev-Modus** (`isDevMode` / `?dev=1`), sodass die Linie in der Dev-Ansicht durchgehend sichtbar ist und in der normalen Ansicht ausgeblendet bleibt.

---

## LLM-Input mitschneiden: Debug-Log zeigt jetzt, was die KI als INPUT bekommt — ERLEDIGT (16.11.2026)
- Umgesetzt: Neue `llm_input`-Events (in_feed = 0) bei jedem Modell-Call – `engine.js` (Alltags-Prompt + Whitelist), `arbiter.js` (Arbiter-Prompt + `resolveIntent` bekommt jetzt `characterId` durchgereicht) und `runNightlyConsolidation` (Nacht-Call). `server.js /api/brain` liefert `llmInputs` (letzte 8, voller Prompt); Gehirn-Overlay Chronik-Tab zeigt „📥 LLM-Input"-Aufklapper. `llm_debug`-Fehler-Events tragen den zugehörigen Prompt jetzt mit.

## Bäume als 1 einfacher grüner Zylinder — ERLEDIGT (16.11.2026)
- Umgesetzt: `baueDioramaBaeume()` jetzt 1 InstancedMesh (leicht konischer Zylinder 0,35→0,5 m, Farbe `0x4f7a3e`); Höhe skaliert weiter nach `baumhoehe` (~75 %), Breite konstanter Standard (kein `kronendurchmesser` mehr). `BAUM_FARBEN`, `baumFarbeFuer`, Wackel-Krone und Stamm/Krone-Split entfernt.

## Welt-Reset von 0 — ERLEDIGT (16.11.2026)
- Neu: `scripts/reset-world.js` + `npm run reset` (Backup nach `world.sqlite.bak-<Zeit>`) / `npm run reset:hard` (ohne Backup). Warnt, wenn der Server auf Port 3077 läuft. Respektiert `AIQUARIUM_DB`.

---

# Job-Zusage erreicht den Prompt nicht → Hungerschleife statt Schichtarbeit

**Beobachtet:** 16.11.2026, Live-DB (`~/.local/share/aiquarium/world.sqlite`)

## Symptom
- 17:59: Kiezling hinterlässt Zettel bei `kleine_pause` („Hilfe beim Abwaschen oder Aufräumen“) → `messages_outbox`, Status `pending`, `resolve_after_at = 19:59`.
- 20:17: Autonomer Ladenbesitzer-Arbiter (`bewerteBewerbungen()` in `src/arbiter.js`, Z. 289–321) sagt zu: Job `Küchenhilfe`, 8,24 €/Schicht, liegt korrekt in `jobs` (`status: 'active'`). Feed-Event `job_offer` + Memory *„Zusage als Küchenhilfe bei Kleine Pause (Wohlwillstrasse). Der Zettel hat gewirkt.“* wurden angelegt.
- Danach: **Hungerschleife.** Er läuft zur Kleinen Pause, versucht `consume` (Pommes), bricht am Interrupt `geld_reicht_nicht` ab (Kontostand 0 €), läuft heim, wieder raus, wiederholt das Ganze. `shifts_completed: 0`, `geld: 0`, `hunger: 100`, `gesund: 59.8` (fällt durch die 60er-Chunk-Schwelle).
- Ironie: Er hungert **am Ort seines Arbeitgebers** und macht trotzdem nie `work_shift`.

## Ursache
- `work_shift` ist in `OFFENE_INTENTS` (`src/prompt.js` Z. 137) und in der Engine implementiert (`src/engine.js` Z. 503) – das Modell könnte es also nutzen.
- Aber: **`buildPrompt()` enthält nirgends die Information, dass ein aktiver Job existiert.** Die `job_offer`-Zusage schreibt nur Event + Memory; im Prompt taucht der Job weder als Faktenblock (Ort, Rolle, „kannst dort work_shift machen“) noch in `WO DU BIST` auf. Das Modell kennt nur die Zusage-Erinnerung als flüchtigen Text und kann daraus keine Handlung ableiten.
- Folge: Bei `hunger 100` priorisiert das Modell konsequent `consume`, das ohne Geld immer am `geld_reicht_nicht`-Interrupt scheitert – ein Loop, den nur der Prompt aufbrechen kann.

## Fix-Ideen
1. **`src/prompt.js`:** Neuer Block „DEIN JOB“ in `buildPrompt()`, wenn `arbiter.aktiverJob(db, ch.id)` existiert, z. B.:
   > *„Du hast einen aktiven Job als Küchenhilfe bei kleine_pause (Kleine Pause). Du kannst dort als Schicht arbeiten (work_shift) und verdienst damit dein Geld – die Schicht dauert eine Weile und macht hungrig und müde, aber danach hast du Geld in der Tasche.“*
   Ohne Zahlen (Lohn-Wert nicht nennen, Welt-Regel: Engine rechnet, Modell spürt).
2. **`src/engine.js`:** Zusätzlich könnte der `geld_reicht_nicht`-Interrupt bei aktivem Job eine Hint-Notiz liefern („Du könntest stattdessen als Küchenhilfe eine Schicht arbeiten“), damit der nächste Plan reagiert.
3. Optional: Aktiven Job auch im `Gehirn`-Overlay (Character-Sheet-Tab) sichtbar machen.

## Randnotiz (kleiner zweiter Befund)
- `src/arbiter.js` (Z. 214, 275, 308) und `src/db.js` (Z. 457) insertieren Memories **direkt per SQL** statt über `speichereMemory()` aus `src/memory.js` – dabei umgehen sie Kapazitätscheck und „First-to-go“-Ersetzung der 25-Slot-Regel. Bei wenigen Events harmlos, sollte aber vereinheitlicht werden.

---

# Modell-Routing verständlich machen → model.json — ERLEDIGT (16.11.2026)

**Vorher:** SLOTS-Härte in `src/config.js` (googleDirektAktiv()-Zoo, AIQUARIUM_DEV-Schalter,
8 versch. `AIQUARIUM_*_MODEL`-Env-Overrides, doppelte Slot-Definitionen) — „welches Modell wann"
war fast nur durch Code-Lesen beantwortbar. Der `test-routing`-Test war dabei schon vorher rot
(„dev fallback-2 diversifiziert") — SOLL vs. Code-Mismatch.

**Jetzt:**
- **`model.json`** (Projekt-Root) = einzige Quelle der Wahrheit: 4 Rollen (`alltag`, `arbiter`,
  `nightly`, `dev`), jede mit `_wofuer` + `kette[]` (Reihenfolge = Fallback-Kette).
- `src/config.js` ist nur Loader (~90 Zeilen): lädt + validiert model.json, filtert
  Provider ohne Key (google ohne GEMINI_API_KEY / im Test-Modus, mit Log-Zeile), baut
  `primary/fallback/fallback2` (= kette[0..2]) + `kette` → brain/arbiter kompatibel.
- **Env-Overrides entfernt:** `AIQUARIUM_MODEL`, `AIQUARIUM_FALLBACK_MODEL`,
  `AIQUARIUM_ARBITER_MODEL/_FALLBACK`, `AIQUARIUM_NIGHTLY_MODEL/_FALLBACK`,
  `AIQUARIUM_DEV_MODEL/_FALLBACK2`, `GEMINI_MODEL`, der `AIQUARIUM_DEV`-Schalter — alle raus
  (aus `.env` + Code). Übrig: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `PORT`, `AIQUARIUM_DB`.
- `src/brain.js` `decide()`: baut `attempts` aus `pair.kette` (null-Einträge raus, Labels
  `primary`/`fallback`/`fallback-2`… stabil); Guard bei leerer Kette
  (`kein_modell_konfiguriert`). `src/server.js`: Start-Log druckt jetzt `rollenTabelle()`.
- `scripts/test-routing.js`: komplett auf model.json umgeschrieben (Key-Filter, kein
  Env-Override mehr, 429→Fallback, JSON→Fallback, Rollen-Trennung, Google-Mock-Erfolg,
  rollenTabelle). **Alle 8 Test-Suiten grün** (inkl. routing — der alte rote Test ist geheilt).
- `arbiter`-Kette bekam `mistral-nemo` als fallback-2 (aus dem Masterplan, ohne ihn war
  ohne Google-Key kein Fallback möglich).
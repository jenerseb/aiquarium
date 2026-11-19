# test 

- gebäude highlight wenn er drin sit funktioneirt nicht richtig: die positionen werden wohl falsch gecheckt, aueßrdem ist das highlight komisch. es soll kein extra leuchten eingeblenet werden. nur das gebäude soll in seiner farbe zu etwas helelr und wieder normal pulsieren.


- glaube parkfläche nbuggen. die erste parkfläche wird als kreis gezeichnet, dann folgt keine weitere.

.




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
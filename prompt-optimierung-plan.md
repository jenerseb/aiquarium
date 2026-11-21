# Plan: LLM-Prompt-Optimierung (`alltag` / `buildPrompt`)

Ziel: Deutlich kürzere, fokussiertere Outgoing-Prompts (weniger Input-Tokens, geringere Latenz, weniger Halluzinationen) bei gleichbleibender Stimmungs- und Spielqualität (weiterhin keine Roh-Prozente im Prompt).

---

## Maßnahmen

1. **Unveränderlichen Charakter eindampfen (`src/db.js`, `scripts/test-m1.js`)**
   - `SEED_SHEET` von 11 langen Sätzen auf **5 prägnante Kern-Traits** (über `like`, `cares`, `fears`, `small_things`) reduzieren.
   - `test-m1.js` entsprechend auf `sheetN >= 5` anpassen.

2. **`Ausloeser:` im Alltags-Prompt weglassen (`src/prompt.js`)**
   - `sheetText()` gibt bei gelernten Einträgen nur noch `- [category] text` aus. Die `source_reason`-Texte bleiben in der DB für das Gehirn-UI/Nightly erhalten.

3. **Memory-Duplikate im Prompt zusammenfassen (`src/prompt.js`)**
   - `memoriesText()` fasst identische Erinnerungstexte (z. B. mehrfaches `Gelesen: St. Pauli ...`) zu einer Zeile mit `(×N)` zusammen.

4. **Bücherregal & Notizbuch-IDs straffen (`src/prompt.js`)**
   - Rohe `notiz_<timestamp>`-Einträge werden nicht mehr als Themen-Liste in den Prompt gedumpt; nur echte Themen/Titel (max. 3 neueste).
   - Außerhalb von `apartment` wird das Regal auf einen kurzen Hinweis reduziert, da `read_book` / `write_notebook` nur daheim möglich sind.

5. **Körpergefühl, Job-Block & Ortsangabe verdichten (`src/prompt.js`, `src/engine.js`)**
   - `koerperSaetze()` kürzer und knackiger formulieren (weiterhin als Gefühl ohne Roh-Prozente).
   - `jobText()` auf eine Zeile verdichten und den toten Verweis auf `look_for_work`/`take_job` entfernen.
   - In `engine.js` rohe Meter-Koordinaten `(-24, -200)` aus `woText` entfernen (`Du bist draussen unterwegs.`).

6. **Kontext-abhängige Intent-Whitelist (`src/prompt.js`)**
   - Nicht verfügbare Intents aus der Whitelist filtern (unter Beibehaltung von Multi-Step-Ketten wie `work_shift → walk_to(apartment) → sleep`):
     - `send_sms`, `send_email`, `web_search` nur mit Handy
     - `return_deposit` nur mit Pfand im Inventar
     - `work_shift`, `quit_job` nur bei aktivem Job
     - `consume` nicht als ersten Vorschlag erzwingen, wenn `hunger < 20`

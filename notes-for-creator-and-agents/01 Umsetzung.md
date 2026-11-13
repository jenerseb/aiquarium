---
typ: plan
status: gültig
stand: 2026-11-14
projekt: AIquarium
tags: [aiquarium, bruchpilot, 3d, llm, eigenprojekt]
---

# AIquarium — 01 Umsetzung

**Einzige Arbeitsdatei.** Reihenfolge → Pakete → offene Punkte → Messlatte → Anhang (Stimme, Schema). Einstieg und Entscheidungen: [[00 Stand]]. Historie: [[archiv/02-roadmap-2026-11-13]], [[archiv/03-runde3-2026-11-13]], [[archiv/behoben-log-2026-11-13]].

Code: `vault-privat/Seb Privat Stuff/aiquarium/app/`, Start: `npm start` → `http://127.0.0.1:3077`. Nach jedem Paket: `npm test` grün, `npm run check`, echter Messlauf, [[00 Stand]] nachziehen.

## Reihenfolge

0. Vorab-Schnitt — **gebaut 2026-11-13**: ganze Kugel begehbar (3D-Einheitsvektoren, Großkreis), Post-Checks entschlackt (B-Schärfung), Catch-up-Freeze mit Reboot-Event, DB-Pruning. **63 Tests grün.**
1. **K-Umsetzung — gebaut 2026-11-14** → 2. **A — gebaut 2026-11-14** (Vorhaben + Weg, Grid 15°) → 3. **C** (Kurzzeit + Ungereimtheit-Zeile) → 4. **D** (`nachdenken` + LTM, regeneriert `halt`) → 5. **E** (Glaubenssätze folgenreich + Zweiteilung) → 6. **F** (Fernziel) → 7. **G** (Fragen) → 8. **H** (`world_belief`). F–H erst nach A–E. **Danach: Tag/Nacht als nächstes** (eigener Beschluss, dann J–M, dann v0.2+). B-Rest (Musterbremse) ebenfalls **gebaut 2026-11-14**.
2. Paket I (Sichtstufen) ist **vorgezogen gebaut** — fundiert G.

## Paket A — Vorhaben und Weg · gebaut 2026-11-14 (79 Tests grün)

Ziel erreicht: aus „der Körper ist leer" wird „ich laufe zum Feld, hinter dem Wrack".

- [x] **DB:** `pilots.vorhaben_json` (TEXT, Default `''`), Migration analog `near_json`.
- [x] **Engine:** `vorhaben = {ziel, grund, seit_tick}` aus echten Treibern (hunger > 45 → field/capsule-Fallback; thermo ±40 → shade/capsule; drang −40 → Zufalls-Ort, J verfeinert; halt < 40 → shade; nie bei mind_state != klar). Löschen bei Ankunft ≤ 5 oder Treiber-ok, nie bei Aktionswechsel. `VORHABEN`-Konstanten in config.js.
- [x] **Engine:** Weg-Text (reine Geometrie, `ORT_DATIV`-Map): Schritte + „hinter/neben …" + „du kommst an … vorbei". Keine Himmelsrichtungen, Zahlen nur Schritte.
- [x] **Prompt:** `Was du vorhast:` + `Weg:` nur wenn aktiv.
- [x] **Checks:** `wiederholung_beduerfnis` (BEDUERFNIS_SAETZE, Umlaut-normalisiert) + Retry.
- [x] **Tests:** 8 A-Tests grün (Schwelle, Löschen, Überleben, Stupor-Sperre, Bremse, Weg-Regeln, Migration, eat ← Hunger).
- [x] **Grid-Task:** Breiten/Längen 30° → 15°, Labels jedes 2. (du prüfst per `G`).
- [ ] **Abnahme (Messlauf):** in 50 Entscheidungen < 10 % Bedürfnis-Sätze, mind. 3 abgeschlossene Vorhaben pro Spieltag, kein „ich muss …" zweimal in Folge.

## Paket B — Formfreiheit · teils gebaut 2026-11-13

- [x] **Gebaut:** Schablone gestrichen, Impuls-Wuerfel (30/30/20/20), `seit`-Flag, `MODEL.maxWords` 20, `aktionsmismatch` + Motiv-Quota gestrichen.
- [x] **B-Rest gebaut 2026-11-14:** Musterbremse `eroeffnung_objekt` (checks.js + brain.js + engine.decide mit Ortsnamen) — 3 von 4 Objekt-Eroeffnungen → verwerfen + Retry. Test grün.
- [ ] **Tests:** 20-Woerter-Grenze · Impuls-Zeile in jedem Prompt.
- [ ] **Abnahme:** Objekt-Eroeffnung < 30 % (Baseline 62 %).

### Forscher-Prompt-Baukasten · spec'd 2026-11-13, Umsetzung offen (`src/prompt.js`)

```
[LAGE & GEDAECHTNIS] Flucht: {parts}/7 · Zuletzt: {last_action} · Vorhaben: {vorhaben} ({weg}) · Ungereimtheit: {kontrast}
[KOERPER & KOPF] {body_thermo_hunger} · {psyche_drang_halt} · {seit_flag}
[WAS DU GLAUBST] Ueber dich: {somatic} · Ueber diesen Ort: {world}
[SICHTFELD] {sicht_stufen}
[DEIN IMPULS] {gewuerfelt}
Whitelist: {whitelist} · Antwort: {"action","thought","musing"} · thought max. 20 Woerter, 1-2 Saetze, Praesens, Ich-Form. Keine Zahlen, kein Englisch.
```

5 Impulse: Praktiker (25 %) · Detektiv (25 %, nur bei Ungereimtheit) · Körper-Rebell (20 %) · Trockener (15 %, schwerer bei negativer Psyche) · Zweifler (15 %, nur bei Glaubenssatz).


## Paket C — Kurzzeitgedächtnis (gratis)

Ziel: er weiss, was er gerade tut und was ihn eben gestoert hat. Kein Modellaufruf.

- [ ] **Engine:** vier Zeilen aus DB-Fakten, immer im Prompt: Zuletzt / Unterwegs / Gestoert / Offen (Quellen: letzte Aktion + Ort + Psyche-Delta, aktives Vorhaben, letztes negatives Ereignis, zuletzt entdeckter Ort).
- [ ] **Prompt:** Block `Was gerade laeuft` vor dem Körperfuehl, max. 4 Zeilen, harte Zeichenobergrenze. Plus Ungereimtheit-Zeile (Kontrast-Paar): offene Frage oder Bauteile-Zaehler neben den aktuellen Ort stellen (z. B. "Vorhin hat der Mast geklopft — und hier im Wrack fehlt die Antenne.").
- [ ] **Tests:** Zeilen aus Fakten, nicht aus Gedanken · leerer Zustand erzeugt keine leeren Zeilen · unter Zeichengrenze.
- [ ] **Abnahme:** keine Entscheidung ohne Block; Prompt-Laenge +< 15 %.

## Paket D — nachdenken und 10-Zeilen-Langzeitgedächtnis (teuer)

- [ ] **DB:** Tabelle `long_memory (id, pilot_id, slot 1..10, text, weight, event_type, created_tick, last_used_tick)`, UNIQUE(pilot_id, slot). Startet leer — bis zum ersten wichtigen Ereignis gibt es `nachdenken` nicht in der Whitelist (keine Startzeile "Ankunft auf dem Mond").
- [ ] **Schreiben:** Gewicht je Ereignis: Zusammenbruch ueberlebt 8 · Belief bestaetigt 6 · erster Fund 5 · erster Ortsbesuch 3 · dritte Monotonie-Strafe 2. Ein Modellaufruf ("max. 12 Woerter"), Post-Checks wie beim Gedanken. Kein Slot frei → niedrigstes Gewicht ersetzen, bei Gleichstand aeltester; nie in hoeheren Slot schreiben.
- [ ] **Aktion:** Dauer 60 s, `psyche +0,004/s`, `body -0,002/s`. Saettigung: zweites Nachdenken innert 20 Min → keine Wirkung, `psyche -0,0027/s`. Zaehlt als Ruhe. Nur bei `mind_state klar` und mind. 1 Zeile. Später bei Tag/Nacht: nur bei Licht, Erinnerung im Schlaf nur als Traum.
- [ ] **Lesen:** Zeilen nur im Folge-Prompt nach `nachdenken` (hoechstes Gewicht, bei Gleichstand zum Vorhaben passende event_type). Auftrag: "Beziehe dich auf genau diese Erinnerung: …".
- [ ] **Frontend:** eigener Zustand ("denkt nach"), Denkblase andere Farbe; Langzeittext nie im Feed, nur Bezugnahme im Gedanken.
- [ ] **Tests:** leeres LTM → Aktion nicht in Whitelist · niedrigstes Gewicht ersetzt, hoeheres nie · Determinismus · Saettigung · nur Folge-Prompt.
- [ ] **Abnahme:** 1–3× pro Spieltag; jeder Eintrag auf echtes Ereignis zurueckfuehrbar; kein Eintrag ohne Bezug im Folge-Gedanken.

## Paket E — Glaubenssaetze folgenreich

Ziel: wer glaubt, das Wrack raube ihm den Frieden, steht nicht 181 s spaeter wieder davor.

- [ ] **Engine:** bestaetigter Glaubenssatz aendert Verfuegbarkeit, kein Verbot: negativ (avg_psyche_delta < -0,2): Schwelle +10, Wirkung ×1,5; positiv: Schwelle -10, bevorzugt angeboten.
- [ ] **Prompt:** max. 3 im Blickfeld, Unterdrueckung nur für zuletzt gewaehlte Aktion.
- [ ] **Tests:** negativer Glaube senkt Wahlrate ueber 20 Entscheidungen · kein Verbot · positiver erhoeht Rate.
- [ ] **Abnahme:** Aktionen gegen negativen Glauben < 20 %.

### Zweiteilung · spec'd 2026-11-13, Umsetzung offen (`src/belief.js`)

Explorative Aktionen (dig, search_wrack, inspect, Mast, Zettel) duerfen nie Wellness-Saetze erzeugen.

1. **Schicht 1 — Körper-Macken (`somatic_theory`):** nur bei eat/sleep/sit_shade/look_earth, ab 3× + starkem Delta. Bodenstaendige Faustregel, max. 10 Woerter, keine Wellness-Floskeln ("Wer mit vollem Bauch schlaeft, traeumt schwerer.").
2. **Schicht 2 — Welt-Hypothesen (`world_belief`, Paket H):** nur ueber Ereignis-Zaehler (3 Funde am Ort, 3× Klopfen, 3× Zettel), unabhaengig von Deltas. Technische/detektivische Vermutung, max. 12 Woerter ("Die Spule aus dem Wrack gehoert in den stummen Sendemast.").


## Paket F — Fernziel-Zaehler (das Wozu)

Ziel: Graben wird Fluchtvorbereitung. Nur die Zahl steuert, kein Satz, keine Sperre.

- [ ] **DB:** Tabelle `parts (id, pilot_id, art, fundort, tick)`, UNIQUE(pilot_id, art). 7 Arten der Reihe nach (Schraube, Platte, Spule, Kabel, Zelle, Antenne, Kern); Wiederholung = nur Schrott. Tod loescht den Zaehler.
- [ ] **Engine:** Fund → Ereignis `part` (in_feed, "Bauteil: Spule (3/7)").
- [ ] **Prompt:** eine Zeile, immer: `Für die Flucht: 3 von 7 Bauteilen.` Whitelist unveraendert.
- [ ] **Tests:** Reihenfolge deterministisch · 8. Fund kein Teil · Tod loescht · Zeile zeigt x/7.
- [ ] **Abnahme:** in 50 Entscheidungen ≥ 5 Gedanken mit Zielbezug ("um zu", "damit", "Flucht", "Teil"); dig + search_wrack > 25 %.

## Paket G — Offene-Fragen-Ledger (Unerledigtes bleibt)

- [ ] **DB:** Tabelle `fragen (id, pilot_id, text, ort, status offen|beantwortet|verfallen, created_tick)`, max. 8 je Pilot.
- [ ] **Engine:** Ausloeser ohne Modellaufruf: Klopfen → "Was klopft im Mast?"; 3. Schrott ohne Teil am Ort → "Liegt hier noch mehr?"; 1. Bake → "Hoert mich jemand?"; 3. Zettel → "Was wusste mein Vorgaenger?". Beantwortet durch Handeln (Teil gefunden / 3. Besuch / 5. Bake-Ruf ohne Antwort = niemand). Nach 2 Spieltagen → verfallen (Feed-Notiz, kein Vorwurf).
- [ ] **Prompt:** Block `Offen:` max. 3 Zeilen, nach den Glaubenssaetzen, neutral, kein Auftrag.
- [ ] **Tests:** Ausloeser schreibt Frage · Handeln beantwortet · Verfall nach 2 Tagen · max. 3 Zeilen.
- [ ] **Abnahme:** im Schnitt ≥ 2 offene Fragen je Spieltag; keine aelter als 2 Spieltage.

## Paket H — Welt-Beliefs (zweite Schicht)

Ziel: Saetze ueber die Welt (Ereignis-Zaehler), nicht ueber Werte (Deltas).

- [ ] **DB:** Tabelle `welt (id, pilot_id, thema, text, treffer, created_tick, last_used_tick)`, UNIQUE(pilot_id, thema). Themen: fundort:wrack, bake_schweigen, klopfen, vorsaenger.
- [ ] **Engine:** ab 3 Treffern formuliert die Figur einen Satz ("Was vermutest du ueber die Welt?"), Ersatzsatz nach 3 Fehlversuchen. Max. 12 Woerter, keine Wellness-Floskeln.
- [ ] **Prompt:** alter Block "Was du ueber dich gelernt hast", neuer Block "Was du ueber die Welt vermutest" (max. 3, nie zur zuletzt gewaehlten Aktion). Eigener Block "Ueber diesen Ort", getrennt von "Ueber dich".
- [ ] **Tests:** Zaehler loest Formulierung aus · Schichten getrennt · Ersatzsatz greift.
- [ ] **Abnahme:** ≥ 1 Welt-Satz je Spieltag.

## Gebaut (Stand 2026-11-13, 63 Tests grün)

- **Vorab-Schnitt:** ganze Kugel begehbar (3D-Einheitsvektoren, Grosskreis), Post-Checks entschlackt, Catch-up-Freeze ("Anzug-Reboot", Luecke > 60 s, Mini-Luecken normal), DB-Pruning (Rohticks > 7 Tage, thoughts > 500/Pilot).
- **Paket I — Sichtstufen (vorgezogen gebaut 2026-11-12):** ungesehen / Silhouette (7–15 m, 160°-Kegel) / klar (< 7 m Kegel oder < 3 m rundum); Discovery nur auf klar; near nur auf klar; Maskierung im Prompt; Dev-Kegel; Anker am Bauwerk (Halt am Nahkreis ausser schlafen/rennen); Orte ≥ 25 m; Schilder je Grad (weg / "?" / "Eine Art Turm?" / Name); Erkanntheitsgrad sicht 0–3 (nie zurueck); Erkennungsvorlauf 1 m; Betrachtung (unfinished_thought → naechste Entscheidung Zusatz erzwungen); Modell-Log (roh/ms/versuche in stale+decision, Debug-Box, Konsolen-Zeile).


## Paket K — 2-Schichten-Wertesystem · gebaut 2026-11-14 (71 Tests grün)

Ersetzt das 1-Schichten-Modell.

- **Level 1:** Manie (+100: ×1,4/×0,7/×1,5, Ruhe + eat gesperrt, danach +75, Zündung/Rückfall exakt) · Flow (Musing 75 %) · Klar (35 %) · Grüblerisch (ab -40 Vorhaben-Schwellen) · Stupor/Wahn.
- **Level 2 (DB + Migration, Start 15/0/10/80):** hunger passiv +0,0025/s, eat −30; body-Kopplung < 35 / > 50 / > 80 · thermo Orts-Anteil ±0,05/s (Tag/Nacht folgt), Drain |40|/|75| · drang Novelty +/Monotonie −, ±30 zieht · halt Klopfen −15, Erde/Kapsel +5/+8, > 60 stabil (nur recover…Manie), < 40 Wahn-Zug.
- **Entschieden:** Manie sticht Notfall (eat fliegt in Manie auch aus AVAIL) · Wahn ×1,5 + 50 % Scheitern (deterministisch aus in Tests) · hide_capsule = Rückzug in Kapsel (Aktion + Anker + Label + Kommentar).
- **Whitelist/AVAIL/Sensory/Musing:** eat ← hunger · Ruhe ← drang/halt · Erde ← halt · Hunger-/Thermo-Sätze · Flow 75 %.
- **Frontend:** Treiber live, 6 Schieber, dev/set alle sechs.
- **Abnahme erfüllt** (alle Tests grün). **Offen:** thermo Licht-Anteil, nachdenken, Träume (Tag/Nacht).

## Danach (geplant)

- **Tag/Nacht** (eigener Beschluss, kein Paket — NÄCHSTES nach H, vor J–M): Lichtkante/Dämmergürtel mit Mechanik (Sicht, Körper-Drain), nachdenken nur bei Licht, Träume im Schlaf.
- **J — Kacheln:** raeumliches Gedächtnis auf Radius-120-Kugel (ACHTUNG: alte Spec nannte Radius 60 — neu rechnen). streifen = naechste unbesuchte Kachel.
- **L — Emergent:** L1 erfundene Aktionen (max. 5, Verfall 3 Tage) · L2 Funde + Kombinieren (Inventar, 7 Teile = F) · L3 Benennen (rufname) · L4 Rituale (max. 3, Carve-out vs. Zickzack) · L5 Forces (alle 500–1500 Ticks).
- **M Friedhof:** Grab/Helm als entity, verrostete Teile (Haelfte) bleiben, ancestral_echo bei discovery. **N Gap-UI · O OS-Direktiven · P Ambient-Audio.**
- **v0.2+:** O2/Filter-Reichweite, Depots, Crafting, Erd-Uplink, Social, Cookies/Umami. Regel: mehr Inhalt = siebter Ort, kein neues System.


## Offene Punkte (Stand 2026-11-13)

ROT: `inspect` ~50 % — Kandidaten: Wrack mit Fund, Zettel umdrehen, Mast abhoeren.
KALIBRIERUNG: Sterberate ungemessen (Ziel 40–60 %, dann DRAIN tunen) · Psyche ungemessen (8-h-Lauf fehlt) · Wahn-Roll fehlt (einbauen oder Satz streichen) · minDelta 0,2 kaum geprueft.
OFFEN (WE 2/3): epitaph NULL · "Seit Besuch" fehlt · Sprungmarken fehlen · GLB fehlen (CREDITS fuellen) · Impressum/KI/Subdomain/noindex · kein Echo-Erbe.
FORSCHER: F Fernziel · G Fragen · H Welt-Beliefs (brauchen A–E).
RAND: Dev-Grid jeden 2. Kreis · Freeze ab 60 s · kein Auth (Dev nur 127.0.0.1) · Key-Test nur Unit · discovery Start = Kapsel (gewollt).

## Messlatte (50 Entscheidungen, echter Schluessel)

Skript `tools/messung-runde3.js`: Objekt-Eroeffnung < 30 % · Beduerfnis < 10 % · 3-Satz < 40 % · Top-3 < 25 % · ohne Text 0 · Vorhaben gezaehlt · nachdenken 1–3/Tag · keine Aktion > 40 % · Zielbezug > 30 %. Nach jedem Paket gleichen Lauf wiederholen.
RISIKEN: niedrigsten Slot ersetzen · nachdenken = Ruhe + Sättigung · LTM leer ok · Prompt kurz halten · kein Quest-Zwang · Vorhaben = Empfehlung · 20 Wörter + Bremsen.

## Anhang A — Stimme und Post-Checks

1–2 Saetze, max. 20 Woerter, Praesens, deutsch, körperlich, 1 Ausruf ok. Verboten: Emojis, Zahlen/Prozent, Energie/Sanity/HP, KI-Reflexion, Englisch, CJK. Checks: 1. JSON · 2. Whitelist · 3. ≤ 20 · 4. kein CJK/Englisch · 5. Jaccard < 0,65 (15) · 6. Ausruf-Bremse (5). Fehlschlag → Retry -0,3, dann Gedanke weg, Aktion trotzdem. Tagebuch (MiMo, 1×/Schlaf): 3–4 Saetze, lyrisch, konkret.

## Anhang B — Schema (Zielbild inkl. offener Spec)

Bestehend: world_state · pilots (body, psyche, pos 3D ×120, heading, mania_until, epitaph) · pilot_mind (instinct|somatic|world|echo) · world_entities (sicht 0..3, unfinished) · events · nerve_events. Neu bei Umsetzung: vorhaben_json, hunger/thermo/drang/halt, long_memory, fragen, welt, parts, ggf. erfindungen/rufname/inventar.


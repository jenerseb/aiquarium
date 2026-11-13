---
typ: log
status: archiv
stand: 2026-11-13
projekt: AIquarium
tags: [aiquarium, log]
---

# Archiv — Behoben-Log (aus 01 Offene Punkte, Stand 2026-11-13)

Nachfolger: [[01 Umsetzung]]. Quelle eingefroren am 2026-11-14 bei der Konsolidierung (Variante C). Enthält nur die ✅-Blöcke — offene Punkte stehen in [[01 Umsetzung#Offene Punkte (Stand 2026-11-13)]].

## Behoben (2026-11-13, sechste Runde — Vorab-Schnitt)

- **Paket K:** Körper 0–100 + Psyche −100…+100 ersetzen Hunger/Erschöpfung/Stress (Migration, Engine, Prompt, Beliefs, HUD, Dev-Schieber). Manie bei +100 (Tempo ×1,4, Dauer ×0,7, Kosten ×1,5, Rückfall +75), Stupor/Wahn bei −100, Notfall-Instinkt unter Körper 25. Gedanken geben nichts mehr — nur Novelty/Discovery/Funde füttern die Psyche.
- **Hunger/Erschöpfung-Zwilling erledigt:** eine Uhr (Körper) mit mehreren Zuflüssen (Grundverbrauch + Gehen pro Meter).
- **Motiv-Quote ganz gestrichen:** Jaccard-Novelty + Bremsen fangen echte Wiederholung.
- **Ganze Kugel begehbar:** 3D-Einheitsvektoren, Großkreis, Sicht/Anker/Halt/Kegel über Vektoren, Frontend per Quaternion, Dev-Grid als Breiten-/Längenkreise.
- **Checks entschlackt:** aktionsmismatch gestrichen, maxWords 20, Impuls-Würfel + seit-Flag.
- **Catch-up-Freeze:** Lücke > 60 s friert ein (ein reboot-Event, „Anzug-Reboot"), Mini-Lücken normal.
- **DB-Hygiene:** pruneDB alle 3600 Ticks + beim Serverstart (Rohticks > 7 Tage, thoughts > 500/Pilot).
- **60 Tests grün** (Manie-Cap, Notfall-Instinkt, Großkreis, Impuls-Gewichte, Freeze, Pruning, Migration).

## Behoben (2026-11-12, fünfte Runde)

- **Zickzack-Bremse:** A-B-A-B → erste Aktion setzt eine Runde aus (außer Notfall Hunger/Exhaustion > 80).
- **Ehrliche Alternativen bei Langeweile:** streifen (zufälliger Ort) und sinnieren (Musing fast immer) — beide immer wählbar.
- **Aktivitäts-Wippen:** Rollen um die Vorwärtsachse (3,4 Hz) beim Handeln.
- **Motiv-Quote ohne Welt-Wörter:** wrack/schatten/erde/öl wieder erlaubt — nur Stil-Tics verboten.

## Behoben (2026-11-12, vierte Runde)

- **Anker, Layout, Schatten:** Orte ≥ 25 m auseinander, sichtbar ≥ 20 m; Engine läuft das sichtbare Bauwerk an (Halt am Nahkreis, außer schlafen/rennen); Figur schaut das Ziel an; Schilder je Grad (weg / ? / Eine Art Turm? / Name); eine Shadowmap; Feed ein-/ausblendbar.
- **Sichtstufen (Paket I):** Discovery auf klarer Sicht (< 7 m im 160°-Kegel oder < 3 m rundum); 7–15 m nur Silhouette; Ungesehenes fehlt im Prompt. Blick aus Bewegung, Dev-Kegel.

## Behoben (2026-11-12, dritte Runde)

- **Gedanke/Aktion-Abgleich:** aktionsmismatch-Check (Wortanfänge in AKTIONSVERBEN, eigenes Verb zählt nie). Beleg-Fall eat + "ich werde graben" ist Test.
- **Musing-Limit:** Gedanke und Zusatz getrennt gespeichert (thought/musing), Feed zeigt Zusatz kursiv.
- **PLAN nachgezogen:** AGENTS/BEDIENUNG auf Stand gebracht.

## Behoben (2026-11-12, zweite Runde)

- **Werte umgekehrt:** Hunger/Erschöpfung/Stress statt Futter/Kraft/Nerven. Ausruhen bei gutem Zustand aktiv schädlich (Langeweile +0,0027/s).
- **Neugier:** Erstbesuch −12, zweiter −4, danach 0; erstes Tun −6, erste Aktion am Ort −8; 10 min ohne Neues → Stress steigt.
- **Repetitive Gedanken:** Motiv-Quota (Bild ≥ 3× in 12 → verboten + verworfen) · Musings ~35 % (nur Richtung vorgegeben, max. 10 Wörter) · Beliefs max. 3, nie zur letzten Aktion.
- **sit_shade:** sättigt, nur bei Erschöpfung > 35 oder Stress > 45. **look_earth:** nur bei Stress > 30 beruhigend, sonst hoch.
- **Neugier-Tick-Bug:** near_json am Piloten (vorher Speicher, 1449 statt 4). **IDs sind Text** (map(Number) → NaN). **/api/dev/set:** logEvent-Import fehlte (jetzt 200 + dev_set). **Debug-Panel:** eigene Scrollbereiche, Log auf 25. **Planet 120** mit Bogenlänge. **Dev:** drei Schieber + Zeitraffer. **Tests:** *.test.js nötig.

## Behoben (2026-11-12, erste Runde)

- **Modell still:** src/env.js Loader (CRLF, Quotes, Leerzeilen), Env hat Vorrang. Belegt: ok true, 913 ms.
- **SSE:** state jede Sekunde, feed sofort. **Tick-Drift:** Schleife an Wanduhr. **Tageszähler** aus created_tick. **Uhr rückwärts** → clock_skew. **Somatic Theories** ab 3× + Delta ≥ 0,2 (Modell formuliert, Ersatz nach 3 Versuchen). **Reload-Snap** (3,5 Einheiten/s). **was-Fehlalarm.** **Totzeit** (statt Sofort-Neustart). **Monotonie** nur bei Aktionsabschluss.

## Nächster Schritt (aus alter 01, damals)

1. B-Rest, K-Umsetzung, C–E, dann F–H, dann Tag/Nacht; 8-h-Lauf erst bei lohnenden Werten. 2. Dann WE 2: Platzhalter aufhübschen, Sprungmarken.


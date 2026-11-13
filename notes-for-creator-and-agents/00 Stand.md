---
typ: plan
status: gültig
stand: 2026-11-14
projekt: AIquarium
tags: [aiquarium, bruchpilot, 3d, llm, eigenprojekt]
---

# AIquarium — 00 Stand

Autonomes 24/7-Web-Terrarium: ein KI-gesteuerter Piloten-Charakter lebt auf einem kleinen Mond, die Engine rechnet die Wahrheit, das Modell darf nur fühlen, glauben und reden. Öffentlich als Kunststück, kein Produkt.

**Name:** nach außen **AIquarium** (`aiquarium.sebschuster.de`, später `aiquarium.space`), „Bruchpilot OS" nur als Stempel in der Ecke.

**Arbeiten:** [[01 Umsetzung]] (einzige Arbeitsdatei) · **Historie:** [[archiv/02-roadmap-2026-11-13]], [[archiv/03-runde3-2026-11-13]], [[archiv/behoben-log-2026-11-13]] · **Wünsche:** [[03 Nice to Haves small changes]] · **Fremdmaterial:** [[CREDITS]]

## Entschieden

- **Zweck** — öffentliches Kunstprojekt mit Fenster (Webseite), Beta ab v0.1.
- **Wahrheitsschicht** — Engine ist deterministisch die einzige Wahrheit; das LLM wählt nur aus validierter Whitelist und liefert Text.
- **Werte (gebaut 2026-11-14)** — zwei Kerne: **Körper 0–100** (0 = tot) und **Psyche −100…+100** (5 Zonen: Manie / Flow / Klar / Grüblerisch / Zusammenbruch). Darunter vier Treiber: **hunger** (passiv +, drückt body), **thermo** (−100…+100, Ort; Tag/Nacht folgt), **drang** (Novelty/Monotonie → Flow/Manie oder Stupor), **halt** (Erdung → Wahn). Spec: [[01 Umsetzung#Paket K — 2-Schichten-Wertesystem · gebaut 2026-11-14 (71 Tests grün)]].
- **Tag/Nacht** — wandernde Lichtkante + Erde-Tor, als drittes nach K/A gebaut (Sonne als Vektor, 2-h-Tag, kein Psyche-Effekt).
- **Tod** — Körper 0 = tot; 10 Minuten Totzeit, dann neuer Pilot mit neuem Namen (Komposit, Dopplung römisch). Kein Fernziel in v0.1.
- **Psyche −100** — Stupor oder Wahn je nach letzten 5 nerve_events; Ausweg Schlaf bzw. Kapsel; Notfall-Instinkt gegen garantierten Tod (sticht NICHT die Manie — Manie hat höhere Prio). Sichtbar als Wort („Meero · Tag 14 · Wahn").
- **Neugier als Motor** — neue Orte/Taten füttern die Psyche, 10 min ohne Neues drückt die Langeweile. Ausruhen bei gutem Zustand schadet, ohne je verboten zu sein.
- **Welt & Kamera** — ganze Kugel (Radius 120) begehbar (3D-Einheitsvektoren, Großkreis). Zwei Kameras (Charakter orbitbar / Planet mit Pin), Feed-Sprungmarke mit Stapel (aktuell → 1 vorher → Standard). Feed rechts, Ortsgebundenes einklappbar.
- **Stimme** — 1–2 Sätze, max. 20 Wörter, deutsch, keine Zahlen, Impuls pro Entscheidung, Post-Checks (Jaccard < 0,65, Ausruf-Bremse). Spec: [[01 Umsetzung#Anhang A — Stimme und Post-Checks]].
- **Forscher** — Prompt-Baukasten + 5 Impulse + Belief-Zweiteilung (somatic/world) + Ungereimtheit-Zeile, alles spec'd, Umsetzung offen. Spec: [[01 Umsetzung#Paket B — Formfreiheit · teils gebaut 2026-11-13]].
- **Öffentlichkeit** — Subdomain, noindex, Impressum, KI-Hinweis unten links, kein Login, keine Kommentare. Nur CC0/CC-BY, Nennung im Footer.

## Offen

- **Figur** — Nager oder Slime mit Händen? (Modelle noch nicht geladen.)
- **Assets** — Links in `links-zu-3d-models.txt`, nichts heruntergeladen, Lizenzen ungeprüft (siehe [[CREDITS]]).
- **Luftreiniger/Ventilator** als Zonen-Freischalter (v0.2+, braucht Crafting).
- **Umami/cookieless Tracking** — erst nach v0.1.

## Mockup (2026-11-12)

3D-Platzhalter: Kugel (Radius 120) mit acht Orten, Figur mit Helm, zwei Kameras, HUD (Körper/Psyche), Feed, Sprechblase. Bedienung: `1` `2`, ziehen = drehen, Rad = zoom. Dev-Modus `?mode=dev`: Schieber, Zeitraffer ×1/×3/×10, Debug-Rahmen.

![[mockup-nah.png]]
![[mockup-mittel.png]]
![[mockup-planet.png]]

## Nächster Schritt

**Vorab-Schnitt + K/B/A + Tag/Nacht gebaut** (2026-11-14, 82 Tests grün): Kugel, Checks, Freeze, Pruning, 2-Schichten-Werte, Musterbremse, Vorhaben + Weg, Grid 15°, wandernde Lichtkante + Erde-Tor. **Neu spec'd (kein Code):** Forscher-Baukasten, Belief-Zweiteilung, Ungereimtheit — Umsetzung offen.

Als Nächstes: Paket C nach [[01 Umsetzung#Paket C — Kurzzeitgedächtnis (gratis)]], dann D, E, danach F–H (dann J–M). 8-h-Lauf erst bei lohnenden Werten.

## Roh (Sebastian)

_neue Ideen hier abladen, werden beim nächsten Durchgang einsortiert_
# AIquarium — 03 Nice to Haves

Kleine Wünsche, nach Aufwand sortiert. Status: `offen` / `gebaut DATUM` / `geplant → Paket`.
Ausführliche Bewertung + Reihenfolge: [[01 Umsetzung#Gebaut (2026-11-14, 84 Tests grün)]].

## Sofort (Frontend, kein Risiko)

- [x] **Pole mit Flaggen markieren** — gebaut 2026-11-14. Nord blau / Süd orange, später Sektor-Nullpunkte (Paket J).
- [x] **Planetenoberfläche subtil mustern** — gebaut 2026-11-14. Canvas-Textur, Seed `20261114`, ±5 % Alpha. Idee: pro Sektor ±3 % Helligkeit (Wiedererkennung, später).
- [x] **Dev-Linien Planet→Sonne + Planet→Erde** — gebaut 2026-11-14. Nur `?mode=dev`, Deckung < 3,2° färbt rot (Finsternis-Debug).
- [x] **Kamera-Flip über den Polen (4b)** — gebaut 2026-11-14. Radiales Up im Planet-Modus, Charakter-Modus Welt-Y. Pole ohne Flip begehbar.

## Welt-Layout

- [x] **Orte weg vom Nordpol, aufs obere Cluster** — gebaut 2026-11-14 (`CLUSTER` 35°N/20°O, 84 Tests grün). Idee: HUD „Gründe statt Prozent" gehört hierher.
- [ ] **Map auf ganzen Planeten erweitern** — geplant → Paket J (Fibonacci-Sphere).

## Sektoren + Spuren (Paket J, nach C–H)

- [ ] **Welt in Sektoren einteilen** — geplant → Paket J. **Entschieden: Cube-Sphere** (kein Hex — Euler: 12 Fünfecke nötig; kein Polar-Grid — Flächen am Pol zu klein). Größe 20–25 m (~300–450 Sektoren, nicht 10 m). Boost bei Erstbetritt (`psyche`/`halt`, nur Wort „neuer Grund"). `G` schaltet dreistufig.
- [ ] **Fußstapfen pro Sektor, verwitternd** — geplant → nach J. 1× verstreute Abdrücke (keine Linie), persistent `traces`, fremde Spur = Discovery-light, zählt auf L2/M ein.

## Aufgehobene Ideen

- Flaggen = Sektor-Nullpunkte · Boden-Hash = Orientierung · Spur = Friedhof-Echo — alle in [[01 Umsetzung#Danach (geplant)]] einsortiert.


# neu von seb:

- frage: dimmt sich die sonne manchmal? sieht bissche nso aus, als wäre sie heller, wenn sie auf unseren bewohnten bereich scheint. oer liegt das daran, dass diem map noch nciht rundrum um den planeten geht?


- felsen sind gedankenlos überall auf den planeten gelegt worden, wo vorher nicht bewohnt war. jetzt haben wir wohnort cverschoben und der alte wohnort hat nur kleine stienchen, der neue (und der rest des planeten) riesen felsen. evtl überall selten felsen aber meistens steinchen?

neu: feddback einer anderen ki:

 three js libs: größter Hebel. OrbitControls würde deinen handgerollten Kamera-Code (ziehen/zoomen, Pole-Flip-Bug aus den Nice-to-Haves!) massiv vereinfachen, GLTFLoader brauchst du sowieso für Figur-Modelle (Nager/Slime). Kein npm nötig, einfach zwei Dateien neben three.module.js legen

 andere libs etc für uns AUCH HILFREICH? ich will zwar wenig dependencies, aber auch nicht rad neu erfinden immer wieder!
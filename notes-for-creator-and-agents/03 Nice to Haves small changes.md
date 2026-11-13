# AIquarium — 03 Nice to Haves

Kleine Wünsche, nach Aufwand sortiert. Status: `offen` / `beantwortet` / `abgelehnt` / `geplant → Paket`.
Erledigtes steht nicht mehr hier — siehe [[01 Umsetzung#Gebaut (2026-11-14, 84 Tests grün)]] und [[01 Umsetzung#Tag/Nacht — wandernde Lichtkante + Erde-Tor · gebaut 2026-11-14 (82 Tests grün)]].
Stand: 2026-11-14.

> Aufgeräumt 2026-11-14: Pole-Flaggen, Bodenmuster, Dev-Linien, Kamera-Up (4b) und Cluster-Umzug waren hier als `[x] gebaut` doppelt — sie stehen nur noch in 01. Neue Roh-Notizen von unten einsortiert + bewertet.

## Erledigt 2026-11-14 (Seb: „abdunkeln ist doch komplett quatsch" — Recht hat er)

- [x] **Deko-Balance: selten Felsen, meist Steinchen** — gebaut 2026-11-14 (`public/scene.js`, `baueDeko`).
  Ein Pass über die Kugel (z uniform/theta uniform, Seed `1337`): 220 Objekte, 80 % Steinchen (Geo 0/1/2, Skala ~0,5–1,8), 20 % Felsen (Dodeca 2.6, Skala ~1,2–2,8). Orte frei (9 m Sehne auf Engine-Vektor), Pole frei (5 m, Flaggen). Kulissen-Ring (220 Riesen) ersatzlos raus — Paket J verteilt eh neu. Toter `belegt`-Helper raus.
- [x] **Sonne rotiert, kein Dimmer** — gebaut 2026-11-14 (`public/scene.js`, `sonneSetzen`).
  `tag.phase` dimmt nichts mehr global: `sun.intensity = SONNE_TAG (3.2)`, `hemi = HEMI_TAG (1.35)` — konstant. Nacht wird dunkel, weil das DirectionalLight von der anderen Seite kommt. Nur Finsternis skaliert weiter global (`SONNE_F/HEMI_F`). Scheibe/Hof immer voll (nur total frisst sie), Lampe weiter lokal nach Phase (nacht 1 / dämmer 0,5). `SONNE_NACHT`/`HEMI_NACHT` ersatzlos raus.
  Syntax-Check (`node --check` als .mjs) grün. Engine-Tests: 79/84 — 5 Fehler sind Vorzustand (per `git stash` belegt: ohne scene.js-Änderung identisch), Frontend-only, unschuldig.

## Fremd-Feedback: Three.js-Libs — bewertet 2026-11-14

Vorschlag Fremd-KI: OrbitControls + GLTFLoader vendoren (zwei Dateien neben `three.module.js`), „andere libs auch hilfreich? will wenig dependencies, aber nicht alles neu erfinden."

- **OrbitControls — abgelehnt für v0.1.** Hand-Code (~60 Zeilen: ziehen/zoomen, Yaw frei, Pitch-Limits, radiales Up im Planet-Modus) tut's, Pol-Flip ist seit 4b gelöst. OrbitControls denkt in festem Up + festem Target — radiales Up + Kugel-Follow müsste man ihm wieder austreiben. Re-Eval erst, wenn die Kamera mehr soll (Pan, Sektor-Picken).
- **GLTFLoader — geplant, nicht jetzt.** Brauchen wir sowieso für die Figur (Nager/Slime), passt zur Vendor-Strategie (`public/engine/`, kein npm, keine Build-Chain). Erst wenn [[CREDITS]] geklärt + erstes GLB da (siehe [[00 Stand#Offen]]).
- **Sonstige Libs — keine.** Projekt ist bewusst zero-dep (`package.json`: `dependencies: {}`, Frontend nur `three.module.js`). Passt zum Kunststück (langlebig, kein Build-Bruch). Kein Bedarf: State via SSE, DB via SQLite, Rest Hand-Code.
- [ ] **GLTFLoader vendoren, sobald erstes Figur-GLB gewählt** (mit Figur-Entscheid Nager/Slime).

## Welt-Layout

- [ ] **Map auf ganzen Planeten erweitern** — geplant → Paket J (Fibonacci-Sphere).

## Sektoren + Spuren (Paket J, nach C–H)

- [ ] **Welt in Sektoren einteilen** — geplant → Paket J. **Entschieden: Cube-Sphere** (kein Hex — Euler: 12 Fünfecke nötig; kein Polar-Grid — Flächen am Pol zu klein). Größe 20–25 m (~300–450 Sektoren, nicht 10 m). Boost bei Erstbetritt (`psyche`/`halt`, nur Wort „neuer Grund"). `G` schaltet dreistufig.
- [ ] **Fußstapfen pro Sektor, verwitternd** — geplant → nach J. 1× verstreute Abdrücke (keine Linie), persistent `traces`, fremde Spur = Discovery-light, zählt auf L2/M ein.

## Aufgehobene Ideen

- Flaggen = Sektor-Nullpunkte · Boden-Hash = Orientierung · Spur = Friedhof-Echo — alle in [[01 Umsetzung#Danach (geplant)]] einsortiert.
- HUD „Gründe statt Prozent" gehört zum Cluster-Umzug — siehe [[01 Umsetzung#Gebaut (2026-11-14, 84 Tests grün)]].


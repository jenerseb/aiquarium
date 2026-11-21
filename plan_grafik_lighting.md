# Grafik- & Lighting-Plan: AIquarium Diorama

Alle geplanten Punkte wurden am **21.11.2026** in [public/scene.js](./public/scene.js) umgesetzt (und in [scripts/test-m3-7.js](./scripts/test-m3-7.js) abgeglichen):

- ✅ Sonnenbogen + Lichtfarbe (`tageszeitZustand`, `ZEIT_OVERRIDE_STUNDE`) + minütliches `shadowMap.needsUpdate`
- ✅ Stufenlose Morgen-/Abendröte-Skybox (`ShaderMaterial` mit Sonnen-Glow & dunkelblauem Nachthimmel + Sternen) + synchronisierte Wolken
- ✅ Realistisch dunkle Nacht (`umgebung` nachts auf `0.06`, Mond `0.22`, `hemi` `0.18`) + `256×256` **Laternen-Lightmap** (`uLightMap`) für Straßen, Luftbild & untere Hauswände (`y < 9 m`)
- ✅ Fake-AO am Gebäudefuß (Vertex-Color-Höhenabdunklung in `baueLoD2()`)
- ✅ Zufällige Nacht-Fenster (`~10 %` via Shader-Hash) mit zufälligem Farb-Mix zwischen Neutralweiß und warmem Orange (`emissiveMap`) & `bumpMap`
- ✅ Straßenlaternen über den Kiez (`baueLaternen`: 3 `InstancedMesh`es für Masten, Köpfe & Boden-Lichtpfützen)
- ✅ Subtiler Horizont-Dunst (`FogExp2`, Himmel mit `fog: false`)
- ✅ Charakter-Schatten (`castShadow`) & Geh-Animation der Beine
- ✅ Additive POI-Licht-Halos bei Nacht (`bauePoiHalo`)
- ✅ Regen-Partikel bei `weather === 'rain'` (`baueRegen`, `regenUpdaten`)
- ✅ Modellbau-Zierring am Diorama-Rand (grüne Bodenfläche deaktiviert → Schatten nur auf Luftbild)

*(Keine offenen Punkte mehr in diesem Plan.)*

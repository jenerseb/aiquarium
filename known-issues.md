

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
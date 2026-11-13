# AIquarium — Regeln für Coding-Agenten

Kurz und verbindlich. Bei Konflikt gilt diese Datei, nicht der Sprachgebrauch.

## Projekt

- Spielerisch-simulative Web-App: ein Charakter lebt autonom in einer kleinen 3D-Welt.
- Die **Engine** (Node + SQLite) ist die einzige Wahrheit über den Weltzustand.
- Das **LLM** liefert nur Absicht (aus einer Whitelist) und Text. Es rechnet nie.
- Kein Cloud-Dienst außer dem Modell-Endpunkt. Keine Tracker, keine Cookies in v0.1.

## Technik

- Node ≥ 22.5, **keine** npm-Abhängigkeiten in v0.1: `node:sqlite`, `node:http`, `fetch`.
- Alles Zeitliche in Sekunden, Tick ist die kleinste Einheit.
- Kein `setInterval` für den Spiel-Loop — sequenzielle Schleife, damit Ticks nicht überlappen.
- Zustand immer in SQLite, nie nur im Speicher. Neustart muss verlustfrei sein.
- Modellaufrufe: Timeout 30 s, ein Retry, danach deterministische Ersatzaktion + `stale`-Flag.

## Sprache und Ton

- Deutsch in UI, Prompts, Feed, Kommentaren und Commits.
- Prompts an das Modell: Deutsch, keine Prozentwerte im Text.
- Keine Emojis in Code und UI, außer in Kommentaren zur Gliederung.

## Qualität

- Vor jedem Commit: `npm test` (79 Tests, alle grün) und `npm run check`.
- Neue Regel = neuer Test. Kein Feature ohne Test, das im Vault-Plan als Pflicht markiert ist.
- Zahlen (Verbrauch, Schwellen) nur in `src/config.js`.
- Keine stillen Fehler: Modellfehler werden geloggt und im Zustand sichtbar gemacht.

## Was hier nicht hingehört

- Fog of War, Crafting, Social-Anbindung, Erd-Uplink — alles v0.2+.
- Neue Ideen: in den Vault-Plan unter Roh, nicht in den Code.

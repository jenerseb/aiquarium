# AIquarium — Bedienung

Kurz und praktisch. Das Repo liegt in `aiquarium-app/`, die Datenbank **außerhalb**, damit Sync sie nicht anfasst.

**Container-Pfad (seb-dev):** vor jedem `node`/`npm`-Befehl:

```
cd /workspaces/seb-dev/aiquarium/aiquarium-app
```

## Modell-Routing (model.json, kein Secret)

Default ist der **dev**-Slot (Free-Modell, unbegrenzt): `nvidia/nemotron-3.5-super-vl:free`.
Versuche pro Entscheidung: 1) aktiver Slot normal (`temperature 0.85`), 2) gleicher Slot
kühler (`retryTemperature 0.55`), 3) **Fallback**-Slot kühler (`openai/gpt-oss-120b`) —
danach deterministische Ersatzaktion + `stale`. `primary` (`z-ai/glm-5.3-flash`,
Reasoning an) greift nur bei `AIQUARIUM_DEV=0`, z. B. für den 50er-Messlauf:

```
AIQUARIUM_DEV=0 node src/server.js
```

Einzelne Slots überstimmen: `AIQUARIUM_MODEL`, `AIQUARIUM_FALLBACK_MODEL`, `AIQUARIUM_DEV_MODEL`.
`reasoningExclude` steht pro Slot (nemotron:free `true`, GLM/gpt-oss `false`).

(Nach einem Vault-Umzug Windows → Linux/Docker bricht nichts an Node — häufigste
Ursache ist nur das falsche Verzeichnis: `node src/server.js` im falschen Ordner
meldet `Cannot find module '.../src/server.js'`.)

## Wo was liegt

| Was | Pfad |
|---|---|
| Programm | `/workspaces/seb-dev/aiquarium/aiquarium-app/` |
| Zugangsschlüssel | `app/.env` (nicht im Git, nicht im Backup) |
| Datenbank | Linux/Container: `~/.local/share/aiquarium/world.sqlite` — oder `AIQUARIUM_DB` (empfohlen: gemountetes Volume, sonst beim Container-Rebuild weg) · Windows: `C:\Users\<du>\.local\share\aiquarium\world.sqlite` |
| Log (bei Hintergrundstart) | `app/aiquarium.log` |

## Starten

**Linux (VPS oder PC), im Vordergrund** — Strg+C beendet ihn sauber:

```
cd /workspaces/seb-dev/aiquarium/aiquarium-app
node src/server.js
```

**Linux, im Hintergrund** (läuft weiter, wenn das Terminal zugeht):

```
cd /workspaces/seb-dev/aiquarium/aiquarium-app
nohup node src/server.js > aiquarium.log 2>&1 & echo $! > aiquarium.pid
```

**Windows (PowerShell), im Vordergrund:**

```
cd "<Vault>\Seb Privat Stuff\aiquarium\app"
node src/server.js
```

**Windows, im Hintergrund:**

```
cd "<Vault>\Seb Privat Stuff\aiquarium\app"
$p = Start-Process node -ArgumentList 'src/server.js' -PassThru; $p.Id | Out-File aiquarium.pid
```

## Stoppen

- **Vordergrund:** `Strg+C`. Der Server schließt offene Verbindungen und ist in unter zwei Sekunden weg.
- **Linux, Hintergrund:** `kill $(cat aiquarium.pid)`
- **Windows, Hintergrund:** `Stop-Process -Id (Get-Content aiquarium.pid)`
- **Port belegt und PID unbekannt:** Linux `ss -ltnp | grep 3077` · Windows `Get-NetTCPConnection -LocalPort 3077 | Select-Object OwningProcess`

`kill -9` nur, wenn nichts anderes hilft. Er schreibt sekündlich in die Datenbank; ein hartes Abschießen ist dank WAL meist unkritisch, kann aber den letzten Tick verlieren. Verpasste Zeit holt er beim nächsten Start automatisch nach (max. 12 Stunden).

## Nach einer Änderung

Stoppen, starten. Kein Build, kein `npm install` — es gibt keine Abhängigkeiten.

## Läuft er?

```
curl http://127.0.0.1:3077/api/state
```

Im Startlog müssen zwei Zeilen stehen:

```
[env] …/app/.env geladen (1 gesetzt)
AIquarium läuft auf http://127.0.0.1:3077 (DB: …)
```

## Adressen

| Adresse | Was |
|---|---|
| `http://127.0.0.1:3077/` | 3D-Ansicht mit HUD, Feed (per `Feed`-Knopf ein-/ausblendbar, Standard: aus), zwei Kameras (`1` `2`) |
| `http://127.0.0.1:3077/?mode=dev` | zusätzlich das **Debug-Log**: jede Entscheidung mit Ziel, Dauer, Auswahlraum, Werten und Gedanken, im gestrichelten Rahmen |

Debug-Log liest `/api/debug` alle zwei Sekunden — der normale Live-Strom bleibt davon unberührt.

## Dev-Werkzeuge (nur `?mode=dev`)

Im Panel rechts unten:

- **Sechs Schieber** für Körper (0–100), Psyche (−100…+100) und die vier Treiber Hunger (0–100), Temperatur (−100…+100), Drang (−100…+100), Halt (0–100). Sie setzen den Wert sofort und schreiben ein `dev_set`-Ereignis ins Log.
- **Zeitraffer** `×1 / ×3 / ×10`: Die Simulationsuhr läuft schneller, alle Aktionen und Bedürfnisse entsprechend auch. Der aktuelle Faktor steht in der Kopfzeile.
- Jede Entscheidung erscheint mit Aktion, Ziel, Dauer, Auswahlmenü, Werten und Gedanken im gestrichelten Debug-Rahmen.
- **Taste `G`**: Kugel-Grid (Breiten-/Längenkreise alle 15°) ein/aus — zum Prüfen, wo Orte und Figur stehen.
- **Tag/Nacht**: Die Sonne wandert (1 Umdrehung = 2 h), das Licht dimmt mit. HUD zeigt `Tag N · Tag/Nacht/Dämmerung` (Nummer global, Phase lokal). Erde fest am Himmel — `Erde weg` im HUD heißt: kein Notruf möglich (Tor, kein Verbot).

Nur von `127.0.0.1` erreichbar; von außen antworten die Endpunkte mit 403:

```
curl "http://127.0.0.1:3077/api/dev/set?body=40&psyche=-30"
curl "http://127.0.0.1:3077/api/dev/speed?x=10"
```

Beim Start lässt sich der Faktor auch per Umgebung setzen: `AIQUARIUM_SPEED=10 node src/server.js`.

## Wenn etwas klemmt

| Symptom | Ursache und Abhilfe |
|---|---|
| „Modell still" im HUD | `model.last.reason` in `/api/state` lesen: `no_key` = `.env` fehlt/leer, `request: HTTP 401` = Key ungültig, `HTTP 429` = Rate-Limit |
| `EADDRINUSE` | Port belegt: `PORT=3080 node src/server.js` |
| Figur steht still | normal während einer Aktion (Aktionen haben Dauer); im Debug-Log steht, was läuft und wann sie endet |
| Alles zurücksetzen | Datenbank-Datei löschen (Historie weg), Server neu starten |
| Werte sehen verkehrt aus (Futter statt Körper) | Alte Datenbank von vor dem Werte-Rework: wird beim Öffnen automatisch auf Körper/Psyche abgebildet; alte Glaubenssätze werden dabei verworfen |
| `node -v` zu alt | Node ≥ 22.5 nötig, sonst fehlt `node:sqlite` |

## Tests

```
cd /workspaces/seb-dev/aiquarium/aiquarium-app
npm test          # 84 Tests (5 rot = Paket R, siehe 01 Umsetzung)
npm run check     # Syntaxprüfung aller Module
```

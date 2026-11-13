// 3D-Mockup: Platzhalter-Geometrie, drei Kamerapositionen, echte Engine-Daten.
// Bewusst ohne Modelldateien — erst der Loop, dann die Assets.
import * as THREE from './engine/three.module.js';

// ---------------------------------------------------------------- Grundwerte
const R = 120;                // Planetenradius (Meter) — 1 Weltmeter bleibt 1 Meter
const WORLD_R = 60;           // Radius der Spielfläche in Engine-Koordinaten

const DEV = new URLSearchParams(location.search).get('mode') === 'dev';

const stage = document.getElementById('stage');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
renderer.shadowMap.enabled = true;   // simple Schatten, ein Licht, eine Map
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.setSize(innerWidth, innerHeight);
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070b);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.5, 1200);

// Licht wandert mit der Sonne (Vektor aus /api/state), nicht fest.
// Start: alte Festposition, bis der erste State kommt.
const hemi = new THREE.HemisphereLight(0x3b4a63, 0x151311, 1.35);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
sun.position.set(0.45, 1, 0.35).normalize().multiplyScalar(200);
// Ganz simple Schatten: eine 1024er Shadowmap, Boden fängt, Meshes werfen
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -80;
sun.shadow.camera.right = 80;
sun.shadow.camera.top = 80;
sun.shadow.camera.bottom = -80;
sun.shadow.camera.near = 50;
sun.shadow.camera.far = 450;
sun.shadow.bias = -0.0005;
scene.add(sun);

// ---------------------------------------------------------------- Himmel
// Tag/Nacht: Die Sonne wandert (Vektor aus /api/state), Erde hängt fest.
// licht: Hemisphere hell, Sonne warm. Nacht: beides runter auf ~0,3.
// Tag/Nacht 2026-11-14: kein globales Dimmen mehr — Sonne rotiert, Richtung macht Tag/Nacht.
// Nur Finsternis skaliert (SONNE_F/HEMI_F in sonneSetzen). NACHT-Konstanten ersatzlos raus.
const HEMI_TAG = 1.35;
const SONNE_TAG = 3.2;
{
  const geo = new THREE.BufferGeometry();
  const pts = [];
  for (let i = 0; i < 900; i += 1) {
    const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
      .normalize().multiplyScalar(320 + Math.random() * 120);
    pts.push(v.x, v.y, v.z);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x8fa3bd, size: 1.4, sizeAttenuation: true })));
}

// Die Erde hängt fest am Himmel (V1) — der Anker für den späteren Uplink.
// Wird aus /api/state gesetzt (gleicher Vektor wie die Engine rechnet).
// Weit draußen als Scheibe (Sprite, immer zur Kamera), visuell GRÖSSER als
// die Sonne: 80 px bei ×900 schlägt 20 px Scheibe bei ×600 deutlich.
// Muster: prozeduraler Canvas (Ozean + Zufalls-Kontinente + Wolken), einmalig,
// keine Texturdatei, kein Rechenaufwand pro Frame.
// In-Scale-Himmel (winkeltreu, nicht maßstabstreu): Sonne + Erde auf derselben
// Schale (×900), Radien 10/40. Deckung = Richtungsabstand < (10+40)/900.
// Die Erde ist eine KUGEL mit StandardMaterial — das echte Sonnenlicht malt
// ihre Phasen von selbst (Vollerde/Halb/Neumond). Sprite war immer voll hell.
const HIMMEL_WEIT = 900;
const SONNE_RADIUS = 10, ERDE_RADIUS = 40;
// Deterministischer Seed — die Erde sieht bei jedem Laden gleich aus.
// Mulberry32, prozedural, keine Datei, kein Aufwand pro Frame.
function erdeZufall(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const erde = (() => {
  const zufall = erdeZufall(20261114);   // fester Seed: gleiche Erde bei jedem Laden
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;   // 2:1 Equirectangular — echte Kugel-Map, kein Kreis-Bild
  const g = c.getContext('2d');
  // Ozean-Grund: vertikaler Verlauf (Äquator satter, Pole dunkler/kälter)
  const ozean = g.createLinearGradient(0, 0, 0, 256);
  ozean.addColorStop(0, '#1a4a78');
  ozean.addColorStop(0.25, '#2a7ab8');
  ozean.addColorStop(0.5, '#3a8fd0');
  ozean.addColorStop(0.75, '#2265a0');
  ozean.addColorStop(1, '#143a63');
  g.fillStyle = ozean; g.fillRect(0, 0, 512, 256);
  // Kontinente in Equirect-Koordinaten: x = 0…512 (Länge), y = 0…256 (Breite).
  // Ellipsen-Cluster mit zerfranster Küste (Seed-gesteuert). Am linken/rechten
  // Rand doppelt malen (wrap) — sonst Naht an der Datumsgrenze.
  const gruen = ['#3f9150', '#5da85c', '#7cbf6a', '#2f7340'];
  const land = (x, y, rx, ry, n, streu) => {
    for (let i = 0; i < n; i += 1) {
      const ex = x + (zufall() - 0.5) * streu, ey = y + (zufall() - 0.5) * streu;
      const erx = rx * (0.35 + zufall() * 0.5), ery = ry * (0.35 + zufall() * 0.5);
      g.fillStyle = gruen[Math.floor(zufall() * gruen.length)];
      for (const ox of (ex < 60 || ex > 452) ? [0, -512, 512] : [0]) {
        g.beginPath(); g.ellipse(ex + ox, ey, erx, ery, zufall() * Math.PI, 0, Math.PI * 2); g.fill();
      }
    }
  };
  land(300, 128, 90, 62, 11, 110);   // Afrika/Eurasien-Block (Mitte/Osten)
  land(140, 120, 48, 55, 8, 70);     // Amerika-Band (Westen)
  land(410, 195, 30, 16, 4, 30);     // Australien-Klecks (unten rechts)
  land(256, 40, 90, 14, 5, 110);     // Nordküste (oben, schmal)
  // Eiskappen als gerade Bänder (Pole sind in Equirect oben/unten gerade)
  g.fillStyle = 'rgba(235,242,250,0.95)';
  g.fillRect(0, 0, 512, 20);
  g.fillRect(0, 236, 512, 20);
  // Wolken: dünne weiße Streifen, halbtransparent (Seed-gesteuert, fest)
  g.fillStyle = 'rgba(255,255,255,0.5)';
  for (let i = 0; i < 26; i += 1) {
    const x = zufall() * 512, y = zufall() * 256;
    g.beginPath();
    g.ellipse(x, y, 24 + zufall() * 44, 3 + zufall() * 5, (zufall() - 0.5) * 0.6, 0, Math.PI * 2);
    g.fill();
  }
  // KEINE gemalte Lichtkante mehr: Das Sonnenlicht (DirectionalLight) malt
  // die Phasen echt auf die Kugel — ein Fake-Schatten würde dagegen arbeiten.
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Kugel statt Sprite: Das Sonnenlicht (DirectionalLight) beleuchtet sie echt —
  // Phasen entstehen von selbst. Emissive lässt die Nachtseite schimmern
  // (kein Schwarz vor den Sternen). Kein Schattenwurf (26-km-Schatten in
  // 1024 px wäre Matsch — die Boden-Finsternis dimmt das Licht, nicht der Schatten).
  const erde = new THREE.Mesh(
    new THREE.SphereGeometry(ERDE_RADIUS, 32, 24),
    new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.9, metalness: 0,
      emissive: 0x0a1830, emissiveIntensity: 0.35,
    }),
  );
  erde.castShadow = false;
  erde.receiveShadow = false;
  return erde;
})();
const ERDE_VEC = { x: 0.7071, y: 0.6124, z: 0.3536 };   // wie ERDE in config.js
erde.position.set(0.5, 0.42, 0.75).normalize().multiplyScalar(HIMMEL_WEIT);
scene.add(erde);

// Die Sonne als sichtbarer Himmelskörper: kleine helle Scheibe + Hof,
// auf derselben Schale wie die Erde (×900). Das DirectionalLight
// bleibt unsichtbar — das hier ist sein Körper am Himmel.
const SONNE_WEIT = HIMMEL_WEIT;
const sonnenScheibe = new THREE.Mesh(
  new THREE.SphereGeometry(SONNE_RADIUS, 24, 16),
  new THREE.MeshBasicMaterial({ color: 0xfff3d6 }),
);
scene.add(sonnenScheibe);
const sonnenHof = (() => {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,240,210,0.9)');
  grad.addColorStop(0.35, 'rgba(255,220,160,0.35)');
  grad.addColorStop(1, 'rgba(255,210,140,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: true, depthWrite: false,
  }));
  sprite.scale.set(90, 90, 1);
  return sprite;
})();
scene.add(sonnenHof);

// ------------------------------------------------- Pole: Flaggen als Sektor-Nullpunkte
// Die Flaggen markieren Nord-/Südpol sichtbar — später Sektor-Nullpunkte (Paket J).
// Im Dev-Modus zusätzlich: durchgehende Polachsen-Linie (Süd→Nord, über beide
// Pole hinaus) + größere Flaggen, damit man die Achse aus jeder Entfernung sieht.
function polFlagge(nord) {
  const gruppe = new THREE.Group();
  const stange = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.12, 4.5, 8),
    new THREE.MeshStandardMaterial({ color: 0xd8dee8, roughness: 0.6 }),
  );
  stange.position.y = 2.25;
  stange.castShadow = true;
  const tuch = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 1.6),
    new THREE.MeshStandardMaterial({ color: nord ? 0x38bdf8 : 0xf5a524, side: THREE.DoubleSide, roughness: 0.8 }),
  );
  tuch.position.set(1.35, 3.5, 0);
  gruppe.add(stange, tuch);
  const pol = new THREE.Vector3(0, nord ? R : -R, 0);
  gruppe.position.copy(pol);
  gruppe.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pol.clone().normalize());
  if (DEV) gruppe.scale.setScalar(2.2);   // Dev: Flaggen größer, Achse sofort finden
  scene.add(gruppe);
  return gruppe;
}
polFlagge(true);
polFlagge(false);
let polAchse = null;
if (DEV) {
  // Polachse: dünne Linie Süd→Nord, beidseitig 25 über die Pole hinaus.
  // Nord-Hälfte cyan, Süd-Hälfte amber — Richtung auf einen Blick.
  const geoN = new THREE.BufferGeometry().setFromPoints(
    [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, R + 25, 0)]);
  const geoS = new THREE.BufferGeometry().setFromPoints(
    [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -(R + 25), 0)]);
  const linieN = new THREE.Line(geoN,
    new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.9 }));
  const linieS = new THREE.Line(geoS,
    new THREE.LineBasicMaterial({ color: 0xf5a524, transparent: true, opacity: 0.9 }));
  linieN.frustumCulled = false; linieS.frustumCulled = false;
  polAchse = new THREE.Group();
  polAchse.add(linieN, linieS);
  scene.add(polAchse);
}

// ---------------------------------------------------------------- Planet
// Mars-Oberfläche: rostrote Basis, dunkle/helle Marmorierung + stellenweise
// graue Patches (altes Gestein/Asche). Prozedurale Canvas-Textur (Seed fest —
// gleiches Bild bei jedem Laden), kein Rechenaufwand pro Frame.
function planetTextur() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  let s = 20261114;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
  // Basis: Mars-Rost mit leichtem vertikalem Verlauf (Pole etwas heller/staubiger)
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#c08a5e');
  grad.addColorStop(0.25, '#a95027');
  grad.addColorStop(0.6, '#9c4a24');
  grad.addColorStop(0.85, '#a95027');
  grad.addColorStop(1, '#bd8460');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 256);
  // Weiche Marmorierung: dunkle + helle Kleckse, sehr niedriger Kontrast
  for (let i = 0; i < 70; i += 1) {
    const x = rnd() * 512, y = rnd() * 256, r = 10 + rnd() * 34;
    g.fillStyle = rnd() > 0.45 ? 'rgba(70,28,12,0.10)' : 'rgba(232,150,100,0.10)';
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
  // Graue Patches: je Patch 5–9 überlappende Kreise → unregelmäßige Form
  for (let p = 0; p < 16; p += 1) {
    const px = rnd() * 512, py = 30 + rnd() * 196;
    const ton = ['125,120,112', '140,135,126', '105,100,94'][(rnd() * 3) | 0];
    const n = 5 + ((rnd() * 5) | 0);
    for (let k = 0; k < n; k += 1) {
      const x = px + (rnd() - 0.5) * 56, y = py + (rnd() - 0.5) * 30;
      const r = 8 + rnd() * 20;
      g.fillStyle = `rgba(${ton},${0.28 + rnd() * 0.22})`;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
  }
  // Feines Korn: helle + dunkle Sprenkel
  for (let i = 0; i < 2600; i += 1) {
    const x = rnd() * 512, y = rnd() * 256, r = 0.6 + rnd() * 2.2;
    g.fillStyle = rnd() > 0.5 ? 'rgba(255,220,180,0.07)' : 'rgba(40,15,5,0.08)';
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const planet = new THREE.Mesh(
  new THREE.SphereGeometry(R, 96, 64),
  new THREE.MeshStandardMaterial({ map: planetTextur(), roughness: 0.95, metalness: 0.05 }),
);
planet.receiveShadow = true;   // Boden fängt alle Schatten
scene.add(planet);

// Saturnartige Ringe: flach in der XZ-Ebene, teiltransparent (Oberfläche
// bleibt im Planet-View lesbar). Prozedurale Ring-Textur (radiale Bänder,
// Seed fest) auf RingGeometry — innen R+44, außen R+130 (Abstand, keine
// Berührung). Deutlich geneigt (~28°), damit man die Schräge sieht.
// DoubleSide, damit man sie von oben wie unten sieht;
// kein Schattenwurf (wäre Matsch).
const ringe = (() => {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 8;
  const g = c.getContext('2d');
  let s = 20261115;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
  // Radiale Bänder: helle Zonen + Lücken (Cassini!). Alpha niedrig = durchsichtig.
  const baender = [];
  let x = 0;
  while (x < 256) {
    const w = 6 + rnd() * 26;
    const hell = rnd();
    const a = hell > 0.82 ? 0.34 : hell > 0.55 ? 0.20 : 0.10;   // Deckkraft je Band
    const ton = hell > 0.55 ? '210,190,165' : '170,145,120';
    baender.push([x, Math.min(256, x + w), ton, a]);
    x += w + (rnd() > 0.75 ? 4 + rnd() * 14 : 0);   // Lücke
  }
  // Cassini-Lücke: breite fast leere Zone bei ~62 %
  for (const [x0, x1, ton, a] of baender) {
    const cassini = x0 < 165 && x1 > 150;
    for (let px = Math.floor(x0); px < Math.ceil(x1); px += 1) {
      const jitter = 0.75 + rnd() * 0.5;
      const alpha = cassini ? 0.02 : Math.min(0.42, a * jitter);
      g.fillStyle = `rgba(${ton},${alpha.toFixed(3)})`;
      g.fillRect(px, 0, 1, 8);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const geo = new THREE.RingGeometry(R + 44, R + 130, 128, 1);
  // RingGeometry-UVs sind planar — auf radial (x = Radius) umbiegen,
  // damit die Canvas-Bänder als konzentrische Ringe laufen.
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i += 1) {
    const rad = Math.hypot(pos.getX(i), pos.getY(i));
    uv.setXY(i, (rad - (R + 44)) / 86, 0.5);
  }
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, side: THREE.DoubleSide,
    depthWrite: false, opacity: 0.85,
  });
  const ring = new THREE.Mesh(geo, mat);
  ring.rotation.x = -Math.PI / 2 + 0.48;   // deutlich geneigt (~28°, lesbar schräg)
  ring.rotation.y = 0.18;                  // leichte Drehung, kein Frontal-Blick
  ring.renderOrder = 2;                     // nach dem Planeten, vor den Schildern
  scene.add(ring);
  return ring;
})();

// Koordinaten (x,z) der Engine auf die Kugel legen
const _v = new THREE.Vector3();
function placeOnPlanet(x, z, out = new THREE.Vector3()) {
  const r = Math.hypot(x, z);
  if (r < 1e-6) return out.set(0, R, 0);
  // Bogenlänge: r Meter auf der Kugel, nicht ein fester Winkel — sonst wirkt der Horizont wie eine Murmel
  const a = Math.min(r / R, Math.PI / 3);
  const s = Math.sin(a);
  const c = Math.cos(a);
  return out.set((x / r) * s * R, c * R, (z / r) * s * R);
}

// Objekt auf die Oberfläche setzen und nach oben ausrichten (flache x,z-Welt: Deko)
function aufOberflaeche(obj, x, z) {
  placeOnPlanet(x, z, _v);
  obj.position.copy(_v);
  obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _v.clone().normalize());
}

// ... und dasselbe direkt aus 3D-Koordinaten (Engine sendet Kugelvektoren)
function aufKugelVec(obj, x, y, z) {
  _v.set(x, y, z);
  const l = _v.length() || 1;
  _v.multiplyScalar(R / l);
  obj.position.copy(_v);
  obj.quaternion.setFromUnitVectors(HOCH, _v.clone().normalize());
}

// ---------------------------------------------------------------- Orte
const MAT = {
  metall: new THREE.MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.6, metalness: 0.5 }),
  rost: new THREE.MeshStandardMaterial({ color: 0x8b5a3c, roughness: 0.9 }),
  kap: new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.7 }),
  pflanze: new THREE.MeshStandardMaterial({ color: 0x6f8f4a, roughness: 0.9 }),
  karotte: new THREE.MeshStandardMaterial({ color: 0xd07a2a, roughness: 0.8 }),
  papier: new THREE.MeshStandardMaterial({ color: 0xe6e1cf, roughness: 1, side: THREE.DoubleSide }),
  stein: new THREE.MeshStandardMaterial({ color: 0x6f6a63, roughness: 1 }),
  wolke: new THREE.MeshStandardMaterial({ color: 0xe8eef4, roughness: 1, transparent: true, opacity: 0.82, depthWrite: false }),
};
const wolkenGeo = new THREE.SphereGeometry(1.6, 12, 10);

function label(text) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = '600 44px ui-sans-serif, system-ui, sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 28;
  c.width = w; c.height = 72;
  const x = c.getContext('2d');
  x.font = '600 44px ui-sans-serif, system-ui, sans-serif';
  x.fillStyle = 'rgba(8,12,18,0.55)';
  x.roundRect ? x.roundRect(0, 0, w, 72, 16) : x.fillRect(0, 0, w, 72);
  x.fill();
  x.fillStyle = 'rgba(232,238,247,0.92)';
  x.fillText(text, 14, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(w * 0.017, 1.2, 1);
  sprite.userData.base = { x: w * 0.017, y: 1.2 };
  return sprite;
}

// --------------------------------------------- Dev: Linien Planet→Sonne + Planet→Erde + Sonne→Erde
// Nur im Dev-Modus sichtbar — drei Linien: Kern zu Sonne, Kern zu Erde,
// Sonne zu Erde. Die Sonne→Erde-Linie verrät die Erd-Finsternis: Geht sie
// durch unseren Planeten (Kugel R=120), steht die Erde im Erdschatten.
// Die Deckungs-Färbung nutzt die Finsternis-Rechnung der Engine (Deckung < 3,2°).
let linieSonne = null, linieErde = null, linieSonneErde = null;
if (DEV) {
  const geoS = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]);
  linieSonne = new THREE.Line(geoS, new THREE.LineBasicMaterial({ color: 0xffd76a }));
  const geoE = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]);
  linieErde = new THREE.Line(geoE, new THREE.LineBasicMaterial({ color: 0x38bdf8 }));
  const geoSE = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]);
  linieSonneErde = new THREE.Line(geoSE, new THREE.LineBasicMaterial({ color: 0xc084fc, transparent: true, opacity: 0.7 }));
  linieSonne.frustumCulled = false; linieErde.frustumCulled = false; linieSonneErde.frustumCulled = false;
  scene.add(linieSonne, linieErde, linieSonneErde);
}
// Abstand Strecke Sonne→Erde zum Kern (0,0,0). < R → Strahl geht durch
// unseren Planeten → Erd-Finsternis (Erde steht in unserem Schatten).
// Läuft IMMER (auch ohne Dev), nur die Linie ist Dev-only.
let erdFinsternis = 0;   // 0 = keine, 1 = Erde im Erdschatten
const _seA = new THREE.Vector3(), _seB = new THREE.Vector3(), _seAB = new THREE.Vector3();
function erdSchattenRechnen(sonneRichtung) {
  _seA.copy(sonneRichtung).normalize().multiplyScalar(SONNE_WEIT);
  _seB.set(ERDE_VEC.x, ERDE_VEC.y, ERDE_VEC.z).normalize().multiplyScalar(HIMMEL_WEIT);
  _seAB.subVectors(_seB, _seA);
  const t = Math.max(0, Math.min(1, -_seA.dot(_seAB) / (_seAB.lengthSq() || 1)));
  // nächster Punkt der Strecke zum Kern = _seA + t·AB, Abstand = seine Länge
  const d = _seA.addScaledVector(_seAB, t).length();
  erdFinsternis = d < R ? 1 : 0;
  return erdFinsternis;
}
function devLinien(sonneRichtung) {
  erdSchattenRechnen(sonneRichtung);
  if (!DEV || !linieSonne) return;
  const kern = new THREE.Vector3(0, 0, 0);
  const s = sonneRichtung.clone().normalize().multiplyScalar(SONNE_WEIT);
  const e = new THREE.Vector3(ERDE_VEC.x, ERDE_VEC.y, ERDE_VEC.z).normalize().multiplyScalar(HIMMEL_WEIT);
  linieSonne.geometry.setFromPoints([kern, s]);
  linieErde.geometry.setFromPoints([kern, e]);
  linieSonneErde.geometry.setFromPoints([s, e]);
  // Finsternis-Deckung: Richtungsabstand wie in der Engine (FINSTERNIS.deckungMax 3,2°)
  const deckung = s.clone().normalize().angleTo(e.clone().normalize()) * 180 / Math.PI;
  linieSonne.material.color.setHex(deckung < 3.2 ? 0xff5a5a : 0xffd76a);
  // Sonne→Erde-Linie: rot wenn sie durch den Planeten geht (Erd-Finsternis)
  linieSonneErde.material.color.setHex(erdFinsternis ? 0xff5a5a : 0xc084fc);
}

function baueOrt(e) {
  const g = new THREE.Group();
  switch (e.type) {
    case 'capsule': {
      // Sockel, Fensterband (transparent), Dach — man kann hineinschauen
      const sockel = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.4, 1.6, 24), MAT.kap);
      sockel.position.y = 0.8;

      const fenster = new THREE.Mesh(
        new THREE.CylinderGeometry(2.95, 2.95, 4.0, 24, 1, true),
        new THREE.MeshPhysicalMaterial({
          color: 0xcfeaff, transparent: true, opacity: 0.16, roughness: 0.08,
          metalness: 0, side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      fenster.position.y = 3.6;

      // Rahmen oben und unten, damit das Glas als Band lesbar ist
      const ringUnten = new THREE.Mesh(new THREE.CylinderGeometry(3.05, 3.05, 0.22, 24), MAT.metall);
      ringUnten.position.y = 1.55;
      const ringOben = new THREE.Mesh(new THREE.CylinderGeometry(3.02, 3.02, 0.22, 24), MAT.metall);
      ringOben.position.y = 5.65;

      // Sprossen: vier schmale Stege, sonst wirkt es wie ein Zylinder ohne Fenster
      for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * Math.PI * 2;
        const steg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 4.0, 0.16), MAT.metall);
        steg.position.set(Math.cos(a) * 2.95, 3.6, Math.sin(a) * 2.95);
        steg.rotation.y = -a;
        g.add(steg);
      }

      const dach = new THREE.Mesh(new THREE.ConeGeometry(3.25, 2.6, 24), MAT.kap);
      dach.position.y = 6.95;

      // Innenraum: Boden, Konsole, warmes Licht
      const innen = new THREE.Mesh(new THREE.CylinderGeometry(2.85, 2.85, 0.12, 24),
        new THREE.MeshStandardMaterial({ color: 0x2f3640, roughness: 0.9 }));
      innen.position.y = 1.62;
      const konsole = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.85, 0.75), MAT.metall);
      konsole.position.set(0.7, 2.05, 0.8);
      konsole.rotation.y = -0.6;
      const schirm = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.55),
        new THREE.MeshBasicMaterial({ color: 0x6fe3b0 }));
      schirm.position.set(0.98, 2.38, 1.18);
      schirm.rotation.y = -0.6;
      const liege = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.28, 0.9), MAT.papier);
      liege.position.set(-1.15, 1.82, 1.0);
      const lampe = new THREE.PointLight(0xffd8a8, 26, 16, 2);
      lampe.position.set(0, 4.5, 0);

      // Dachlicht: kleine warme Außenlampe auf der Dachspitze — der Heimathafen
      // ist nachts als Leuchtfeuer lesbar. Leuchtet immer (tagsüber gegen die
      // Sonne chancenlos, nachts der Orientierungspunkt). Kein Schatten.
      const dachKnopf = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xffdca8 }));
      dachKnopf.position.set(0, 8.45, 0);
      const dachLicht = new THREE.PointLight(0xffc98a, 30, 14, 2);
      dachLicht.position.set(0, 8.9, 0);

      g.add(sockel, fenster, ringUnten, ringOben, dach, innen, konsole, schirm, liege, lampe,
        dachKnopf, dachLicht);
      break;
    }
    case 'shade': {
      const blech = new THREE.Mesh(new THREE.BoxGeometry(9, 0.35, 7), MAT.rost);
      blech.position.y = 3.4;
      blech.rotation.z = 0.12;
      const st1 = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 3.4, 8), MAT.metall);
      st1.position.set(-3.6, 1.7, 2.6);
      const st2 = st1.clone();
      st2.position.set(3.4, 1.7, -2.4);
      g.add(blech, st1, st2);
      break;
    }
    case 'wreck': {
      const rumpf = new THREE.Mesh(new THREE.BoxGeometry(9, 2.6, 4.5), MAT.rost);
      rumpf.position.y = 1.5;
      rumpf.rotation.y = 0.4;
      rumpf.rotation.z = -0.15;
      const flosse = new THREE.Mesh(new THREE.BoxGeometry(5, 2.4, 0.5), MAT.rost);
      flosse.position.set(-5, 3.4, 1);
      flosse.rotation.z = 0.5;
      const trumm = new THREE.Mesh(new THREE.BoxGeometry(3, 1.2, 2), MAT.metall);
      trumm.position.set(5.5, 0.6, -2);
      trumm.rotation.y = 0.9;
      g.add(rumpf, flosse, trumm);
      break;
    }
    case 'field': {
      for (let i = 0; i < 7; i += 1) {
        const a = (i / 7) * Math.PI * 2;
        const rr = 2.4 + (i % 3);
        const stiel = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.6, 6), MAT.pflanze);
        stiel.position.set(Math.cos(a) * rr, 0.8, Math.sin(a) * rr);
        const karotte = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.5, 8), MAT.karotte);
        karotte.position.set(Math.cos(a) * rr, 0.1, Math.sin(a) * rr);
        karotte.rotation.x = Math.PI;
        g.add(stiel, karotte);
      }
      break;
    }
    case 'mast': {
      const rohr = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 11, 10), MAT.metall);
      rohr.position.y = 5.5;
      const teller = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), MAT.kap);
      teller.position.y = 10.4;
      teller.rotation.x = Math.PI * 0.18;
      const kasten = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1), MAT.rost);
      kasten.position.y = 1.4;
      g.add(rohr, teller, kasten);
      break;
    }
    case 'note': {
      const zettel = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 2.4), MAT.papier);
      zettel.position.set(0, 1.6, 0);
      zettel.rotation.x = -0.5;
      const stein = new THREE.Mesh(new THREE.DodecahedronGeometry(0.7), MAT.rost);
      stein.position.set(0.9, 0.4, 0.2);
      g.add(zettel, stein);
      break;
    }
    case 'kuppel': {
      // Glaskuppel: Halbkugel transparent, Metallring, drei Beete darunter
      const glas = new THREE.Mesh(
        new THREE.SphereGeometry(4, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshPhysicalMaterial({
          color: 0xcfeaff, transparent: true, opacity: 0.25, roughness: 0.1,
          metalness: 0, side: THREE.DoubleSide, depthWrite: false,
        }));
      glas.position.y = 0.2;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(4, 0.3, 8, 24), MAT.metall);
      ring.position.y = 0.2;
      ring.rotation.x = Math.PI / 2;
      g.add(glas, ring);
      for (let i = -1; i <= 1; i += 1) {
        const beet = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.4, 1.1), MAT.pflanze);
        beet.position.set(0, 0.2, i * 1.8);
        g.add(beet);
      }
      break;
    }
    case 'bake': {
      // Notfunkbake: niedriger Mast, Kiste, rote Lampe
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 4.2, 8), MAT.metall);
      mast.position.y = 2.1;
      const kiste = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), MAT.rost);
      kiste.position.y = 0.5;
      const lampe = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xf43f5e }));
      lampe.position.y = 4.5;
      g.add(mast, kiste, lampe);
      break;
    }
    default: {
      const stein = new THREE.Mesh(new THREE.DodecahedronGeometry(1), MAT.rost);
      stein.position.y = 0.6;
      g.add(stein);
    }
  }
  const schild = label(e.name);
  schild.position.set(0, 8.5, 0);
  schild.visible = false;   // syncOrte setzt Text + Sichtbarkeit je Entdeckungsgrad
  g.add(schild);
  g.userData.schild = schild;
  g.userData.schildText = undefined;
  return g;
}

const orte = new Map();     // id -> Group

// ---------------------------------------------------------------- Deko: Steine + Wolken (rein optisch, kein Engine-Bezug)
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const deko = new THREE.Group();
const wolken = [];   // {x, z, h, tempo, gruppe}, treiben langsam in +x
let dekoGebaut = false;
const _wolkN = new THREE.Vector3();
const HOCH = new THREE.Vector3(0, 1, 0);
scene.add(deko);

function baueDeko(entities) {
  const zufall = mulberry32(1337);   // fester Seed: gleiche Welt bei jedem Reload
  // Vereinheitlicht 2026-11-14: ein Pass ueber die Kugel, 80 % Steinchen / 20 % Felsen.
  // Vorher zwei Welten (60 klein flach + 220 Riesen-Kulisse) — nach dem Cluster-Umzug
  // lag das Wohngebiet mitten im Riesenfeld. Seed fix (1337), Orte bleiben frei (9 m Sehne).
  const steinGeos = [new THREE.DodecahedronGeometry(0.7), new THREE.DodecahedronGeometry(1.2),
    new THREE.BoxGeometry(1.4, 0.7, 1.0), new THREE.DodecahedronGeometry(2.6)];
  const _sd = new THREE.Vector3();
  const _nord = new THREE.Vector3(0, R, 0);
  const _sued = new THREE.Vector3(0, -R, 0);
  // entities nutzen x/y/z (Engine-Vektor, Kugel x120) — Abstand als Sehne
  const belegtKugel = (p) => entities.some((e) => {
    const dx = (e.x || 0) - p.x, dy = (e.y || 0) - p.y, dz = (e.z || 0) - p.z;
    return dx * dx + dy * dy + dz * dz < 81;
  });
  let gesetzt = 0;
  for (let versuch = 0; versuch < 3000 && gesetzt < 220; versuch += 1) {
    // Gleichmaessig auf der Kugel: z uniform, theta uniform (kein Pol-Bias)
    const zz = zufall() * 2 - 1, th = zufall() * Math.PI * 2;
    const ss = Math.sqrt(Math.max(0, 1 - zz * zz));
    _sd.set(ss * Math.cos(th), zz, ss * Math.sin(th)).multiplyScalar(R);
    if (belegtKugel(_sd)) continue;
    if (_sd.distanceTo(_nord) < 5 || _sd.distanceTo(_sued) < 5) continue;   // Flaggen frei
    const w = zufall();
    const geo = w < 0.4 ? steinGeos[0] : w < 0.8 ? steinGeos[1] : w < 0.9 ? steinGeos[2] : steinGeos[3];
    const stein = new THREE.Mesh(geo, MAT.stein);
    stein.castShadow = true;
    stein.receiveShadow = true;
    const gr = w < 0.8 ? 0.5 + zufall() * 1.3 : 1.2 + zufall() * 1.6;
    stein.scale.set(gr * (0.7 + zufall() * 0.6), gr * (0.5 + zufall() * 0.5), gr * (0.7 + zufall() * 0.6));
    const dir = _sd.clone().normalize();
    stein.position.copy(dir).multiplyScalar(R - 0.25 * gr);
    stein.quaternion.setFromUnitVectors(HOCH, dir);
    stein.rotateY(zufall() * Math.PI);
    deko.add(stein);
    gesetzt += 1;
  }
  // Dichte Wolken aus je 4 Kugeln
  for (let i = 0; i < 12; i += 1) {
    const g = new THREE.Group();
    for (let k = 0; k < 4; k += 1) {
      const puff = new THREE.Mesh(wolkenGeo, MAT.wolke);
      puff.position.set((zufall() * 2 - 1) * 4.5, (zufall() * 2 - 1) * 0.8, (zufall() * 2 - 1) * 2.5);
      const ps = 0.7 + zufall() * 0.9;
      puff.scale.set(2.6 * ps, 1.3 * ps, 1.9 * ps);
      g.add(puff);
    }
    const w = {
      x: (zufall() * 2 - 1) * 90, z: (zufall() * 2 - 1) * 90,
      h: 20 + zufall() * 12, tempo: 0.3 + zufall() * 0.5, gruppe: g,
    };
    wolken.push(w);
    deko.add(g);
  }
}

function syncOrte(entities) {
  for (const e of entities) {
    let g = orte.get(e.id);
    if (!g) {
      g = baueOrt(e);
      orte.set(e.id, g);
      scene.add(g);
      g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    }
    // e.x/e.y/e.z sind Anker-Koordinaten (sichtbares Bauwerk, siehe config.js)
    aufKugelVec(g, e.x, e.y, e.z);
    // Schild folgt dem Entdeckungsgrad (? → Silhouette → Name), nicht der DB-Flagge
    const txt = e.label || null;
    if (g.userData.schildText !== txt) {
      g.userData.schildText = txt;
      if (g.userData.schild) {
        g.remove(g.userData.schild);
        g.userData.schild.material.map?.dispose();
        g.userData.schild.material.dispose();
        g.userData.schild = null;
      }
      if (txt) {
        const s = label(txt);
        s.position.set(0, 8.5, 0);
        g.add(s);
        g.userData.schild = s;
      }
    }
    if (g.userData.schild) g.userData.schild.visible = mode !== 'planet';
  }
  if (!dekoGebaut && entities.length) {
    dekoGebaut = true;
    baueDeko(entities);   // einmalig: Steine meiden die Orte, danach ändert sich nichts mehr
  }
}

// ---------------------------------------------------------------- Figur
const FIGUR_SKALA = 0.5;   // Figur ist halb so groß wie die Welt um sie herum
const figur = new THREE.Group();
const korperMat = new THREE.MeshStandardMaterial({ color: 0xd9c9a8, roughness: 0.85 });
const korper = new THREE.Mesh(new THREE.CapsuleGeometry(1.15, 1.5, 8, 16), korperMat);
korper.position.y = 2.1;
const kopf = new THREE.Mesh(new THREE.SphereGeometry(1.0, 20, 16), korperMat);
kopf.position.y = 3.9;
const augeMat = new THREE.MeshStandardMaterial({ color: 0x101418 });
const augeL = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), augeMat);
augeL.position.set(-0.33, 4.05, 0.86);
const augeR = augeL.clone();
augeR.position.x = 0.33;
const helm = new THREE.Mesh(
  new THREE.SphereGeometry(1.35, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.62),
  new THREE.MeshStandardMaterial({ color: 0x9fb4c9, roughness: 0.35, metalness: 0.6, transparent: true, opacity: 0.5 }),
);
helm.position.y = 3.95;
figur.add(korper, kopf, augeL, augeR, helm);
figur.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
// Namensschild über der Figur (wie Ortsnamen über Orten): Sprite, immer zur Kamera
const namensSchild = label('…');
namensSchild.position.set(0, 6.2, 0);
figur.add(namensSchild);
figur.userData.schild = namensSchild;
figur.userData.schildText = undefined;
scene.add(figur);

// Helmleuchte: kleines warmes PointLight an der Stirn — erhellt den Astronauten
// selbst minimal, auch tagsüber wenn das Gesicht im Schatten liegt.
// Reichweite ~6 m (nur Figur + Nahfeld), kein Schatten (billig, nur Aufhellen).
// Tagsüber dezent (Sockel), nachts/dämmrig voller (mit Taschenlampe gekoppelt).
const helmLicht = new THREE.PointLight(0xfff1dd, 1.2, 7, 1.8);
helmLicht.position.set(0, 4.6, 1.1);
figur.add(helmLicht);
// Nah-Fill von vorn-oben: fängt den Gesichtsschatten auch bei Gegenlicht.
// Sitzt an der Figur (Kind-Knoten), zeigt fix nach vorn auf Kopfhöhe.
const gesichtsFill = new THREE.SpotLight(0xdfeaff, 0, 9, 45 * Math.PI / 180, 0.9, 1.6);
gesichtsFill.position.set(0, 5.2, 3.2);
figur.add(gesichtsFill);
gesichtsFill.target.position.set(0, 3.9, 0);
figur.add(gesichtsFill.target);

// Taschenlampe: SpotLight an der Figur, Blickrichtung = weiche _blick-Richtung.
// Warmweiß, ~25° Öffnung, ~18 m weit — grob die „mittel"-Distanz (15 m).
// An nur bei Nacht/Dämmerung; tagsüber unsichtbar. Kein Schatten (teuer),
// nur Aufhellen. Der sichtbare Kegel ist dezent, im Dev-Modus aus.
const lampe = new THREE.SpotLight(0xffe6c0, 0, 22, 25 * Math.PI / 180, 0.5, 1.2);
lampe.position.set(0, 3.6, 0.6);
figur.add(lampe);
lampe.target.position.set(0, 1.5, 12);
figur.add(lampe.target);
const lampenKegel = new THREE.Mesh(
  new THREE.ConeGeometry(4.2, 16, 20, 1, true),
  new THREE.MeshBasicMaterial({
    color: 0xffe6c0, transparent: true, opacity: 0.05,
    side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
  }),
);
lampenKegel.position.set(0, 2.2, 8);
lampenKegel.rotation.x = Math.PI / 2 - 0.12;   // leicht nach unten geneigt
lampenKegel.visible = false;
figur.add(lampenKegel);

// Dev-Sichtkegel (Paket I, nur ?mode=dev): 15 m vage + 7 m klar als Overlay,
// ausgerichtet am Engine-Heading. Kein Tiefentest — reine Debug-Anzeige.
let kegel = null;
const _fwd = new THREE.Vector3();
const _rechts = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _blick = new THREE.Vector3(0, 0, 1);   // weiche Blickrichtung der Figur (Engine-Heading)
const _rolle = new THREE.Quaternion();          // seitliches Wippen (Aktivität zeigen)
const _vorwaerts = new THREE.Vector3(0, 0, 1);
if (DEV) {
  kegel = new THREE.Group();
  kegel.visible = false;
  scene.add(kegel);
}

// Dev-Grid (Taste G, nur ?mode=dev): Breiten- und Längenkreise der Kugel.
// Zum Prüfen, wo was steht — funktioniert überall, nicht nur an der Polkappe.
const gridGruppe = new THREE.Group();
gridGruppe.visible = false;
scene.add(gridGruppe);
let gridGebaut = false;
function baueGrid() {
  const mat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.3 });
  const pts = [];
  const ring = (ptsArr) => { for (let i = 0; i < ptsArr.length - 1; i += 1) pts.push(...ptsArr[i], ...ptsArr[i + 1]); };
  // Breitenkreise alle 15° (Paket A: verdoppelt, vorher 30°)
  for (let b = -75; b <= 75; b += 15) {
    const phi = (90 - b) * Math.PI / 180;
    const kr = [];
    for (let a = 0; a <= 48; a += 1) {
      const t = (a / 48) * Math.PI * 2;
      kr.push([Math.sin(phi) * Math.cos(t) * (R + 0.4), Math.cos(phi) * (R + 0.4), Math.sin(phi) * Math.sin(t) * (R + 0.4)]);
    }
    ring(kr);
    const s = label(`${b}°`);
    const t0 = 0;
    s.position.set(Math.sin(phi) * Math.cos(t0) * (R + 1.6), Math.cos(phi) * (R + 1.6) + 1.2, Math.sin(phi) * Math.sin(t0) * (R + 1.6));
    gridGruppe.add(s);
  }
  // Längenkreise alle 15° (Paket A: verdoppelt, vorher 30°) — beschriftet weiter jeder zweite
  for (let k = 0; k < 24; k += 1) {
    const t = (k / 24) * Math.PI * 2;
    const kr = [];
    for (let a = 0; a <= 48; a += 1) {
      const phi = (a / 48) * Math.PI;
      kr.push([Math.sin(phi) * Math.cos(t) * (R + 0.4), Math.cos(phi) * (R + 0.4), Math.sin(phi) * Math.sin(t) * (R + 0.4)]);
    }
    ring(kr);
    if (k % 2 === 0) {
      const s = label(`${k * 15}°`);
      s.position.set(Math.cos(t) * (R + 1.6), (R + 1.6) + 1.2, Math.sin(t) * (R + 1.6));
      gridGruppe.add(s);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  gridGruppe.add(new THREE.LineSegments(geo, mat));
}
addEventListener('keydown', (ev) => {
  if ((ev.key === 'g' || ev.key === 'G') && DEV) {
    if (!gridGebaut) { gridGebaut = true; baueGrid(); }
    gridGruppe.visible = !gridGruppe.visible;
  }
});

// Dev-Sichtkegel (Paket I): Sektoren werden aus /api/state gebaut, nicht aus
// festen Zahlen — Config-Änderungen erscheinen nach Reload von selbst.
let kegelWerte = '';
function syncKegel(sicht) {
  if (!kegel) return;
  const s = sicht || {
    fernWeit: { winkel: 160, dist: 30 }, fernEng: { winkel: 45, dist: 40 },
    mittel: { winkel: 100, dist: 20 }, nah: { winkel: 90, dist: 5 }, kontakt: 3,
  };
  const key = JSON.stringify(s);
  if (key === kegelWerte) return;
  kegelWerte = key;
  while (kegel.children.length) {
    const m = kegel.children.pop();
    m.geometry.dispose();
    m.material.dispose();
  }
  const sektor = (zone, farbe, deckkraft) => {
    const halb = (zone.winkel / 2) * Math.PI / 180;
    const geo = new THREE.CircleGeometry(Math.max(zone.dist, 0.1), 40, Math.PI / 2 - halb, halb * 2);
    geo.rotateX(-Math.PI / 2);
    geo.rotateY(Math.PI);                     // Sektor zeigt lokal +Z (Blickrichtung)
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: farbe, transparent: true, opacity: deckkraft,
      side: THREE.DoubleSide, depthWrite: false, depthTest: false,
    }));
    m.renderOrder = 999;
    return m;
  };
  kegel.add(
    sektor(s.fernWeit, 0x38bdf8, 0.06),
    sektor(s.fernEng, 0x38bdf8, 0.10),
    sektor(s.mittel, 0x38bdf8, 0.22),
    sektor({ winkel: s.nah.winkel, dist: s.nah.dist + (s.vorlauf || 0) }, 0xf5a524, 0.35),
  );
}

// Pin für die Planetenansicht: dort ist die Figur nur ein Punkt
const pin = (() => {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(190,235,255,1)');
  grad.addColorStop(0.22, 'rgba(90,200,250,0.75)');
  grad.addColorStop(1, 'rgba(90,200,250,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  }));
  sprite.scale.set(9, 9, 1);
  sprite.visible = false;
  return sprite;
})();
scene.add(pin);

// Grab, wenn der Pilot tot ist
const grab = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.6, 0.4),
  new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 1 }));
grab.visible = false;
scene.add(grab);

// ---------------------------------------------------------------- Kamera
// Zwei Modi: Charakter (folgt der Figur) und Planet (frei drehbar, immer auf
// den Kern zentriert). Charakter-Pitch ist die Elevation über der lokalen
// Tangentialebene (Achse Figur→Mittelpunkt), nicht über Welt-Y — sonst kippt
// die Cam am Äquator anders als an der Polkappe.
const MODES = {
  charakter: { dist: 13, min: 6, max: 80, yaw: 0.7, pitch: 0.22, pitchMin: -0.1, pitchMax: 1.25, target: 'pilot' },
  // Planet: Pitch bis ±85° (fast Pole, kein Gimbal mehr dank radialem Up).
  // Weit raus bis 640 (Ringe außen R+130 bleiben im Bild). Up im Planet-Modus
  // ist persistent (freies Rollen): kein Nordpol-Zwang mehr — die Achse kann
  // schräg stehen und bleibt schräg. Shift+Ziehen rollt, normal Ziehen orbitet.
  planet: { dist: 380, min: 250, max: 640, yaw: 0.6, pitch: 0.85, pitchMin: -1.48, pitchMax: 1.48, target: 'planet' },
};
const PLANET_TILT = 0.55;   // Planet-Up fest um ~31° um die Blickachse kippen — Achse steht sichtbar schräg

let mode = 'charakter';
const cam = { yaw: MODES.charakter.yaw, pitch: MODES.charakter.pitch, dist: MODES.charakter.dist };
const camZiel = { yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist };

// Richtungs-Blend (Variante B, beide Wege): Klickpunkt/Kern erst halten,
// dann weich zum Ziel. Beim Umschalten frieren wir StartPos/StartLook/StartUp
// ein und fahren die Kamera in Weltkoordinaten — dadurch kein Yaw-Sprung
// zwischen Tangential-Frame (Charakter) und Welt-Yaw (Planet) und kein
// langer Interpolations-Schwenk.
const BLEND_DAUER = 2.0;   // s gesamt: ~0,7 s halten + ~1,3 s fahren (Ease-In-Out)
const modusBlend = {
  aktiv: false,
  t: 0,
  von: 'charakter',   // Start-Modus der Fahrt
  startPos: new THREE.Vector3(),
  startLook: new THREE.Vector3(),
  startUp: new THREE.Vector3(0, 1, 0),
  // Beide Wege: eingefrorene End-Pose in Weltkoordinaten (einmalig in setzeModus
  // berechnet, danach nur noch per Figuren-Delta mitgeführt — keine Kurve).
  // Drehen-vor-Zoomen: Richtung (drehMix, läuft zuerst) und Abstand (zoomMix,
  // setzt überlappend ein) fahren getrennt — sonst schneidet die Gerade die Kugel.
  endPos: new THREE.Vector3(),
  endLook: new THREE.Vector3(),
  startDir: new THREE.Vector3(0, 1, 0),  // Offset-Richtung Start (normiert)
  endDir: new THREE.Vector3(0, 1, 0),    // Offset-Richtung Ende (normiert)
  startDist: 13,                          // Offset-Länge Start
  endDist: 13,                            // Offset-Länge Ende
  endYaw: 0,
  followFig: new THREE.Vector3(),  // letzte Figuren-Position für die Mitführung
  upNach: 0,                        // Up-Nachblend in s nach Blend-Ende (gegen Roll-Snap)
  rollExtra: 0,                     // Roll-Gedächtnis aus Shift+Ziehen (bleibt über Fahrten erhalten)
};
const _upZiel = new THREE.Vector3();
const _figNeu = new THREE.Vector3();
const _figDelta = new THREE.Vector3();
const _nRueck = new THREE.Vector3(0, 1, 0);   // Rückweg-Normale (lokal aus istP, normal lebt nur in tick())
const _blendEnde = new THREE.Vector3();
const _blendLook = new THREE.Vector3();
const _blendUp = new THREE.Vector3();
const _KERN = new THREE.Vector3(0, 0, 0);
function winkelDelta(a, b) {
  // kürzeste Differenz b - a in [-PI, PI], damit 3,1 → -3,1 nicht um den Planeten rotiert
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function glatt01(x) {
  // Smootherstep (6t⁵−15t⁴+10t³): Ease-In-Out mit noch weicheren Enden als
  // Smoothstep — kein „Anstoßen" beim Anhalten auf 2,0 s.
  const k = Math.min(1, Math.max(0, x));
  return k * k * k * (k * (k * 6 - 15) + 10);
}
// Phasenversetzte Mixe: drehMix läuft zuerst (Großteil des Weges drehen,
// außen bleiben), zoomMix setzt überlappend ein (rein-/rauszoomen).
// Anteile von k: Drehen 0 → 0,78 · Zoom 0,42 → 1 · Look hält bis 0,35.
const DREH_ENDE = 0.78;
const ZOOM_START = 0.42;
function drehMixFaktor(t) {
  return glatt01(t / (BLEND_DAUER * DREH_ENDE));
}
function zoomMixFaktor(t) {
  return glatt01((t - BLEND_DAUER * ZOOM_START) / (BLEND_DAUER * (1 - ZOOM_START)));
}
function posMixFaktor() {
  return glatt01(modusBlend.t / BLEND_DAUER);
}

const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
const zielPunkt = new THREE.Vector3(0, R, 0);

// Radial-Frame der Charakter-Cam: T1/T2 spannen die Tangentialebene (⊥ N).
// T1 = „Norden" (Meridian-Richtung), T2 = N × T1. Yaw dreht darin, Pitch ist
// die Elevation darüber — die Kipp-Erlaubnis hängt damit an der Achse
// Charakter→Mittelpunkt, nicht an Welt-Y.
const _tanA = new THREE.Vector3(1, 0, 0);
const _tanB = new THREE.Vector3(0, 0, 1);
const _tanH = new THREE.Vector3();
const _wunsch = new THREE.Vector3();
const _seit = new THREE.Vector3();
let camStartGesicht = true;   // nächster Tick rahmt das Gesicht ein (Seite frei ±45°)
const GESICHT_SEITE = Math.PI / 4;  // 45° Spielraum links/rechts der Blickachse
function tangentialBasis(n) {
  _tanH.set(0, 1, 0).addScaledVector(n, -n.y);
  if (_tanH.lengthSq() < 1e-6) _tanH.set(1, 0, 0).addScaledVector(n, -n.x);
  if (_tanH.lengthSq() < 1e-6) _tanH.set(0, 0, 1).addScaledVector(n, -n.z);
  _tanA.copy(_tanH.normalize());
  // Rechtssystem: _tanB = _tanA × N (NICHT N × _tanA) — sonst misst
  // atan2(wunsch·_tanB, wunsch·_tanA) den Winkel andersherum als die
  // Positionsformel _tanA·cos(yaw) + _tanB·sin(yaw) ihn aufbaut, und die
  // Kamera landet auf der gespiegelten Seite. BITTE NICHT „AUFRÄUMEN".
  _tanB.crossVectors(_tanA, n);
}

function setzeModus(neu) {
  if (!MODES[neu]) return;
  mode = neu;
  const m = MODES[neu];
  if (neu === 'charakter') {
    // Rückweg = gleiche Fahrt rückwärts, aber mit EINGEFRORENEM Ziel:
    // End-Pose einmalig aus live-Figur/normal/Gesichts-Yaw in Weltkoordinaten
    // rechnen, danach nur noch per Figuren-Delta mitführen. Das alte
    // „Ziel jeden Tick aus cam.yaw/pitch/dist neu rechnen" hat das Ziel
    // selbst bewegt (Expo lief gleichzeitig) — das gab die gebogene Fahrt.
    tangentialBasis(_nRueck.set(istP.x, istP.y, istP.z).normalize());
    // Gesichts-Yaw: Blick auf Tangentialebene projizieren. Aus der
    // ±45°-Spanne (GESICHT_SEITE) wird die Gradzahl mit dem kleinsten
    // Drehaufwand vom Start-Yaw gewählt — nicht stur links/rechts.
    // Der Dreh zu „ins Gesicht" beginnt erst spät (GESICHT_START).
    _wunsch.copy(_blick).addScaledVector(_nRueck, -_blick.dot(_nRueck));
    if (_wunsch.lengthSq() < 1e-6) _wunsch.set(0, 0, 1).applyMatrix4(_basis);
    _wunsch.normalize();
    _seit.crossVectors(_wunsch, _nRueck).normalize();  // links der Figur
    const yawDirekt = Math.atan2(_wunsch.dot(_tanB), _wunsch.dot(_tanA));
    // Start-Yaw: Blick von der Planet-Pose auf die Figur (wo wir herkommen).
    _figNeu.copy(camera.position.lengthSq() > 1e-6 ? camera.position : camPos)
      .sub(figur.position);
    // In Tangentialebene projizieren für vergleichbare Yaw-Basis.
    _figNeu.addScaledVector(_nRueck, -_figNeu.dot(_nRueck));
    if (_figNeu.lengthSq() < 1e-6) _figNeu.copy(_wunsch);
    _figNeu.normalize();
    const yawStart = Math.atan2(_figNeu.dot(_tanB), _figNeu.dot(_tanA));
    // Feinsuche über die Spanne: welcher Offset ∈ [-45°, +45°] braucht
    // den kleinsten Dreh vom Start-Yaw? (9 Stützstellen à 11,25° reichen.)
    let seite = 0;   // als Winkel-Offset, nicht nur links/rechts
    let bestDreh = Infinity;
    for (let k = -4; k <= 4; k += 1) {
      const off = (k / 4) * GESICHT_SEITE;
      const d = Math.abs(winkelDelta(yawStart, yawDirekt + off));
      if (d < bestDreh) { bestDreh = d; seite = off; }
    }
    _wunsch.multiplyScalar(Math.cos(seite))
      .addScaledVector(_seit, Math.sin(seite));
    const yawNeu = Math.atan2(_wunsch.dot(_tanB), _wunsch.dot(_tanA));
    const sp = Math.sin(m.pitch), cp = Math.cos(m.pitch);
    _tanH.copy(_tanA).multiplyScalar(Math.cos(yawNeu))
      .addScaledVector(_tanB, Math.sin(yawNeu));
    _figNeu.copy(figur.position).addScaledVector(_nRueck, -1.0);
    modusBlend.endLook.copy(_figNeu).addScaledVector(_nRueck, 3.0);
    modusBlend.endPos.copy(modusBlend.endLook)
      .addScaledVector(_tanH, cp * m.dist)
      .addScaledVector(_nRueck, sp * m.dist);
    const bodenAb0 = modusBlend.endPos.length();
    if (bodenAb0 < R + 0.6) modusBlend.endPos.multiplyScalar((R + 0.6) / (bodenAb0 || 1));
    modusBlend.followFig.copy(_figNeu);
    modusBlend.endYaw = yawNeu;
    // Rückweg-Start: Richtung/Dist aus aktueller Pose relativ zum
    // Start-Look (Kern) — gleiche Bezugsgröße wie die Fahrt-Geometrie.
    _figNeu.copy(camera.position.lengthSq() > 1e-6 ? camera.position : camPos).sub(zielPunkt);
    modusBlend.startDist = Math.max(_figNeu.length() || m.dist, R + 2);
    modusBlend.startDir.copy(_figNeu).normalize();
    modusBlend.endDist = modusBlend.endPos.clone().sub(modusBlend.endLook).length() || m.dist;
    modusBlend.endDir.copy(modusBlend.endPos).sub(modusBlend.endLook).normalize();
    modusBlend.startPos.copy(camera.position.lengthSq() > 1e-6 ? camera.position : camPos);
    modusBlend.startLook.copy(zielPunkt);
    modusBlend.startUp.copy(camera.up);
    modusBlend.t = 0;
    modusBlend.von = 'planet';
    modusBlend.aktiv = true;
    modusBlend.upNach = 0;
    camStartGesicht = false;   // kein Snap während/nach der Fahrt (siehe unten)
    camZiel.dist = m.dist;
    // Yaw/Pitch bleiben während der Fahrt eingefroren — der Welt-Blend trägt.
    camZiel.pitch = cam.pitch;
    camZiel.yaw = cam.yaw;
  } else {
    // Hinweg: Achse = Kern ↔ letzter Charakter-Standpunkt (N).
    // Position als Kugel-Interpolation: Richtung per Slerp drehen, Radius
    // wachsen lassen, Look Klickpunkt → Kern. Kein Durchflug, kein Kern-Bogen.
    const nl = Math.hypot(istP.x, istP.y, istP.z) || 1;
    _nRueck.set(istP.x / nl, istP.y / nl, istP.z / nl);
    const yawNeu = Math.atan2(_nRueck.z, _nRueck.x);
    const pitchNeu = Math.min(m.pitchMax, Math.max(m.pitchMin, Math.asin(Math.min(1, Math.max(-1, _nRueck.y)))));
    const sp = Math.sin(pitchNeu), cp = Math.cos(pitchNeu);
    modusBlend.endLook.copy(_KERN);
    modusBlend.endDir.set(Math.cos(yawNeu) * cp, sp, Math.sin(yawNeu) * cp).normalize();
    modusBlend.endDist = m.dist;
    modusBlend.endPos.copy(_KERN).addScaledVector(modusBlend.endDir, m.dist);
    // Start: Richtung/Dist aus aktueller Pose relativ zum Start-Look
    // (Klickpunkt) — gleiche Bezugsgröße wie die Fahrt-Geometrie unten.
    _figNeu.copy(camPos.lengthSq() > 1e-6 ? camPos : camera.position).sub(zielPunkt);
    modusBlend.startDist = Math.max(_figNeu.length() || m.dist, R + 2);
    modusBlend.startDir.copy(_figNeu).normalize();
    modusBlend.followFig.copy(figur.position);
    modusBlend.endYaw = yawNeu;
    // Blend in Weltkoordinaten starten: von aktueller Pose aus fahren.
    modusBlend.startPos.copy(camera.position.lengthSq() > 1e-6 ? camera.position : camPos);
    modusBlend.startLook.copy(zielPunkt);
    modusBlend.startUp.copy(camera.up);
    modusBlend.t = 0;
    modusBlend.von = 'charakter';
    modusBlend.aktiv = true;
    modusBlend.upNach = 0;
    cam.yaw = yawNeu;
    camZiel.yaw = yawNeu;
    cam.pitch = pitchNeu;
    camZiel.pitch = pitchNeu;
    cam.dist = modusBlend.startDist;
    camZiel.dist = m.dist;
  }
  for (const b of document.querySelectorAll('.cam button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === neu));
  }
  document.getElementById('hinweis').textContent = neu === 'planet'
    ? 'ziehen = drehen · Shift+ziehen = rollen · Rad = zoom · der Punkt ist die Figur'
    : 'ziehen = drehen · Rad = zoom';
  for (const [, g] of orte) if (g.userData.schild) g.userData.schild.visible = neu !== 'planet';
}

document.querySelectorAll('.cam button').forEach((b) => {
  b.addEventListener('click', () => setzeModus(b.dataset.mode));
});
addEventListener('keydown', (ev) => {
  if (ev.key === '1') setzeModus('charakter');
  if (ev.key === '2') setzeModus('planet');
});

// Maus/Touch: drehen und zoomen
let dragging = false;
let letzteX = 0;
let letzteY = 0;
renderer.domElement.addEventListener('pointerdown', (e) => {
  dragging = true;
  letzteX = e.clientX;
  letzteY = e.clientY;
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const m = MODES[mode];
  // Eigenes Ziehen während eines Modus-Blends beendet die Fahrt — danach
  // gelten Yaw/Pitch/Dist direkt, kein Zurückspringen. Beim Rückweg danach
  // Gesichts-Rahmung nachholen, sonst bleibt die Cam an der Blend-Pose.
  if (modusBlend.aktiv) {
    modusBlend.aktiv = false;
    camZiel.yaw = cam.yaw;
    camZiel.pitch = cam.pitch;
    camZiel.dist = cam.dist;
    if (mode === 'charakter') camStartGesicht = true;
  }
  // Yaw: immer frei (360°+, beide Modi). Pitch: Charakter begrenzt (über der
  // Oberfläche bleiben), Planet frei (Pole erlaubt, Kern bleibt das Ziel).
  // Shift + horizontal ziehen = Rollen (nur Planet): Up um die Blickachse
  // drehen — so lässt sich die Polachse schräg stellen und bleibt schräg.
  if (e.shiftKey && mode === 'planet') {
    _kamBlick.subVectors(zielPunkt, camera.position);
    if (_kamBlick.lengthSq() > 1e-12) {
      _kamBlick.normalize();
      const winkel = (e.clientX - letzteX) * 0.008;
      camera.up.applyAxisAngle(_kamBlick, winkel).normalize();
      modusBlend.rollExtra += winkel;   // merken — nächste Fahrt übernimmt die Schräglage
      if (modusBlend.aktiv) modusBlend.startUp.copy(camera.up);
      letzteX = e.clientX;
      letzteY = e.clientY;
      return;
    }
  }
  camZiel.yaw -= (e.clientX - letzteX) * 0.005;
  camZiel.pitch = Math.min(m.pitchMax, Math.max(m.pitchMin, camZiel.pitch - (e.clientY - letzteY) * 0.004));
  letzteX = e.clientX;
  letzteY = e.clientY;
});
renderer.domElement.addEventListener('pointerup', () => { dragging = false; });
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  // Während einer Fahrt kein Trigger und kein Abbruch per Wheel —
  // sonst startet jeder Tick eine neue Fahrt (Dauerfeuer).
  if (modusBlend.aktiv) return;
  const m = MODES[mode];
  // Zoom-Trigger an den Grenzen (Buttons/Tasten bleiben zusätzlich):
  // Charakter ganz raus (max = weit weg) → Planet-Fahrt, Planet ganz
  // rein (min = nah dran) → Charakter-Fahrt. Nur bei klarem Zoom-Willen
  // (|deltaY|-Schwelle gegen Trackpad-Rauschen, kein Pinch per ctrlKey).
  const willZoom = Math.abs(e.deltaY) > 4 && !e.ctrlKey;
  if (willZoom && mode === 'charakter' && e.deltaY > 0 && camZiel.dist >= m.max - 0.5) {
    setzeModus('planet');
    return;
  }
  if (willZoom && mode === 'planet' && e.deltaY < 0 && camZiel.dist <= m.min + 0.5) {
    setzeModus('charakter');
    return;
  }
  camZiel.dist = Math.min(m.max, Math.max(m.min, camZiel.dist * (1 + e.deltaY * 0.0012)));
}, { passive: false });

// ---------------------------------------------------------------- Daten
let letzterState = null;
let letzterGedanke = null;
const zielP = { x: 0, y: R, z: 0 };   // wohin die Figur laufen soll (Kugelpunkt)
const istP = { x: 0, y: R, z: 0 };    // wo sie gerade ist
let laeuft = false;
let ersterSync = true;           // beim ersten Paket nicht von (0,0) loslaufen
let letzterPilot = null;         // Name+Zyklus, um einen Respawn zu erkennen

// Treiber (Paket K, gebaut): p.treiber kommt live aus der Engine.
function treiberAnzeigen(p) {
  const box = document.getElementById('treiber');
  const t = (p && p.treiber) || null;
  if (box) box.classList.toggle('lebt', !!t);
  const defs = [
    ['hunger', 0, 100], ['thermo', -100, 100], ['drang', -100, 100], ['halt', 0, 100],
  ];
  for (const [f, lo, hi] of defs) {
    const v = t ? t[f] : null;
    const balken = document.getElementById(`b-${f}`);
    const zahl = document.getElementById(`n-${f}`);
    if (balken) balken.style.width = (v == null ? 0 : ((v - lo) / (hi - lo)) * 100) + '%';
    if (zahl) zahl.textContent = v == null ? '–'
      : ((v > 0 && lo < 0 ? '+' : '') + (Math.round(v * 10) / 10).toFixed(1));
  }
}

// Inventar: links als Liste mit Fund-Tick (älteste zuerst).
function inventarAnzeigen(liste) {
  const ul = document.getElementById('inventar-liste');
  if (!ul) return;
  const escInv = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const items = Array.isArray(liste) ? liste : [];
  ul.innerHTML = items.length
    ? items.map((f) => `<li><span class="tick">T${f.tick}</span><span>${escInv(String((f && f.text) || (f && f.id) || '?'))}</span></li>`).join('')
    : '<li class="leer">Noch nichts gefunden.</li>';
}

function zeichneHud(s) {
  const p = s.pilot;
  const c = s.clock || { day: 1, ageHours: 0 };
  const h = c.ageHours < 1 ? `${Math.round(c.ageHours * 60)} min` : `${Math.round(c.ageHours * 10) / 10} h`;
  // Tag/Nacht: globale Tag-Nr + lokale Phase („Tag 3 · Nacht" = 3× gedreht, hier Nacht)
  const tag = s.tag || null;
  const tagZeile = tag
    ? ` · Tag ${tag.nr} · ${tag.phase === 'licht' ? 'Tag' : tag.phase === 'nacht' ? 'Nacht' : 'Dämmerung'}`
    : '';
  document.getElementById('name').innerHTML =
    `<b>${p.name}</b> · Zyklus ${p.cycle_num}${tagZeile} · seit ${h}`;
  const hinweise = [`Tick ${s.world.tick}`, AKTION[p.current_action] || p.current_action];
  // Erde untergegangen → Bake-Tor zu (steht im Prompt, hier als Hinweis)
  if (tag && !tag.erde) hinweise.push('Erde weg');
  // Finsternis: Warn-Hinweis bei total, klein daneben bei Anbiss/Halb
  if (tag && tag.finsternisWort) hinweise.push(tag.finsternisWort);
  if (s.speed && s.speed > 1) hinweise.push(`×${s.speed} Zeit`);
  if (p.mania) hinweise.push('MANIE');
  if (p.mind_state !== 'klar') hinweise.push(p.mind_state.toUpperCase());
  if (p.status === 'dead') hinweise.push('TOT');
  if (s.stale) hinweise.push(`Modell still (${s.staleMinutes} min)`);
  document.getElementById('sub').innerHTML = hinweise
    .map((t) => (/^[A-Z]{3,}|Modell/.test(t) ? `<span class="warn">${t}</span>` : t))
    .join(' · ');

  document.getElementById('b-body').style.width = p.body + '%';
  document.getElementById('b-psyche').style.width = ((p.psyche + 100) / 2) + '%';
  document.getElementById('n-body').textContent = (Math.round(p.body * 10) / 10).toFixed(1);
  const psy = Math.round(p.psyche * 10) / 10;
  document.getElementById('n-psyche').textContent = (psy > 0 ? '+' : '') + psy.toFixed(1);
  treiberAnzeigen(p);
  inventarAnzeigen(s.inventar);
  if (DEV) devWerteSpiegeln(p);

  korperMat.color.setHSL(((p.accent_hue || 200) / 360) * 0.35 + 0.09, 0.35, 0.72);
  const neuerPilot = letzterPilot && (letzterPilot.name !== p.name || letzterPilot.cycle !== p.cycle_num);
  letzterPilot = { name: p.name, cycle: p.cycle_num };
  // Namensschild über der Figur: Text nur bei Wechsel neu bauen (Texture kostet)
  if (figur.userData.schild && figur.userData.schildText !== p.name) {
    const alt = figur.userData.schild;
    const neu = label(p.name);
    neu.position.copy(alt.position);
    neu.userData.base = alt.userData.base;
    figur.remove(alt);
    alt.material.map?.dispose();
    alt.material.dispose();
    figur.add(neu);
    figur.userData.schild = neu;
    figur.userData.schildText = p.name;
  }
  if (figur.userData.schild) figur.userData.schild.visible = p.status !== 'dead';
  zielP.x = p.x; zielP.y = p.y; zielP.z = p.z;
  if (neuerPilot) { istP.x = p.x; istP.y = p.y; istP.z = p.z; }   // Nachfolger erscheint am Startpunkt, kein Gleiten
  if (ersterSync) {
    // Beim Laden steht die Figur schon da, wo die Engine sie hat — kein Wanderlauf
    istP.x = p.x; istP.y = p.y; istP.z = p.z;
    ersterSync = false;
  }
  figur.visible = p.status !== 'dead';
  grab.visible = p.status === 'dead';
  aufKugelVec(grab, p.x, p.y, p.z);
}

const AKTION = {
  eat: 'frisst', sleep: 'schläft', sit_shade: 'sitzt im Schatten', inspect: 'untersucht das Wrack',
  search_wrack: 'durchwühlt das Wrack', read_note: 'liest den Zettel', check_stock: 'prüft den Vorrat',
  tend_dome: 'pflegt das Beet', call_bake: 'sendet einen Notruf',
  streifen: 'streift umher', sinnieren: 'sinnt vor sich hin',
  look_earth: 'schaut zur Erde', dig: 'gräbt', run_wild: 'rennt',
  hide_capsule: 'flüchtet in die Kapsel', idle: 'steht',
};

const NAMEN = { body: 'Körper' };
function feedText(e) {
  let t = {};
  try { t = JSON.parse(e.payload_json); } catch { /* egal */ }
  switch (e.type) {
    case 'thought': return (t.thought || '(kein Gedanke)')
      + (t.musing ? ` <span class="musing">· ${t.musing}</span>` : '');
    case 'death': return `${t.name} ist tot — ${NAMEN[t.cause] || t.cause}`;
    case 'spawn': return `Neuer Pilot: ${t.name} (Zyklus ${t.cycle})`;
    case 'discovery': return `Erster Fußabdruck: ${t.name}`;
    case 'find': return `Fund: ${t.text || 'Schrott'}`;
    case 'note': return `Zettel: „${t.text}“`;
    case 'bake': return 'Notruf gesendet — nur Rauschen.';
    case 'reboot': return `Bruchpilot OS: System-Neustart nach ${t.minuten} Minuten Kälteschlaf — Filmriss.`;
    case 'mind': return `Zustand: ${t.state}`;
    case 'belief': return `Gelernt: ${t.text}`;
    default: return e.type;
  }
}

function zeichneFeed(feed) {
  if (!feed) return;
  document.getElementById('feed').innerHTML = feed.map((e) =>
    `<div class="eintrag ${e.type}"><small>Tick ${e.tick}</small>${feedText(e)}</div>`).join('');
  const letzte = feed.find((e) => e.type === 'thought');
  if (letzte) {
    try {
      const t = JSON.parse(letzte.payload_json);
      if (t.thought) letzterGedanke = t.thought;
    } catch { /* egal */ }
  }
}

function zeichneGlaube(beliefs) {
  const el = document.getElementById('glaube');
  if (!beliefs || !beliefs.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<b>Was er glaubt</b>' + beliefs.map((b) => `<div>· ${b.text}</div>`).join('');
}

// Feed ein-/ausblendbar (Standard: aus, Wahl bleibt im Browser gemerkt)
const feedPanel = document.getElementById('feedPanel');
const feedAn = document.getElementById('feedAn');
function feedSichtbar(an) {
  feedPanel.style.display = an ? '' : 'none';
  feedAn.setAttribute('aria-pressed', String(an));
  try { localStorage.setItem('aq_feed', an ? 'an' : 'aus'); } catch { /* egal */ }
}
let feedStart = 'aus';
try { feedStart = localStorage.getItem('aq_feed') || 'aus'; } catch { /* egal */ }
feedSichtbar(feedStart === 'an');
document.getElementById('feedAus').onclick = () => feedSichtbar(false);
feedAn.onclick = () => feedSichtbar(feedPanel.style.display === 'none');

const es = new EventSource('/api/stream');
es.onmessage = (ev) => {
  let d;
  try { d = JSON.parse(ev.data); } catch { return; }
  if (d.kind === 'state') { letzterState = d; syncOrte(d.entities); zeichneHud(d); sonneSetzen(d.tag); return; }
  if (d.kind === 'feed') { zeichneFeed(d.feed); zeichneGlaube(d.beliefs); return; }
  letzterState = d;
  syncOrte(d.entities);
  zeichneHud(d);
  sonneSetzen(d.tag);
  zeichneFeed(d.feed);
  zeichneGlaube(d.beliefs);
};

// Tag/Nacht 2026-11-14: Die Sonne dreht sich um den Planeten, sonst nichts.
// Kein globales Abdunkeln: Der Nacht wird es dunkel, weil das gerichtete Licht von
// der anderen Seite kommt — nicht weil wir einen Dimmer drehen. Nur die Finsternis
// (Deckung Sonne/Erde) dimmt global mit, Lampe/Scheibe folgen dem lokalen Licht.
// Kein eigenes Modell — dasselbe Ding wie die Engine rechnet, kein Drift.
// phase fehlt (alter Server): nichts tun, Startposition bleibt.
function sonneSetzen(tag) {
  if (!tag || !tag.sonne || !tag.phase) return;
  const v = tag.sonne;
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  sun.position.set(v.x / l, v.y / l, v.z / l).multiplyScalar(200);
  // Scheibe + Hof folgen derselben Richtung, auf der Himmels-Schale
  sonnenScheibe.position.set(v.x / l, v.y / l, v.z / l).multiplyScalar(SONNE_WEIT);
  sonnenHof.position.copy(sonnenScheibe.position);
  // Finsternis: Richtungsabstand Sonne↔Erde entscheidet (gleiche Rechnung wie Engine).
  // Faktoren hart verdrahtet wie FINSTERNIS in config.js (kein Doppel-Modell).
  const ex = 0.7071, ey = 0.6124, ez = 0.3536;   // ERDE_VEC — synchron mit ERDE in config.js halten
  const el = Math.hypot(ex, ey, ez) || 1;
  const nx = v.x / l, ny = v.y / l, nz = v.z / l;
  const abstand = Math.acos(Math.max(-1, Math.min(1,
    nx * (ex / el) + ny * (ey / el) + nz * (ez / el))));
  const fenster = (10 + 40) / 900;         // SONNE_RADIUS + ERDE_RADIUS / Schale
  const grad = abstand >= fenster ? 0 : 1 - abstand / fenster;
  const finst = grad >= 0.9 ? 3 : grad >= 0.5 ? 2 : grad >= 0.1 ? 1 : 0;
  // Nur Finsternis dimmt global (Deckung, nicht Phase — die Phase macht das Licht
  // per Richtung von selbst: Nachtseite liegt im Schatten des DirectionalLights).
  const SONNE_F = [1, 0.8, 0.5, 0][finst], HEMI_F = [1, 1, 0.7, 0][finst];
  hemi.intensity = HEMI_TAG * HEMI_F;
  sun.intensity = SONNE_TAG * SONNE_F;
  // Scheibe/Hof stehen immer voll da — nur totale Finsternis frisst sie.
  // Ob es am Piloten hell oder dunkel ist, entscheidet die Lichtrichtung, kein Dimmer.
  sonnenScheibe.material.color.setScalar(finst >= 3 ? 0.2 : 1);
  const hofF = SONNE_F;
  sonnenHof.scale.set(90 * hofF, 90 * hofF, 1);
  // Taschenlampe: an bei lokalem Nacht/Daemmerlicht am Piloten — und bei totaler
  // Finsternis am Tag. Der Spot folgt der Figur (Kind-Knoten), der Kegel zeigt den Strahl.
  const lampenHell = finst >= 3 ? 1 : tag.phase === 'nacht' ? 1 : tag.phase === 'daemmer' ? 0.5 : 0;
  lampe.intensity = lampenHell * 60;
  lampenKegel.visible = lampenHell > 0 && !DEV;
  lampenKegel.material.opacity = lampenKegel.visible ? 0.05 * lampenHell : 0;
  // Selbst-Licht: Helmleuchte + Gesichts-Fill laufen IMMER (Sockel tagsüber),
  // damit das Gesicht nie absäuft. Nachts/dämmrig voller, gekoppelt an lampenHell.
  helmLicht.intensity = 1.2 + lampenHell * 2.0;
  gesichtsFill.intensity = 0.9 + lampenHell * 2.4;
  // Erd-Finsternis: Geht die Strecke Sonne→Erde durch unseren Planeten
  // (Strecken-Abstand zum Kern < R), steht die Erde in unserem Schatten —
  // Erde abdunkeln (Phasen kommen weiter vom Sonnenlicht von selbst).
  // Läuft immer, nicht nur im Dev-Modus (nur die Linie ist Dev-only).
  erde.material.emissiveIntensity = erdFinsternis ? 0.03 : 0.35;
  erde.material.color.setScalar(erdFinsternis ? 0.18 : 1);
  // Erde: Kugel auf der Himmels-Schale, aus dem gleichen Vektor wie die Engine.
  erde.position.set(ERDE_VEC.x, ERDE_VEC.y, ERDE_VEC.z).normalize().multiplyScalar(HIMMEL_WEIT);
  // Dev-Linien: Kern → Sonne + Kern → Erde (nur ?mode=dev sichtbar)
  devLinien(new THREE.Vector3(v.x / l, v.y / l, v.z / l));
}

// ---------------------------------------------------------------- Debug-Log (?mode=dev)
const dbgListe = document.getElementById('debugliste');
const dbgBox = document.getElementById('debug');
const dbgBadge = document.getElementById('devbadge');
let dbgSeit = 0;
const dbgZeilen = [];

const KURZ = {
  eat: 'fressen', sleep: 'schlafen', sit_shade: 'im Schatten sitzen', inspect: 'Wrack untersuchen',
  search_wrack: 'Wrack durchwühlen', read_note: 'Zettel lesen', check_stock: 'Vorrat prüfen',
  tend_dome: 'Beet pflegen', call_bake: 'Notruf senden',
  streifen: 'umherschweifen', sinnieren: 'sinnieren',
  look_earth: 'zur Erde schauen', dig: 'graben', run_wild: 'rennen', idle: 'warten',
};

function dbgText(e) {
  let t = {};
  try { t = JSON.parse(e.payload_json); } catch { /* egal */ }
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const z = `<span class="t">${e.tick}</span>`;
  const tempo = (typeof t.ms === 'number' && typeof t.versuche === 'number')
    ? ` · ${Math.round(t.ms)}ms/${t.versuche}V` : '';
  // Tokenverbrauch: prompt + completion + reasoning (falls Provider sie meldet)
  const u = t.usage || {};
  const det = u.completion_tokens_details || t.completion_tokens_details || {};
  const tokStr = (typeof u.prompt_tokens === 'number' || typeof u.completion_tokens === 'number')
    ? ` · <span class="t">tok p${u.prompt_tokens ?? '?'}→c${u.completion_tokens ?? '?'}`
      + (typeof det.reasoning_tokens === 'number' ? ` (reas ${det.reasoning_tokens})` : '')
      + `</span>`
    : '';
  // Komplette Raw-Antwort, eingeklappt (Details/Summary, kein JS nötig)
  const rohDetail = (typeof t.roh === 'string' && t.roh.length)
    ? `<br><details><summary>raw (${t.roh.length} Zeichen)</summary><code>${esc(t.roh)}</code></details>`
    : '';
  switch (e.type) {
    case 'decision':
      return `${z} → <b>${KURZ[t.action] || t.action}</b>`
        + (t.target ? ` @ ${t.target}` : '')
        + (t.dur ? ` · ${t.dur}s` : '')
        + ` · ${t.source}${t.source === 'fallback' ? ' <span class="w">(Ersatz)</span>' : ''}${tempo}${tokStr}`
        + ` · Auswahl ${t.auswahl}`
        + (t.source === 'model' && t.finish ? ` · finish=${t.finish}` : '')
        + (t.source === 'model' ? ` [${(t.whitelist || []).join(', ')}]` : '')
        + (typeof t.hunger === 'number'
          ? ` · H${t.hunger} E${t.exhaustion} S${t.stress}` : '')
        + (t.thought ? `<br>„${t.thought}“` : '')
        + (t.musing ? `<br>↳ ${t.musing}` : '')
        + (t.source === 'fallback' ? rohDetail : '');
    case 'action':
      return `${z} ✓ <b>${KURZ[t.action] || t.action}</b> fertig nach ${t.dur}s (begonnen ${e.tick - t.dur})`
        + (typeof t.stress_delta === 'number'
          ? ` · Stress ${t.stress_delta > 0 ? '+' : ''}${Math.round(t.stress_delta * 10) / 10}` : '');
    case 'stale': {
      const diag = [t.finish ? `finish=${t.finish}` : null].filter(Boolean).join(' ');
      return `${z} <span class="w">Modell still</span>: ${t.reason || ''}`
        + (t.failures ? ` [${t.failures.join(',')}]` : '') + tempo + tokStr
        + (diag ? ` <span class="t">${diag}</span>` : '')
        + rohDetail;
    }
    case 'mind':
      return `${z} ~ Zustand: <b>${t.state}</b>`;
    case 'belief':
      return `${z} ✎ gelernt: ${t.text}`;
    case 'death':
      return `${z} ☠ ${t.name} (${t.cause})`;
    case 'spawn':
      return `${z} ✚ neuer Pilot ${t.name}`;
    case 'discovery':
      return `${z} ◎ entdeckt: ${t.name}`;
    case 'offline':
      return `${z} ↺ Catch-up: ${t.minutes} min · Tode ${t.deaths} · Neustarts ${t.spawned}`;
    case 'clock_skew':
      return `${z} ⏱ Uhrsprung ${t.seconds}s`;
    case 'nerve':
      return `${z} ↑ Stress: ${t.source}`;
    case 'knock':
      return `${z} ! unregelmäßiges Klopfen`;
    case 'force_sleep':
      return `${z} z erzwungener Schlaf`;
    default:
      return `${z} ${e.type}`;
  }
}

function dbgZeichne() {
  // `thought` steht schon in der Entscheidung — nicht doppelt zeigen
  dbgListe.innerHTML = dbgZeilen
    .filter((e) => e.type !== 'thought')
    .map((e) => `<div class="dbg">${dbgText(e)}</div>`).join('');
}

async function dbgHole() {
  try {
    const r = await fetch(`/api/debug?since=${dbgSeit}&limit=200`);
    const d = await r.json();
    if (!d.events.length) return;
    dbgSeit = d.last;
    for (const e of d.events) dbgZeilen.unshift(e);   // neueste oben
    if (dbgZeilen.length > 25) dbgZeilen.length = 25;
    dbgZeichne();
  } catch { /* Server weg: nächster Versuch */ }
}

// --- Dev: Werte-Slider und Zeitfaktor -------------------------------------
// Paket K: alle sechs Werte (Kerne + Treiber) per Schieber setzbar.
const slider = { body: null, psyche: null, hunger: null, thermo: null, drang: null, halt: null };
let sliderAktiv = false;

function treiberWert(p, f) {
  if (f === 'body' || f === 'psyche') return p[f];
  return p.treiber ? p.treiber[f] : null;
}

function devWerteSpiegeln(p) {
  if (sliderAktiv) return;
  for (const f of ['body', 'psyche', 'hunger', 'thermo', 'drang', 'halt']) {
    const el = document.getElementById(`s-${f}`);
    if (!el) continue;
    const v = treiberWert(p, f);
    if (v == null) continue;
    el.value = Math.round(v);
    document.getElementById(`v-${f}`).textContent = Math.round(v);
  }
}

function devSetzen() {
  const q = ['body', 'psyche', 'hunger', 'thermo', 'drang', 'halt']
    .map((f) => `${f}=${document.getElementById(`s-${f}`).value}`).join('&');
  fetch(`/api/dev/set?${q}`).catch(() => {});
}

if (DEV) {
  for (const f of ['body', 'psyche', 'hunger', 'thermo', 'drang', 'halt']) {
    const el = document.getElementById(`s-${f}`);
    if (!el) continue;
    el.addEventListener('pointerdown', () => { sliderAktiv = true; });
    el.addEventListener('pointerup', () => { sliderAktiv = false; });
    el.addEventListener('input', () => {
      document.getElementById(`v-${f}`).textContent = el.value;
    });
    el.addEventListener('change', devSetzen);
  }
  for (const b of document.querySelectorAll('.devctl .speed button')) {
    b.addEventListener('click', () => {
      fetch(`/api/dev/speed?x=${b.dataset.speed}`).catch(() => {});
      for (const x of document.querySelectorAll('.devctl .speed button')) {
        x.setAttribute('aria-pressed', String(x === b));
      }
    });
  }
}

if (DEV) {
  dbgBadge.classList.add('an');
  dbgBox.classList.add('an');
  fetch('/api/debug?since=0&limit=40').then((r) => r.json()).then((d) => {
    if (!d.events.length) return;
    dbgSeit = d.last;
    dbgZeilen.push(...d.events.slice().reverse());    // neueste oben
    dbgZeichne();
  }).catch(() => {});
  setInterval(dbgHole, 2000);
}

// ---------------------------------------------------------------- Schleife
const uhr = new THREE.Clock();
const bubble = document.getElementById('bubble');
const kopfWelt = new THREE.Vector3();
const blick = new THREE.Vector3();
// Blick-Hilfsvektor für die Kameraführung (Up-Weiche) — wird jeden Tick
// frisch beschrieben, kein Zustand. Nicht mit _fwd verwechseln (Figurenblick).
const _kamBlick = new THREE.Vector3();
const _upHilf = new THREE.Vector3();

function tick() {
  const dt = Math.min(uhr.getDelta(), 0.1);
  const t = uhr.elapsedTime;

  // Figur weich zum Ziel bewegen (Sehne, danach auf die Kugel zurück)
  const dx = zielP.x - istP.x;
  const dy = zielP.y - istP.y;
  const dz = zielP.z - istP.z;
  const weg = Math.hypot(dx, dy, dz);
  if (weg > 80) {
    // Nur bei unmöglichen Sprüngen (Datenfehler) hart setzen
    istP.x = zielP.x; istP.y = zielP.y; istP.z = zielP.z;
    laeuft = false;
  } else if (weg > 0.05) {
    const schritt = Math.min(weg, dt * 3.5);
    istP.x += (dx / weg) * schritt;
    istP.y += (dy / weg) * schritt;
    istP.z += (dz / weg) * schritt;
    const nl = Math.hypot(istP.x, istP.y, istP.z) || 1;
    istP.x = (istP.x / nl) * R; istP.y = (istP.y / nl) * R; istP.z = (istP.z / nl) * R;
    laeuft = true;
  } else {
    laeuft = false;
  }

  figur.position.set(istP.x, istP.y, istP.z);
  const normal = _v.set(istP.x, istP.y, istP.z).normalize().clone();
  // Figur schaut in Engine-Blickrichtung: Beim Hinlaufen zum Ziel gedreht,
  // beim Handeln davor stehen geblieben — sie schaut an, womit sie interagiert
  const hFig = letzterState && letzterState.pilot ? letzterState.pilot.heading : null;
  if (Array.isArray(hFig)) {
    _fwd.set(hFig[0], hFig[1], hFig[2]);
    _fwd.addScaledVector(normal, -_fwd.dot(normal));
    if (_fwd.lengthSq() > 1e-6) _blick.lerp(_fwd.normalize(), Math.min(1, dt * 4)).normalize();
  }
  _rechts.crossVectors(normal, _blick);
  _basis.makeBasis(_rechts, normal, _blick);
  figur.quaternion.setFromRotationMatrix(_basis);

  // Wolken treiben langsam in +x (rein optisch)
  for (const w of wolken) {
    w.x += w.tempo * dt;
    if (w.x > 100) w.x = -100;
    placeOnPlanet(w.x, w.z, _v);
    _wolkN.copy(_v).normalize();
    w.gruppe.position.copy(_v).addScaledVector(_wolkN, w.h);
    w.gruppe.quaternion.setFromUnitVectors(HOCH, _wolkN);
  }

  // Kegel an Figur + Engine-Heading hängen (Vektor, keine Gradzahl)
  if (kegel) {
    syncKegel(letzterState && letzterState.sicht);
    const h = letzterState && letzterState.pilot ? letzterState.pilot.heading : null;
    if (!Array.isArray(h) || mode === 'planet') {
      kegel.visible = false;
    } else {
      kegel.visible = true;
      kegel.position.copy(figur.position).addScaledVector(normal, 0.4);
      _fwd.set(h[0], h[1], h[2]);
      _fwd.addScaledVector(normal, -_fwd.dot(normal));
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
      _fwd.normalize();
      _rechts.crossVectors(normal, _fwd);
      _basis.makeBasis(_rechts, normal, _fwd);
      kegel.quaternion.setFromRotationMatrix(_basis);
    }
  }

  // Watscheln: Squash-and-Stretch, beim Laufen schneller —
  // plus seitliches Wippen, damit man Handeln (nicht nur Gehen) sieht
  const p0 = letzterState && letzterState.pilot;
  const handelt = !!(p0 && p0.current_action && p0.current_action !== 'idle');
  const f = laeuft ? 9 : (handelt ? 3.4 : 2.2);
  const amp = laeuft ? 0.12 : (handelt ? 0.07 : 0.04);
  const w = Math.sin(t * f);
  figur.scale.set(
    (1 - w * amp * 0.6) * FIGUR_SKALA,
    (1 + w * amp) * FIGUR_SKALA,
    (1 - w * amp * 0.6) * FIGUR_SKALA,
  );
  const rollAmp = laeuft ? 0.10 : (handelt ? 0.07 : 0.015);
  _rolle.setFromAxisAngle(_vorwaerts, Math.sin(t * f * 0.5 + 1) * rollAmp);
  figur.quaternion.multiply(_rolle);

  // Kamera weich nachziehen (Yaw immer auf kürzestem Weg, sonst Spin bei ±PI).
  // Während einer Fahrt ist das Expo AUS — der Welt-Blend trägt die Pose
  // allein (Expo gegen den Blend hat die gebogene Fahrt verursacht).
  const blendLaeuft = modusBlend.aktiv;
  if (!blendLaeuft) {
    cam.yaw += winkelDelta(cam.yaw, camZiel.yaw) * Math.min(1, dt * 6);
    cam.pitch += (camZiel.pitch - cam.pitch) * Math.min(1, dt * 6);
    cam.dist += (camZiel.dist - cam.dist) * Math.min(1, dt * 5);
  }
  // Blend-Uhr: beide Richtungen teilen sich Uhr + Easing (Smootherstep).
  // Dazu phasenversetzt: drehMix (Richtung, zuerst) + zoomMix (Abstand,
  // überlappend) — kein Durchflug durch den Planeten.
  if (blendLaeuft) modusBlend.t = Math.min(BLEND_DAUER, modusBlend.t + dt);
  const posMix = blendLaeuft ? glatt01(modusBlend.t / BLEND_DAUER) : 1;
  const drehMix = blendLaeuft ? drehMixFaktor(modusBlend.t) : 1;
  const zoomMix = blendLaeuft ? zoomMixFaktor(modusBlend.t) : 1;
  // Look schwenkt phasenversetzt zum Drehen: hält Start-Fokus, folgt dann
  // überlappend (gleiche Logik wie Zoom, eigenes Timing).
  const LOOK_START = 0.35;
  const lookMix = blendLaeuft
    ? glatt01((modusBlend.t - BLEND_DAUER * LOOK_START) / (BLEND_DAUER * (1 - LOOK_START)))
    : 1;

  if (MODES[mode].target === 'planet') {
    if (modusBlend.aktiv && modusBlend.von === 'charakter') {
      // Hinweg: Kugel-Interpolation um den Look — Richtung per Slerp drehen
      // (außen bleiben, kein Kern-Bogen), Radius überlappend wachsen lassen.
      // Figur läuft weiter — endPos per Figuren-Delta mitführen.
      _figNeu.copy(figur.position);
      _figDelta.subVectors(_figNeu, modusBlend.followFig);
      modusBlend.followFig.copy(_figNeu);
      modusBlend.endPos.add(_figDelta);
      modusBlend.endDir.copy(modusBlend.endPos).sub(modusBlend.endLook).normalize();
      modusBlend.endDist = modusBlend.endPos.distanceTo(modusBlend.endLook) || modusBlend.endDist;
      _blendLook.copy(modusBlend.startLook).lerp(_KERN, lookMix);
      zielPunkt.copy(_blendLook);
    } else {
      zielPunkt.set(0, 0, 0);
    }
  } else if (blendLaeuft && modusBlend.von === 'planet') {
    // Rückweg: Kern erst halten, dann weich aufs EINGEFRORENE End-Look.
    // Die Figur läuft weiter — endPos/endLook werden per Figuren-Delta
    // mitgeführt (Translation), die Gerade bleibt eine Gerade.
    _figNeu.copy(figur.position).addScaledVector(normal, -1.0);
    _figDelta.subVectors(_figNeu, modusBlend.followFig);
    modusBlend.followFig.copy(_figNeu);
    modusBlend.endPos.add(_figDelta);
    modusBlend.endLook.add(_figDelta);
    // Figuren-Delta ändert auch die End-Geometrie → Richtung/Dist nachziehen.
    _tanH.copy(modusBlend.endPos).sub(zielPunkt);
    modusBlend.endDist = _tanH.length() || modusBlend.endDist;
    modusBlend.endDir.copy(_tanH).normalize();
    zielPunkt.copy(modusBlend.startLook).lerp(modusBlend.endLook, lookMix);
  } else {
    zielPunkt.copy(figur.position).addScaledVector(normal, 2.0);
  }

  // Charakter-Cam im Radial-Frame: Pitch = Elevation über der lokalen
  // Tangentialebene (Achse Charakter→Mittelpunkt N), Yaw dreht darin.
  // Planet-Modus bleibt Welt-Y (Kern als Ziel, Pole erlaubt).
  _kamBlick.subVectors(zielPunkt, camPos);
  if (_kamBlick.lengthSq() > 1e-12) _kamBlick.normalize();
  if (mode === 'planet') {
    if (modusBlend.aktiv && modusBlend.von === 'charakter') {
      // Kugelschale um den Look: Richtung drehen (slerp), Radius wachsen.
      // Start = aktuelle Pose über Klickpunkt, Ende = radial über Kern —
      // außen bleiben, kein Kern-Bogen, kein Durchflug.
      _blendEnde.copy(modusBlend.startDir).lerp(modusBlend.endDir, drehMix);
      if (_blendEnde.lengthSq() < 1e-8) _blendEnde.copy(modusBlend.endDir);
      _blendEnde.normalize();
      const distNeu = modusBlend.startDist + (modusBlend.endDist - modusBlend.startDist) * zoomMix;
      camPos.copy(zielPunkt).addScaledVector(_blendEnde, distNeu);
      cam.dist = distNeu;
      cam.yaw = modusBlend.endYaw;
      camZiel.yaw = modusBlend.endYaw;
      if (modusBlend.t >= BLEND_DAUER) {
        modusBlend.aktiv = false;
        cam.pitch = Math.asin(Math.min(1, Math.max(-1, modusBlend.endDir.y)));
        camZiel.pitch = cam.pitch;
        cam.dist = modusBlend.endDist;
        camZiel.dist = modusBlend.endDist;
        camPos.copy(modusBlend.endPos);
        zielPunkt.copy(_KERN);
      }
    } else {
      const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
      _blendEnde.set(
        zielPunkt.x + Math.cos(cam.yaw) * cp * cam.dist,
        zielPunkt.y + sp * cam.dist,
        zielPunkt.z + Math.sin(cam.yaw) * cp * cam.dist,
      );
      camPos.copy(_blendEnde);
    }
  } else {
    tangentialBasis(normal);
    // Start: 30° von der linken Seite auf das Gesicht — die Cam steht vor
    // der Figur (_blick zeigt dorthin, wo sie hinschaut) und sieht sie
    // leicht von links. Danach bleibt yaw frei (kein Mitrotieren).
    // Während des Rückweg-Blends NICHT snappen — erst am Ende nachholen.
    if (camStartGesicht && !(modusBlend.aktiv && modusBlend.von === 'planet')
        && _blick.lengthSq() > 1e-6) {
      _wunsch.copy(_blick).addScaledVector(normal, -_blick.dot(normal));
      if (_wunsch.lengthSq() > 1e-6) {
        _wunsch.normalize();
        _seit.crossVectors(_wunsch, normal).normalize();  // links der Figur
        _wunsch.multiplyScalar(Math.cos(GESICHT_SEITE))
          .addScaledVector(_seit, Math.sin(GESICHT_SEITE));
        const yawNeu = Math.atan2(_wunsch.dot(_tanB), _wunsch.dot(_tanA));
        cam.yaw = yawNeu;
        camZiel.yaw = yawNeu;
      }
      camStartGesicht = false;
    }
    const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
    _tanH.copy(_tanA).multiplyScalar(Math.cos(cam.yaw))
      .addScaledVector(_tanB, Math.sin(cam.yaw));
    _blendEnde.copy(zielPunkt)
      .addScaledVector(_tanH, cp * cam.dist)
      .addScaledVector(normal, sp * cam.dist);
    // Unter die Oberfläche tauchen verboten (nahe, flache Cam am Boden).
    const bodenAb = _blendEnde.length();
    if (bodenAb < R + 0.6) _blendEnde.multiplyScalar((R + 0.6) / (bodenAb || 1));
    if (blendLaeuft && modusBlend.von === 'planet') {
      // Drehen-vor-Zoomen rückwärts: Richtung zuerst auf Kugelschale um den
      // (sich bewegenden) Look, Abstand überlappend danach. Slerp-Fallback.
      // Der Dreh zu „ins Gesicht" (Gesichts-Mix) beginnt erst spät
      // (GESICHT_START) — vorher nur außen anfliegen, kein frühes Eindrehen.
      const GESICHT_START = 0.62;
      const gesichtMix = glatt01((modusBlend.t - BLEND_DAUER * GESICHT_START)
        / (BLEND_DAUER * (1 - GESICHT_START)));
      _tanH.copy(modusBlend.startDir).lerp(modusBlend.endDir, drehMix);
      if (_tanH.lengthSq() < 1e-8) _tanH.copy(modusBlend.endDir);
      _tanH.normalize();
      // Ziel-Richtung fürs Gesicht: endDir ist bereits die 30°-Seite —
      // spät dorthin eindrehen statt von Anfang an.
      _blendEnde.copy(_tanH).lerp(modusBlend.endDir, gesichtMix * 0.85);
      if (_blendEnde.lengthSq() < 1e-8) _blendEnde.copy(modusBlend.endDir);
      _blendEnde.normalize();
      const distNeu = modusBlend.startDist + (modusBlend.endDist - modusBlend.startDist) * zoomMix;
      camPos.copy(zielPunkt).addScaledVector(_blendEnde, distNeu);
      cam.dist = distNeu;
      if (modusBlend.t >= BLEND_DAUER) {
        modusBlend.aktiv = false;
        cam.yaw = modusBlend.endYaw;
        camZiel.yaw = modusBlend.endYaw;
        cam.pitch = MODES.charakter.pitch;
        camZiel.pitch = MODES.charakter.pitch;
        cam.dist = MODES.charakter.dist;
        camZiel.dist = MODES.charakter.dist;
        camPos.copy(modusBlend.endPos);
        zielPunkt.copy(modusBlend.endLook);
        // Up noch 0,25 s nachblenden statt hart umschalten (gegen Roll-Snap).
        modusBlend.upNach = 0.25;
      }
    } else {
      camPos.copy(_blendEnde);
    }
    _kamBlick.subVectors(zielPunkt, camPos).normalize();
  }
  camera.position.copy(camPos);
  // Up-Logik: Charakter radial (N projiziert, Pol-Flip-Schutz), Planet
  // PERSISTENT (freies Rollen — kein Nordpol-Zwang, die Achse darf schräg
  // stehen). Während der Fahrt blendet Up vom Start zum Ziel, danach bleibt
  // es stehen. Pol-Notfall: Blick ∥ Up → Fallback statt lookAt-Rollen.
  if (modusBlend.upNach > 0 && !blendLaeuft) {
    modusBlend.upNach = Math.max(0, modusBlend.upNach - dt);
    _upZiel.copy(normal).addScaledVector(_kamBlick, -_kamBlick.dot(normal));
    if (_upZiel.lengthSq() < 1e-6) _upZiel.copy(normal);
    _upZiel.normalize();
    const kNach = 1 - modusBlend.upNach / 0.25;   // 0 → 1
    camera.up.copy(camera.up).lerp(_upZiel, Math.min(1, dt * 8) * (0.3 + 0.7 * kNach)).normalize();
  } else if (blendLaeuft) {
    if (mode === 'planet') {
      // Ziel-Up für den Hinweg: Welt-Y projiziert, dann FEST um PLANET_TILT
      // um die Blickachse kippen — die Achse steht sichtbar schräg statt
      // senkrecht (kein Nordpol-Zwang). Roll-Anteil aus Shift-Ziehen wird
      // unten draufaddiert, nicht überschrieben.
      _upHilf.set(0, 1, 0).addScaledVector(_kamBlick, -_kamBlick.y);
      if (_upHilf.lengthSq() < 1e-6) _upHilf.set(0, 0, _kamBlick.z >= 0 ? -1 : 1);
      _upHilf.normalize().applyAxisAngle(_kamBlick, PLANET_TILT + modusBlend.rollExtra);
    } else {
      _upHilf.copy(normal).addScaledVector(_kamBlick, -_kamBlick.dot(normal));
      if (_upHilf.lengthSq() < 1e-6) _upHilf.copy(normal);
    }
    _upHilf.normalize();
    _blendUp.copy(modusBlend.startUp).lerp(_upHilf, posMix).normalize();
    camera.up.copy(_blendUp);
  } else if (mode === 'planet') {
    // Persistent: Up bleibt wie es ist (frei gerollt oder aus der Fahrt).
    // Nur Pol-Notfall abfangen: Blick ∥ Up → minimal kippen statt Rollen.
    if (Math.abs(camera.up.dot(_kamBlick)) > 0.995) {
      _upHilf.set(0, 0, 1).addScaledVector(_kamBlick, -_kamBlick.z);
      if (_upHilf.lengthSq() < 1e-6) _upHilf.set(1, 0, 0).addScaledVector(_kamBlick, -_kamBlick.x);
      camera.up.copy(_upHilf.normalize());
    }
  } else {
    _upHilf.copy(normal).addScaledVector(_kamBlick, -_kamBlick.dot(normal));
    if (_upHilf.lengthSq() < 1e-6) _upHilf.copy(normal);
    camera.up.copy(_upHilf.normalize());
  }
  camera.lookAt(zielPunkt);

  // Pin: in der Planetenansicht ersetzt er die Figur als sichtbaren Punkt
  pin.visible = mode === 'planet' && figur.visible;
  if (pin.visible) {
    pin.position.copy(figur.position).addScaledVector(normal, 1.5);
    pin.material.opacity = 0.55 + 0.35 * Math.sin(t * 2.4);
    pin.scale.setScalar(13 + 2.5 * Math.sin(t * 2.4));
  }

  // Ortschilder: Größe an die Entfernung anpassen, damit sie in der Nähe nicht explodieren
  for (const [, g] of orte) {
    const schild = g.userData.schild;
    if (!schild || !schild.visible) continue;
    const d = camera.position.distanceTo(g.position);
    const f = Math.min(2.2, Math.max(0.28, d / 42));
    schild.scale.set(schild.userData.base.x * f, schild.userData.base.y * f, 1);
  }

  // Namensschild der Figur: gleiche Entfernungs-Skalierung wie Ortschilder
  if (figur.userData.schild?.visible) {
    const d = camera.position.distanceTo(figur.position);
    const f = Math.min(2.2, Math.max(0.28, d / 42));
    figur.userData.schild.scale.set(
      figur.userData.schild.userData.base.x * f,
      figur.userData.schild.userData.base.y * f, 1);
  }

  // Sprechblase an den Kopf projizieren
  if (letzterGedanke && figur.visible && mode !== 'planet') {
    kopfWelt.copy(figur.position).addScaledVector(normal, 5.6 * FIGUR_SKALA);
    blick.copy(kopfWelt).project(camera);
    const sichtbar = blick.z < 1;
    const x = (blick.x * 0.5 + 0.5) * innerWidth;
    const y = (-blick.y * 0.5 + 0.5) * innerHeight;
    if (sichtbar && x > 60 && x < innerWidth - 60 && y > 40) {
      bubble.style.display = 'block';
      bubble.style.left = `${x}px`;
      bubble.style.top = `${y}px`;
      bubble.textContent = letzterGedanke;
    } else {
      bubble.style.display = 'none';
    }
  } else {
    bubble.style.display = 'none';
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

setzeModus('charakter');
requestAnimationFrame(tick);

// Kleiner Prüf-Haken für Tests/Diagnose (kein Einfluss auf die Szene)
window.__aq = {
  get mode() { return mode; },
  get cam() { return { ...cam }; },
  get blend() {
    return {
      aktiv: modusBlend.aktiv,
      t: modusBlend.t,
      von: modusBlend.von,
      rest: modusBlend.aktiv
        ? Math.hypot(
            modusBlend.endPos.x - modusBlend.startPos.x,
            modusBlend.endPos.y - modusBlend.startPos.y,
            modusBlend.endPos.z - modusBlend.startPos.z,
          ) * (1 - posMixFaktor())
        : 0,
    };
  },
  get figur() { return figur.position.toArray(); },
  get istP() { return { ...istP }; },
  get zielP() { return { ...zielP }; },
  get orte() { return orte.size; },
  // Nur für Tests: Ziel von Hand setzen, um das Nachziehen zu prüfen
  setZiel(x, y, z) { zielP.x = x; zielP.y = y; zielP.z = z; },
  stopStream() { es.close(); },
  get renderer() { return renderer.info.render; },
};

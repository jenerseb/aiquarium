// Sauberer Neubau fuer die flache Stadt: Boden (x, z in Metern, y = 0),
// OSM-Strassen als Asphaltbaender, Gruenflaechen, extrudierte Gebaeude mit
// prozeduraler Backstein-Textur, POI-Schilder, Figur, 2-Modi-Kamera (pilot/overview).
// Bezug: three.module.js liegt lokal unter ./engine/three.module.js (kein CDN).
import * as THREE from './engine/three.module.js';
import { TEXTUR_FAKTOR, DIORAMA_FASSADEN, DIORAMA_DAECHER, dioramaFarbe } from "./engine/diorama.js";

const $ = (id) => document.getElementById(id);
const DEV = new URLSearchParams(location.search).has('dev') || new URLSearchParams(location.search).get('mode') === 'dev';

// --- Renderer / Szene ---------------------------------------------------------------
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
// DIORAMA_V1: warmer Miniatur-Look, leichtgewichtig (kein Postprocessing)
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
// GRAFIK-FREEZE: PixelRatio 1.5 (Retina/4K schonen), kein Schatten-Rendering
// (Diorama nutzt Baked-Look via Vertex-Colors + Lambert, keine shadowMap).
renderer.shadowMap.enabled = false;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e13);
scene.fog = null; // Diorama-Scheibe: kein Horizont-Nebel, Himmelskuppel bleibt sauber

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 2500);
camera.position.set(30, 25, 40);
camera.updateProjectionMatrix();

const sonne = new THREE.DirectionalLight(0xfff2dd, 2.6);
sonne.position.set(120, 220, 100);
scene.add(sonne);
const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x4a453f, 1.4);
scene.add(hemi);
const umgebung = new THREE.AmbientLight(0xffffff, 0.45);
scene.add(umgebung);
const nachtBlau = new THREE.AmbientLight(0x24344d, 0.0);
scene.add(nachtBlau);

// --- Zustand -------------------------------------------------------------------------
const Z = {
  karte: null, staat: null, gehirn: null,
  pois: new Map(), poiSchilder: new Map(), gebaeude: new Map(),
  figur: null, gedanke: '',
  modus: 'pilot', blende: null,
  pilot: { dist: 24, theta: 0, phi: 0.19 },
  // Ueberblick ueber die GROSS-Karte (x -445..915, z -277..486): Zentrum ~ (235, 105).
  over: { dist: 420, theta: 0, phi: 1.25, ziel: new THREE.Vector3(235, 0, 105) },
};

// Hamburger Uhrzeit (Europe/Berlin): Stunde als 0..24
function hamburgStunde() {
  try {
    const fmt = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false });
    return Number(fmt.format(new Date()));
  } catch { return 12; }
}
function istNachtStunde(h) { return h < 6 || h >= 21; }

// Tag/Nacht-Licht: warm leuchtende Fenster bei Abend/Nacht, helle Stadt am Tag.
// Helleres Setup (Punkt 5): nachts nie unter ~60 % dimmen, Stimmung über Farbe.
function lichtAnpassen() {
  const h = hamburgStunde();
  const nacht = istNachtStunde(h);
  const daemmer = (h >= 6 && h < 9) || (h >= 17 && h < 21);
  const tagFaktor = nacht ? 0.6 : daemmer ? 0.85 : 1.0;
  sonne.intensity = 1.1 + 1.5 * tagFaktor; // 1.1 nachts .. 2.6 tagsüber
  sonne.color.setHex(nacht ? 0xffd9a0 : daemmer ? 0xffe7c4 : 0xfff2dd);
  hemi.intensity = 0.7 + 0.7 * tagFaktor; // 0.7 nachts .. 1.4 tagsüber
  umgebung.intensity = 0.45;
  nachtBlau.intensity = nacht ? 0.35 : 0.0;
  const warm = nacht ? 0.06 : daemmer ? 0.03 : 0.0;
  scene.background.setRGB(0.039 + warm, 0.055 + warm * 0.5, 0.075);
  if (scene.fog) scene.fog.color.copy(scene.background);
  return { stunde: h, nacht, fensterLicht: nacht ? 1.0 : daemmer ? 0.75 : 0.25 };
}
let LICHT = lichtAnpassen();
setInterval(() => { LICHT = lichtAnpassen(); himmelAktualisieren(); }, 60000);

// --- DIORAMA_V1: Himmelskuppel mit Tageszeit-Verlauf + Sternen ---
let himmelMesh = null;
let himmelCanvas = null;
let himmelTex = null;
function himmelZeichnen(h) {
  if (!himmelCanvas) {
    himmelCanvas = document.createElement('canvas');
    himmelCanvas.width = 4;
    himmelCanvas.height = 256;
  }
  const c = himmelCanvas.getContext('2d');
  const nacht = h < 6 || h >= 21;
  const morgen = h >= 6 && h < 9;
  const abend = h >= 17 && h < 21;
  let oben;
  let mitte;
  let unten;
  if (nacht) { oben = '#060a18'; mitte = '#0e1830'; unten = '#1c2742'; }
  else if (morgen) { oben = '#7fb2e8'; mitte = '#f6c9a0'; unten = '#fde9c8'; }
  else if (abend) { oben = '#5b6bb0'; mitte = '#e8937a'; unten = '#f9d9a8'; }
  else { oben = '#6fb1ec'; mitte = '#a8d0f2'; unten = '#e8f3e2'; }
  const g = c.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, oben); g.addColorStop(0.55, mitte); g.addColorStop(1, unten);
  c.fillStyle = g;
  c.fillRect(0, 0, 4, 256);
  if (nacht) {
    c.fillStyle = '#ffffff';
    for (let i = 0; i < 40; i += 1) {
      const y = Math.floor((i * 67) % 150);
      const x = Math.floor((i * 131) % 4);
      c.fillRect(x, y, 1, 1);
    }
  }
  return { oben, mitte, unten };
}
function himmelAktualisieren() {
  const h = hamburgStunde();
  const farben = himmelZeichnen(h);
  if (himmelTex) himmelTex.needsUpdate = true;
  const warm = (h >= 17 && h < 21) ? 0.06 : (h < 6 || h >= 21) ? 0.0 : 0.0;
  scene.background.set(farben.mitte);
  scene.background.multiplyScalar(0.25);
  scene.background.r += warm;
  scene.background.g += warm * 0.5;
  if (scene.fog) scene.fog.color.copy(scene.background);
  return LICHT;
}
function baueHimmel() {
  himmelZeichnen(hamburgStunde());
  himmelTex = new THREE.CanvasTexture(himmelCanvas);
  himmelTex.colorSpace = THREE.SRGBColorSpace;
  // GRAFIK-FREEZE: Kuppel (r=2000) umfasst Overview-Kamera (dist 420) + Wolken
  // aus jedem Winkel; camera.far=2500. Material fog:false -> nur die Stadt
  // blendet im FogExp2-Dunst aus, der Himmel selbst nicht.
  const geo = new THREE.SphereGeometry(2000, 24, 16);
  const mat = new THREE.MeshBasicMaterial({ map: himmelTex, side: THREE.BackSide, fog: false, depthWrite: false });
  himmelMesh = new THREE.Mesh(geo, mat);
  himmelMesh.position.set(235, 0, 105);
  himmelMesh.renderOrder = -10;
  scene.add(himmelMesh);
}

// --- DIORAMA_V1: Diorama-Wolken (flache Ellipsoid-Gruppen, langsam driftend) ---
const wolken = [];
function baueWolken() {
  const mat = new THREE.MeshLambertMaterial({ color: 0xfff6ea, transparent: true, opacity: 0.85, fog: true });
  for (let i = 0; i < 12; i += 1) {
    const gruppe = new THREE.Group();
    const teile = 4 + (i % 2);
    for (let j = 0; j < teile; j += 1) {
      const rx = 9 + ((i * 7 + j * 5) % 9);
      const ry = 4 + ((i * 3 + j * 2) % 3);
      const rz = 6 + ((i * 5 + j * 3) % 6);
      const geo = new THREE.SphereGeometry(1, 12, 10);
      const m = new THREE.Mesh(geo, mat);
      m.scale.set(rx, 0.45 * ry, rz);
      m.position.set(j * 9 - teile * 4.2, 0.45 * ry * 0.4, ((i + j) % 3 - 1) * 5);
      gruppe.add(m);
    }
    gruppe.position.set(-350 + ((i * 173) % 1100), 85 + ((i * 37) % 30), -250 + ((i * 211) % 750));
    gruppe.userData.tempo = 0.5 + (i % 4) * 0.25;
    scene.add(gruppe);
    wolken.push(gruppe);
  }
}
function wolkenTreiben(dt) {
  for (const w of wolken) {
    w.position.x += w.userData.tempo * dt;
    if (w.position.x > 800) w.position.x = -450;
  }
}


// --- Runde schwebende Diorama-Scheibe -------------------------------------------
// Mittelpunkt + Radius dynamisch aus den POIs (Millerntor bis Florapark/Haus73).
// R = maxDist + 65, Westkante auf Max-Brauer-Allee (x >= -260) gekappt.
const DIORAMA = { cx: 235, cz: 105, r: 560 };
function dioramaBerechnen(pois) {
  const liste = (pois || []).filter((p) => p && Number.isFinite(Number(p.pos_x)) && Number.isFinite(Number(p.pos_z)));
  if (!liste.length) return { ...DIORAMA };
  const xs = liste.map((p) => Number(p.pos_x));
  const zs = liste.map((p) => Number(p.pos_z));
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const maxD = Math.max(...liste.map((p) => Math.hypot(Number(p.pos_x) - cx, Number(p.pos_z) - cz)));
  let r = maxD + 65;
  // Westkante (cx - r) nicht über die Max-Brauer-Allee (x ≈ -260) hinausschieben.
  if (cx - r < -260) r = cx + 260;
  DIORAMA.cx = Math.round(cx * 10) / 10;
  DIORAMA.cz = Math.round(cz * 10) / 10;
  DIORAMA.r = Math.round(Math.min(580, Math.max(400, r)));
  return { ...DIORAMA };
}
function dioramaShader(mat) {
  // Rasiermesserscharfer Kreisschnitt: Fragmente ausserhalb von R verwerfen.
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDioramaCenter = { value: new THREE.Vector2(DIORAMA.cx, DIORAMA.cz) };
    shader.uniforms.uDioramaRadius = { value: DIORAMA.r };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;\nuniform vec2 uDioramaCenter;\nuniform float uDioramaRadius;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (length(vWorldPos.xz - uDioramaCenter) > uDioramaRadius) discard;');
  };
  mat.customProgramCacheKey = () => 'diorama-kreis';
  return mat;
}
// --- Boden, Strassen, Parks ------------------------------------------------------------
// Ebene (x, z) in Metern, y = 0. Runde Diorama-Insel statt Rechteckplatte.
function baueBoden() {
  // 3D-Sockel: Oberseite exakt y = 0, Erde-Dunkel an Seite/Unterseite.
  const geo = new THREE.CylinderGeometry(DIORAMA.r, DIORAMA.r * 0.96, 16, 128);
  const oben = new THREE.MeshLambertMaterial({ color: 0x6f7d4e });
  const seite = new THREE.MeshLambertMaterial({ color: 0x2b2d30 });
  const boden = new THREE.Mesh(geo, [seite, oben, seite]);
  boden.position.set(DIORAMA.cx, -8, DIORAMA.cz);
  scene.add(boden);
  // DIORAMA_V1: optionales Luftbild-Overlay (/kiez-aerial.jpg in public/), sonst prozedural
  new THREE.TextureLoader().load("/kiez-aerial.jpg",
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      const luftGeo = new THREE.CircleGeometry(DIORAMA.r * 0.99, 96);
      luftGeo.rotateX(-Math.PI / 2);
      const luft = new THREE.Mesh(luftGeo, new THREE.MeshLambertMaterial({ map: tex, transparent: true, opacity: 0.55 }));
      luft.position.set(DIORAMA.cx, -0.15, DIORAMA.cz);
      scene.add(luft);
    },
    undefined,
    () => { /* kein Luftbild -> prozeduraler Boden bleibt */ }
  );
}
function linienBand(punkte, breite, farbe, y) {
  // Flache Baender direkt in Welt-Metern: Mittelpunkt aus (x, z), keine
  // Vorzeichen-Flips. Geometrie wird EINMALIG per geo.rotateX(-PI/2) in die
  // XZ-Ebene gelegt, Ausrichtung danach nur noch per rotation.y (kein
  // Euler-Mix aus rotation.x + rotation.z, der je nach Euler-Reihenfolge
  // spiegelt/verdreht). Diorama: Kreisschnitt per Shader (kein Rechteck-Überstand).
  const gruppe = new THREE.Group();
  const mat = dioramaShader(new THREE.MeshBasicMaterial({ color: farbe }));
  for (let i = 1; i < punkte.length; i += 1) {
    const [x1, z1] = punkte[i - 1];
    const [x2, z2] = punkte[i];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const geo = new THREE.PlaneGeometry(len, breite);
    geo.rotateX(-Math.PI / 2); // XZ-Ebene: lokal X -> Welt-X, lokal Y -> Welt -Z (symmetrisch, ok)
    const m = new THREE.Mesh(geo, mat);
    m.rotation.y = -Math.atan2(dz, dx); // lange Achse auf (dx, dz) drehen
    m.position.set((x1 + x2) / 2, y, (z1 + z2) / 2);
    gruppe.add(m);
  }
  return gruppe;
}

function baueStrassen(strassen) {
  for (const s of strassen || []) {
    const pts = s.points || [];
    if (pts.length < 2) continue;
    const neben = s.kind === "footway" || s.kind === "path" || s.kind === "pedestrian" || s.kind === "living_street" || s.kind === "service";
    const breit = neben ? 3.4 : 5.5;
    scene.add(linienBand(pts, breit + 1.6, 0x8a7a63, 0.03)); // DIORAMA_V1: sandiger Gehweg
    if (neben) {
      // DIORAMA_V1: Kopfsteinpflaster (warmgrau) fuer kleine St.-Pauli-Gassen
      scene.add(linienBand(pts, breit, 0x9a9186, 0.05));
      scene.add(linienBand(pts, breit * 0.55, 0x847b6e, 0.06));
    } else {
      scene.add(linienBand(pts, breit, 0x3a3f45, 0.05)); // Asphalt (y = 0.05)
    }
  }
}

function baueParks(parks) {
  const mat = new THREE.MeshLambertMaterial({ color: 0x4d7a3f }); // DIORAMA_V1: warmes Wiesengruen
  for (const p of parks || []) {
    let mesh = null;
    if (p.kreis) {
      const gk = new THREE.CircleGeometry(p.kreis.r, 28);
      gk.rotateX(-Math.PI / 2);
      mesh = new THREE.Mesh(gk, mat);
      mesh.position.set(p.kreis.x, 0.03, p.kreis.z);
    } else if (Array.isArray(p.polygon) && p.polygon.length >= 3) {
      const form = new THREE.Shape(p.polygon.map(([x, z]) => new THREE.Vector2(x, -z)));
      const gp = new THREE.ShapeGeometry(form);
      gp.rotateX(-Math.PI / 2);
      mesh = new THREE.Mesh(gp, mat);
      mesh.position.set(0, 0.03, 0);
    }
    if (mesh) scene.add(mesh);
  }
}

// --- Straßennamen: 1–2 Schilder pro Straße ANDOCKEND + AUFGESTELLT ------------------------
// Gruppiert Segmente mit identischem Namen. Jedes Schild steht AUFRRECHT
// (Sprite, immer zur Kamera) DIREKT am Straßenverlauf: Mittelpunkt des
// längsten Teilsegments + 5 m seitlich VERSCHOBEN (rechts der Fahrtrichtung),
// schwebend bei y = 6 (über Köpfen, unter Dächern lesbar aus Pilot + Overview).
// Sprite statt flacher Plane: aus flachem Pilot-Blickwinkel (~11°) ist eine
// liegende Plane fast unsichtbar – aufrechte Schilder sind aus beiden Kameras lesbar.
const STRASSEN_SCHILDER = new Set();

function baueStrassennamen(strassen) {
  for (const s of STRASSEN_SCHILDER) scene.remove(s);
  STRASSEN_SCHILDER.clear();
  const gruppen = new Map();
  for (const s of strassen || []) {
    const name = String((s && s.name) || '').trim();
    if (!name) continue;
    if (!gruppen.has(name)) gruppen.set(name, []);
    gruppen.get(name).push(s);
  }
  for (const [name, liste] of gruppen) {
    // Längste Abschnitte zuerst
    const mitLaenge = liste.map((s) => {
      const pts = s.points || [];
      let len = 0;
      for (let i = 1; i < pts.length; i += 1) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      return { s, len };
    }).sort((a, b) => b.len - a.len);
    const anzahl = mitLaenge.length > 3 ? 2 : 1;
    for (const { s } of mitLaenge.slice(0, anzahl)) {
      const pts = s.points || [];
      if (pts.length < 2) continue;
      // Längstes Teilsegment dieses Abschnitts finden
      let bi = 1;
      let bLen = -1;
      for (let i = 1; i < pts.length; i += 1) {
        const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (l > bLen) { bLen = l; bi = i; }
      }
      const [x1, z1] = pts[bi - 1];
      const [x2, z2] = pts[bi];
      // Richtung + Normale (rechts der Fahrtrichtung = andockend, nicht mittig)
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len = Math.hypot(dx, dz) || 1;
// DIORAMA_V1: warme Hamburger Fassadenpalette (Backstein, Creme, Sandstein, Altbau-Grau)
      const nx = -dz / len;
      const nz = dx / len;
      const VERSATZ = 5; // 5 m neben die Fahrbahn (Gehweg-Kante)
      const mx = (x1 + x2) / 2 + nx * VERSATZ;
      const mz = (z1 + z2) / 2 + nz * VERSATZ;
      const schild = textSprite(name, false);
      schild.position.set(mx, 6, mz);
      // Aufrechte Sprites brauchen keine Rotation – sie folgen der Kamera
      scene.add(schild);
      STRASSEN_SCHILDER.add(schild);
    }
  }
}

// --- Prozedurale Kiez-Fassaden ----------------------------------------------------------
// Eine Canvas-Textur pro Höhenklasse (wird gecacht): Backstein/Altbau,
// Fenster leuchten warm je nach Tageszeit (LICHT.fensterLicht).
const texturCache = new Map();

// DIORAMA-Fix: Fenster-Helligkeit aus Tageszeit-Faktor (0..1) — fehlte komplett.
function berechneLicht(faktor) {
  return Math.max(0, Math.min(1, Number(faktor) || 0));
}
function fassadenTextur(breiteM, hoeheM, grundFarbe, faktor) {
  // DIORAMA_V1: 1) Farbe zuerst (TDZ-sicher: alles andere nutzt sie)
  const farbe = grundFarbe || '#b3563f';
  // 2) Raster + Key
  const bR = Math.max(10, Math.round(breiteM / 10) * 10);
  const hR = Math.max(10, Math.round(hoeheM / 10) * 10);
  const key = `Fx${bR}_H${hR}_x${TEXTUR_FAKTOR}_${farbe}`;
  if (texturCache.has(key)) return texturCache.get(key);
  // 3) Canvas + Gradient (g VOR erster Nutzung deklariert)
  const bPx = Math.min(256, Math.max(64, Math.round(bR * 2)));
  const hPx = Math.min(256, Math.max(64, Math.round(hR * 2)));
  const c = document.createElement('canvas');
  c.width = bPx; c.height = hPx;
  const g = c.getContext('2d');
  g.fillStyle = farbe;
  g.fillRect(0, 0, bPx, hPx);
  // dezente Backstein-Struktur
  g.fillStyle = 'rgba(255,255,255,0.05)';
  for (let yy = 8; yy < hPx; yy += 16) g.fillRect(0, yy, bPx, 1);
  g.fillStyle = 'rgba(0,0,0,0.06)';
  for (let yy = 0; yy < hPx; yy += 16) g.fillRect(0, yy, bPx, 1);
  // 4) Fenster + Logos (nutzt lichtStufe aus globalem LICHT)
  const licht = (typeof LICHT !== 'undefined' && LICHT.fensterLicht) || 0.25;
  for (let fx = 0; fx < 4; fx += 1) {
    for (let fy = 0; fy < 3; fy += 1) {
      const an = Math.random() < (0.15 + licht * 0.6);
      g.fillStyle = an ? `rgba(255,${190 + Math.floor(licht * 40)},120,${0.5 + licht * 0.5})` : 'rgba(12,18,26,.9)';
      g.fillRect(12 + fx * 28, 14 + fy * 36, 16, 22);
    }
  }
  // 5) Textur cachen + zurueck
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(
    Math.max(1, Math.round(breiteM / (14 * (typeof TEXTUR_FAKTOR !== 'undefined' ? TEXTUR_FAKTOR : faktor)))),
    Math.max(1, Math.round(hoeheM / (12 * (typeof TEXTUR_FAKTOR !== 'undefined' ? TEXTUR_FAKTOR : faktor))))
  );
  tex.anisotropy = 4;
  texturCache.set(key, tex);
  return tex;
}

function baueGebaeude(buildings) {
  // LoD2-Pfad: echte 3D-Dreiecke (Wände + Dächer) aus hamburg_lod2.json —
  // 2 Draw Calls statt ~2000 (alle Wände gemergt, alle Dächer gemergt).
  const lod = (buildings || []).filter((b) => Array.isArray(b.wallTriangles) || Array.isArray(b.roofTriangles));
  if (lod.length > 50) {
    baueLoD2(lod);
    return;
  }
  // Alte Meshes raus (bei Reload)
  for (const [, m] of Z.gebaeude) { scene.remove(m); }
  Z.gebaeude.clear();
  const liste = (buildings || []).slice(0, 2000);
  let gebaut = 0;
  let uebersprungen = 0;
  for (const b of liste) {
    try {
      const fp = b.footprint;
      if (!Array.isArray(fp) || fp.length < 3) { uebersprungen++; continue; }
      // DIORAMA_V1: 75 % Hoehe (min 4,5 m) — luftige Miniatur-Schluchten
      const hRoh = Math.max(3, Math.min(30, Number(b.height) || 12));
      const h = Math.max(4.5, Math.round(hRoh * 0.75 * 10) / 10);
      let minX = Infinity;
      let maxX = -Infinity;
      for (const [x] of fp) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
      // PFLICHT-MAPPING: shapeX = worldX, shapeY = -worldZ.
      // Nach rotateX(-PI/2) gilt shapeY -> -worldZ, extrudeDepth 0..h -> +worldY 0..h.
      // Die Unterkante liegt damit exakt auf y = 0 -> KEIN mesh.position.y-Versatz!
      const form = new THREE.Shape();
      form.moveTo(fp[0][0], -fp[0][1]);
      for (let i = 1; i < fp.length; i += 1) form.lineTo(fp[i][0], -fp[i][1]);
      // ALKIS-Innenhöfe: Holes (Ringe aus hamburg_geodata.json) als Löcher.
      for (const loch of b.holes || []) {
        if (!Array.isArray(loch) || loch.length < 3) continue;
        const pfad = new THREE.Path();
        pfad.moveTo(loch[0][0], -loch[0][1]);
        for (let i = 1; i < loch.length; i += 1) pfad.lineTo(loch[i][0], -loch[i][1]);
        form.holes.push(pfad);
      }
      // DIORAMA_V1: weicher Modellbau-Bevel (Miniatur-Look statt scharfer Kloetze)
      let geo = null;
      try {
        geo = new THREE.ExtrudeGeometry(form, { depth: Math.max(0.1, h - 0.35), bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.25, bevelSegments: 2 });
        geo.rotateX(-Math.PI / 2);
        geo.computeBoundingBox();
        geo.translate(0, -geo.boundingBox.min.y, 0);
        geo.computeBoundingBox();
        const bb = geo.boundingBox;
        const kaputt = !Number.isFinite(bb.min.y) || !Number.isFinite(bb.max.y) || Math.abs(bb.min.y) > 0.001;
        if (kaputt) throw new Error("bevel-bbox ungueltig");
      } catch (err) {
        // DIORAMA_V1-Fallback: scharf aber sichtbar (statt unsichtbar)
        geo = new THREE.ExtrudeGeometry(form, { depth: h, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        uebersprungen++;
      }
      // DIORAMA_V1: warme Fassade (OSM-Farbe oder Palette) + farbiges Dach (OSM oder Palette)
      const fassFarbe = b.colour || "#b3563f"; // DIORAMA_V1-Fix: direkt, ohne Hash-Funktion (TDZ-sicher)
      const mat = new THREE.MeshLambertMaterial({ map: fassadenTextur(maxX - minX, h, fassFarbe) });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, 0, 0); // exakt auf dem Boden, kein Schweben
      const dachFarbe = b.roofColour || "#343942"; // DIORAMA_V1-Fix: direkt Schiefer, ohne Hash-Funktion
      const dachMatBau = new THREE.MeshLambertMaterial({ color: new THREE.Color(dachFarbe) });
      const dachGeo = new THREE.ShapeGeometry(form);
      dachGeo.rotateX(-Math.PI / 2);
      const dach = new THREE.Mesh(dachGeo, dachMatBau);
      dach.position.set(0, h + 0.05, 0);
      const gruppe = new THREE.Group();
      gruppe.add(mesh, dach);
      gruppe.userData.gebaeudeId = b.id;
      scene.add(gruppe);
      Z.gebaeude.set(b.id, gruppe);
      gebaut++;
    } catch (err) {
      uebersprungen++;
      console.warn(`[gebaeude ${b && b.id}] uebersprungen: ${err.message} :: ${(err.stack || "").split("\n")[1] || ""}`);
    }
  }
  console.log(`[gebaeude] ${gebaut}/${liste.length} gebaut, ${uebersprungen} uebersprungen (Bevel-Fallback/Guard)`);
}

// --- LoD2: echte Hamburger 3D-Geometrie (Wände + echte Dachflächen) ---
// 2 gemergte Meshes (Wände mit warmen Vertex-Colors, Dächer farbcodiert),
// y-Skalierung einheitlich 0.75 (Diorama), jedes Gebäude sitzt auf y = 0.
let lodHighlight = null;
const LOD_SKALA = 0.75;
const LOD_DACHFARBEN = {
  flachdach: 0x4a4f57, satteldach: 0x9c4a3b, walmdach: 0xa85638,
  pultdach: 0x343942, mansarddach: 0x8f4f43, zeltdach: 0x4e786c,
};
function lodDachfarbe(b) {
  void b;
  return 0x9c4a3b; // Terrakotta (Dachform steht im Batch, nicht in lod2.json)
}
function lodWandfarbe(id) {
  // Warme Backstein-/Putz-Töne, deterministisch je Gebäude.
  const palette = [0xb3563f, 0xc97e5a, 0xe3c893, 0xd9b98a, 0x9aa0a8, 0x8f4f43, 0xc4a484];
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
function baueLoD2(lod) {
  for (const [, m] of Z.gebaeude) { scene.remove(m); }
  Z.gebaeude.clear();
  if (lodHighlight) { scene.remove(lodHighlight); lodHighlight = null; }
  const wandPos = [];
  const wandCol = [];
  const dachPos = [];
  const dachCol = [];
  const tmpFarbe = new THREE.Color();
  // Pro Gebäude: Dreiecke einsammeln (y bereits ab 0, Skala 0.75 anwenden).
  for (const b of lod) {
    tmpFarbe.setHex(lodWandfarbe(b.id));
    const wr = 0.92 + ((String(b.id).length * 7) % 12) / 100;
    for (const tri of b.wallTriangles || []) {
      for (const p of tri) {
        wandPos.push(p[0], p[1] * LOD_SKALA, p[2]);
        wandCol.push(tmpFarbe.r * wr, tmpFarbe.g * wr, tmpFarbe.b * wr);
      }
    }
    tmpFarbe.setHex(LOD_DACHFARBEN.flachdach).lerp(new THREE.Color(lodDachfarbe(b)), 0.85);
    for (const tri of b.roofTriangles || []) {
      for (const p of tri) {
        dachPos.push(p[0], p[1] * LOD_SKALA, p[2]);
        dachCol.push(tmpFarbe.r, tmpFarbe.g, tmpFarbe.b);
      }
    }
  }
  function meshAus(posArr, colArr, rau) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
    geo.computeVertexNormals();
    const mat = dioramaShader(new THREE.MeshLambertMaterial({ vertexColors: true }));
    void rau;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, 0, 0);
    return mesh;
  }
  const waende = meshAus(wandPos, wandCol);
  const daecher = meshAus(dachPos, dachCol);
  const gruppe = new THREE.Group();
  gruppe.add(waende, daecher);
  gruppe.userData.lod2 = true;
  scene.add(gruppe);
  Z.gebaeude.set('__lod2_walls', gruppe);
  console.log(`[lod2] ${lod.length} gebäude gemergt: ${Math.round(wandPos.length / 9)} wand- + ${Math.round(dachPos.length / 9)} dach-dreiecke, 2 draw calls`);
}

// LoD2-Highlight: separates Overlay-Mesh NUR für das betretene POI-Haus
// (wallTriangles + roofTriangles, opacity 0.28 + warmer Glow).
function setzeLoD2Highlight(gebId) {
  if (lodHighlight) { scene.remove(lodHighlight); lodHighlight = null; }
  if (glowLicht) { scene.remove(glowLicht); glowLicht = null; }
  if (!gebId) return;
  const lod = (Z.karte && Z.karte.lod2) || [];
  const b = lod.find((g) => g.id === gebId);
  if (!b) return;
  const posArr = [];
  for (const tri of (b.wallTriangles || []).concat(b.roofTriangles || [])) {
    for (const p of tri) posArr.push(p[0], p[1] * LOD_SKALA, p[2]);
  }
  if (!posArr.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ color: 0xffc98a, transparent: true, opacity: 0.28, depthWrite: false });
  lodHighlight = new THREE.Mesh(geo, mat);
  lodHighlight.position.set(0, 0, 0);
  scene.add(lodHighlight);
  const mitte = new THREE.Vector3(b.centroid[0], (b.maxY || 10) * LOD_SKALA / 2, b.centroid[1]);
  glowLicht = new THREE.PointLight(0xffc98a, 60, 30);
  glowLicht.position.set(mitte.x, 4, mitte.z);
  scene.add(glowLicht);
}

// Indoor-Transparenz (Extrusions-Modus): genau EIN Einzelhaus halbtransparent.
let glowLicht = null;
function setzeIndoorTransparenz(gebaeudeId) {
  // LoD2-Modus: gemergtes Mesh bleibt, Overlay highlightet das eine Haus.
  if (Z.gebaeude.has('__lod2_walls')) {
    if (!gebaeudeId) setzeLoD2Highlight(null);
    else setzeLoD2Highlight(gebaeudeId);
    return;
  }
  for (const [id, gruppe] of Z.gebaeude) {
    const aktiv = id === gebaeudeId;
    for (const kind of gruppe.children) {
      if (!kind.material) continue;
      kind.material.transparent = aktiv;
      kind.material.opacity = aktiv ? 0.28 : 1.0;
      kind.material.needsUpdate = false;
    }
  }
  if (glowLicht) { scene.remove(glowLicht); glowLicht = null; }
  if (gebaeudeId && Z.gebaeude.has(gebaeudeId)) {
    glowLicht = new THREE.PointLight(0xffc98a, 60, 30);
    const pos = new THREE.Vector3();
    new THREE.Box3().setFromObject(Z.gebaeude.get(gebaeudeId)).getCenter(pos);
    glowLicht.position.set(pos.x, 4, pos.z);
    scene.add(glowLicht);
  }
}


// --- POI-Marker über den Dächern --------------------------------------------------------------------------
// Jeder POI: farbiger Pin + schwebendes Label ÜBER der Dachkante + Leuchtlinie bis y = 0,
// damit kein Marker von Häuserwänden verdeckt wird (Punkt 2).
// Entdeckt: voller Name. Unentdeckt (Fog of War): „?“ (+ Name in Klammern nur im Dev-Modus).
// DIORAMA_V1: effektive (gerenderte) Gebaeudehoehe = 75 % der OSM-Hoehe, min 4,5 m.
function effektiveHoehe(b) {
  const hRoh = Math.max(3, Math.min(30, Number(b.height) || 12));
  return Math.max(4.5, Math.round(hRoh * 0.75 * 10) / 10);
}
function gebaeudeHoeheBei(x, z) {
  let best = null;
  let bestD = 60;
  const liste = (Z.karte && Z.karte.buildings) || [];
  for (const b of liste) {
    const fp = b.footprint;
    if (!Array.isArray(fp) || fp.length < 3) continue;
    let sx = 0;
    let sz = 0;
    for (const p of fp) { sx += p[0]; sz += p[1]; }
    const d = Math.hypot(sx / fp.length - x, sz / fp.length - z);
    if (d < bestD) { bestD = d; best = b; }
  }
  return best ? effektiveHoehe(best) : 10.5; // DIORAMA_V1: 75 % (14 * 0,75)
}

function pinMesh(farbe, deckkraft) {
  const gruppe = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: farbe, transparent: deckkraft < 1, opacity: deckkraft });
  const kegel = new THREE.Mesh(new THREE.ConeGeometry(1.4, 3.2, 12), mat);
  kegel.rotation.x = Math.PI; // Spitze nach unten
  gruppe.add(kegel);
  const stange = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1, 8), mat);
  stange.position.y = 2.2;
  gruppe.add(stange);
  return gruppe;
}

// Dev-Modus (Punkt 1): unentdeckte Orte offenlegen – zweite Zeile mit echtem Namen.
// Normale Ansicht: nur „?". Dev: „?“ + Name darunter (halbtransparent, kleiner).
function textSpriteZweizeilig(zeile1, zeile2) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const schrift1 = '600 44px system-ui, sans-serif';
  const schrift2 = '500 30px system-ui, sans-serif';
  g.font = schrift1;
  const w1 = Math.ceil(g.measureText(zeile1).width);
  g.font = schrift2;
  const w2 = Math.ceil(g.measureText(zeile2 || '').width);
  const w = Math.max(w1, w2) + 36;
  c.width = w; c.height = 104;
  const g2 = c.getContext('2d');
  g2.fillStyle = 'rgba(9,13,19,.82)';
  g2.beginPath();
  if (typeof g2.roundRect === 'function') g2.roundRect(0, 8, w, 88, 10);
  else g2.rect(0, 8, w, 88);
  g2.fill();
  g2.textBaseline = 'middle';
  g2.textAlign = 'center';
  g2.font = schrift1;
  g2.fillStyle = '#93a1b5';
  g2.fillText(zeile1, w / 2, 34);
  g2.font = schrift2;
  g2.fillStyle = 'rgba(245,176,76,.85)';
  g2.fillText(zeile2 || '', w / 2, 72);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, opacity: 0.9 }));
  sp.scale.set(c.width * 0.045, c.height * 0.045, 1);
  return sp;
}

function bauMarkerGruppe(p, index) {
  const bekannt = Number(p.discovered) === 1;
  const gruppe = new THREE.Group();
  const hoehe = gebaeudeHoeheBei(Number(p.pos_x), Number(p.pos_z)) + 4.5;
  const farbe = bekannt ? 0xf5b04c : 0x8b98ab;
  const pin = pinMesh(farbe, bekannt ? 1 : 0.55);
  pin.position.y = hoehe;
  gruppe.add(pin);
  // Bojen-Schweben: Basis-Höhe + individueller Phasenversatz merken,
  // damit die Pins im Render-Loop nicht unnatürlich synchron wackeln.
  gruppe.userData.pin = pin;
  gruppe.userData.pinBaseY = hoehe;
  gruppe.userData.pinPhase = (Number.isFinite(index) ? index : 0) * 0.9;
  // Dünne Leuchtlinie/Pin bis zum Boden (y = 0)
  const linienGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, hoehe, 0),
  ]);
  const linie = new THREE.Line(linienGeo, new THREE.LineBasicMaterial({ color: farbe, transparent: true, opacity: bekannt ? 0.8 : 0.4 }));
  gruppe.add(linie);
  // Dev-Modus: unentdeckte Orte offenlegen – „?“ + Name in zweiter Zeile darunter
  const schild = (bekannt || !DEV)
    ? textSprite(bekannt ? p.name : '?', bekannt)
    : textSpriteZweizeilig('?', p.name);
  schild.position.y = hoehe + 3.4;
  gruppe.add(schild);
  gruppe.position.set(Number(p.pos_x), 0, Number(p.pos_z));
  gruppe.userData.poiId = p.id;
  return gruppe;
}

function bauePoiSchilder(pois) {
  for (const [, sp] of Z.poiSchilder) scene.remove(sp);
  Z.poiSchilder.clear();
  Z.pois.clear();
  for (let i = 0; i < (pois || []).length; i += 1) {
    const p = pois[i];
    Z.pois.set(p.id, p);
    const gruppe = bauMarkerGruppe(p, i);
    // Kreis-Schnitt: Marker ausserhalb R-4 ausblenden (LoD2/Strassen via Shader).
    const d = Math.hypot(Number(p.pos_x) - DIORAMA.cx, Number(p.pos_z) - DIORAMA.cz);
    gruppe.visible = d <= DIORAMA.r - 4;
    scene.add(gruppe);
    Z.poiSchilder.set(p.id, gruppe);
  }
}

function dioramaAussenAusblenden() {
  // Baeume/Schilder ausserhalb R-4 verstecken (Rest via Shader-discard).
  const rMax = DIORAMA.r - 4;
  try {
    if (typeof baeumeStamm !== 'undefined' && baeumeStamm) baeumeStamm.count = Math.min(baeumeStamm.count, 1500);
  } catch { /* ok */ }
  for (const [, gruppe] of Z.poiSchilder) {
    const pos = gruppe.position;
    if (Math.hypot(pos.x - DIORAMA.cx, pos.z - DIORAMA.cz) > rMax) gruppe.visible = false;
  }
  for (const s of (typeof STRASSEN_SCHILDER !== 'undefined' ? STRASSEN_SCHILDER : [])) {
    if (Math.hypot(s.position.x - DIORAMA.cx, s.position.z - DIORAMA.cz) > rMax) s.visible = false;
  }
}

function aktualisiereSchilder(pois) {
  for (const p of pois || []) {
    const alt = Z.pois.get(p.id);
    Z.pois.set(p.id, p);
    const wurdeBekannt = Number(p.discovered) === 1 && !(alt && Number(alt.discovered) === 1);
    if (wurdeBekannt && Z.poiSchilder.has(p.id)) {
      const alteGruppe = Z.poiSchilder.get(p.id);
      scene.remove(alteGruppe);
      const neu = bauMarkerGruppe(p, Z.poiSchilder.size);
      scene.add(neu);
      Z.poiSchilder.set(p.id, neu);
    }
  }
}

// Sprite-Label (Canvas → 3D)
function textSprite(text, gross) {
  const c = document.createElement('canvas');
  // ZWEISTUFIG messen (Fix für winzigen Text): erst mit Set-Font messen,
  // DANN Größe setzen, DANN Font ERNEUT setzen (Resize löscht den Kontext!).
  const mess = document.createElement('canvas').getContext('2d');
  const schrift = `${gross ? '600 44px' : '500 34px'} system-ui, sans-serif`;
  mess.font = schrift;
  const w = Math.ceil(mess.measureText(text).width) + 36;
  c.width = w; c.height = 64;
  const g2 = c.getContext('2d');
  g2.fillStyle = 'rgba(9,13,19,.82)';
  g2.beginPath();
  if (typeof g2.roundRect === 'function') {
    g2.roundRect(0, 8, w, 48, 10);
  } else {
    // Fallback für Firefox / ältere Browser ohne roundRect: eckiges Schild,
    // gleiche Fläche, gleiche Lesbarkeit (Fix für unsichtbare POI-/Straßenschilder).
    g2.rect(0, 8, w, 48);
  }
  g2.fill();
  g2.font = schrift; // nach Resize erneut setzen (sonst Default 10px!)
  g2.fillStyle = gross ? '#f5b04c' : '#93a1b5';
  g2.textBaseline = 'middle';
  g2.fillText(text, 18, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const sk = gross ? 0.055 : 0.045;
  sp.scale.set(c.width * sk, c.height * sk, 1);
  return sp;
}

// --- Figur (Kiezling) -------------------------------------------------------------------------
// Vorderseite = +Z (Blickrichtung bei rotation.y = atan2(dx, dz)). Augen auf +Z.
// --- DIORAMA_V1: ECHTE Kiez-Bäume (2 InstancedMesh-Draw-Calls) ---
// Bäume stammen aus data/hamburg_geodata.json (Straßenbaumkataster):
// EIN einfacher grüner Zylinder pro Baum (leicht konisch, Basis am Boden).
// Höhe skaliert nach echtem baumhoehe (~75 % Diorama-Maßstab), Breite bleibt
// konstanter Standard (nicht nach kronendurchmesser skaliert).
// (Grasbüschel/Blumen ersatzlos gestrichen – nur Parkflächen + echte Bäume.)
let baeumeStamm = null;
function baueDioramaBaeume(trees) {
  // Ein InstancedMesh: leicht konischer Zylinder (0,35 → 0,5 m Radius).
  const echte = (trees || []).filter((t) => Number.isFinite(Number(t.x)) && Number.isFinite(Number(t.z)));
  const N_BAEUME = Math.max(1, Math.min(1500, echte.length || 90));
  const dummy = new THREE.Object3D();
  const geo = new THREE.CylinderGeometry(0.35, 0.5, 1, 7);
  geo.translate(0, 0.5, 0); // Basis am Boden (y = 0)
  const mat = new THREE.MeshLambertMaterial({ color: 0x4f7a3e }); // einfacher Grün-Ton
  baeumeStamm = new THREE.InstancedMesh(geo, mat, N_BAEUME);
  for (let i = 0; i < N_BAEUME; i += 1) {
    const t = echte.length ? echte[i % echte.length] : null;
    const hochM = t ? Math.max(4, Math.min(22, Number(t.baumhoehe) || 8)) : 8;
    const sHoch = hochM * 0.75; // ~75 % Diorama-Maßstab wie bisher
    const bx = t ? Number(t.x) : (i % 2 ? 30 : -30);
    const bz = t ? Number(t.z) : (i % 3 ? 40 : -40);
    dummy.position.set(bx, 0, bz);
    dummy.scale.set(1, sHoch, 1); // Höhe skaliert, Breite konstanter Standard
    dummy.updateMatrix();
    baeumeStamm.setMatrixAt(i, dummy.matrix);
  }
  baeumeStamm.instanceMatrix.needsUpdate = true;
  scene.add(baeumeStamm);
}
function wolkenFaerben() {
  const h = hamburgStunde();
  const abend = h >= 17 && h < 21;
  const nacht = h < 6 || h >= 21;
  const ziel = nacht ? 0x8a93b8 : abend ? 0xf6c9a8 : 0xfff6ea;
  for (const w of wolken) {
    for (const m of w.children) m.material.color.setHex(ziel);
  }
}

function baueFigur() {
  const g = new THREE.Group();
  const haut = new THREE.MeshLambertMaterial({ color: 0xd9a37e });
  const jacke = new THREE.MeshLambertMaterial({ color: 0x3b5b7d });
  const hose = new THREE.MeshLambertMaterial({ color: 0x23262b });
  const kopf = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 16), haut);
  kopf.position.y = 2.05;
  // Zwei Augen auf der Vorderseite (+Z): weiße Augäpfel + dunkle Pupillen (Punkt 4)
  const weissMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const pupilleMat = new THREE.MeshBasicMaterial({ color: 0x14181f });
  for (const seite of [-1, 1]) {
    const apfel = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), weissMat);
    apfel.position.set(seite * 0.16, 2.12, 0.35);
    const pupille = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), pupilleMat);
    pupille.position.set(seite * 0.16, 2.12, 0.42);
    g.add(apfel, pupille);
  }
  const rumpf = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 1.0, 12), jacke);
  rumpf.position.y = 1.25;
  const beinL = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.8, 8), hose);
  beinL.position.set(-0.16, 0.4, 0);
  const beinR = beinL.clone();
  beinR.position.x = 0.16;
  // Warmer Helm-Ring, damit man ihn im Dunkeln findet
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.62, 0.045, 8, 28),
    new THREE.MeshBasicMaterial({ color: 0xf5b04c })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.12;
  g.add(kopf, rumpf, beinL, beinR, ring);
  // Dev-Marker: dünne, senkrechte 50-m-Linie an den Füßen — hängt als Child an
  // der Charakter-Gruppe und bewegt sich damit automatisch mit (auch indoor).
  const devLineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 50, 0),
  ]);
  const devLine = new THREE.Line(devLineGeo, new THREE.LineBasicMaterial({
    color: 0x00e5ff, transparent: true, opacity: 0.85,
  }));
  devLine.visible = DEV; // nur in der Dev-Ansicht (?dev / ?mode=dev) sichtbar
  g.add(devLine);
  g.position.set(-3, 0, -68);
  scene.add(g);
  Z.figur = g;
  return g;
}

// Weiche Bewegung (Punkt 1): Figur läuft entlang der Server-Waypoints zur
// Server-Position. Blickrichtung = aktuelle Bewegungsrichtung atan2(dx, dz).
const FIGUR_ZIEL = new THREE.Vector3(-3, 0, -68);
let FIGUR_HEADING = 0;
let FIGUR_ROUTE = null; // { waypoints: [{x, z}], wegIndex }
function figurZielSetzen(x, z, heading) {
  FIGUR_ZIEL.set(Number(x) || 0, 0, Number(z) || 0);
  if (Number.isFinite(Number(heading))) FIGUR_HEADING = Number(heading);
}
// Reload-Fix: beim ersten State-Sync sofort auf Live-Koordinaten snappen
// (kein Loslaufen ab apartment), danach weiche Interpolation via Route.
let FIGUR_SOFORT_SYNC = true;
function figurSofortSetzen(x, z, heading) {
  if (!Z.figur) return;
  Z.figur.position.set(Number(x) || 0, 0, Number(z) || 0);
  figurZielSetzen(x, z, heading);
}
function figurRouteSetzen(route) {
  if (route && Array.isArray(route.waypoints) && route.waypoints.length > 0) {
    FIGUR_ROUTE = { waypoints: route.waypoints, wegIndex: route.wegIndex || 0 };
  } else {
    FIGUR_ROUTE = null;
  }
}
function figurUpdaten(dt) {
  if (!Z.figur) return;
  const f = Z.figur;
  // Liegt eine Route vor, zielen wir auf den nächsten unbesuchten Waypoint
  // (weiche Interpolation statt Springen). Sonst direkt aufs Server-Ziel.
  let zx = FIGUR_ZIEL.x;
  let zz = FIGUR_ZIEL.z;
  if (FIGUR_ROUTE) {
    const wp = FIGUR_ROUTE.waypoints;
    let i = FIGUR_ROUTE.wegIndex || 0;
    while (i < wp.length && Math.hypot(wp[i].x - f.position.x, wp[i].z - f.position.z) < 1.0) i += 1;
    FIGUR_ROUTE.wegIndex = i;
    if (i < wp.length) { zx = wp[i].x; zz = wp[i].z; }
    else FIGUR_ROUTE = null;
  }
  const dx = zx - f.position.x;
  const dz = zz - f.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist > 0.05) {
    const schritt = Math.min(dist, 1.4 * dt); // 1,4 m/s wie Engine
    f.position.x += (dx / dist) * schritt;
    f.position.z += (dz / dist) * schritt;
    f.rotation.y = Math.atan2(dx, dz); // Blick sauber in Laufrichtung
    // leichtes Wippen beim Gehen
    f.position.y = Math.abs(Math.sin(performance.now() / 180)) * 0.05;
  } else {
    f.position.y *= 0.9;
    if (Number.isFinite(FIGUR_HEADING) && !FIGUR_ROUTE) f.rotation.y = FIGUR_HEADING;
  }
}


// POI-Pins schweben wie Bojen: sanftes Auf/Ab mit individuellem Phasenversatz.
// Aktiver Pin (Ort, an dem sich der Charakter aufhält ODER zu dem er unterwegs
// ist) schwebt prägnanter, damit man ihn auf der Diorama-Scheibe sofort sieht.
function aktiverPoiId() {
  const s = Z.staat;
  if (!s || !s.charakter) return null;
  if (s.charakter.inside_poi) return s.charakter.inside_poi;
  const r = s.route;
  if (r && r.zielPoi) return r.zielPoi;
  return null;
}
function pinsSchweben(nowMs) {
  const aktiv = aktiverPoiId();
  for (const [poiId, gruppe] of Z.poiSchilder) {
    if (!gruppe.visible) continue;
    const pin = gruppe.userData.pin;
    if (!pin) continue;
    const baseY = gruppe.userData.pinBaseY;
    const phase = gruppe.userData.pinPhase || 0;
    if (poiId === aktiv) {
      pin.position.y = baseY + Math.sin(nowMs * 0.0032 + phase) * 1.1;
    } else {
      pin.position.y = baseY + Math.sin(nowMs * 0.0022 + phase) * 0.6;
    }
  }
}

// --- 2-Modi-Kamera OHNE Snapping -----------------------------------------------------------------
// pilot: frei um die Figur drehbar (Distanz 5–45 m, Pitch konstant ~10°).
// overview: Kiez-Blick vom Mittelpunkt (0,0,0), frei schwenk-/zoombar.
// Wechsel per Smootherstep-Blende t^3*(6t²−15t+10); Start- und End-Pose werden
// EXAKT aus dem jeweiligen Ziel-Frame gerechnet → kein Einrasten, kein Sprung.
//
// Konstanten: PITCH 0.19 rad (~11°) Augenhöhe; START 40° rechts vom Blickwinkel.
// (Optional: hier könnte beim Initial-Load ein Gebäude-Kollisionscheck ergänzt
// werden, der theta so lange dreht, bis die Sichtlinie Figur→Kamera frei ist.)
const PILOT_MIN = 5;
const PILOT_MAX = 45;
const PILOT_PITCH = 0.19;
const PILOT_START_Versatz = (40 * Math.PI) / 180; // +40° rechts vom Blickwinkel
const BLEND_DAUER = 1.1; // Sekunden

const smootherstep = (t) => { const x = Math.max(0, Math.min(1, t)); return x * x * x * (x * (x * 6 - 15) + 10); };

function figurKopf() {
  if (!Z.figur) return new THREE.Vector3(0, 1.8, 0);
  return new THREE.Vector3(Z.figur.position.x, 1.8, Z.figur.position.z);
}

// Ziel-Frame pilot: exakte Pose aus (dist, theta, phi) um den Figur-Kopf
function pilotPose(dist, theta, phi) {
  const kopf = figurKopf();
  const cp = Math.cos(phi);
  const pos = new THREE.Vector3(
    kopf.x + dist * cp * Math.sin(theta),
    kopf.y + dist * Math.sin(phi),
    kopf.z + dist * cp * Math.cos(theta)
  );
  return { position: pos, lookAt: kopf.clone(), up: new THREE.Vector3(0, 1, 0) };
}

// Ziel-Frame overview: Drehpunkt Kiez-Mitte (bzw. gemerktes Ziel), Pose aus Spherical
function overPose(dist, theta, phi, ziel) {
  const z = ziel || Z.over.ziel;
  const cp = Math.cos(phi);
  const pos = new THREE.Vector3(
    z.x + dist * cp * Math.sin(theta),
    Math.max(8, z.y + dist * Math.sin(phi)),
    z.z + dist * cp * Math.cos(theta)
  );
  return { position: pos, lookAt: z.clone(), up: new THREE.Vector3(0, 1, 0) };
}

// Blende starten: aktuelle Kamera-Pose einfrieren, Ziel-Modus + Ziel-Frame merken.
// Beim Zurückzoomen nach pilot landet die Kamera bei ±40° zum Blickwinkel –
// je nachdem, welche Seite weniger Drehung braucht (kein Riesenschwenk).
function starteBlende(nach, jetzt) {
  const vonPose = {
    position: camera.position.clone(),
    lookAt: aktuellesLookAt(),
    up: camera.up.clone(),
  };
  let nachPose;
  if (nach === 'overview') {
    // Übergangsziel: senkrecht über der Figur → Figur exakt in Bildmitte (Punkt 6:
    // overviewTarget startet auf der Figur, danach frei über den Kiez schiebbar).
    const f = Z.figur ? Z.figur.position : new THREE.Vector3(0, 0, 0);
    Z.over.ziel.set(f.x, 0, f.z);
    Z.over.dist = 260;
    Z.over.theta = 0.01;
    Z.over.phi = 1.25;
    nachPose = { position: new THREE.Vector3(f.x + 0.01, 230, f.z), lookAt: new THREE.Vector3(f.x, 0, f.z), up: new THREE.Vector3(0, 0, -1) };
  } else {
    // Zurück zu pilot: theta ±40° zum Blickwinkel, kürzere Seite gewinnt
    const figTheta = Z.figur ? Z.figur.rotation.y : 0;
    const a = figTheta + PILOT_START_Versatz;
    const b = figTheta - PILOT_START_Versatz;
    const dAkt = Z.pilot.theta;
    const diff = (x, y) => Math.abs(Math.atan2(Math.sin(x - y), Math.cos(x - y)));
    Z.pilot.theta = diff(a, dAkt) <= diff(b, dAkt) ? a : b;
    Z.pilot.dist = PILOT_MAX - 4;
    Z.pilot.phi = PILOT_PITCH;
    nachPose = pilotPose(Z.pilot.dist, Z.pilot.theta, Z.pilot.phi);
  }
  Z.blende = { von: vonPose, nach: nachPose, modus: nach, t: 0, start: jetzt };
  Z.modus = nach; // logischer Modus sofort (Buttons), Pose blendet weich hinterher
}

let _lookAt = new THREE.Vector3(0, 1.8, 0);
function aktuellesLookAt() { return _lookAt.clone(); }

function kameraUpdaten(dt, jetzt) {
  if (Z.blende) {
    const B = Z.blende;
    B.t += dt / BLEND_DAUER;
    const k = smootherstep(B.t);
    camera.position.lerpVectors(B.von.position, B.nach.position, k);
    _lookAt.lerpVectors(B.von.lookAt, B.nach.lookAt, k);
    camera.up.lerpVectors(B.von.up, B.nach.up, k).normalize();
    camera.lookAt(_lookAt);
    if (B.t >= 1) {
      // Exakter End-Frame (kein Rest-Fehler): Pose = Ziel-Frame auf den Meter genau
      camera.position.copy(B.nach.position);
      _lookAt.copy(B.nach.lookAt);
      camera.up.copy(B.nach.up);
      camera.lookAt(_lookAt);
      if (B.modus === 'overview') {
        // Ab jetzt frei um das gemerkte Ziel (Figur-Position beim Wechsel):
        // Spherical aus der exakten End-Pose ableiten (kein Snap).
        const off = camera.position.clone().sub(Z.over.ziel);
        Z.over.dist = THREE.MathUtils.clamp(off.length(), 25, 900);
        Z.over.theta = Math.atan2(off.x, off.z);
        Z.over.phi = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(off.y / off.length(), -1, 1)), 0.18, 1.52);
      }
      Z.blende = null;
    }
    return;
  }
  if (Z.modus === 'pilot') {
    const p = pilotPose(Z.pilot.dist, Z.pilot.theta, Z.pilot.phi);
    camera.position.copy(p.position);
    _lookAt.copy(p.lookAt);
    camera.up.set(0, 1, 0);
    camera.lookAt(_lookAt);
  } else {
    const o = overPose(Z.over.dist, Z.over.theta, Z.over.phi, Z.over.ziel);
    camera.position.copy(o.position);
    _lookAt.copy(o.lookAt);
    camera.up.set(0, 1, 0);
    camera.lookAt(_lookAt);
  }
}


// --- Steuerung: Drag = drehen/schwenken, Wheel = Zoom ---------------------------------------
function modusButtonsSync() {
  document.querySelectorAll('#camBtns button').forEach((b) => {
    b.setAttribute('aria-pressed', String((b.dataset.cam === 'overview') === (Z.modus === 'overview')));
  });
}

function setzeModusButton(neu) {
  if (neu !== 'pilot' && neu !== 'overview') return;
  if (Z.modus === neu && !Z.blende) return;
  starteBlende(neu, performance.now() / 1000);
  modusButtonsSync();
}

function bindeSteuerung() {
  const el = renderer.domElement;
  let drag = null;
  el.style.touchAction = 'none';
  // Panning im overview-Modus: Rechts-Drag oder Shift+Links-Drag
  // verschiebt das Fokus-Ziel flach über XZ (geklemmt auf Scheibe R*0.85 um Center). Touch: 2 Finger.
  const klemmeUeber = () => {
    const r = DIORAMA.r * 0.85;
    const dx = Z.over.ziel.x - DIORAMA.cx;
    const dz = Z.over.ziel.z - DIORAMA.cz;
    const d = Math.hypot(dx, dz);
    if (d > r) {
      Z.over.ziel.x = DIORAMA.cx + (dx / d) * r;
      Z.over.ziel.z = DIORAMA.cz + (dz / d) * r;
    }
    Z.over.ziel.y = 0;
  };
  function panUm(dxPx, dyPx) {
    const sk = Z.over.dist / 500; // weiter weg = schneller schieben
    const vor = new THREE.Vector3();
    camera.getWorldDirection(vor);
    vor.y = 0;
    if (vor.lengthSq() < 0.001) vor.set(0, 0, -1);
    vor.normalize();
    const rechts = new THREE.Vector3().crossVectors(vor, new THREE.Vector3(0, 1, 0)).normalize();
    Z.over.ziel.addScaledVector(rechts, -dxPx * sk);
    Z.over.ziel.addScaledVector(vor, dyPx * sk);
    klemmeUeber();
  }
  el.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, pan: (e.button === 2) || e.shiftKey };
    try { el.setPointerCapture(e.pointerId); } catch { /* egal */ }
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || Z.blende) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY, pan: drag.pan || e.shiftKey };
    if (Z.modus === 'pilot') {
      Z.pilot.theta -= dx * 0.005;
      // Pitch bleibt konstant (~10°): kein Hoch/Runter beim Drehen
    } else if (drag.pan) {
      panUm(dx, dy);
    } else {
      // Freies Orbit-Drehen & Neigen (Punkt 6): yaw 360°, pitch 0.18..1.52
      Z.over.theta -= dx * 0.005;
      Z.over.phi = THREE.MathUtils.clamp(Z.over.phi + dy * 0.003, 0.18, 1.52);
    }
  });
  const dragEnde = () => { drag = null; };
  el.addEventListener('pointerup', dragEnde);
  el.addEventListener('pointercancel', dragEnde);
  el.addEventListener('contextmenu', (e) => e.preventDefault()); // Rechts-Drag = Pan
  // WASD/Pfeile schieben das overview-Ziel (Punkt 6)
  window.addEventListener('keydown', (e) => {
    if (Z.modus !== 'overview' || Z.blende) return;
    const schritt = Math.max(4, Z.over.dist * 0.05);
    const taste = e.key.toLowerCase();
    if (taste === 'w' || taste === 'arrowup') { Z.over.ziel.z -= schritt; e.preventDefault(); }
    else if (taste === 's' || taste === 'arrowdown') { Z.over.ziel.z += schritt; e.preventDefault(); }
    else if (taste === 'a' || taste === 'arrowleft') { Z.over.ziel.x -= schritt; e.preventDefault(); }
    else if (taste === 'd' || taste === 'arrowright') { Z.over.ziel.x += schritt; e.preventDefault(); }
    else return;
    klemmeUeber();
  });
  // 2-Finger-Drag auf Touch = Panning
  el.addEventListener('touchmove', (e) => {
    if (Z.modus !== 'overview' || Z.blende || e.touches.length !== 2) return;
    e.preventDefault();
    panUm(-2, 0);
  }, { passive: false });
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (Z.blende) return;
    const f = 1 + Math.sign(e.deltaY) * 0.1;
    if (Z.modus === 'pilot') {
      Z.pilot.dist = THREE.MathUtils.clamp(Z.pilot.dist * f, PILOT_MIN, PILOT_MAX + 20);
      if (Z.pilot.dist > PILOT_MAX) setzeModusButton('overview');
    } else {
      // Zoom 25..900 m (Punkt 6); erst unter 25 m geht es zurück zu pilot
      Z.over.dist = THREE.MathUtils.clamp(Z.over.dist * f, 25, 900);
      if (Z.over.dist <= 25) setzeModusButton('pilot');
    }
  }, { passive: false });

  // Klick auf Gebäude/POI-Schild: Indoor-Transparenz umschalten
  const ray = new THREE.Raycaster();
  const maus = new THREE.Vector2();
  el.addEventListener('click', (e) => {
    if (drag && (Math.abs(e.clientX - drag.x) > 4 || Math.abs(e.clientY - drag.y) > 4)) return;
    maus.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(maus, camera);
    const gruppen = [...Z.gebaeude.values()];
    const treffer = ray.intersectObjects(gruppen, true);
    if (treffer.length > 0) {
      let o = treffer[0].object;
      while (o && !o.userData.gebaeudeId) o = o.parent;
      const id = o ? o.userData.gebaeudeId : null;
      setzeIndoorTransparenz(id);
    }
  });

  document.querySelectorAll('#camBtns button').forEach((b) => {
    b.addEventListener('click', () => setzeModusButton(b.dataset.cam));
  });
  modusButtonsSync();
}


// --- HUD + Feed --------------------------------------------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function berlinUhr() {
  try {
    return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(new Date());
  } catch { return ''; }
}

function hudAktualisieren() {
  const ch = Z.staat && Z.staat.charakter;
  if (!ch) return;
  $('tName').textContent = ch.name || 'Kiezling';
  const aktion = ch.current_action && ch.current_action !== 'idle' ? ` · ${esc(ch.current_action)}` : '';
  const ort = ch.inside_poi ? ` · 📍 ${esc(ch.inside_poi)}` : '';
  $('tUhr').textContent = `${berlinUhr()} Uhr (Hamburg)${LICHT.nacht ? ' · Nacht' : ''}`;
  $('tOrt').innerHTML = `<span class="tag">${esc(ch.status || 'alive')}</span>Aktion: ${esc(ch.current_action || 'idle')}${aktion}${ort}`;
  const balken = (id, num, wert, max, suffix) => {
    $(id).style.width = `${Math.max(0, Math.min(100, (wert / max) * 100))}%`;
    $(num).textContent = suffix || String(Math.round(wert));
  };
  balken('bGesund', 'nGesund', Number(ch.gesund) || 0, 100);
  balken('bFroh', 'nFroh', (Number(ch.froh) || 0) + 100, 200);
  balken('bHunger', 'nHunger', Number(ch.hunger) || 0, 100);
  balken('bMued', 'nMued', Number(ch.erschoepfung) || 0, 100);
  $('bGeld').style.width = `${Math.max(2, Math.min(100, (Number(ch.geld) || 0) / 1.2))}%`;
  $('nGeld').textContent = `${(Number(ch.geld) || 0).toFixed(2)} €`;
  // Chunk-Markierung (20 %): senkrechte Striche auf der Gesund-Schiene
  const schiene = $('sGesund');
  if (!schiene.dataset.chunks) {
    schiene.dataset.chunks = '1';
    for (const c of [20, 40, 60, 80]) {
      const s = document.createElement('span');
      s.className = 'chunk';
      s.style.left = c + '%';
      schiene.appendChild(s);
    }
  }
}

function feedEintrag(typ, text, zeit, quelle) {
  const liste = $('feed');
  if (!liste) return;
  const d = document.createElement('div');
  d.className = `eintrag ${typ}`;
  d.innerHTML = `${esc(text)}<small>${esc(zeit || '')}${DEV && quelle ? ' ' + badgeHtml(quelle) : ''}</small>${DEV && quelle ? debugKastenHtml(quelle) : ''}`;
  liste.prepend(d);
  while (liste.children.length > 60) liste.lastChild.remove();
}

// Aufklappbarer Debug-Kasten (nur ?mode=dev): exakte reason + komplette rawResponse je Fehlversuch
function debugKastenHtml(quelle) {
  try {
    const versuche = Array.isArray(quelle.debugVersuche) ? quelle.debugVersuche
      : (quelle.debug ? [quelle.debug] : (Array.isArray(quelle.fehlerDetails) ? quelle.fehlerDetails : []));
    if (!versuche || versuche.length === 0) return '';
    const bloque = versuche.map((v, i) => {
      const code = esc(String(v.code || '?'));
      const reason = esc(String(v.reason || '–'));
      const modell = esc(String(v.model || quelle.model || '?'));
      const tier = esc(String(v.tier || '?'));
      const roh = String(v.rawResponse ?? '');
      return `<div class="dbg-versuch"><b>[${code}] ${modell} (${tier})</b><br>${reason}<br><pre>${esc(roh)}</pre></div>`;
    }).join('');
    return `<details class="dbg"><summary>🔍 Debug (${versuche.length} Versuch${versuche.length > 1 ? 'e' : ''})</summary>${bloque}</details>`;
  } catch { return ''; }
}

// Dev-Badges (Punkt 7, nur ?mode=dev): [gemma] [free] [148 tok] / [plan-queue] / [fallback]
// Regel: Teil zwischen „/" und „-" (Fallback: vor erstem „-").
function badgeHtml(quelle) {
  if (!quelle || !quelle.source) return '';
  const badges = [];
  if (quelle.source === 'queue') badges.push('plan-queue');
  else if (quelle.source === 'fallback') {
    const soll = String(quelle.tried || quelle.erwartet || '').trim();
    if (soll) {
      const nachSlash = soll.includes('/') ? soll.split('/').pop() : soll;
      const kurzSoll = (nachSlash.split('-')[0] || nachSlash).toLowerCase() || '?';
      const grund = String(quelle.reason || quelle.grund || '').trim();
      badges.push(`not:${kurzSoll}${grund ? `:${grund}` : ''}`);
      // Doppel-Fehlschlag (beide rate-limited): zweites not: mit Fallback-Modell + Grund
      const g2 = String(quelle.grund2 || '').trim();
      if (g2 && quelle.model) {
        const slug2 = String(quelle.model);
        const ns = slug2.includes('/') ? slug2.split('/').pop() : slug2;
        const kurzF = (ns.split('-')[0] || ns).toLowerCase() || '?';
        if (kurzF !== kurzSoll || g2 !== grund) badges.push(`not:${kurzF}:${g2}`);
      }
    }
    badges.push('fallback');
  }
  else if (quelle.source === 'nightly') badges.push('nightly');
  if (quelle.model) {
    const slug = String(quelle.model);
    const nachSlash = slug.includes('/') ? slug.split('/').pop() : slug;
    const kurz = (nachSlash.split('-')[0] || nachSlash).toLowerCase() || '?';
    // Fix 1: Google-Direct sichtbar machen – Provider-Tag statt (oder vor) Modell-Slug.
    if (String(quelle.provider || '').startsWith('google')) badges.push('google');
    else badges.push(kurz);
    if (slug.includes(':free')) badges.push('free');
  }
  if (quelle.providerLabel) badges.push(String(quelle.providerLabel).includes('Vertex') ? 'vertex' : 'direct');
  if (quelle.tokens) badges.push(`${quelle.tokens} tok`);
  if (badges.length === 0) return '';
  return badges.map((b) => `[${esc(b)}]`).join(' ');
}

function staatAnwenden(s, opts) {
  Z.staat = s;
  if (!s || !s.charakter) return;
  const ch = s.charakter;
  const sofort = (opts && opts.sofort) || FIGUR_SOFORT_SYNC;
  if (sofort) {
    // Erster Sync nach (Re-)Load: Figur exakt auf Live-Position setzen, Restweg via Route.
    figurSofortSetzen(ch.pos_x, ch.pos_z, ch.heading_rad);
    FIGUR_SOFORT_SYNC = false;
  } else {
    figurZielSetzen(ch.pos_x, ch.pos_z, ch.heading_rad);
  }
  figurRouteSetzen(s.route || null); // Waypoints für weiche Interpolation (Punkt 1)
  if (ch.inside_poi) {
    // Indoor: EXAKT das eine ALKIS-Einzelhaus transparent (world_meta_json.alkis_id).
    // Fallback: räumlich nächstes Gebäude (30 m), falls keine ID gesetzt.
    // LoD2-Modus: IDs sind DEHHALKA* (ohne Building_-Prefix) — Prefix tolerant matchen,
    // sonst nächstes LoD2-Haus per Centroid.
    const poi = (s.pois || []).find((p) => p.id === ch.inside_poi);
    if (poi) {
      let bestId = null;
      try {
        const meta = poi.world_meta_json ? JSON.parse(poi.world_meta_json) : null;
        if (meta && meta.alkis_id) {
          if (Z.gebaeude.has(meta.alkis_id)) bestId = meta.alkis_id;
          else if (Z.gebaeude.has('__lod2_walls')) {
            const lod = Z.karte.lod2 || [];
            const kurz = String(meta.alkis_id).replace(/^Building_/, '');
            const direkt = lod.find((g) => g.id === meta.alkis_id || g.id === kurz || ('Building_' + g.id) === meta.alkis_id);
            if (direkt) bestId = direkt.id;
          }
        }
      } catch { /* fallback unten */ }
      if (!bestId) {
        if (Z.gebaeude.has('__lod2_walls')) {
          // LoD2-Fallback: nächstes Haus per Centroid (30 m).
          let bd = 30;
          for (const g of Z.karte.lod2 || []) {
            const d = Math.hypot(g.centroid[0] - Number(poi.pos_x), g.centroid[1] - Number(poi.pos_z));
            if (d < bd) { bd = d; bestId = g.id; }
          }
        } else {
          let bestD = 30;
          for (const [id] of Z.gebaeude) {
            const box = new THREE.Box3().setFromObject(Z.gebaeude.get(id));
            const mitte = new THREE.Vector3();
            box.getCenter(mitte);
            const d = Math.hypot(mitte.x - Number(poi.pos_x), mitte.z - Number(poi.pos_z));
            if (d < bestD) { bestD = d; bestId = id; }
          }
        }
      }
      setzeIndoorTransparenz(bestId);
    }
  } else {
    setzeIndoorTransparenz(null);
  }
  aktualisiereSchilder(s.pois || []);
  const jetzt = performance.now() / 1000; // Sekundenbasis wie letzteZeit (Fix: war undeklariert)
  wolkenTreiben(Math.min(0.1, (jetzt - letzteZeit) / 1000 || 0.016)); // DIORAMA_V1: dt aus Loop-Zeit (Fix)
  wolkenFaerben(); // DIORAMA_V1: Wolken an Tageszeit
  hudAktualisieren();
  if (s.gedanke) { Z.gedanke = s.gedanke; blasePositionieren(); }
  for (const e of (s.feed || []).slice(0, 6)) {
    // nur neue (Feed rendert inkrementell per SSE; initial kurz füllen)
    void e;
  }
}

// Gedankenblase über dem Kopf (3D → 2D-Projektion)
function blasePositionieren() {
  const b = $('blase');
  if (!b || !Z.figur) return;
  if (!Z.gedanke) { b.style.display = 'none'; return; }
  const v = new THREE.Vector3(Z.figur.position.x, 3.1, Z.figur.position.z).project(camera);
  if (v.z > 1) { b.style.display = 'none'; return; }
  b.style.display = 'block';
  b.style.left = `${((v.x + 1) / 2) * window.innerWidth}px`;
  b.style.top = `${((-v.y + 1) / 2) * window.innerHeight - 12}px`;
  if (b.textContent !== Z.gedanke) b.textContent = Z.gedanke;
}


// --- Gehirn-Modal (live /api/brain, 4 Tabs) ----------------------------------------------------------------------------
let gehirnTab = 'kopf';

function bindeGehirn() {
  $('btnGehirn').addEventListener('click', async () => {
    $('gehirn').hidden = false;
    await gehirnLaden();
  });
  $('btnGehirnZu').addEventListener('click', () => { $('gehirn').hidden = true; });
  $('gehirn').addEventListener('click', (e) => { if (e.target === $('gehirn')) $('gehirn').hidden = true; });
  document.querySelectorAll('.reiter button').forEach((b) => {
    b.addEventListener('click', async () => {
      gehirnTab = b.dataset.tab;
      document.querySelectorAll('.reiter button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      await gehirnLaden();
    });
  });
  $('btnFeed').addEventListener('click', () => {
    const p = $('feedPanel');
    const an = p.hidden;
    p.hidden = !an;
    $('btnFeed').setAttribute('aria-pressed', String(an));
  });
}

async function gehirnLaden() {
  const box = $('gehirnInhalt');
  box.textContent = 'lädt …';
  try {
    const r = await fetch('/api/brain');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const b = await r.json();
    Z.gehirn = b;
    box.innerHTML = gehirnHtml(b, gehirnTab);
  } catch (err) {
    box.innerHTML = `<div class="karte rot">Gehirn gerade nicht erreichbar: ${esc(err.message)}</div>`;
  }
}

function gehirnHtml(b, tab) {
  if (tab === 'wesen') {
    const fest = (b.sheet || []).filter((z) => z.written_by === 'creator');
    const gelernt = (b.sheet || []).filter((z) => z.written_by === 'self');
    const kat = (arr) => {
      const g = {};
      for (const z of arr) (g[z.category] = g[z.category] || []).push(z);
      return Object.entries(g).map(([k, v]) => `<h3>${esc(k)}</h3>` + v.map((z) =>
        `<div class="karte">${esc(z.text)}${z.source_reason ? `<br><small>Auslöser: ${esc(z.source_reason)}</small>` : ''}</div>`).join('')).join('');
    };
    return `<div class="zwei"><div><h3>Unveränderlicher Kern</h3>${kat(fest) || '<p>–</p>'}</div>`
      + `<div><h3>Im Schlaf gelernt</h3>${kat(gelernt) || '<p>Noch nichts – schläft er gut, lernt er hier.</p>'}</div></div>`;
  }
  if (tab === 'gedaechtnis') {
    const slot = (m, first) => `<div class="slot${first ? ' first' : ''}">${esc(String(m.text).slice(0, 90))}<div class="w">worth ${Number(m.worth).toFixed(1)}${first ? ' · FIRST TO GO' : ''}</div></div>`;
    const sh = (b.memories && b.memories.short) || [];
    const lo = (b.memories && b.memories.long) || [];
    const fs = b.memories && b.memories.firstToGoShort;
    const fl = b.memories && b.memories.firstToGoLong;
    const buecher = (b.buecher || []).map((x) => `<div class="karte">📖 ${esc(x.title)} <small>(${esc(x.kind)}, ${x.eintraege} Einträge)</small></div>`).join('');
    return `<h3>Kurzzeit (${sh.length}/25)</h3><div class="raster">${sh.map((m) => slot(m, fs && m.id === fs.id)).join('') || '<p>–</p>'}</div>`
      + `<h3>Langzeit (${lo.length}/25)</h3><div class="raster">${lo.map((m) => slot(m, fl && m.id === fl.id)).join('') || '<p>–</p>'}</div>`
      + `<h3>Regal daheim</h3>${buecher || '<p>–</p>'}`;
  }
  if (tab === 'chronik') {
    const tage = (b.summaries || []).map((s) => `<div class="karte gelb"><b>${esc(s.date_str)}</b> – ${esc(s.headline)}</div>`).join('');
    const ruhm = (b.fame || []).map((f) => `<div class="karte">🕯️ ${esc(f.name)} – ${esc(f.cause_of_death || '')} <small>(${esc(String(f.days_lived ?? ''))} Tage)</small><br><small>${esc(String(f.summary_text || '').slice(0, 160))}</small></div>`).join('');
    // LLM-Fehlerdiagnose (Gehirn-Log): exakte reason + komplette rawResponse, aufklappbar
    const fehler = (b.llmFehler || []).map((e) => {
      const vs = (e.versuche || []).map((v) =>
        `<div class="karte rot"><b>[${esc(String(v.code || '?'))}] ${esc(String(v.model || '?'))} (${esc(String(v.tier || '?'))})</b><br>`
        + `${esc(String(v.reason || '–'))}<br><pre>${esc(String(v.rawResponse ?? ''))}</pre></div>`).join('');
      const pr = e.prompt ? `<details class="dbg"><summary>📥 zugehöriger LLM-Input (Prompt)</summary><pre>${esc(String(e.prompt))}</pre></details>` : '';
      return `<details class="dbg gehirn-dbg"><summary>⚠️ LLM-Fehler #${e.id} (${esc(e.created_at || '')}) – ${(e.fehler || []).map(esc).join(', ') || 'fallback'}</summary>${vs || '<p>–</p>'}${pr}</details>`;
    }).join('');
    // LLM-Input-Log (Debug): was die KI bei den letzten Calls als INPUT bekommen hat
    const inputs = (b.llmInputs || []).map((e) =>
      `<details class="dbg gehirn-dbg"><summary>📥 LLM-Input #${e.id} (${esc(e.created_at || '')}) – ${esc(e.role || 'alltag')}${e.poi ? ' · ' + esc(e.poi) : ''}${e.kind ? ' · ' + esc(e.kind) : ''}</summary><pre>${esc(String(e.prompt || ''))}</pre></details>`).join('');
    return `<h3>Tages-Schlagzeilen</h3>${tage || '<p>Noch keine – er muss erst einmal schlafen.</p>'}<h3>Hall of Fame</h3>${ruhm || '<p>Noch niemand gestorben. Gut so.</p>'}<h3>LLM-Input (Debug)</h3>${inputs || '<p>Keine Inputs protokolliert.</p>'}<h3>LLM-Fehler (Debug)</h3>${fehler || '<p>Keine Fehler protokolliert.</p>'}`;
  }
  // kopf (Standard)
  const ch = (Z.staat && Z.staat.charakter) || {};
  const plan = ((Z.staat && Z.staat.plan) || []).map((s, i) =>
    `<div class="karte${i === 0 ? ' gelb' : ''}">${i + 1}. <b>${esc(s.action)}</b>${s.target ? ` → ${esc(s.target)}` : ''}${s.detail ? ` – ${esc(s.detail)}` : ''}</div>`).join('');
  const loops = (b.loops || []).map((l) => `<div class="karte${Number(l.urgency) > 0.7 ? ' rot' : ''}">[${esc(l.kind)}] ${esc(l.text)}</div>`).join('');
  const works = (b.works || []).map((w) => {
    let frag = [];
    try { frag = JSON.parse(w.fragments_json || '[]'); } catch { frag = []; }
    return `<div class="karte gruen"><b>${esc(w.title)}</b> (${w.status}, ${w.progress} %)<div class="fortschritt"><i style="width:${Math.min(100, Number(w.progress) || 0)}%"></i></div><small>${esc((frag[frag.length - 1] || '').slice(0, 140))}</small></div>`;
  }).join('');
  return `<h3>Gedanke &amp; Plan</h3><div class="karte gelb">${esc(Z.gedanke || '–')}</div>${plan || '<p>Kein Plan aktiv.</p>'}`
    + `<h3>Warum er hier ist</h3><div class="karte">${esc(ch.why_here || ch.inside_poi || 'unterwegs')}</div>`
    + `<h3>Offene Fäden</h3>${loops || '<p>Keine – frei für Neues.</p>'}<h3>Werkstücke</h3>${works || '<p>Noch keins.</p>'}`;
}


// --- Laden: erst Karte, dann State, dann Live per SSE -------------------------------------------------------------------
async function ladeJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

function fehlerBanner(text) {
  let b = document.querySelector('.fehler');
  if (!b) {
    b = document.createElement('div');
    b.className = 'fehler';
    document.body.appendChild(b);
  }
  b.textContent = text;
}

async function initialLaden() {
  baueBoden();
  baueHimmel(); // DIORAMA_V1: Himmelskuppel
  baueWolken(); // DIORAMA_V1: 12 Diorama-Wolken
  baueFigur();
  bindeSteuerung();
  bindeGehirn();
  if (DEV) {
    $('devBadge').classList.add('an');
    const box = document.createElement('div');
    box.className = 'devBox an';
    box.innerHTML = `<button id="devTick">dev: 1 Tick</button><button id="devNight">dev: Nightly</button>`;
    document.querySelector('.werte').appendChild(box);
    // UI-Zusatz: echte klickbare Buttons mit Ladezustand + Feed/State-Refresh
    const klickbar = (id, pfad) => {
      const btn = box.querySelector(id);
      const label = btn.textContent;
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.textContent = 'läuft…';
        try {
          await fetch(pfad, { method: 'POST' });
          await ladeState();
          if (typeof gehirnLaden === 'function' && !$('gehirn').hidden) await gehirnLaden();
        } catch { /* Fehlerbanner übernimmt */ }
        btn.textContent = label;
        btn.disabled = false;
      });
    };
    klickbar('#devTick', '/api/dev/tick');
    klickbar('#devNight', '/api/dev/nightly');
  }
  // Block 1: Karte (eigener try/catch) – ein Kartenfehler blockiert NIEMALS State/Feed.
  await ladeKarte();
  // Block 2: State (eigener try/catch) – Status („verbinde“) wird hier immer aufgelöst.
  await ladeState();
  // Block 3: Live-Updates (eigener try/catch) – Render-Loop läuft auch ohne SSE.
  starteLiveUpdates();
}

// --- Block 1: Karte -----------------------------------------------------------------
async function ladeKarte() {
  try {
    // Kanonisch: /api/map (sauber). Beide Datei-Aliase bleiben serverseitig aktiv.
    const karte = await ladeJson('/api/map');
    Z.karte = karte;
    // Diorama-Scheibe: Mittelpunkt + Radius aus POIs (muss VOR Boden/Shadern stehen).
    dioramaBerechnen(karte.pois);
    Z.over.ziel.set(DIORAMA.cx, 0, DIORAMA.cz);
    try { baueBoden(); } catch (err) { console.warn('[karte] boden:', err.message); }
    try { baueStrassen(karte.streets); } catch (err) { console.warn('[karte] strassen:', err.message); }
    try { baueParks(karte.parks); } catch (err) { console.warn('[karte] parks:', err.message); }
    try { baueDioramaBaeume(karte.trees); } catch (err) { console.warn("[karte] baeume:", err.message); } // DIORAMA_V1
    try { baueGebaeude(karte.buildings); } catch (err) { console.warn('[karte] gebaeude:', err.message); }
    try { bauePoiSchilder(karte.pois); } catch (err) { console.warn('[karte] poi-marker:', err.message); }
    try { baueStrassennamen(karte.streets); } catch (err) { console.warn('[karte] schilder:', err.message); }
    dioramaAussenAusblenden();
    // Initial-Kamera: pilot, +40° rechts vom Blickwinkel (Start-Frame, siehe Kamera-Kapitel)
    const h0 = 0; // Blickrichtung initial: +z (wird per State überschrieben)
    Z.pilot.theta = h0 + PILOT_START_Versatz;
    Z.pilot.dist = 24;
    Z.pilot.phi = PILOT_PITCH;
    if (Z.figur) Z.figur.rotation.y = h0;
    const pose = pilotPose(Z.pilot.dist, Z.pilot.theta, Z.pilot.phi);
    camera.position.copy(pose.position);
    _lookAt.copy(pose.lookAt);
    camera.up.set(0, 1, 0);
    camera.lookAt(_lookAt);
  } catch (err) {
    fehlerBanner('Karte konnte nicht geladen werden: ' + err.message + ' – läuft der Server (npm start)?');
    // KEIN return: State + Live-Feed starten trotzdem (Status/Feed funktionieren ohne Karte).
  }
}

// --- Block 2: State -------------------------------------------------------------------
async function ladeState() {
  try {
    const s = await ladeJson('/api/state');
    // Reload-Fix: erster Sync snapt sofort auf (x, z), danach weich interpolieren.
    FIGUR_SOFORT_SYNC = true;
    staatAnwenden(s, { sofort: true });
    for (const e of (s.feed || []).slice(0, 8).reverse()) {
      try {
        const p = JSON.parse(e.payload_json || '{}');
        const text = (p.notizen && p.notizen.join(' ')) || p.thought || e.type;
        feedEintrag(e.type.startsWith('nacht') || e.type === 'nightly' ? 'traum' : 'gedanke', String(text).slice(0, 200), e.created_at, p.quelle || null);
      } catch { /* ein Eintrag darf nie alles kaputt machen */ }
    }
  } catch (err) {
    fehlerBanner('State konnte nicht geladen werden: ' + err.message);
  }
}

// --- Block 3: Live-Updates (SSE + State-Refresh) -----------------------------------------
function starteLiveUpdates() {
  // Live per SSE: nur bei Tick/Feed-Aktivität (Initial-State kam per Fetch)
  try {
    const es = new EventSource('/api/stream');
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data);
        if (ev.typ === 'tick') {
          if (ev.gedanke) Z.gedanke = ev.gedanke;
          if (ev.route) figurRouteSetzen(ev.route);
          // Feed nur bei echten Ereignissen: schritt/gedanke nur wenn gesetzt
          // (unterwegs-Ticks senden bewusst leere schritt/gedanke/notizen).
          if (ev.schritt) feedEintrag('gedanke', `${ev.schritt.action}${ev.schritt.target ? ' → ' + ev.schritt.target : ''}${ev.schritt.detail ? ': ' + ev.schritt.detail : ''}`, '', ev.quelle || null);
          else if (ev.gedanke) feedEintrag('gedanke', String(ev.gedanke).slice(0, 200), '', ev.quelle || null);
          for (const n of (ev.notizen || [])) feedEintrag('', String(n).slice(0, 200), '', null);
          // Frischen State holen (Figur-Position, Werte, POIs)
          ladeJson('/api/state').then(staatAnwenden).catch(() => {});
        }
      } catch { /* kaputte SSE-Nachricht ignorieren */ }
    };
    es.onerror = () => { /* Browser verbindet selbst neu */ };
  } catch { /* ohne SSE läuft die Szene trotzdem (statisch + State) */ }
}

// --- Render-Loop (GRAFIK-FREEZE: 30 FPS, Tab-Pause, far 480) ---------------------------
let letzteZeit = performance.now() / 1000;
let letztesBild = 0;
function loop() {
  requestAnimationFrame(loop);
  // Tab versteckt: kein Rendering, keine Updates (GPU-Pause).
  if (typeof document !== 'undefined' && document.hidden) return;
  const jetzt = performance.now() / 1000;
  // 30-FPS-Cap: vollkommen fluessig fuers Diorama, halbiert die GPU-Last.
  if (jetzt - letztesBild < 1 / 30) return;
  const dt = Math.max(0.001, Math.min(0.1, jetzt - letzteZeit));
  letzteZeit = jetzt;
  letztesBild = jetzt;
  figurUpdaten(dt);
  pinsSchweben(performance.now()); // Bojen-Schweben der POI-Pins (ms-Basis)
  kameraUpdaten(dt, jetzt);
  blasePositionieren();
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

initialLaden().then(() => loop()).catch((err) => fehlerBanner(String(err.message || err)));


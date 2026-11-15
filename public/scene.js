// AIquarium · Hamburg St. Pauli — 3D-Kiez-Szene (Meilenstein 3).
// Sauberer Neubau fuer die flache Stadt: Boden (x, z in Metern, y = 0),
// OSM-Strassen als Asphaltbaender, Gruenflaechen, extrudierte Gebaeude mit
// prozeduraler Backstein-Textur, POI-Schilder, Figur, 2-Modi-Kamera (pilot/overview).
// Bezug: three.module.js liegt lokal unter ./engine/three.module.js (kein CDN).
import * as THREE from './engine/three.module.js';

const $ = (id) => document.getElementById(id);
const DEV = new URLSearchParams(location.search).has('dev') || new URLSearchParams(location.search).get('mode') === 'dev';

// --- Renderer / Szene ---------------------------------------------------------------
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e13);
scene.fog = new THREE.Fog(0x0a0e13, 320, 900);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 3000);
camera.position.set(30, 25, 40);

const hemi = new THREE.HemisphereLight(0xbdd3e6, 0x1c1a16, 0.9);
scene.add(hemi);
const sonne = new THREE.DirectionalLight(0xfff2dd, 1.6);
sonne.position.set(120, 160, 60);
scene.add(sonne);
const nachtBlau = new THREE.AmbientLight(0x24344d, 0.0);
scene.add(nachtBlau);

// --- Zustand -------------------------------------------------------------------------
const Z = {
  karte: null, staat: null, gehirn: null,
  pois: new Map(), poiSchilder: new Map(), gebaeude: new Map(),
  figur: null, gedanke: '',
  modus: 'pilot', blende: null,
  pilot: { dist: 24, theta: 0, phi: 0.19 },
  over: { dist: 260, theta: 0, phi: 1.25, ziel: new THREE.Vector3(0, 0, 0) },
};

// Hamburger Uhrzeit (Europe/Berlin): Stunde als 0..24
function hamburgStunde() {
  try {
    const fmt = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false });
    return Number(fmt.format(new Date()));
  } catch { return 12; }
}
function istNachtStunde(h) { return h < 6 || h >= 21; }

// Tag/Nacht-Licht: warm leuchtende Fenster bei Abend/Nacht, helle Stadt am Tag
function lichtAnpassen() {
  const h = hamburgStunde();
  const nacht = istNachtStunde(h);
  const daemmer = (h >= 6 && h < 9) || (h >= 17 && h < 21);
  const tagFaktor = nacht ? 0.25 : daemmer ? 0.7 : 1.0;
  sonne.intensity = 0.25 + 1.45 * tagFaktor;
  hemi.intensity = 0.25 + 0.7 * tagFaktor;
  nachtBlau.intensity = nacht ? 0.55 : 0.0;
  const warm = nacht ? 0.06 : daemmer ? 0.03 : 0.0;
  scene.background.setRGB(0.039 + warm, 0.055 + warm * 0.5, 0.075);
  scene.fog.color.copy(scene.background);
  return { stunde: h, nacht, fensterLicht: nacht ? 1.0 : daemmer ? 0.75 : 0.25 };
}
let LICHT = lichtAnpassen();
setInterval(() => { LICHT = lichtAnpassen(); }, 60000);


// --- Boden, Strassen, Parks ------------------------------------------------------------
// Ebene (x, z) in Metern, y = 0. Karte spannt ca. x -412..392, z -467..602.
function baueBoden() {
  const geo = new THREE.PlaneGeometry(1100, 1300);
  const mat = new THREE.MeshLambertMaterial({ color: 0x151a17 });
  const boden = new THREE.Mesh(geo, mat);
  boden.rotation.x = -Math.PI / 2;
  boden.position.set(0, -0.3, 60);
  scene.add(boden);
}

function linienBand(punkte, breite, farbe, y) {
  const gruppe = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: farbe });
  for (let i = 1; i < punkte.length; i += 1) {
    const [x1, z1] = punkte[i - 1];
    const [x2, z2] = punkte[i];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const geo = new THREE.PlaneGeometry(len, breite);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = -Math.atan2(dz, dx);
    m.position.set((x1 + x2) / 2, y, (z1 + z2) / 2);
    gruppe.add(m);
  }
  return gruppe;
}

function baueStrassen(strassen) {
  for (const s of strassen || []) {
    const pts = s.points || [];
    if (pts.length < 2) continue;
    const breit = s.kind === 'footway' || s.kind === 'path' ? 2.2 : 5.5;
    scene.add(linienBand(pts, breit + 1.6, 0x232a30, 0.02)); // Gehweg
    scene.add(linienBand(pts, breit, 0x101418, 0.05)); // Asphalt
  }
}

function baueParks(parks) {
  const mat = new THREE.MeshLambertMaterial({ color: 0x14301d });
  for (const p of parks || []) {
    let mesh = null;
    if (p.kreis) {
      mesh = new THREE.Mesh(new THREE.CircleGeometry(p.kreis.r, 28), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(p.kreis.x, 0.08, p.kreis.z);
    } else if (Array.isArray(p.polygon) && p.polygon.length >= 3) {
      const form = new THREE.Shape(p.polygon.map(([x, z]) => new THREE.Vector2(x, z)));
      mesh = new THREE.Mesh(new THREE.ShapeGeometry(form), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.08;
    }
    if (mesh) scene.add(mesh);
  }
}

// --- Prozedurale Kiez-Fassaden ----------------------------------------------------------
// Eine Canvas-Textur pro Höhenklasse (wird gecacht): Backstein/Altbau,
// Fenster leuchten warm je nach Tageszeit (LICHT.fensterLicht).
const texturCache = new Map();

function fassadenTextur(breiteM, hoeheM) {
  const licht = (typeof LICHT !== 'undefined' && LICHT.fensterLicht) || 0.25;
  const key = `${Math.round(hoeheM)}_${licht > 0.6 ? 'nacht' : licht > 0.4 ? 'abend' : 'tag'}`;
  if (texturCache.has(key)) return texturCache.get(key);
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  const toene = ['#6b4a3a', '#5d4033', '#715039', '#635046'];
  g.fillStyle = toene[Math.floor(Math.random() * toene.length)];
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = 'rgba(0,0,0,.12)';
  for (let y = 0; y < 128; y += 6) g.fillRect(0, y, 128, 1); // Ziegelreihen
  // Fenster: 4 x 3 Raster, warmes Licht je nach Tageszeit
  for (let fx = 0; fx < 4; fx += 1) {
    for (let fy = 0; fy < 3; fy += 1) {
      const an = Math.random() < (0.15 + licht * 0.6);
      g.fillStyle = an ? `rgba(255,${190 + Math.floor(licht * 40)},120,${0.5 + licht * 0.5})` : 'rgba(12,18,26,.9)';
      g.fillRect(12 + fx * 28, 14 + fy * 36, 16, 22);
      g.strokeStyle = 'rgba(0,0,0,.5)';
      g.strokeRect(12 + fx * 28, 14 + fy * 36, 16, 22);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(Math.max(1, Math.round(breiteM / 14)), Math.max(1, Math.round(hoeheM / 12)));
  texturCache.set(key, tex);
  return tex;
}

function baueGebaeude(buildings) {
  // Alte Meshes raus (bei Reload)
  for (const [, m] of Z.gebaeude) { scene.remove(m); }
  Z.gebaeude.clear();
  const dachMat = new THREE.MeshLambertMaterial({ color: 0x23262b });
  const liste = (buildings || []).slice(0, 550);
  for (const b of liste) {
    const fp = b.footprint;
    if (!Array.isArray(fp) || fp.length < 3) continue;
    const h = Math.max(3, Math.min(30, Number(b.height) || 12));
    let minX = Infinity;
    let maxX = -Infinity;
    for (const [x] of fp) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    const form = new THREE.Shape(fp.map(([x, z]) => new THREE.Vector2(x, z)));
    const geo = new THREE.ExtrudeGeometry(form, { depth: h, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); // XZ-Grundriss, Höhe nach +y
    const mat = new THREE.MeshLambertMaterial({ map: fassadenTextur(maxX - minX, h) });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = h; // Extrude läuft nach Rotation nach unten → anheben
    const dach = new THREE.Mesh(new THREE.ShapeGeometry(form), dachMat);
    dach.rotation.x = -Math.PI / 2;
    dach.position.y = h + 0.05;
    const gruppe = new THREE.Group();
    gruppe.add(mesh, dach);
    gruppe.userData.gebaeudeId = b.id;
    scene.add(gruppe);
    Z.gebaeude.set(b.id, gruppe);
  }
}

// Indoor-Transparenz: genau ein Gebäude halbtransparent + warmer Glow,
// damit man die Figur drinnen sieht (Betritt oder Klick).
let glowLicht = null;
function setzeIndoorTransparenz(gebaeudeId) {
  for (const [id, gruppe] of Z.gebaeude) {
    const aktiv = id === gebaeudeId;
    for (const kind of gruppe.children) {
      if (!kind.material) continue;
      kind.material.transparent = aktiv;
      kind.material.opacity = aktiv ? 0.25 : 1.0;
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


// --- POI-Schilder --------------------------------------------------------------------------
// Bekannte POIs: Namensschild. Unbekannte: dezentes „?".
function textSprite(text, gross) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const schrift = `${gross ? '600 44px' : '500 34px'} system-ui, sans-serif`;
  g.font = schrift;
  const w = Math.ceil(g.measureText(text).width) + 36;
  c.width = w; c.height = 64;
  const g2 = c.getContext('2d');
  g2.fillStyle = 'rgba(9,13,19,.82)';
  g2.beginPath();
  g2.roundRect(0, 8, w, 48, 10);
  g2.fill();
  g2.font = schrift;
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

function bauePoiSchilder(pois) {
  for (const [, sp] of Z.poiSchilder) scene.remove(sp);
  Z.poiSchilder.clear();
  Z.pois.clear();
  for (const p of pois || []) {
    Z.pois.set(p.id, p);
    const bekannt = Number(p.discovered) === 1;
    const sp = textSprite(bekannt ? p.name : '?', bekannt);
    sp.position.set(Number(p.pos_x), 9, Number(p.pos_z));
    sp.userData.poiId = p.id;
    scene.add(sp);
    Z.poiSchilder.set(p.id, sp);
  }
}

function aktualisiereSchilder(pois) {
  for (const p of pois || []) {
    const alt = Z.pois.get(p.id);
    Z.pois.set(p.id, p);
    const wurdeBekannt = Number(p.discovered) === 1 && !(alt && Number(alt.discovered) === 1);
    if (wurdeBekannt && Z.poiSchilder.has(p.id)) {
      const sp = Z.poiSchilder.get(p.id);
      scene.remove(sp);
      const neu = textSprite(p.name, true);
      neu.position.set(Number(p.pos_x), 9, Number(p.pos_z));
      neu.userData.poiId = p.id;
      scene.add(neu);
      Z.poiSchilder.set(p.id, neu);
    }
  }
}

// --- Figur (Kiezling) -------------------------------------------------------------------------
function baueFigur() {
  const g = new THREE.Group();
  const haut = new THREE.MeshLambertMaterial({ color: 0xd9a37e });
  const jacke = new THREE.MeshLambertMaterial({ color: 0x3b5b7d });
  const hose = new THREE.MeshLambertMaterial({ color: 0x23262b });
  const kopf = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 16), haut);
  kopf.position.y = 2.05;
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
  g.position.set(-3, 0, -68);
  scene.add(g);
  Z.figur = g;
  return g;
}

// Weiche Bewegung: Figur läuft in Laufrichtung, Position wird pro Frame
// an das Server-Ziel herangeführt (kein Springen).
const FIGUR_ZIEL = new THREE.Vector3(-3, 0, -68);
let FIGUR_HEADING = 0;
function figurZielSetzen(x, z, heading) {
  FIGUR_ZIEL.set(Number(x) || 0, 0, Number(z) || 0);
  if (Number.isFinite(Number(heading))) FIGUR_HEADING = Number(heading);
}
function figurUpdaten(dt) {
  if (!Z.figur) return;
  const f = Z.figur;
  const dx = FIGUR_ZIEL.x - f.position.x;
  const dz = FIGUR_ZIEL.z - f.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist > 0.05) {
    const schritt = Math.min(dist, 1.3 * dt); // 1,3 m/s wie Engine
    f.position.x += (dx / dist) * schritt;
    f.position.z += (dz / dist) * schritt;
    f.rotation.y = Math.atan2(dx, dz); // Blick in Laufrichtung
    // leichtes Wippen beim Gehen
    f.position.y = Math.abs(Math.sin(performance.now() / 180)) * 0.05;
  } else {
    f.position.y *= 0.9;
    if (Number.isFinite(FIGUR_HEADING)) f.rotation.y = FIGUR_HEADING;
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
    // Übergangsziel: senkrecht über der Figur → Figur exakt in Bildmitte,
    // danach frei schwenkbar um (0,0,0). Start-Frame = exakte Fortsetzung.
    const f = Z.figur ? Z.figur.position : new THREE.Vector3(0, 0, 0);
    const uebergang = new THREE.Vector3(f.x, 0, f.z);
    Z.over.ziel.copy(uebergang.length() > 1 ? new THREE.Vector3(0, 0, 0) : uebergang);
    // Hinweis: Ziel wird SOFORT auf Kiez-Mitte gelegt, Pose startet exakt über der Figur.
    nachPose = { position: new THREE.Vector3(f.x, 230, f.z), lookAt: new THREE.Vector3(f.x, 0, f.z), up: new THREE.Vector3(0, 0, -1) };
    // Smootherstep-Variante: up dreht weich von +y nach -z (liegt Fotografie-Trick:
    // exakt senkrecht ginge nicht mit up=+y, daher kleiner Tilt + sanfter Roll).
    nachPose.position.x += 0.01;
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
        // Ab jetzt frei um Kiez-Mitte: Spherical aus der exakten End-Pose ableiten
        const z = new THREE.Vector3(0, 0, 0);
        Z.over.ziel.copy(z);
        const off = camera.position.clone().sub(z);
        Z.over.dist = THREE.MathUtils.clamp(off.length(), 60, 700);
        Z.over.theta = Math.atan2(off.x, off.z);
        Z.over.phi = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(off.y / off.length(), -1, 1)), 0.35, 1.45);
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
  el.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || Z.blende) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    if (Z.modus === 'pilot') {
      Z.pilot.theta -= dx * 0.005;
      // Pitch bleibt konstant (~10°): kein Hoch/Runter beim Drehen
    } else {
      Z.over.theta -= dx * 0.005;
      Z.over.phi = THREE.MathUtils.clamp(Z.over.phi + dy * 0.003, 0.35, 1.45);
    }
  });
  el.addEventListener('pointerup', () => { drag = null; });
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (Z.blende) return;
    const f = 1 + Math.sign(e.deltaY) * 0.1;
    if (Z.modus === 'pilot') {
      Z.pilot.dist = THREE.MathUtils.clamp(Z.pilot.dist * f, PILOT_MIN, PILOT_MAX + 20);
      if (Z.pilot.dist > PILOT_MAX) setzeModusButton('overview');
    } else {
      Z.over.dist = THREE.MathUtils.clamp(Z.over.dist * f, 60, 700);
      if (Z.over.dist <= 62 && e.deltaY < 0) setzeModusButton('pilot');
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

function feedEintrag(typ, text, zeit) {
  const liste = $('feed');
  if (!liste) return;
  const d = document.createElement('div');
  d.className = `eintrag ${typ}`;
  d.innerHTML = `${esc(text)}<small>${esc(zeit || '')}</small>`;
  liste.prepend(d);
  while (liste.children.length > 60) liste.lastChild.remove();
}

function staatAnwenden(s) {
  Z.staat = s;
  if (!s || !s.charakter) return;
  const ch = s.charakter;
  figurZielSetzen(ch.pos_x, ch.pos_z, ch.heading_rad);
  if (ch.inside_poi) {
    // Indoor: passendes Gebäude transparent (entdeckt + räumlich nah)
    const poi = (s.pois || []).find((p) => p.id === ch.inside_poi);
    if (poi) {
      let bestId = null;
      let bestD = 30;
      for (const [id] of Z.gebaeude) {
        const box = new THREE.Box3().setFromObject(Z.gebaeude.get(id));
        const mitte = new THREE.Vector3();
        box.getCenter(mitte);
        const d = Math.hypot(mitte.x - Number(poi.pos_x), mitte.z - Number(poi.pos_z));
        if (d < bestD) { bestD = d; bestId = id; }
      }
      setzeIndoorTransparenz(bestId);
    }
  } else {
    setzeIndoorTransparenz(null);
  }
  aktualisiereSchilder(s.pois || []);
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
    return `<h3>Tages-Schlagzeilen</h3>${tage || '<p>Noch keine – er muss erst einmal schlafen.</p>'}<h3>Hall of Fame</h3>${ruhm || '<p>Noch niemand gestorben. Gut so.</p>'}`;
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
  baueFigur();
  bindeSteuerung();
  bindeGehirn();
  if (DEV) {
    $('devBadge').classList.add('an');
    const box = document.createElement('div');
    box.className = 'devBox an';
    box.innerHTML = `<button id="devTick">dev: 1 Tick</button><button id="devNight">dev: Nightly</button>`;
    document.querySelector('.werte').appendChild(box);
    box.querySelector('#devTick').addEventListener('click', () => fetch('/api/dev/tick', { method: 'POST' }).catch(() => {}));
    box.querySelector('#devNight').addEventListener('click', () => fetch('/api/dev/nightly', { method: 'POST' }).catch(() => {}));
  }
  try {
    const karte = await ladeJson('/api/map');
    Z.karte = karte;
    baueStrassen(karte.streets);
    baueParks(karte.parks);
    baueGebaeude(karte.buildings);
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
    return;
  }
  try {
    const s = await ladeJson('/api/state');
    staatAnwenden(s);
    for (const e of (s.feed || []).slice(0, 8).reverse()) {
      try {
        const p = JSON.parse(e.payload_json || '{}');
        const text = (p.notizen && p.notizen.join(' ')) || e.type;
        feedEintrag(e.type.startsWith('nacht') || e.type === 'nightly' ? 'traum' : 'gedanke', String(text).slice(0, 200), e.created_at);
      } catch { /* ein Eintrag darf nie alles kaputt machen */ }
    }
  } catch (err) {
    fehlerBanner('State konnte nicht geladen werden: ' + err.message);
  }
  // Live per SSE: nur bei Tick/Feed-Aktivität (Initial-State kam per Fetch)
  try {
    const es = new EventSource('/api/stream');
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data);
        if (ev.typ === 'tick') {
          if (ev.gedanke) Z.gedanke = ev.gedanke;
          if (ev.schritt) feedEintrag('gedanke', `${ev.schritt.action}${ev.schritt.target ? ' → ' + ev.schritt.target : ''}${ev.schritt.detail ? ': ' + ev.schritt.detail : ''}`, '');
          for (const n of (ev.notizen || [])) feedEintrag('', String(n).slice(0, 200), '');
          // Frischen State holen (Figur-Position, Werte, POIs)
          ladeJson('/api/state').then(staatAnwenden).catch(() => {});
        }
      } catch { /* kaputte SSE-Nachricht ignorieren */ }
    };
    es.onerror = () => { /* Browser verbindet selbst neu */ };
  } catch { /* ohne SSE läuft die Szene trotzdem (statisch + State) */ }
}

// --- Render-Loop --------------------------------------------------------------------------------------------------------------
let letzteZeit = performance.now() / 1000;
function loop() {
  requestAnimationFrame(loop);
  const jetzt = performance.now() / 1000;
  const dt = Math.max(0.001, Math.min(0.1, jetzt - letzteZeit));
  letzteZeit = jetzt;
  figurUpdaten(dt);
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


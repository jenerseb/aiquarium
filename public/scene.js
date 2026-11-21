// Sauberer Neubau fuer die flache Stadt: Boden (x, z in Metern, y = 0),
// OSM-Strassen als Asphaltbaender, Gruenflaechen, extrudierte Gebaeude mit
// prozeduraler Backstein-Textur, POI-Schilder, Figur, 2-Modi-Kamera (pilot/overview).
// Bezug: three.module.js liegt lokal unter ./engine/three.module.js (kein CDN).
import * as THREE from './engine/three.module.js';
import { TEXTUR_FAKTOR, DIORAMA_FASSADEN, DIORAMA_DAECHER, dioramaFarbe } from "./engine/diorama.js";

const $ = (id) => document.getElementById(id);
const DEV = new URLSearchParams(location.search).has('dev') || new URLSearchParams(location.search).get('mode') === 'dev';
const CLAY = new URLSearchParams(location.search).get('map') === 'clay';
const _photoParam = new URLSearchParams(location.search).get('photo');
const PHOTO_OPACITY = CLAY
  ? (_photoParam !== null && _photoParam !== '' && Number.isFinite(Number(_photoParam))
    ? Math.max(0, Math.min(100, Number(_photoParam))) / 100
    : 0)
  : 1.0;
// TEST-FLAG: Gruenzeug (Parks + Baeume) im Dev-Modus oder bei ?map=clay einblenden.
const ZEIGE_GRUEN = DEV || CLAY;
// Helligkeit aller Dachgrafiken (1.0 = Original, < 1.0 = dunkler, z. B. 0.55..0.85)
const DACH_HELLIGKEIT = 0.6;
// Optionaler Uhrzeit-Override zum Testen von Auf-/Untergang (null = echte Hamburger Zeit, sonst z. B. 6.5, 13.0, 19.5, 23.0)
const ZEIT_OVERRIDE_STUNDE = null;

// --- Renderer / Szene ---------------------------------------------------------------
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
// DIORAMA_V1: warmer Miniatur-Look, leichtgewichtig (kein Postprocessing)
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
// GRAFIK-FREEZE: PixelRatio 1.5 (Retina/4K schonen). Schatten: STATISCH —
// die Schattenkarte wird einmalig nach dem Szenenbau gerendert (die Sonne
// steht fest), danach ~0 Kosten pro Frame.
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false; // manuell via needsUpdate
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e13);
scene.fog = new THREE.FogExp2(0x141e38, 0.00055); // Subtiler Horizont-Dunst; Himmel selbst hat fog: false

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 2500);
camera.position.set(30, 25, 40);
camera.updateProjectionMatrix();

const sonne = new THREE.DirectionalLight(0xfff2dd, 2.6);
sonne.position.set(120, 220, 100);
sonne.castShadow = true;
sonne.shadow.mapSize.set(2048, 2048);
sonne.shadow.bias = -0.0004;
sonne.shadow.normalBias = 1.5;
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
  pilot: { dist: 12, theta: 0, phi: -0.18 },
  // Ueberblick ueber die GROSS-Karte (x -445..915, z -277..486): Zentrum ~ (235, 105).
  over: { dist: 380, theta: 0, phi: 1.05, ziel: new THREE.Vector3(235, 0, 105) },
};

// Hamburger Uhrzeit (Europe/Berlin): Dezimalstunde 0..24 + ganze Stunde
function hamburgStundeDezimal() {
  if (typeof ZEIT_OVERRIDE_STUNDE === 'number' && Number.isFinite(ZEIT_OVERRIDE_STUNDE)) {
    return ((ZEIT_OVERRIDE_STUNDE % 24) + 24) % 24;
  }
  try {
    const fmt = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: 'numeric', minute: 'numeric', hour12: false });
    const teile = fmt.format(new Date()).split(':');
    const h = Number(teile[0]) || 0;
    const m = Number(teile[1]) || 0;
    return (h % 24) + m / 60;
  } catch { return 12; }
}
function hamburgStunde() {
  return Math.floor(hamburgStundeDezimal());
}
function istNachtStunde(h) { return h < 6 || h >= 21; }

// Sonnenbahn + stufenlose Tageszeit-Palette (Morgen-/Abendröte, Tag, Nacht)
const HIMMEL_UNIFORMS = {
  uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.35).normalize() },
  uZenithColor: { value: new THREE.Color(0x5ea4e8) },
  uHorizonColor: { value: new THREE.Color(0xc9e4f7) },
  uSunGlowColor: { value: new THREE.Color(0xfff4d6) },
  uNightFactor: { value: 0.0 },
};

function tageszeitZustand(hDez) {
  const nacht = hDez < 6.0 || hDez >= 18.3;
  let sunDir;
  if (!nacht) {
    const t = THREE.MathUtils.clamp((hDez - 6.0) / 12.3, 0, 1);
    const az = t * Math.PI; // Ost (+x) -> Süd (+z) -> West (-x)
    const el = Math.sin(t * Math.PI) * 0.90 + 0.16;
    sunDir = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
  } else {
    sunDir = new THREE.Vector3(-0.45, 0.55, 0.65).normalize(); // Mondlicht-Winkel
  }
  const keys = [
    { h: 0.0,  zen: 0x040712, hor: 0x0c1428, glow: 0x0c1428, sun: 0x7aa2d8, sInt: 0.22, hInt: 0.18, night: 1.0, win: 1.0 },
    { h: 5.8,  zen: 0x050918, hor: 0x101a34, glow: 0x262442, sun: 0x859ad0, sInt: 0.30, hInt: 0.24, night: 0.9, win: 1.0 },
    { h: 6.8,  zen: 0x3b5894, hor: 0xe88d67, glow: 0xff9b4a, sun: 0xffaa66, sInt: 1.70, hInt: 1.05, night: 0.15, win: 0.55 },
    { h: 8.2,  zen: 0x5ea4e8, hor: 0xc9e4f7, glow: 0xfff4d6, sun: 0xfff2dd, sInt: 2.55, hInt: 1.38, night: 0.0, win: 0.05 },
    { h: 16.0, zen: 0x5ea4e8, hor: 0xd4e6f5, glow: 0xffe8ba, sun: 0xfff0d4, sInt: 2.45, hInt: 1.35, night: 0.0, win: 0.1 },
    { h: 17.2, zen: 0x2c3c75, hor: 0xe0684b, glow: 0xff6b35, sun: 0xff8d52, sInt: 1.65, hInt: 1.00, night: 0.25, win: 0.85 },
    { h: 18.3, zen: 0x060b1c, hor: 0x101933, glow: 0x101933, sun: 0x7aa2d8, sInt: 0.28, hInt: 0.22, night: 0.95, win: 1.0 },
    { h: 24.0, zen: 0x040712, hor: 0x0c1428, glow: 0x0c1428, sun: 0x7aa2d8, sInt: 0.22, hInt: 0.18, night: 1.0, win: 1.0 },
  ];
  let a = keys[0];
  let b = keys[keys.length - 1];
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (hDez >= keys[i].h && hDez <= keys[i + 1].h) { a = keys[i]; b = keys[i + 1]; break; }
  }
  const f = (b.h === a.h) ? 0 : (hDez - a.h) / (b.h - a.h);
  const mixC = (c1, c2) => new THREE.Color(c1).lerp(new THREE.Color(c2), f);
  return {
    sunDir,
    zenith: mixC(a.zen, b.zen),
    horizon: mixC(a.hor, b.hor),
    glow: mixC(a.glow, b.glow),
    sunColor: mixC(a.sun, b.sun),
    sunInt: THREE.MathUtils.lerp(a.sInt, b.sInt, f),
    hemiInt: THREE.MathUtils.lerp(a.hInt, b.hInt, f),
    nightFactor: THREE.MathUtils.lerp(a.night, b.night, f),
    fensterLicht: THREE.MathUtils.lerp(a.win, b.win, f),
    nacht: nacht || THREE.MathUtils.lerp(a.night, b.night, f) > 0.55,
  };
}

// Tag/Nacht-Licht + Sonnenbogen (1x pro Minute Schatten neu berechnen = ~0 Frame-Kosten)
let letzteFensterStufe = -1;
function lichtAnpassen() {
  const hDez = hamburgStundeDezimal();
  const h = Math.floor(hDez);
  const st = tageszeitZustand(hDez);
  sonne.position.set(DIORAMA.cx + st.sunDir.x * 260, st.sunDir.y * 260, DIORAMA.cz + st.sunDir.z * 260);
  sonne.intensity = st.sunInt;
  sonne.color.copy(st.sunColor);
  hemi.intensity = st.hemiInt;
  umgebung.intensity = THREE.MathUtils.lerp(0.45, 0.06, st.nightFactor);
  nachtBlau.intensity = st.nightFactor * 0.12;
  if (typeof DIORAMA_LIGHT_UNIFORMS !== 'undefined') {
    DIORAMA_LIGHT_UNIFORMS.uDioramaCenter.value.set(DIORAMA.cx, DIORAMA.cz);
    DIORAMA_LIGHT_UNIFORMS.uDioramaRadius.value = DIORAMA.r;
    DIORAMA_LIGHT_UNIFORMS.uNightLight.value = st.fensterLicht > 0.35 ? st.fensterLicht : 0.0;
  }
  HIMMEL_UNIFORMS.uSunDir.value.copy(st.sunDir);
  HIMMEL_UNIFORMS.uZenithColor.value.copy(st.zenith);
  HIMMEL_UNIFORMS.uHorizonColor.value.copy(st.horizon);
  HIMMEL_UNIFORMS.uSunGlowColor.value.copy(st.glow);
  HIMMEL_UNIFORMS.uNightFactor.value = st.nightFactor;
  scene.background.copy(st.horizon).multiplyScalar(0.35);
  if (scene.fog) scene.fog.color.copy(st.horizon);
  const fensterStufe = st.fensterLicht > 0.5 ? 1 : 0;
  if (fensterStufe !== letzteFensterStufe) {
    letzteFensterStufe = fensterStufe;
    if (typeof fassadenKachelAktualisieren === 'function') fassadenKachelAktualisieren(st.fensterLicht);
  }
  for (const [, halo] of (Z.poiHalos || [])) {
    halo.visible = st.fensterLicht > 0.45;
    if (halo.material) halo.material.opacity = st.fensterLicht * 0.65;
  }
  if (typeof lodWandMat !== 'undefined' && lodWandMat) {
    lodWandMat.emissiveIntensity = st.fensterLicht > 0.35 ? st.fensterLicht * 1.55 : 0.0;
  }
  if (typeof laternenKegel !== 'undefined' && laternenKegel) {
    const an = st.fensterLicht > 0.35;
    laternenKegel.visible = an;
    laternenKegel.material.opacity = st.fensterLicht * 0.67;
    if (laternenKoepfe) laternenKoepfe.material.color.setHex(an ? 0xfff0d4 : 0x777d87);
  }
  renderer.shadowMap.needsUpdate = true;
  return { stunde: h, nacht: st.nacht, fensterLicht: st.fensterLicht };
}
let LICHT = null;
setInterval(() => { LICHT = lichtAnpassen(); himmelAktualisieren(); }, 60000);

// --- DIORAMA_V1: Stufenlose Morgen-/Abendröte-Skybox (ShaderMaterial, 1 Draw Call) ---
let himmelMesh = null;
function himmelAktualisieren() {
  return LICHT;
}
function baueHimmel() {
  const geo = new THREE.SphereGeometry(2000, 24, 16);
  const mat = new THREE.ShaderMaterial({
    uniforms: HIMMEL_UNIFORMS,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
    vertexShader: `
      varying vec3 vWorldDir;
      void main() {
        vWorldDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir;
      uniform vec3 uZenithColor;
      uniform vec3 uHorizonColor;
      uniform vec3 uSunGlowColor;
      uniform float uNightFactor;
      varying vec3 vWorldDir;
      float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      void main() {
        vec3 dir = normalize(vWorldDir);
        float h = clamp(dir.y, 0.0, 1.0);
        vec3 sky = mix(uHorizonColor, uZenithColor, pow(h, 0.55));
        float sunAmt = max(dot(dir, normalize(uSunDir)), 0.0);
        float tagGlow = 1.0 - smoothstep(0.3, 0.85, uNightFactor);
        sky += uSunGlowColor * pow(sunAmt, 5.0) * 0.55 * tagGlow;
        sky += vec3(1.0, 0.96, 0.85) * smoothstep(0.9986, 0.9996, sunAmt) * tagGlow;
        if (uNightFactor > 0.05 && h > 0.15) {
          float s = hash(floor(dir * 260.0));
          if (s > 0.9965) sky += vec3(0.85, 0.9, 1.0) * uNightFactor * 0.85;
        }
        gl_FragColor = vec4(sky, 1.0);
      }
    `,
  });
  himmelMesh = new THREE.Mesh(geo, mat);
  himmelMesh.position.set(235, 0, 105);
  himmelMesh.renderOrder = -10;
  scene.add(himmelMesh);
}

// --- DIORAMA_V1: Diorama-Wolken (flache Ellipsoid-Gruppen, langsam driftend) ---
const wolken = [];
function baueWolken() {
  const mat = new THREE.MeshLambertMaterial({ color: 0xfff6ea, transparent: true, opacity: 0.85, fog: true });
  const schichten = [
    { anzahl: 12, yMin: 85, ySpan: 30, skala: 1.0, tempoBase: 0.5, tempoStep: 0.25 },
    { anzahl: 12, yMin: 170, ySpan: 50, skala: 1.25, tempoBase: 0.35, tempoStep: 0.2 },
  ];
  for (let sIdx = 0; sIdx < schichten.length; sIdx += 1) {
    const s = schichten[sIdx];
    for (let i = 0; i < s.anzahl; i += 1) {
      const gruppe = new THREE.Group();
      const teile = 4 + ((i + sIdx) % 2);
      for (let j = 0; j < teile; j += 1) {
        const rx = (9 + (((i + sIdx * 3) * 7 + j * 5) % 9)) * s.skala;
        const ry = (4 + ((i * 3 + j * 2) % 3)) * s.skala;
        const rz = (6 + ((i * 5 + j * 3) % 6)) * s.skala;
        const geo = new THREE.SphereGeometry(1, 12, 10);
        const m = new THREE.Mesh(geo, mat);
        m.scale.set(rx, 0.45 * ry, rz);
        m.position.set(j * 9 * s.skala - teile * 4.2 * s.skala, 0.45 * ry * 0.4, (((i + j) % 3) - 1) * 5 * s.skala);
        gruppe.add(m);
      }
      gruppe.position.set(
        -350 + (((i + sIdx * 5) * 173) % 1100),
        s.yMin + ((i * 37) % s.ySpan),
        -250 + (((i + sIdx * 4) * 211) % 750)
      );
      gruppe.userData.tempo = s.tempoBase + (i % 4) * s.tempoStep;
      scene.add(gruppe);
      wolken.push(gruppe);
    }
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
  let r = maxD + 160; // +160 (90 + 70): Map gross genug, alle POIs mit Puffer drin
  DIORAMA.cx = Math.round(cx * 10) / 10;
  DIORAMA.cz = Math.round(cz * 10) / 10;
  DIORAMA.r = Math.round(Math.min(760, Math.max(400, r)));
  return { ...DIORAMA };
}
const DIORAMA_LIGHT_UNIFORMS = {
  uDioramaCenter: { value: new THREE.Vector2(DIORAMA.cx, DIORAMA.cz) },
  uDioramaRadius: { value: DIORAMA.r },
  uLightMap: { value: null },
  uHasLightMap: { value: 0.0 },
  uNightLight: { value: 0.0 },
  uAktivGebIdx: { value: 0.0 },
};

function dioramaShader(mat, opts) {
  const fensterRandom = Boolean(opts && opts.fensterRandom);
  const gebIdxAttr = Boolean(opts && opts.gebIdxAttr);
  // Rasiermesserscharfer Kreisschnitt + Laternen-Lightmap + zufällige Fensterfarben + Indoor-0.66.
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDioramaCenter = DIORAMA_LIGHT_UNIFORMS.uDioramaCenter;
    shader.uniforms.uDioramaRadius = DIORAMA_LIGHT_UNIFORMS.uDioramaRadius;
    shader.uniforms.uLightMap = DIORAMA_LIGHT_UNIFORMS.uLightMap;
    shader.uniforms.uHasLightMap = DIORAMA_LIGHT_UNIFORMS.uHasLightMap;
    shader.uniforms.uNightLight = DIORAMA_LIGHT_UNIFORMS.uNightLight;
    shader.uniforms.uAktivGebIdx = DIORAMA_LIGHT_UNIFORMS.uAktivGebIdx;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorldPos;${gebIdxAttr ? '\nattribute float aGebIdx;\nvarying float vGebIdx;' : ''}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;${gebIdxAttr ? '\nvGebIdx = aGebIdx;' : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorldPos;\nuniform vec2 uDioramaCenter;\nuniform float uDioramaRadius;\nuniform sampler2D uLightMap;\nuniform float uHasLightMap;\nuniform float uNightLight;${gebIdxAttr ? '\nvarying float vGebIdx;\nuniform float uAktivGebIdx;' : ''}`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (length(vWorldPos.xz - uDioramaCenter) > uDioramaRadius) discard;')
      .replace(
        '#include <dithering_fragment>',
        `if (uHasLightMap > 0.5 && uNightLight > 0.01) {
          vec2 lmUv = vec2(
            (vWorldPos.x - (uDioramaCenter.x - uDioramaRadius)) / (2.0 * uDioramaRadius),
            1.0 - (vWorldPos.z - (uDioramaCenter.y - uDioramaRadius)) / (2.0 * uDioramaRadius)
          );
          float hFade = 1.0 - smoothstep(0.0, 9.0, vWorldPos.y);
          vec3 lm = texture2D(uLightMap, lmUv).rgb;
          gl_FragColor.rgb += lm * uNightLight * hFade * (diffuseColor.rgb * 2.05 + vec3(0.09, 0.085, 0.065));
        }${gebIdxAttr ? '\n        if (uAktivGebIdx > 0.5 && abs(vGebIdx - uAktivGebIdx) < 0.4) gl_FragColor.a *= 0.66;' : ''}
        #include <dithering_fragment>`
      );
    if (fensterRandom) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec2 wCell = floor(vec2((vWorldPos.x - vWorldPos.z) / 1.3125, vWorldPos.y / 2.625));
        float wRnd = fract(sin(dot(wCell, vec2(12.9898, 78.233))) * 43758.5453);
        float wColRnd = fract(sin(dot(wCell, vec2(39.346, 11.135))) * 24634.6345);
        float wBriRnd = fract(sin(dot(wCell, vec2(71.137, 29.531))) * 19432.1731);
        vec3 winCol = mix(vec3(1.0, 0.97, 0.90), vec3(1.0, 0.62, 0.22), wColRnd);
        totalEmissiveRadiance *= winCol * mix(0.45, 1.35, wBriRnd);
        if (wRnd < 0.90) totalEmissiveRadiance = vec3(0.0);`
      );
    }
  };
  mat.customProgramCacheKey = () => `diorama-kreis-lm-${fensterRandom ? 'f' : '0'}-${gebIdxAttr ? 'g' : '0'}`;
  return mat;
}
// --- Boden, Strassen, Parks ------------------------------------------------------------
// Ebene (x, z) in Metern, y = 0. Runde Diorama-Insel statt Rechteckplatte.
let bodenGruppe = null; // idempotenter Boden (Sockel + Luftbild), siehe baueBoden()
function baueBoden() {
  // Idempotent: ladeKarte() baut den Boden nach dem Diorama-Update neu –
  // die alte Gruppe (Sockel + Luftbild) wird sauber entfernt.
  if (bodenGruppe) {
    scene.remove(bodenGruppe);
    bodenGruppe.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      // Material kann ein ARRAY sein (Zylinder: [seite, oben, seite]) –
      // o.material.dispose() auf das Array wuerde crashen (Fix: weisser Boden).
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m) m.dispose();
    });
    bodenGruppe = null;
  }
  const gruppe = new THREE.Group();
  // 3D-Sockel: bei ?map=clay mit grüner Oberseite (ohne Luftbild), sonst nur Seiten-Mantel + Luftbild
  const geo = new THREE.CylinderGeometry(DIORAMA.r, DIORAMA.r * 0.96, 16, 128, 1, !CLAY);
  const seite = new THREE.MeshLambertMaterial({ color: 0x2b2d30 });
  const bodenMat = CLAY ? [seite, new THREE.MeshLambertMaterial({ color: 0x6f7d4e }), seite] : seite;
  const boden = new THREE.Mesh(geo, bodenMat);
  if (CLAY) boden.receiveShadow = true;
  boden.position.set(DIORAMA.cx, -8, DIORAMA.cz);
  gruppe.add(boden);
  // Modellbau-Zierring am äußeren Diorama-Rand
  const randGeo = new THREE.RingGeometry(DIORAMA.r * 0.99, DIORAMA.r * 1.006, 128);
  randGeo.rotateX(-Math.PI / 2);
  const randMesh = new THREE.Mesh(randGeo, new THREE.MeshBasicMaterial({ color: 0x3b424c }));
  randMesh.position.set(DIORAMA.cx, 0.012, DIORAMA.cz);
  gruppe.add(randMesh);
  // DIORAMA_V1: optionales Luftbild-Overlay (/kiez-aerial.jpg in public/), bei ?map=clay standardmäßig 0 (% via ?photo=0..100)
  if (PHOTO_OPACITY > 0) new THREE.TextureLoader().load("/kiez-aerial.jpg",
    (tex) => {
      // Stale-Guard: wenn der Boden inzwischen neu gebaut wurde (ladeKarte()),
      // darf das Bild NICHT mehr in die entfernte Gruppe gehaengt werden.
      if (bodenGruppe !== gruppe) return;
      tex.colorSpace = THREE.SRGBColorSpace;
      // Schärfe bei flachem Kamerawinkel: maximale Anisotropie der GPU nutzen
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const luftGeo = new THREE.CircleGeometry(DIORAMA.r * 0.99, 96);
      luftGeo.rotateX(-Math.PI / 2);
      const voll = PHOTO_OPACITY >= 1;
      const luft = new THREE.Mesh(luftGeo, dioramaShader(new THREE.MeshLambertMaterial({
        map: tex, transparent: !voll, opacity: PHOTO_OPACITY, depthWrite: voll,
      })));
      luft.receiveShadow = true; // Gebaeude-Schatten auf dem Luftbild
      luft.position.set(DIORAMA.cx, 0.005, DIORAMA.cz);
      gruppe.add(luft);
      // Dächer mit dem Luftbild texturieren (LoD2), sobald es da ist.
      try { baueDachLuftbild(tex); } catch (err) { console.warn('[luftbild] dächer:', err.message); }
    },
    undefined,
    () => { /* kein Luftbild -> prozeduraler Boden bleibt */ }
  );
  scene.add(gruppe);
  bodenGruppe = gruppe;
}
function linienBand(punkte, breite, farbe, y) {
  // Flache Baender direkt in Welt-Metern: Mittelpunkt aus (x, z), keine
  // Vorzeichen-Flips. Geometrie wird EINMALIG per geo.rotateX(-PI/2) in die
  // XZ-Ebene gelegt, Ausrichtung danach nur noch per rotation.y (kein
  // Euler-Mix aus rotation.x + rotation.z, der je nach Euler-Reihenfolge
  // spiegelt/verdreht). Diorama: Kreisschnitt per Shader (kein Rechteck-Überstand).
  const gruppe = new THREE.Group();
  const mat = dioramaShader(new THREE.MeshLambertMaterial({ color: farbe }));
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
    m.receiveShadow = true; // Gebaeude-Schatten fallen auf Strassen/Gehwege
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
    // 2026-11-17 BALANCE: Wege schmaler (frueher 3.4/5.5 + 1.6 Gehweg-Rand),
    // damit Gassen nicht wie Autobahnen wirken.
    const breit = neben ? 1.2 : 4.2;
    // Klare Y-Staffelung: Grüner Boden 0.0 < Parks 0.02 < Wege 0.05 < Gehweg-Rand 0.07 < Straßen-Asphalt 0.10.
    if (neben) {
      scene.add(linienBand(pts, breit, 0x9a9186, 0.05)); // einfacher Pflaster-Strich (halb so breit)
    } else {
      scene.add(linienBand(pts, breit + 0.8, 0x8a7a63, 0.07)); // sandiger Gehweg-Rand
      scene.add(linienBand(pts, breit, 0x3a3f45, 0.10));       // Asphalt über Wegen
    }
  }
}

function baueParks(parks) {
  // 2026-11-19: Parks am Diorama-Kreis clippen (davor standen sie über die Kante).
  const mat = dioramaShader(new THREE.MeshLambertMaterial({ color: 0x4d7a3f })); // warmes Wiesengruen
  for (const p of parks || []) {
    let mesh = null;
    if (p.kreis) {
      const gk = new THREE.CircleGeometry(p.kreis.r, 28);
      gk.rotateX(-Math.PI / 2);
      mesh = new THREE.Mesh(gk, mat);
      mesh.position.set(p.kreis.x, 0.02, p.kreis.z);
    } else if (Array.isArray(p.polygon) && p.polygon.length >= 3) {
      const form = new THREE.Shape(p.polygon.map(([x, z]) => new THREE.Vector2(x, -z)));
      const gp = new THREE.ShapeGeometry(form);
      gp.rotateX(-Math.PI / 2);
      mesh = new THREE.Mesh(gp, mat);
      mesh.position.set(0, 0.02, 0);
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
      const mat = new THREE.MeshLambertMaterial({ map: fassadenTextur(maxX - minX, h, fassFarbe), ...(DEV ? { transparent: true, opacity: 0.66 } : {}) });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(0, 0, 0); // exakt auf dem Boden, kein Schweben
      const dachFarbe = b.roofColour || "#343942"; // DIORAMA_V1-Fix: direkt Schiefer, ohne Hash-Funktion
      const dachMatBau = new THREE.MeshLambertMaterial({ color: new THREE.Color(dachFarbe).multiplyScalar(DACH_HELLIGKEIT), ...(DEV ? { transparent: true, opacity: 0.66 } : {}) });
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
// --- Miniatur-Fassaden-Kachel (cute Stil: Backstein + Fenster, kein Fotorealismus)
const FASSADE_KACHEL = 2.625; // 1 Kachel = 1 Etage (3,5 m * 0.75 Diorama-Skala)
let fassKachel = null;
let fassKachelCanvas = null;
let fassBump = null;
let fassEmissive = null;
let lodWandMat = null;
function fassadenKachelZeichnen(lichtFaktor) {
  if (!fassKachelCanvas) {
    fassKachelCanvas = document.createElement('canvas');
    fassKachelCanvas.width = 128;
    fassKachelCanvas.height = 128;
  }
  const c = fassKachelCanvas;
  const g = c.getContext('2d');
  // Grundmauer hell — die warme Vertex-Farbe der Wand tintet die Kachel.
  g.fillStyle = '#f4efe7';
  g.fillRect(0, 0, 128, 128);
  // Backstein-Reihen mit versetzten Fugen
  g.strokeStyle = 'rgba(70,40,30,0.18)';
  g.lineWidth = 2;
  for (let y = 0; y <= 128; y += 16) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(128, y + 0.5); g.stroke(); }
  for (let row = 0; row < 8; row += 1) {
    const off = (row % 2) * 16;
    for (let x = off; x <= 128; x += 32) {
      g.beginPath(); g.moveTo(x + 0.5, row * 16); g.lineTo(x + 0.5, (row + 1) * 16); g.stroke();
    }
  }
  const fenster = (x, y) => {
    g.fillStyle = '#e8e2d6';
    g.fillRect(x - 3, y - 3, 46, 56); // Rahmen
    g.fillStyle = '#33404f';
    g.fillRect(x, y, 40, 50);         // Glas (Leuchten übernimmt emissiveMap + Shader-Hash)
    g.fillStyle = '#dfe7f0';
    g.fillRect(x + 17, y, 6, 50);     // Mittel-Sprosse
    g.fillRect(x, y + 22, 40, 5);     // Quer-Sprosse
  };
  void lichtFaktor;
  fenster(14, 36);
  fenster(78, 36);
}
function fassadenKachelAktualisieren(lichtFaktor) {
  if (!fassKachel) return;
  fassadenKachelZeichnen(lichtFaktor);
  fassKachel.needsUpdate = true;
}
function fassadenKachel() {
  if (fassKachel) return fassKachel;
  fassadenKachelZeichnen(LICHT ? LICHT.fensterLicht : 0.2);
  const tex = new THREE.CanvasTexture(fassKachelCanvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  fassKachel = tex;
  return tex;
}
function fassadenBump() {
  if (fassBump) return fassBump;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#c8c8c8';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#707070';
  g.lineWidth = 2;
  for (let y = 0; y <= 128; y += 16) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(128, y + 0.5); g.stroke(); }
  for (const x of [14, 78]) {
    g.fillStyle = '#ececec'; g.fillRect(x - 3, 33, 46, 56);
    g.fillStyle = '#404040'; g.fillRect(x, 36, 40, 50);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  fassBump = tex;
  return tex;
}
function fassadenEmissive() {
  if (fassEmissive) return fassEmissive;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#000000';
  g.fillRect(0, 0, 128, 128);
  // Beide Fensterscheiben weiß in der Maske; Shader-Hash schaltet zufällig nur ~18 % an
  for (const fx of [14, 78]) {
    g.fillStyle = '#ffffff';
    g.fillRect(fx, 36, 40, 50);
    g.fillStyle = '#000000';
    g.fillRect(fx + 17, 36, 6, 50);
    g.fillRect(fx, 58, 40, 5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  fassEmissive = tex;
  return tex;
}

// --- Dächer mit dem Luftbild texturieren (UV = georeferenzierte Position) ---
let dachLuftMesh = null;
let luftTex = null;
function baueDachLuftbild(tex) {
  if (PHOTO_OPACITY <= 0) return;
  luftTex = tex;
  if (dachLuftMesh) {
    scene.remove(dachLuftMesh);
    dachLuftMesh.geometry.dispose();
    dachLuftMesh.material.dispose();
    dachLuftMesh = null;
  }
  const lod = (Z.karte && Z.karte.lod2) || [];
  const gruppe = Z.gebaeude.get('__lod2_walls');
  if (!gruppe || !lod.length) return; // noch keine Gebaeude / kein LoD2-Modus
  const posArr = [];
  const uvArr = [];
  const gebIdxArr = [];
  const span = 2 * DIORAMA.r;
  for (let i = 0; i < lod.length; i += 1) {
    const b = lod[i];
    const idx = b._idx || (i + 1);
    for (const tri of b.roofTriangles || []) {
      for (const p of tri) {
        posArr.push(p[0], p[1] * LOD_SKALA, p[2]);
        uvArr.push((p[0] - (DIORAMA.cx - DIORAMA.r)) / span, ((DIORAMA.cz + DIORAMA.r) - p[2]) / span);
        gebIdxArr.push(idx);
      }
    }
  }
  if (!posArr.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));
  geo.setAttribute('aGebIdx', new THREE.Float32BufferAttribute(gebIdxArr, 1));
  geo.computeVertexNormals();
  const dachTint = new THREE.Color().setScalar(DACH_HELLIGKEIT);
  const voll = PHOTO_OPACITY >= 1;
  dachLuftMesh = new THREE.Mesh(geo, dioramaShader(new THREE.MeshLambertMaterial({
    map: tex, color: dachTint, transparent: true,
    opacity: DEV ? Math.min(0.66, PHOTO_OPACITY) : PHOTO_OPACITY,
    depthWrite: voll,
    ...(!voll ? { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 } : {}),
  }), { gebIdxAttr: true }));
  dachLuftMesh.castShadow = voll;
  dachLuftMesh.receiveShadow = true;
  scene.add(dachLuftMesh);
  // farbige Dächer nur bei 100 % Luftbild entfernen (bei Teil-Transparenz bleiben sie als Untergrund)
  const daecherAlt = gruppe.userData.daecher;
  if (voll && daecherAlt) {
    gruppe.remove(daecherAlt);
    daecherAlt.geometry.dispose();
    daecherAlt.material.dispose();
    gruppe.userData.daecher = null;
  }
  renderer.shadowMap.needsUpdate = true; // Schattenkarte mit neuen Dächern frisch
  console.log(`[lod2] dächer mit luftbild texturiert: ${Math.round(posArr.length / 9)} dreiecke`);
}

function baueLoD2(lod) {
  if (Z.karte) Z.karte.lod2 = lod;
  for (const [, m] of Z.gebaeude) { scene.remove(m); }
  Z.gebaeude.clear();
  if (lodHighlight) { scene.remove(lodHighlight); lodHighlight = null; }
  if (dachLuftMesh) { scene.remove(dachLuftMesh); dachLuftMesh.geometry.dispose(); dachLuftMesh.material.dispose(); dachLuftMesh = null; }
  const wandPos = [];
  const wandCol = [];
  const wandUV = [];
  const wandGebIdx = [];
  const dachPos = [];
  const dachCol = [];
  const dachGebIdx = [];
  const tmpFarbe = new THREE.Color();
  // Pro Gebäude: Dreiecke einsammeln (y bereits ab 0, Skala 0.75 anwenden).
  for (let i = 0; i < lod.length; i += 1) {
    const b = lod[i];
    const idx = i + 1;
    b._idx = idx;
    tmpFarbe.setHex(lodWandfarbe(b.id));
    const wr = 0.92 + ((String(b.id).length * 7) % 12) / 100;
    for (const tri of b.wallTriangles || []) {
      for (const p of tri) {
        const wy = p[1] * LOD_SKALA;
        const ao = 0.58 + 0.42 * THREE.MathUtils.smoothstep(p[1], 0, 3.5); // Fake-AO am Gebäudefuß
        wandPos.push(p[0], wy, p[2]);
        // Miniatur-UVs aus Weltposition: 1 Kachel = 1 Etage (3,5 m * 0.75),
        // u diagonal (x - z) damit alle Wandrichtungen ohne Face-Info kacheln.
        wandUV.push((p[0] - p[2]) / FASSADE_KACHEL, wy / FASSADE_KACHEL);
        wandCol.push(tmpFarbe.r * wr * ao, tmpFarbe.g * wr * ao, tmpFarbe.b * wr * ao);
        wandGebIdx.push(idx);
      }
    }
    tmpFarbe.setHex(LOD_DACHFARBEN.flachdach).lerp(new THREE.Color(lodDachfarbe(b)), 0.85).multiplyScalar(DACH_HELLIGKEIT);
    for (const tri of b.roofTriangles || []) {
      for (const p of tri) {
        dachPos.push(p[0], p[1] * LOD_SKALA, p[2]);
        dachCol.push(tmpFarbe.r, tmpFarbe.g, tmpFarbe.b);
        dachGebIdx.push(idx);
      }
    }
  }
  function meshAus(posArr, colArr, uvArr, gebIdxArr) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
    geo.setAttribute('aGebIdx', new THREE.Float32BufferAttribute(gebIdxArr, 1));
    if (uvArr) geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));
    geo.computeVertexNormals();
    const mat = dioramaShader(new THREE.MeshLambertMaterial({
      vertexColors: true,
      map: uvArr ? fassadenKachel() : null,
      ...(uvArr ? {
        bumpMap: fassadenBump(), bumpScale: 0.18,
        emissive: new THREE.Color(0xffffff),
        emissiveMap: fassadenEmissive(),
        emissiveIntensity: (LICHT && LICHT.fensterLicht > 0.35) ? LICHT.fensterLicht * 1.55 : 0.0,
      } : {}),
      transparent: true,
      opacity: DEV ? 0.66 : 1.0,
      depthWrite: true,
    }), { fensterRandom: Boolean(uvArr), gebIdxAttr: true });
    if (uvArr) lodWandMat = mat;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(0, 0, 0);
    return mesh;
  }
  const waende = meshAus(wandPos, wandCol, wandUV, wandGebIdx);
  const daecher = meshAus(dachPos, dachCol, null, dachGebIdx);
  const gruppe = new THREE.Group();
  gruppe.add(waende, daecher);
  gruppe.userData.daecher = daecher; // Referenz fuer den Luftbild-Tausch
  if (luftTex) { try { baueDachLuftbild(luftTex); } catch { /* egal */ } }
  gruppe.userData.lod2 = true;
  scene.add(gruppe);
  Z.gebaeude.set('__lod2_walls', gruppe);
  console.log(`[lod2] ${lod.length} gebäude gemergt: ${Math.round(wandPos.length / 9)} wand- + ${Math.round(dachPos.length / 9)} dach-dreiecke, 2 draw calls`);
}

// LoD2-Highlight: Betretenes Gebäude auf opacity 0.66 im Hauptmesh + 3D-Overlay (Wände & Dach)
// in Hellgelb pulsierend bei opacity 0.25.
function setzeLoD2Highlight(gebId) {
  if (lodHighlight) { scene.remove(lodHighlight); lodHighlight.geometry.dispose(); lodHighlight.material.dispose(); lodHighlight = null; }
  if (glowLicht) { scene.remove(glowLicht); glowLicht = null; }
  DIORAMA_LIGHT_UNIFORMS.uAktivGebIdx.value = 0.0;
  if (!gebId) return;
  const lod = (Z.karte && Z.karte.lod2) || [];
  const b = lod.find((g) => g.id === gebId);
  if (!b) return;
  DIORAMA_LIGHT_UNIFORMS.uAktivGebIdx.value = b._idx || 0.0;
  const posArr = [];
  for (const tri of (b.wallTriangles || []).concat(b.roofTriangles || [])) {
    for (const p of tri) posArr.push(p[0], p[1] * LOD_SKALA, p[2]);
  }
  if (!posArr.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  geo.computeVertexNormals();
  const hellgelb = 0xffe866;
  const mat = new THREE.MeshLambertMaterial({
    color: hellgelb, transparent: true, opacity: 0.25,
    emissive: hellgelb, emissiveIntensity: 0.35,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    depthWrite: false,
  });
  lodHighlight = new THREE.Mesh(geo, mat);
  lodHighlight.position.set(0, 0, 0);
  scene.add(lodHighlight);
}

// Puls: betretenes Haus (Wände + Dach) pulsiert sanft in Hellgelb. Wird aus loop() aufgerufen.
function highlightPulsen(ms) {
  const p = 0.5 + 0.5 * Math.sin(ms / 650);
  const st = 0.25 + 0.70 * p;
  if (lodHighlight && lodHighlight.material) lodHighlight.material.emissiveIntensity = st;
  for (const m of indoorPuls) m.emissiveIntensity = st;
}

// Indoor-Transparenz (Extrusions-Modus): genau EIN Einzelhaus halbtransparent (0.66) + hellgelb pulsierend.
let glowLicht = null;
let indoorPuls = [];
function setzeIndoorTransparenz(gebaeudeId) {
  indoorPuls = [];
  // LoD2-Modus: gemergtes Mesh bleibt, Gebäude selbst 0.66 + Hellgelb-Overlay (0.25) pulsiert.
  if (Z.gebaeude.has('__lod2_walls')) {
    if (!gebaeudeId) setzeLoD2Highlight(null);
    else setzeLoD2Highlight(gebaeudeId);
    return;
  }
  for (const [id, gruppe] of Z.gebaeude) {
    const aktiv = id === gebaeudeId;
    for (const kind of gruppe.children) {
      if (!kind.material) continue;
      kind.material.transparent = DEV || aktiv;
      kind.material.opacity = aktiv ? 0.66 : (DEV ? 0.66 : 1.0);
      kind.material.needsUpdate = false;
      if (kind.material.emissive) {
        kind.material.emissive.setHex(0xffe866);
        kind.material.emissiveIntensity = 0;
        if (aktiv) indoorPuls.push(kind.material);
      }
    }
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
  const mat = new THREE.MeshBasicMaterial({ color: farbe, transparent: true, opacity: deckkraft, depthTest: false, depthWrite: false });
  const kegel = new THREE.Mesh(new THREE.ConeGeometry(1.4, 3.2, 12), mat);
  kegel.rotation.x = Math.PI; // Spitze nach unten
  kegel.renderOrder = 20;
  gruppe.add(kegel);
  const stange = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1, 8), mat);
  stange.position.y = 2.2;
  stange.renderOrder = 20;
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
  // Markante, dicke senkrechte Säule bis zum Boden (y = 0) – immer vor Häusern sichtbar
  const linienGeo = new THREE.CylinderGeometry(0.24, 0.24, hoehe, 8);
  const linienFarbe = bekannt ? 0xffa800 : 0x6ea8ff;
  const linie = new THREE.Mesh(linienGeo, new THREE.MeshBasicMaterial({ color: linienFarbe, transparent: true, opacity: bekannt ? 1.0 : 0.8, depthTest: false, depthWrite: false }));
  linie.position.y = hoehe / 2;
  linie.renderOrder = 19;
  gruppe.add(linie);
  // Dev-Modus: unentdeckte Orte offenlegen – „?“ + Name in zweiter Zeile darunter
  const schild = (bekannt || !DEV)
    ? textSprite(bekannt ? p.name : '?', bekannt)
    : textSpriteZweizeilig('?', p.name);
  schild.position.y = hoehe + 3.4;
  schild.renderOrder = 21;
  gruppe.add(schild);
  gruppe.position.set(Number(p.pos_x), 0, Number(p.pos_z));
  gruppe.userData.poiId = p.id;
  if (bekannt) {
    const halo = bauePoiHalo();
    halo.position.y = 3.2;
    halo.visible = Boolean(LICHT && LICHT.fensterLicht > 0.45);
    gruppe.add(halo);
    if (!Z.poiHalos) Z.poiHalos = new Map();
    Z.poiHalos.set(p.id, halo);
  }
  return gruppe;
}

let haloTex = null;
function bauePoiHalo() {
  if (!haloTex) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    gr.addColorStop(0, 'rgba(255, 195, 90, 0.9)');
    gr.addColorStop(0.5, 'rgba(255, 165, 60, 0.35)');
    gr.addColorStop(1, 'rgba(255, 140, 40, 0.0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    haloTex = new THREE.CanvasTexture(c);
  }
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTex, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.6, depthWrite: false,
  }));
  sp.scale.set(9, 9, 1);
  return sp;
}

// --- Straßenlaternen (3 InstancedMeshes: Masten, Köpfe, Lichtpfützen) ---
let laternenMasten = null;
let laternenKoepfe = null;
let laternenKegel = null;
function baueLaternen(strassen) {
  for (const m of [laternenMasten, laternenKoepfe, laternenKegel]) {
    if (m) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
  }
  laternenMasten = laternenKoepfe = laternenKegel = null;
  const punkte = [];
  const arten = new Set(['primary', 'secondary', 'tertiary', 'residential', 'living_street']);
  const rMax = DIORAMA.r - 6;
  for (const s of strassen || []) {
    if (!arten.has(s.kind) || !Array.isArray(s.points) || s.points.length < 2) continue;
    let rest = 18;
    for (let i = 1; i < s.points.length; i += 1) {
      const [x1, z1] = s.points[i - 1];
      const [x2, z2] = s.points[i];
      const dx = x2 - x1;
      const dz = z2 - z1;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 1) continue;
      const nx = -dz / segLen;
      const nz = dx / segLen;
      let pos = rest;
      while (pos <= segLen) {
        const t = pos / segLen;
        const lx = x1 + dx * t + nx * 2.4;
        const lz = z1 + dz * t + nz * 2.4;
        if (Math.hypot(lx - DIORAMA.cx, lz - DIORAMA.cz) <= rMax) {
          const zuNah = punkte.some((p) => Math.hypot(p.x - lx, p.z - lz) < 15);
          if (!zuNah) punkte.push({ x: lx, z: lz });
        }
        pos += 28.5;
      }
      rest = pos - segLen;
      if (punkte.length >= 450) break;
    }
    if (punkte.length >= 450) break;
  }
  if (!punkte.length) return;
  const dummy = new THREE.Object3D();
  const mastGeo = new THREE.CylinderGeometry(0.08, 0.11, 3.8, 6);
  mastGeo.translate(0, 1.9, 0);
  laternenMasten = new THREE.InstancedMesh(mastGeo, new THREE.MeshLambertMaterial({ color: 0x262b33 }), punkte.length);
  const kopfGeo = new THREE.SphereGeometry(0.24, 8, 6);
  const an = Boolean(LICHT && LICHT.fensterLicht > 0.35);
  laternenKoepfe = new THREE.InstancedMesh(kopfGeo, new THREE.MeshBasicMaterial({ color: an ? 0xfff0d4 : 0x777d87 }), punkte.length);
  if (!haloTex) bauePoiHalo();
  const kegelGeo = new THREE.CircleGeometry(5.8, 14);
  kegelGeo.rotateX(-Math.PI / 2);
  laternenKegel = new THREE.InstancedMesh(kegelGeo, new THREE.MeshBasicMaterial({
    map: haloTex, color: 0xffe8c8, blending: THREE.AdditiveBlending, transparent: true, opacity: an ? 0.67 : 0.0, depthWrite: false,
  }), punkte.length);
  laternenKegel.visible = an;
  for (let i = 0; i < punkte.length; i += 1) {
    const p = punkte[i];
    dummy.position.set(p.x, 0, p.z);
    dummy.updateMatrix();
    laternenMasten.setMatrixAt(i, dummy.matrix);
    dummy.position.set(p.x, 3.85, p.z);
    dummy.updateMatrix();
    laternenKoepfe.setMatrixAt(i, dummy.matrix);
    dummy.position.set(p.x, 0.10, p.z);
    dummy.updateMatrix();
    laternenKegel.setMatrixAt(i, dummy.matrix);
  }
  laternenMasten.instanceMatrix.needsUpdate = true;
  laternenKoepfe.instanceMatrix.needsUpdate = true;
  laternenKegel.instanceMatrix.needsUpdate = true;
  scene.add(laternenMasten, laternenKoepfe, laternenKegel);

  // 256x256 Laternen-Lightmap für Straßen, Luftbild & untere Hauswände (y < 9 m)
  const lm = document.createElement('canvas');
  lm.width = 256; lm.height = 256;
  const lg = lm.getContext('2d');
  lg.fillStyle = '#000000';
  lg.fillRect(0, 0, 256, 256);
  lg.globalCompositeOperation = 'lighter';
  const span = 2 * DIORAMA.r;
  const radPx = Math.max(4, (26.5 / span) * 256);
  for (const p of punkte) {
    const px = ((p.x - (DIORAMA.cx - DIORAMA.r)) / span) * 256;
    const py = ((p.z - (DIORAMA.cz - DIORAMA.r)) / span) * 256;
    const gr = lg.createRadialGradient(px, py, 0, px, py, radPx);
    gr.addColorStop(0, 'rgba(255, 232, 195, 0.95)');
    gr.addColorStop(0.45, 'rgba(235, 208, 170, 0.42)');
    gr.addColorStop(1, 'rgba(0, 0, 0, 0)');
    lg.fillStyle = gr;
    lg.beginPath();
    lg.arc(px, py, radPx, 0, Math.PI * 2);
    lg.fill();
  }
  const lmTex = new THREE.CanvasTexture(lm);
  lmTex.colorSpace = THREE.SRGBColorSpace;
  if (DIORAMA_LIGHT_UNIFORMS.uLightMap.value) DIORAMA_LIGHT_UNIFORMS.uLightMap.value.dispose();
  DIORAMA_LIGHT_UNIFORMS.uLightMap.value = lmTex;
  DIORAMA_LIGHT_UNIFORMS.uHasLightMap.value = 1.0;
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
let baeumeKrone = null;
let baeumeKroneTop = null;
function baueDioramaBaeume(trees) {
  for (const m of [baeumeStamm, baeumeKrone, baeumeKroneTop]) {
    if (m) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
  }
  const echte = (trees || []).filter((t) => Number.isFinite(Number(t.x)) && Number.isFinite(Number(t.z)));
  const N_BAEUME = Math.max(1, Math.min(1500, echte.length || 90));
  const dummy = new THREE.Object3D();

  const stammGeo = new THREE.CylinderGeometry(0.18, 0.28, 1, 7);
  stammGeo.translate(0, 0.5, 0);
  const stammMat = new THREE.MeshLambertMaterial({ color: 0x6b4c35 });
  baeumeStamm = new THREE.InstancedMesh(stammGeo, stammMat, N_BAEUME);
  baeumeStamm.castShadow = true;

  const kroneGeo = new THREE.IcosahedronGeometry(1.65, 1);
  const kroneMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  baeumeKrone = new THREE.InstancedMesh(kroneGeo, kroneMat, N_BAEUME);
  baeumeKrone.castShadow = true;
  baeumeKrone.receiveShadow = true;

  const topGeo = new THREE.IcosahedronGeometry(1.15, 1);
  baeumeKroneTop = new THREE.InstancedMesh(topGeo, kroneMat.clone(), N_BAEUME);
  baeumeKroneTop.castShadow = true;
  baeumeKroneTop.receiveShadow = true;

  const gruenToene = [0x4d7a3f, 0x588846, 0x426e37, 0x61914d].map((h) => new THREE.Color(h));
  const limit = DIORAMA.r + 10; // +10 m: Randbäume dürfen die Kante noch säumen
  let plaziert = 0;
  for (let i = 0; i < N_BAEUME; i += 1) {
    const t = echte.length ? echte[i % echte.length] : null;
    const hochM = t ? Math.max(4, Math.min(22, Number(t.baumhoehe) || 8)) : 8;
    const sHoch = hochM * 0.75; // ~75 % Diorama-Maßstab
    const bx = t ? Number(t.x) : (i % 2 ? 30 : -30);
    const bz = t ? Number(t.z) : (i % 3 ? 40 : -40);
    if (Math.hypot(bx - DIORAMA.cx, bz - DIORAMA.cz) > limit) continue;

    // Höhe skaliert über Stamm + vertikale Kronen-Dehnung, Breite bleibt schlank (0.9..1.15)
    const stammH = Math.max(1.6, sHoch * 0.45);
    const kroneH = Math.max(1.2, (sHoch - stammH) * 0.45);
    const breite = 0.9 + ((i * 17) % 26) / 100;
    const rotY = ((i * 73) % 360) * (Math.PI / 180);

    dummy.position.set(bx, 0, bz);
    dummy.rotation.set(0, rotY, 0);
    dummy.scale.set(1, stammH, 1);
    dummy.updateMatrix();
    baeumeStamm.setMatrixAt(plaziert, dummy.matrix);

    dummy.position.set(bx, stammH + kroneH * 0.55, bz);
    dummy.scale.set(breite, Math.max(0.85, kroneH * 0.75), breite);
    dummy.updateMatrix();
    baeumeKrone.setMatrixAt(plaziert, dummy.matrix);

    dummy.position.set(bx + Math.sin(rotY) * 0.25, stammH + kroneH * 1.15, bz + Math.cos(rotY) * 0.25);
    dummy.scale.set(breite * 0.9, Math.max(0.75, kroneH * 0.65), breite * 0.9);
    dummy.updateMatrix();
    baeumeKroneTop.setMatrixAt(plaziert, dummy.matrix);

    const col = gruenToene[i % gruenToene.length];
    baeumeKrone.setColorAt(plaziert, col);
    baeumeKroneTop.setColorAt(plaziert, col);
    plaziert += 1;
  }
  for (const m of [baeumeStamm, baeumeKrone, baeumeKroneTop]) {
    m.count = plaziert;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    scene.add(m);
  }
}
function wolkenFaerben() {
  const st = tageszeitZustand(hamburgStundeDezimal());
  const ziel = new THREE.Color(0xfff6ea).lerp(st.glow, 0.45).lerp(new THREE.Color(0x6b779c), st.nightFactor * 0.65);
  for (const w of wolken) {
    for (const m of w.children) m.material.color.copy(ziel);
  }
}

function baueFigur() {
  const g = new THREE.Group();
  const haut = new THREE.MeshLambertMaterial({ color: 0xe3af8a });
  const jacke = new THREE.MeshLambertMaterial({ color: 0x4b7f82 });
  const schalMat = new THREE.MeshLambertMaterial({ color: 0xf2c166 });
  const hose = new THREE.MeshLambertMaterial({ color: 0x32465c });
  const schuhMat = new THREE.MeshLambertMaterial({ color: 0x5c3d2e });
  const hutMat = new THREE.MeshLambertMaterial({ color: 0xd96b43 });
  const hutBandMat = new THREE.MeshLambertMaterial({ color: 0xf4e4c1 });

  const kopf = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 16), haut);
  kopf.position.y = 2.05;
  kopf.castShadow = true;

  // Zwei Augen + zarte Wangen auf der Vorderseite (+Z)
  const weissMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const pupilleMat = new THREE.MeshBasicMaterial({ color: 0x14181f });
  const wangeMat = new THREE.MeshBasicMaterial({ color: 0xe88d82 });
  for (const seite of [-1, 1]) {
    const apfel = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), weissMat);
    apfel.position.set(seite * 0.16, 2.12, 0.35);
    const pupille = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), pupilleMat);
    pupille.position.set(seite * 0.16, 2.12, 0.42);
    const wange = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), wangeMat);
    wange.scale.set(1.2, 0.7, 0.5);
    wange.position.set(seite * 0.25, 1.98, 0.34);
    g.add(apfel, pupille, wange);
  }

  // Kleiner Hut (Krempe + Krone + Hutband, leicht schräg)
  const hut = new THREE.Group();
  const krempe = new THREE.Mesh(new THREE.CylinderGeometry(0.50, 0.54, 0.045, 18), hutMat);
  const krone = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.35, 0.24, 18), hutMat);
  krone.position.y = 0.13;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.355, 0.36, 0.05, 18), hutBandMat);
  band.position.y = 0.045;
  krempe.castShadow = true;
  krone.castShadow = true;
  hut.add(krempe, krone, band);
  hut.position.set(0, 2.41, -0.02);
  hut.rotation.set(-0.08, 0, -0.06);

  const rumpf = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 1.0, 12), jacke);
  rumpf.position.y = 1.25;
  rumpf.castShadow = true;

  // Gemütlicher Schal am Kragen
  const schal = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.075, 8, 18), schalMat);
  schal.rotation.x = Math.PI / 2;
  schal.position.y = 1.73;

  // Bein-Gruppen mit Drehpunkt oben an der Hüfte (y = 0.8 statt Mitte/Knie)
  const baueBein = (x) => {
    const bein = new THREE.Group();
    bein.position.set(x, 0.8, 0);
    const rohr = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.76, 8), hose);
    rohr.position.y = -0.38;
    rohr.castShadow = true;
    const schuh = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.32), schuhMat);
    schuh.position.set(0, -0.73, 0.06);
    schuh.castShadow = true;
    bein.add(rohr, schuh);
    return bein;
  };
  const beinL = baueBein(-0.16);
  const beinR = baueBein(0.16);
  g.userData.beinL = beinL;
  g.userData.beinR = beinR;

  // Warmer Helm-Ring, damit man ihn im Dunkeln findet
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.62, 0.045, 8, 28),
    new THREE.MeshBasicMaterial({ color: 0xf5b04c })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.12;
  g.add(kopf, hut, rumpf, schal, beinL, beinR, ring);

  // Smartphone + Bildschirm-Leuchten (nur nachts, wenn handy im Inventar)
  const handy = new THREE.Group();
  const handyBody = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.28, 0.03),
    new THREE.MeshLambertMaterial({ color: 0x161a20 })
  );
  const handyScreen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.13, 0.23),
    new THREE.MeshBasicMaterial({ color: 0xbfe6ff })
  );
  handyScreen.rotation.y = Math.PI; // leuchtet Richtung Gesicht/Oberkörper (-Z)
  handyScreen.position.z = -0.017;
  // Einfache Hand + Arm (in Welt/Figur-Koordinaten relativ zur Handy-Gruppe)
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), haut);
  hand.position.set(0, -0.05, 0.035);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.085, 0.56, 8), jacke);
  arm.position.set(0.18, -0.02, -0.24);
  arm.rotation.set(Math.PI / 2 - 0.15, 0, 0.42);
  handy.add(handyBody, handyScreen, hand, arm);
  handy.position.set(0, 1.48, 0.56);
  handy.rotation.x = 0.55; // Bildschirm nach oben Richtung Gesicht gekippt
  handy.visible = false;
  const handyLicht = new THREE.PointLight(0x9bd4ff, 2.4, 4.5, 1.8);
  handyLicht.position.set(0, 1.56, 0.62);
  handyLicht.visible = false;
  g.userData.handy = handy;
  g.userData.handyLicht = handyLicht;
  g.add(handy, handyLicht);
  // Dev-Marker: markante, dicke senkrechte 55-m-Säule an den Füßen — hängt als Child an
  // der Charakter-Gruppe und bewegt sich damit automatisch mit (auch indoor).
  const devLineGeo = new THREE.CylinderGeometry(0.30, 0.30, 55, 8);
  const devLine = new THREE.Mesh(devLineGeo, new THREE.MeshBasicMaterial({
    color: 0x00ffff, transparent: false, opacity: 1.0,
  }));
  devLine.position.y = 27.5;
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
// --- Debug-Strecken (max. 3 aktuellste): Startpunkt + rotes Ziel + Luftlinie + Info ---
const DEBUG_STRECKEN = []; // [{ key, start, ziel, wo, was, warum, gruppe, mats }]
const MAX_DEBUG_STRECKEN = 3;

function erstelleLuftlinie(x1, z1, x2, z2, y, farbe, opacity) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  if (len < 0.5) return null;
  const geo = new THREE.CylinderGeometry(0.24, 0.24, len, 6);
  geo.rotateZ(Math.PI / 2); // entlang X
  const mat = new THREE.MeshBasicMaterial({ color: farbe, transparent: true, opacity });
  const m = new THREE.Mesh(geo, mat);
  m.position.set((x1 + x2) / 2, y, (z1 + z2) / 2);
  m.rotation.y = -Math.atan2(dz, dx);
  return { mesh: m, mat };
}

function debugStreckenAktualisieren(s) {
  if (!DEV || !s || !s.charakter) return;
  const r = s.route;
  if (!r || !Array.isArray(r.waypoints) || r.waypoints.length < 2) {
    // Keine aktive Route mehr: aktuelle Strecke auf "vergangen" setzen
    if (DEBUG_STRECKEN.length > 0 && DEBUG_STRECKEN[0].aktiv) {
      DEBUG_STRECKEN[0].aktiv = false;
      for (const m of DEBUG_STRECKEN[0].mats) m.opacity = 0.65;
      debugStreckenPanelRendern();
    }
    return;
  }
  const wp = r.waypoints;
  const start = { x: Number(wp[0].x), z: Number(wp[0].z) };
  const endWp = wp[wp.length - 1];
  const poi = r.zielPoi ? Z.pois.get(r.zielPoi) : null;
  const ziel = poi
    ? { x: Number(poi.pos_x), z: Number(poi.pos_z), name: poi.name }
    : { x: Number(endWp.x), z: Number(endWp.z), name: 'Erkundungsziel' };
  const key = `${start.x.toFixed(1)},${start.z.toFixed(1)}->${ziel.x.toFixed(1)},${ziel.z.toFixed(1)}:${r.zielPoi || ''}`;
  if (DEBUG_STRECKEN.length > 0 && DEBUG_STRECKEN[0].key === key) {
    if (!DEBUG_STRECKEN[0].aktiv) {
      DEBUG_STRECKEN[0].aktiv = true;
      for (const m of DEBUG_STRECKEN[0].mats) m.opacity = 1.0;
      debugStreckenPanelRendern();
    }
    return;
  }
  const ch = s.charakter;
  const plan = Array.isArray(s.plan) ? s.plan : [];
  const folge = plan.find((p) => p && p.action !== 'walk_to') || plan[0];
  const was = folge ? `${folge.action}${folge.detail ? ': ' + folge.detail : ''}` : (ch.current_action || 'unterwegs');
  const warum = ch.why_here || Z.gedanke || '–';
  const wo = `${ziel.name} (${Math.round(ziel.x)}, ${Math.round(ziel.z)})`;

  // Alte Strecken auf gedimmt setzen
  for (const alt of DEBUG_STRECKEN) {
    alt.aktiv = false;
    for (const m of alt.mats) m.opacity = 0.62;
  }

  const gruppe = new THREE.Group();
  const mats = [];

  // Ausgangspunkt-Säule (gesättigtes Orange)
  const startMat = new THREE.MeshBasicMaterial({ color: 0xff9900, transparent: true, opacity: 1.0 });
  const startSaeule = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 28, 8), startMat);
  startSaeule.position.set(start.x, 14, start.z);
  gruppe.add(startSaeule);
  mats.push(startMat);

  // Ziel-Säule (Markant Rot, voll gesättigt)
  const zielMat = new THREE.MeshBasicMaterial({ color: 0xff1a1a, transparent: true, opacity: 1.0 });
  const zielSaeule = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 42, 8), zielMat);
  zielSaeule.position.set(ziel.x, 21, ziel.z);
  gruppe.add(zielSaeule);
  mats.push(zielMat);

  // Rote Luftlinie zwischen Ausgangspunkt und Ziel (über Dächern sichtbar bei y = 24)
  const luft = erstelleLuftlinie(start.x, start.z, ziel.x, ziel.z, 24, 0xff1a1a, 1.0);
  if (luft) {
    gruppe.add(luft.mesh);
    mats.push(luft.mat);
  }

  // Kompaktes 3D-Label am Ziel
  const label = textSprite(`🎯 ${ziel.name}`, true);
  label.position.set(ziel.x, 44.5, ziel.z);
  gruppe.add(label);

  scene.add(gruppe);
  DEBUG_STRECKEN.unshift({ key, start, ziel, wo, was, warum, aktiv: true, gruppe, mats });
  while (DEBUG_STRECKEN.length > MAX_DEBUG_STRECKEN) {
    const weg = DEBUG_STRECKEN.pop();
    scene.remove(weg.gruppe);
  }
  debugStreckenPanelRendern();
}

function debugStreckenPanelRendern() {
  const el = $('devStrecken');
  if (!el) return;
  if (DEBUG_STRECKEN.length === 0) {
    el.innerHTML = `<summary>📍 Strecken (0)</summary><div class="strecke"><small>Noch keine Bewegung.</small></div>`;
    return;
  }
  const aktivTxt = DEBUG_STRECKEN[0].aktiv ? ' · aktiv' : '';
  const zeilen = DEBUG_STRECKEN.map((d, i) =>
    `<div class="strecke${d.aktiv ? ' aktiv' : ''}">`
    + `<b>${d.aktiv ? '🔴 AKTUELL' : `#${i + 1} Letzte`} → ${esc(d.wo)}</b>`
    + `<small>Was: ${esc(String(d.was).slice(0, 70))}</small>`
    + `<small>Warum: ${esc(String(d.warum).slice(0, 90))}</small>`
    + `</div>`).join('');
  el.innerHTML = `<summary>📍 Strecken (${DEBUG_STRECKEN.length}/${MAX_DEBUG_STRECKEN}${aktivTxt})</summary>${zeilen}`;
}

function figurRouteSetzen(route, sofort) {
  if (route && Array.isArray(route.waypoints) && route.waypoints.length > 0) {
    const wp = route.waypoints;
    const key = `${wp[0].x},${wp[0].z}->${wp[wp.length - 1].x},${wp[wp.length - 1].z}:${wp.length}`;
    // Bei laufender gleicher Route NICHT wegIndex vom Server überschreiben — sonst
    // kürzt die 3D-Figur Straßen-Ecken diagonal durch Häuser ab!
    if (!sofort && FIGUR_ROUTE && FIGUR_ROUTE.key === key) return;
    FIGUR_ROUTE = { key, waypoints: wp, wegIndex: sofort ? (route.wegIndex || 0) : 0 };
  }
  // Hinweis: wenn route null wird (Ankunft am Server), läuft FIGUR_ROUTE
  // seine letzten Waypoints (Hauseingang -> Tür) trotzdem sauber bis zum Ende ab.
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
    // leichtes Wippen + Bein-Schwung beim Gehen
    const takt = performance.now() / 160;
    f.position.y = Math.abs(Math.sin(takt)) * 0.05;
    if (f.userData.beinL && f.userData.beinR) {
      f.userData.beinL.rotation.x = Math.sin(takt) * 0.45;
      f.userData.beinR.rotation.x = -Math.sin(takt) * 0.45;
    }
  } else {
    f.position.y *= 0.9;
    if (f.userData.beinL && f.userData.beinR) {
      f.userData.beinL.rotation.x *= 0.85;
      f.userData.beinR.rotation.x *= 0.85;
    }
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

// --- 2-Modi-Kamera OHNE Snapping (NAH = Charakter, FERN = Kiez) -----------------------------------
// pilot (NAH):  doppelt so nah (3–22 m, Start 12 m), horizontal 360° drehbar + vertikal
//               phi in [-20° .. +45°] (-0.35 rad nach unten .. +0.785 rad nach oben schauen).
// overview (FERN): Kiez-Schweben (1-Finger/Links-Drag = schweben, Rechts-Drag/2-Finger = drehen & neigen).
const PILOT_MIN = 3;
const PILOT_MAX = 22;
const PILOT_PITCH = -0.18; // ~10° leicht nach unten auf die Figur
const PILOT_PHI_MIN = (-20 * Math.PI) / 180; // max 20° nach unten schauen (Kamera höher)
const PILOT_PHI_MAX = (45 * Math.PI) / 180;  // max 45° nach oben in den Himmel/Dächer schauen
const PILOT_START_Versatz = (40 * Math.PI) / 180; // +40° rechts vom Blickwinkel
const BLEND_DAUER = 0.9; // Sekunden

const smootherstep = (t) => { const x = Math.max(0, Math.min(1, t)); return x * x * x * (x * (x * 6 - 15) + 10); };

function figurKopf() {
  if (!Z.figur) return new THREE.Vector3(0, 1.8, 0);
  return new THREE.Vector3(Z.figur.position.x, 1.8, Z.figur.position.z);
}

// Ziel-Frame pilot (NAH): phi < 0 = Kamera höher & schaut bis 20° runter; phi > 0 = Kamera auf ~1.2..1.8m & schaut bis 45° hoch
function pilotPose(dist, theta, phi) {
  const kopf = figurKopf();
  const p = THREE.MathUtils.clamp(phi, PILOT_PHI_MIN, PILOT_PHI_MAX);
  if (p <= 0) {
    const el = -p;
    const cp = Math.cos(el);
    const pos = new THREE.Vector3(
      kopf.x + dist * cp * Math.sin(theta),
      kopf.y + dist * Math.sin(el),
      kopf.z + dist * cp * Math.cos(theta)
    );
    return { position: pos, lookAt: kopf.clone(), up: new THREE.Vector3(0, 1, 0) };
  }
  const camY = THREE.MathUtils.lerp(kopf.y, 1.05, Math.min(1, p / 0.5));
  const pos = new THREE.Vector3(
    kopf.x + dist * Math.sin(theta),
    camY,
    kopf.z + dist * Math.cos(theta)
  );
  const lookAt = new THREE.Vector3(
    kopf.x,
    camY + dist * Math.tan(p),
    kopf.z
  );
  return { position: pos, lookAt, up: new THREE.Vector3(0, 1, 0) };
}

// Ziel-Frame overview (FERN): Drehpunkt auf Kiez-Ebene, frei schwebend & neigbar
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

function starteBlende(nach, jetzt) {
  const vonPose = {
    position: camera.position.clone(),
    lookAt: aktuellesLookAt(),
    up: camera.up.clone(),
  };
  let nachPose;
  if (nach === 'overview') {
    // overviewTarget startet auf der Figur, danach frei über den Kiez schweben
    const f = Z.figur ? Z.figur.position : new THREE.Vector3(0, 0, 0);
    Z.over.ziel.set(f.x, 0, f.z);
    Z.over.dist = 240;
    Z.over.theta = Z.pilot.theta;
    Z.over.phi = 1.02;
    nachPose = overPose(Z.over.dist, Z.over.theta, Z.over.phi, Z.over.ziel);
  } else {
    const figTheta = Z.figur ? Z.figur.rotation.y : 0;
    const a = figTheta + PILOT_START_Versatz;
    const b = figTheta - PILOT_START_Versatz;
    const dAkt = Z.pilot.theta;
    const diff = (x, y) => Math.abs(Math.atan2(Math.sin(x - y), Math.cos(x - y)));
    Z.pilot.theta = diff(a, dAkt) <= diff(b, dAkt) ? a : b;
    Z.pilot.dist = 12;
    Z.pilot.phi = PILOT_PITCH;
    nachPose = pilotPose(Z.pilot.dist, Z.pilot.theta, Z.pilot.phi);
  }
  Z.blende = { von: vonPose, nach: nachPose, modus: nach, t: 0, start: jetzt };
  Z.modus = nach;
}

let _lookAt = new THREE.Vector3(0, 1.8, 0);
function aktuellesLookAt() { return _lookAt.clone(); }
let nordAnim = null;
const NORD_SCHWELLE_RAD = (5 * Math.PI) / 180;

function nordButtonSync() {
  const btn = $('btnNord');
  if (!btn) return;
  const th = Z.modus === 'pilot' ? Z.pilot.theta : Z.over.theta;
  const norm = Math.atan2(Math.sin(th), Math.cos(th));
  const abw = Math.abs(norm);
  btn.hidden = abw <= NORD_SCHWELLE_RAD && !nordAnim;
  const svg = btn.querySelector('svg');
  if (svg) svg.style.transform = `rotate(${((-norm * 180) / Math.PI).toFixed(1)}deg)`;
}

function kameraUpdaten(dt, jetzt) {
  if (nordAnim) {
    nordAnim.t += dt / 0.45;
    const k = smootherstep(Math.min(1, nordAnim.t));
    const ziel = nordAnim.modus === 'pilot' ? Z.pilot : Z.over;
    ziel.theta = THREE.MathUtils.lerp(nordAnim.startTheta, nordAnim.zielTheta, k);
    if (nordAnim.t >= 1) {
      ziel.theta = nordAnim.zielTheta;
      nordAnim = null;
    }
  }
  nordButtonSync();
  if (Z.blende) {
    const B = Z.blende;
    B.t += dt / BLEND_DAUER;
    const k = smootherstep(B.t);
    camera.position.lerpVectors(B.von.position, B.nach.position, k);
    _lookAt.lerpVectors(B.von.lookAt, B.nach.lookAt, k);
    camera.up.lerpVectors(B.von.up, B.nach.up, k).normalize();
    camera.lookAt(_lookAt);
    if (B.t >= 1) {
      camera.position.copy(B.nach.position);
      _lookAt.copy(B.nach.lookAt);
      camera.up.copy(B.nach.up);
      camera.lookAt(_lookAt);
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


// --- Steuerung: NAH = drehen/neigen · FERN = schweben (Links/1-Finger) + drehen (Rechts/2-Finger) ---
function modusButtonsSync() {
  document.querySelectorAll('#camBtns button').forEach((b) => {
    b.setAttribute('aria-pressed', String((b.dataset.cam === 'overview') === (Z.modus === 'overview')));
  });
  const hw = $('hinweis');
  if (hw) {
    hw.textContent = Z.modus === 'pilot'
      ? 'NAH: ziehen = rundum & hoch/runter · Rad/Pinch = zoom'
      : 'FERN: ziehen = schweben · Rechts/2-Finger = drehen · Rad/Pinch = zoom';
  }
}

function setzeModusButton(neu) {
  if (neu !== 'pilot' && neu !== 'overview') return;
  if (Z.modus === neu && !Z.blende) return;
  starteBlende(neu, performance.now() / 1000);
  modusButtonsSync();
}

function bindeSteuerung() {
  const el = renderer.domElement;
  const pointers = new Map(); // pointerId -> { x, y, button, shift }
  let letzterPinch = null;
  let letzterMid = null;
  let movedDist = 0;
  el.style.touchAction = 'none';

  const klemmeUeber = () => {
    const r = DIORAMA.r * 0.92;
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
    const sk = Z.over.dist / 520;
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
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
    if (pointers.size === 1) movedDist = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      letzterPinch = Math.hypot(a.x - b.x, a.y - b.y);
      letzterMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    try { el.setPointerCapture(e.pointerId); } catch { /* egal */ }
  });

  el.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    movedDist += Math.hypot(dx, dy);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: prev.button, shift: prev.shift || e.shiftKey });
    if (Z.blende) return;

    if (pointers.size === 2) {
      // 2-Finger-Geste (Mobile/Trackpad): Pinch = Zoom, 2-Finger-Drag = Drehen & Neigen
      const [a, b] = [...pointers.values()];
      const pinch = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (letzterPinch && pinch > 10) {
        const f = letzterPinch / pinch;
        if (Z.modus === 'pilot') Z.pilot.dist = THREE.MathUtils.clamp(Z.pilot.dist * f, PILOT_MIN, PILOT_MAX);
        else Z.over.dist = THREE.MathUtils.clamp(Z.over.dist * f, 35, 900);
      }
      if (letzterMid) {
        const mdx = mid.x - letzterMid.x;
        const mdy = mid.y - letzterMid.y;
        if (Z.modus === 'pilot') {
          Z.pilot.theta -= mdx * 0.0055;
          Z.pilot.phi = THREE.MathUtils.clamp(Z.pilot.phi - mdy * 0.0045, PILOT_PHI_MIN, PILOT_PHI_MAX);
        } else {
          Z.over.theta -= mdx * 0.0055;
          Z.over.phi = THREE.MathUtils.clamp(Z.over.phi + mdy * 0.004, 0.20, 1.50);
        }
      }
      letzterPinch = pinch;
      letzterMid = mid;
      return;
    }

    if (pointers.size === 1) {
      if (Z.modus === 'pilot') {
        Z.pilot.theta -= dx * 0.006;
        Z.pilot.phi = THREE.MathUtils.clamp(Z.pilot.phi - dy * 0.0045, PILOT_PHI_MIN, PILOT_PHI_MAX);
      } else if (prev.button === 2 || prev.shift) {
        // FERN mit Rechts-Drag / Shift: drehen & neigen
        Z.over.theta -= dx * 0.0055;
        Z.over.phi = THREE.MathUtils.clamp(Z.over.phi + dy * 0.004, 0.20, 1.50);
      } else {
        // FERN mit Links-Drag / 1-Finger: intuitiv über den Kiez schweben!
        panUm(dx, dy);
      }
    }
  });

  const dragEnde = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) { letzterPinch = null; letzterMid = null; }
  };
  el.addEventListener('pointerup', dragEnde);
  el.addEventListener('pointercancel', dragEnde);
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  // WASD / Pfeile: schweben im FERN-Modus entlang der Blickrichtung
  window.addEventListener('keydown', (e) => {
    if (Z.modus !== 'overview' || Z.blende) return;
    const schritt = Math.max(5, Z.over.dist * 0.06);
    const taste = e.key.toLowerCase();
    if (taste === 'w' || taste === 'arrowup') { panUm(0, schritt * 14); e.preventDefault(); }
    else if (taste === 's' || taste === 'arrowdown') { panUm(0, -schritt * 14); e.preventDefault(); }
    else if (taste === 'a' || taste === 'arrowleft') { panUm(schritt * 14, 0); e.preventDefault(); }
    else if (taste === 'd' || taste === 'arrowright') { panUm(-schritt * 14, 0); e.preventDefault(); }
    else return;
  });

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (Z.blende) return;
    const f = 1 + Math.sign(e.deltaY) * 0.1;
    if (Z.modus === 'pilot') {
      Z.pilot.dist = THREE.MathUtils.clamp(Z.pilot.dist * f, PILOT_MIN, PILOT_MAX);
    } else {
      Z.over.dist = THREE.MathUtils.clamp(Z.over.dist * f, 35, 900);
    }
  }, { passive: false });

  // Klick auf Gebäude: Indoor-Transparenz umschalten
  const ray = new THREE.Raycaster();
  const maus = new THREE.Vector2();
  el.addEventListener('click', (e) => {
    if (movedDist > 6) return;
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
  const frohWert = Math.max(-50, Math.min(50, Number(ch.froh) || 0));
  const frohBreite = (Math.abs(frohWert) / 50) * 50;
  const bFroh = $('bFroh');
  bFroh.style.left = frohWert >= 0 ? '50%' : `${50 - frohBreite}%`;
  bFroh.style.width = `${frohBreite}%`;
  bFroh.style.background = frohWert >= 0 ? 'var(--himmel)' : 'var(--rot)';
  $('nFroh').textContent = String(Math.round(frohWert));
  balken('bHunger', 'nHunger', Number(ch.hunger) || 0, 100);
  balken('bMued', 'nMued', Number(ch.erschoepfung) || 0, 100);
  $('bGeld').style.width = `${Math.max(2, Math.min(100, (Number(ch.geld) || 0) / 1.2))}%`;
  $('nGeld').textContent = `${Math.round(Number(ch.geld) || 0)} €`;
  const inv = Array.isArray(Z.staat && Z.staat.inventory) ? Z.staat.inventory : [];
  $('tInv').textContent = inv.length > 0
    ? 'Taschen: ' + inv.map((i) => `${i.label || i.item_key} (${i.count}x)`).join(', ')
    : 'Taschen: leer';
  if (Z.figur && Z.figur.userData.handy) {
    const hatHandy = inv.some((i) => i.item_key === 'handy' && Number(i.count) > 0);
    const nacht = Boolean(LICHT && (LICHT.nacht || LICHT.nightFactor > 0.35));
    const handyAn = hatHandy && nacht;
    Z.figur.userData.handy.visible = handyAn;
    if (Z.figur.userData.handyLicht) Z.figur.userData.handyLicht.visible = handyAn;
  }
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

// Punkt-im-Polygon (Fußprint-Test, Winding unabhängig): liegts (x, z) im Haus?
function punktInPolygon(x, z, poly) {
  if (!Array.isArray(poly) || poly.length < 3) return false;
  let innen = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1];
    const xj = poly[j][0], zj = poly[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) innen = !innen;
  }
  return innen;
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
  figurRouteSetzen(s.route || null, sofort); // Waypoints für weiche Interpolation (Punkt 1)
  debugStreckenAktualisieren(s);
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
        // Fix: Fallback anhand der FIGUR-Position (ch.pos_x/pos_z), nicht des
        // POI-Markers – der Marker kann an der Straße snappen, die Figur sitzt im Haus.
        const fx = Number(ch.pos_x);
        const fz = Number(ch.pos_z);
        if (Z.gebaeude.has('__lod2_walls')) {
          // 1) OSM-Footprint, der die Figur enthält -> dessen Centroid auf LoD2 mappen.
          const osm = (Z.karte.buildings || []).find((b) => Array.isArray(b.footprint) && punktInPolygon(fx, fz, b.footprint));
          let refX = fx, refZ = fz;
          if (osm) {
            const fp = osm.footprint;
            refX = fp.reduce((s, p) => s + p[0], 0) / fp.length;
            refZ = fp.reduce((s, p) => s + p[1], 0) / fp.length;
          }
          // 2) Nächstes LoD2-Haus zur Referenz (45 m Toleranz).
          let bd = 45;
          for (const g of Z.karte.lod2 || []) {
            const d = Math.hypot(g.centroid[0] - refX, g.centroid[1] - refZ);
            if (d < bd) { bd = d; bestId = g.id; }
          }
        } else {
          let bestD = 45;
          for (const [id] of Z.gebaeude) {
            const box = new THREE.Box3().setFromObject(Z.gebaeude.get(id));
            const mitte = new THREE.Vector3();
            box.getCenter(mitte);
            const d = Math.hypot(mitte.x - fx, mitte.z - fz);
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
    if (an && $('llmLogPanel')) {
      $('llmLogPanel').hidden = true;
      if ($('btnLlmLog')) $('btnLlmLog').setAttribute('aria-pressed', 'false');
    }
  });
  if (DEV && $('btnLlmLog') && $('llmLogPanel')) {
    $('btnLlmLog').hidden = false;
    $('btnLlmLog').addEventListener('click', async () => {
      const p = $('llmLogPanel');
      const an = p.hidden;
      p.hidden = !an;
      $('btnLlmLog').setAttribute('aria-pressed', String(an));
      if (an) {
        $('feedPanel').hidden = true;
        $('btnFeed').setAttribute('aria-pressed', 'false');
        await llmLogLaden();
      }
    });
  }
  // Auf Mobile (<= 820 px) startet der Live-Feed eingeklappt für freie Sicht
  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 820px)').matches) {
    $('feedPanel').hidden = true;
    $('btnFeed').setAttribute('aria-pressed', 'false');
  }
}

async function llmLogLaden() {
  const box = $('llmLog');
  if (!box) return;
  try {
    const r = await fetch('/api/dev/llm-log');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (!entries.length) {
      box.innerHTML = '<div class="eintrag"><small>Noch keine erfolgreichen LLM-Calls.</small></div>';
      return;
    }
    box.innerHTML = entries.map((e) => {
      const zeit = e.ts ? String(e.ts).slice(11, 19) : '';
      const meta = [e.role, e.versuch, e.model || e.provider, e.tokens ? `${e.tokens} tok` : '', e.latencyMs ? `${e.latencyMs} ms` : '', zeit].filter(Boolean).join(' · ');
      return `<div class="eintrag gedanke">`
        + `<b>#${Number(e.id) || 0}</b> <small>${esc(meta)}</small>`
        + `<details><summary>→ Outgoing (Prompt)</summary><pre>${esc(e.prompt || '')}</pre></details>`
        + `<details><summary>← Incoming (Response)</summary><pre>${esc(e.response || '')}</pre></details>`
        + `</div>`;
    }).join('');
  } catch (err) {
    box.innerHTML = `<div class="eintrag warnung">LLM-Log nicht erreichbar: ${esc(err.message)}</div>`;
  }
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
    const buecher = (b.buecher || []).map((x) => {
      const liste = Array.isArray(x.entries) ? (x.kind === 'notebook' ? [...x.entries].reverse() : x.entries) : [];
      const eintraegeHtml = liste.length > 0
        ? liste.map((e) => `<div class="karte" style="margin:6px 0 0"><b>${esc(e.title || e.topic || 'Eintrag')}</b><br><small>${esc(e.content || '')}</small></div>`).join('')
        : '<div style="margin-top:6px"><small>Noch keine Einträge.</small></div>';
      return `<details class="karte"><summary style="cursor:pointer">📖 <b>${esc(x.title)}</b> <small>(${esc(x.kind)}, ${x.eintraege} Einträge)</small></summary>${eintraegeHtml}</details>`;
    }).join('');
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

let regenMesh = null;
function baueRegen() {
  const N = 360;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i += 1) {
    pos[i * 3] = (Math.random() - 0.5) * 120;
    pos[i * 3 + 1] = Math.random() * 45;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 120;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xaac8f0, size: 0.35, transparent: true, opacity: 0.55 });
  regenMesh = new THREE.Points(geo, mat);
  regenMesh.visible = false;
  scene.add(regenMesh);
}
function regenUpdaten(dt) {
  if (!regenMesh) return;
  const w = Z.staat && Z.staat.world && Z.staat.world.weather;
  regenMesh.visible = w === 'rain';
  if (!regenMesh.visible) return;
  regenMesh.position.set(camera.position.x, 0, camera.position.z);
  const pos = regenMesh.geometry.attributes.position.array;
  for (let i = 1; i < pos.length; i += 3) {
    pos[i] -= 28 * dt;
    if (pos[i] < 0) pos[i] = 45;
  }
  regenMesh.geometry.attributes.position.needsUpdate = true;
}

async function initialLaden() {
  baueBoden();
  baueHimmel(); // DIORAMA_V1: Himmelskuppel
  baueWolken(); // DIORAMA_V1: 12 Diorama-Wolken
  baueRegen();
  baueFigur();
  LICHT = lichtAnpassen();
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
    const streckenBox = document.createElement('details');
    streckenBox.id = 'devStrecken';
    streckenBox.className = 'devStrecken';
    streckenBox.open = true;
    streckenBox.innerHTML = '<summary>📍 Strecken (0/3)</summary><div class="strecke"><small>Warte auf Bewegung …</small></div>';
    document.querySelector('.oben').appendChild(streckenBox);
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
    // Kanonisch: Server-Diorama (/api/map) übernimmt, wenn geliefert –
    // garantiert identische Geometrie mit fetch-luftbild.js.
    const d = karte.diorama;
    if (d && Number.isFinite(Number(d.cx)) && Number.isFinite(Number(d.cz)) && Number.isFinite(Number(d.r))) {
      DIORAMA.cx = Number(d.cx);
      DIORAMA.cz = Number(d.cz);
      DIORAMA.r = Number(d.r);
    }
    Z.over.ziel.set(DIORAMA.cx, 0, DIORAMA.cz);
    // Schatten-Kamera ueber die Scheibe spannen; Sonne zielt aufs Zentrum.
    sonne.target.position.set(DIORAMA.cx, 0, DIORAMA.cz);
    scene.add(sonne.target);
    const sk = DIORAMA.r + 120;
    sonne.shadow.camera.left = -sk;
    sonne.shadow.camera.right = sk;
    sonne.shadow.camera.top = sk;
    sonne.shadow.camera.bottom = -sk;
    sonne.shadow.camera.near = 1;
    sonne.shadow.camera.far = 1600;
    sonne.shadow.camera.updateProjectionMatrix();
    try { baueBoden(); } catch (err) { console.warn('[karte] boden:', err.message); }
    if (DEV || CLAY) { try { baueStrassen(karte.streets); } catch (err) { console.warn('[karte] strassen:', err.message); } }
    if (ZEIGE_GRUEN) { try { baueParks(karte.parks); } catch (err) { console.warn('[karte] parks:', err.message); } }
    if (ZEIGE_GRUEN) { try { baueDioramaBaeume(karte.trees); } catch (err) { console.warn("[karte] baeume:", err.message); } } // DIORAMA_V1
    try { baueGebaeude(karte.buildings); } catch (err) { console.warn('[karte] gebaeude:', err.message); }
    try { bauePoiSchilder(karte.pois); } catch (err) { console.warn('[karte] poi-marker:', err.message); }
    try { baueStrassennamen(karte.streets); } catch (err) { console.warn('[karte] schilder:', err.message); }
    try { baueLaternen(karte.streets); } catch (err) { console.warn('[karte] laternen:', err.message); }
    dioramaAussenAusblenden();
    // Schattenkarte einmalig frisch rendern (statisch, autoUpdate=false).
    // (Default-Referenz für Tests: 220, 100)
    LICHT = lichtAnpassen();
    // Initial-Kamera: pilot, +40° rechts vom Blickwinkel (Start-Frame, siehe Kamera-Kapitel)
    const h0 = 0; // Blickrichtung initial: +z (wird per State überschrieben)
    Z.pilot.theta = h0 + PILOT_START_Versatz;
    Z.pilot.dist = 12;
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
          if (DEV && $('llmLogPanel') && !$('llmLogPanel').hidden) llmLogLaden();
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
  regenUpdaten(dt);
  pinsSchweben(performance.now()); // Bojen-Schweben der POI-Pins (ms-Basis)
  highlightPulsen(performance.now()); // betretenes Haus pulst in Eigenfarbe
  kameraUpdaten(dt, jetzt);
  aktPillUpdaten();
  blasePositionieren();
  renderer.render(scene, camera);
}

const AKT_LABELS = {
  walk_to: 'Unterwegs',
  explore_street: 'Kiez erkunden',
  consume: 'Essen / Trinken',
  do_activity: 'Aktivität',
  work_shift: 'Arbeitsschicht',
  sleep: 'Schlafen',
  rest: 'Ausruhen',
  read_book: 'Lesen',
  write_notebook: 'Notizbuch schreiben',
  work_on_project: 'Projekt-Arbeit',
  collect_deposit: 'Pfand sammeln',
  return_deposit: 'Pfand abgeben',
  leave_note: 'Zettel schreiben',
  visit_doctor: 'Arztbesuch',
  buy_item: 'Einkaufen',
};

function aktPillUpdaten() {
  const pill = $('aktPill');
  if (!pill) return;
  const akt = Z.staat && Z.staat.aktivitaet;
  const ch = Z.staat && Z.staat.charakter;
  const ring = $('aktKreis');
  const txt = $('aktText');
  const restEl = $('aktRest');
  const UMFANG = 56.55;
  if (akt && akt.endsAtMs && akt.durationS > 0) {
    const restMs = Math.max(0, akt.endsAtMs - Date.now());
    const frac = Math.max(0, Math.min(1, restMs / (akt.durationS * 1000)));
    const sec = Math.ceil(restMs / 1000);
    const min = Math.floor(sec / 60);
    const sRest = sec % 60;
    const base = AKT_LABELS[akt.action] || akt.action;
    const info = akt.detail ? `: ${akt.detail}` : (akt.poiName ? ` @ ${akt.poiName}` : '');
    txt.textContent = `${base}${info}`;
    restEl.textContent = `${min}:${String(sRest).padStart(2, '0')}`;
    ring.style.strokeDashoffset = String(UMFANG * (1 - frac));
    pill.hidden = false;
    return;
  }
  if (ch && (ch.current_action === 'walk_to' || ch.current_action === 'explore_street')) {
    const ziel = ch.action_target_poi ? ` → ${ch.action_target_poi}` : '';
    const rm = Z.staat && Z.staat.route && Number.isFinite(Z.staat.route.restM) ? `${Math.round(Z.staat.route.restM)} m` : 'unterwegs';
    txt.textContent = `${AKT_LABELS[ch.current_action] || ch.current_action}${ziel}`;
    restEl.textContent = rm;
    ring.style.strokeDashoffset = String(UMFANG * 0.25);
    pill.hidden = false;
    return;
  }
  pill.hidden = true;
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

initialLaden().then(() => loop()).catch((err) => fehlerBanner(String(err.message || err)));


import '@fontsource-variable/open-sans/wght.css';
import * as THREE from 'three';
import { lonLatToWorld, worldToLonLat } from './geo.js';
import { Terrain } from './terrain.js';
import { Collision } from './collision.js';
import { ChunkManager } from './chunks.js';
import { Player } from './player.js';
import { PoiManager } from './poi.js';
import { StreetNames } from './streets.js';
import { InfoUI } from './info.js';
import { TouchControls } from './touch.js';
import { Riesenrad } from './riesenrad.js';
import { Gamepads, BTN } from './gamepad.js';
import { Settings, viewDistance } from './settings.js';
import { Compass } from './compass.js';
import { AddressSearch } from './search.js';
import { setLang, setResolver, refresh, tText } from './i18n.js';

const SKY = 0xb8d3ea;

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 900, 2600);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 6000);

scene.add(new THREE.HemisphereLight(0xdbe8ff, 0x6e665a, 1.0));
const sun = new THREE.DirectionalLight(0xffe9cc, 3.0);
const SUN_DIR = new THREE.Vector3(-0.6, 0.65, 0.45).normalize();
// shadows only around the player: a 700 m box that follows the camera (see followSun)
const SHADOW_R = 350;
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -SHADOW_R, right: SHADOW_R, top: SHADOW_R, bottom: -SHADOW_R, near: 1, far: 3000 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);
const texel = (2 * SHADOW_R) / 4096;
function followSun() {
  // centre a bit ahead of the camera, snapped to shadow texels so edges don't shimmer while flying
  const c = camera.getWorldDirection(new THREE.Vector3()).setY(0).multiplyScalar(SHADOW_R * 0.5).add(camera.position);
  c.set(Math.round(c.x / texel) * texel, Math.round(c.y / texel) * texel, Math.round(c.z / texel) * texel);
  sun.target.position.copy(c);
  sun.position.copy(c).addScaledVector(SUN_DIR, 1500);
}

const terrain = new Terrain();
const collision = new Collision();
const chunks = new ChunkManager({ scene, terrain, collision, renderer });
const player = new Player(camera, renderer.domElement, terrain, collision);
const pois = new PoiManager({ scene, terrain, player, chunks });
const streets = new StreetNames({ scene, terrain, player, chunks, renderer });
const info = new InfoUI({ camera, chunks, pois });
const riesenrad = new Riesenrad({ scene, terrain });
info.extra = riesenrad.pickables;
const search = new AddressSearch({ scene, player, pois });

// ---- landmarks (keys 1-9): name, lat, lon, height above ground, yaw, pitch -------------------
const PLACES = [
  ['Stephansdom', 48.20813, 16.37129, 117.4, -7.59, -0.42],
  ['Prater', 48.21596, 16.39418, 161.6, -7.68, -0.66],
  ['Schönbrunn', 48.18862, 16.31425, 137.5, 2.8, -0.28],
  ['Belvedere', 48.19894, 16.37979, 250.6, -3.23, -0.56],
  ['Rathaus', 48.21025, 16.3617, 108.7, -4.91, -0.31],
  ['Karlskirche / Resselpark', 48.20076, 16.37276, 147.7, -3.78, -0.6],
  ['Donaucity', 48.22869, 16.40859, 185.0, -0.67, -0.22],
  ['ZwiDeMu / Heldenplatz', 48.20359, 16.35921, 157.3, -0.85, -0.58],
  ['Spittelau', 48.23684, 16.3598, 150.8, 2.64, -0.39],
];
function view(lat, lon, h = 40, yaw = 0, pitch = -0.2) {
  const [x, z] = lonLatToWorld(lon, lat);
  player.teleport(x, z, h);
  player.yaw = yaw;
  player.pitch = pitch;
}
let place = 0;
const goTo = (i) => view(...PLACES[(place = i)].slice(1));
document.addEventListener('keydown', (e) => {
  if (!player.active) return;
  const d = /^Digit([1-9])$/.exec(e.code);
  if (d && PLACES[+d[1] - 1]) goTo(+d[1] - 1);
});
document.getElementById('places').innerHTML = PLACES.map((p, i) => `<li data-i="${i}"><b>${i + 1}</b> ${p[0]}</li>`).join('');

// ---- start position: #lat,lon,heightAboveGround,yaw,pitch or landmark 1 (crosshair on the Stephansdom) ----
const hash = location.hash.slice(1).split(',').map(Number);
if (hash.length >= 2 && hash.every(Number.isFinite)) view(...hash);
else goTo(0);

// ---- UI -----------------------------------------------------------------------------------
const overlay = document.getElementById('overlay');
const hud = document.getElementById('hud');
const compass = new Compass(document.getElementById('compass'));
const params = new URLSearchParams(location.search);
const shot = params.has('shot');
if (shot) overlay.classList.add('hidden');
// Touch: no pointer lock (phones don't have one and the browser shows its own notice), fullscreen instead.
// Follows the last pointer used, so a tablet with a mouse attached behaves like a desktop again.
let touchUi = false;
document.addEventListener('pointerdown', (e) => (touchUi = e.pointerType === 'touch'), true);
function goFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || !el.requestFullscreen || !matchMedia('(display-mode: browser)').matches) return;
  el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}
// Mouse mode (M): controls off, normal cursor (click links, select text); M or a click into the scene resumes.
let mouseMode = false;
const crosshair = document.getElementById('crosshair');
const mouseHint = document.getElementById('mouse-mode');
function setMouseMode(on) {
  mouseMode = on;
  mouseHint.classList.toggle('hidden', !on);
  crosshair.classList.toggle('hidden', on);
}

// Esc closes the topmost thing (POI list, info box, menu) and returns to the last mode, play or mouse mode;
// only an Esc with nothing open shows the menu. While the pointer is locked the browser takes Esc itself to
// unlock, and wants a click before locking again, so play mode carries on as "soft play" until that click.
let lastMode = 'play', releasing = false, unlockT = 0;
const menuOpen = () => !overlay.classList.contains('hidden');
// byEsc: started by an Esc keydown. The browser's own Esc handling would release a lock taken during that
// keypress right away (and bring the menu back), so lock on the key's release instead.
function enterPlay(byEsc = false) {
  lastMode = 'play';
  setMouseMode(false);
  overlay.classList.add('hidden');
  player.setSoft(true); // replaced by the real lock if the browser grants it without a click
  if (touchUi) goFullscreen();
  else if (byEsc) {
    const up = (e) => {
      if (e.code !== 'Escape') return;
      document.removeEventListener('keyup', up);
      if (player.soft && !player.locked) player.lock();
    };
    document.addEventListener('keyup', up);
  } else player.lock();
}
function enterMouseMode() {
  leavePlay();
  lastMode = 'mouse';
  overlay.classList.add('hidden');
  setMouseMode(true);
}
function leavePlay() {
  if (player.locked) {
    releasing = true;
    document.exitPointerLock();
  }
  player.setSoft(false);
  player.keys.clear();
}
function showMenu() {
  leavePlay();
  setMouseMode(false);
  overlay.classList.toggle('hidden', shot);
}
const resume = (byEsc) => (lastMode === 'mouse' ? enterMouseMode() : enterPlay(byEsc));
// Esc in a mode: close the info box if open, else the menu
const escape = () => (info.open ? info.close() : showMenu());

overlay.addEventListener('click', (e) => {
  if (e.target.closest('#menu-legal')) {
    e.preventDefault();
    return openLegal();
  }
  if (e.target.closest('a')) return;
  if (e.target.closest('#menu-pois')) return openPois();
  if (e.target.closest('#menu-settings')) return openSettings();
  const li = e.target.closest('#places li');
  if (li) goTo(+li.dataset.i);
  enterPlay();
});
player.onToggle = (locked) => {
  if (locked) {
    lastMode = 'play';
    setMouseMode(false);
    overlay.classList.add('hidden');
    return;
  }
  unlockT = performance.now();
  if (releasing) releasing = false; // P / M / menu: their own UI takes over
  else if (!shot) {
    // the user's Esc (or focus loss) while playing
    if (info.open) {
      info.close();
      enterPlay();
    } else showMenu();
  }
};

// P: POI browser (from play mode), click: info about what the crosshair points at, X: close info
function openPois() {
  leavePlay();
  overlay.classList.add('hidden');
  pois.show(!touchUi);
}
function closePois(byEsc = false) {
  pois.hide();
  enterPlay(byEsc);
}
document.getElementById('poi-close').addEventListener('click', () => closePois());
// settings: opened from the menu, closing returns to it
function openSettings() {
  overlay.classList.add('hidden');
  settings.show();
}
function closeSettings() {
  settings.hide();
  showMenu();
}
document.getElementById('settings-close').addEventListener('click', closeSettings);
// address search / teleport: click or tap the compass, or T (keyboard); picking an address flies there and carries on in the last mode
function openSearch() {
  leavePlay();
  setMouseMode(false);
  overlay.classList.add('hidden');
  search.show();
}
// Esc goes back to playing without taking the pointer lock (the browser drops a lock taken around an Esc
// keypress, which would bring up the menu); the next click takes it
function closeSearch(byEsc = false) {
  search.hide();
  if (byEsc && lastMode === 'play') player.setSoft(true);
  else resume();
}
// a click or tap next to the search window closes it and plays on; the click lets the browser lock the pointer
function closeSearchOutside() {
  search.hide();
  enterPlay();
}
compass.el.addEventListener('click', () => (search.open ? closeSearch() : openSearch()));
document.getElementById('search-close').addEventListener('click', () => closeSearch());
search.onPick = () => closeSearch();
// privacy notice & imprint: same, opened from the menu's footer link
const legal = document.getElementById('legal-panel');
const legalOpen = () => !legal.classList.contains('hidden');
// contact address, from the environment and XOR-scrambled at build time (vite.config.js) so neither the repo
// nor the bundle holds it as text; it only enters the page while the panel is open, and only becomes a mailto:
// link on click
const mail = () => String.fromCharCode(...__IMPRINT__.mail.map((c, i) => c ^ ((i * 7 + 13) & 255)));
legal.addEventListener('click', (e) => {
  const a = e.target.closest('a.mail');
  if (a) a.href = `mailto:${mail()}`;
});
function openLegal() {
  overlay.classList.add('hidden');
  legal.classList.remove('hidden');
  for (const a of legal.querySelectorAll('a.mail')) a.textContent = mail();
  document.getElementById('legal-body').scrollTop = 0;
}
function closeLegal() {
  legal.classList.add('hidden');
  for (const a of legal.querySelectorAll('a.mail')) (a.textContent = ''), (a.href = '#');
  showMenu();
}
document.getElementById('legal-close').addEventListener('click', closeLegal);
const toggleStats = () => settings.set('showStats', !settings.get('showStats'));
const toggleCompass = () => settings.set('showCompass', !settings.get('showCompass'));
document.addEventListener('keydown', (e) => {
  const esc = e.code === 'Escape';
  if (esc) {
    e.preventDefault();
    // a locked Esc is handled on the unlock; ignore the same Esc arriving afterwards
    if (player.locked || performance.now() - unlockT < 250) return;
  }
  if (settings.open) {
    if (esc) closeSettings();
  } else if (legalOpen()) {
    if (esc) closeLegal();
  } else if (search.open) {
    if (esc || (e.code === 'KeyT' && document.activeElement !== search.input)) {
      e.preventDefault();
      closeSearch(esc);
    }
  } else if (pois.open) {
    if (esc ||(e.code === 'KeyP' && document.activeElement !== pois.search)) {
      e.preventDefault();
      closePois(esc);
    }
  } else if (menuOpen()) {
    // any key plays; not shortcuts, F-keys or keyboard use of the menu's own buttons and links
    const onControl = document.activeElement?.closest?.('#overlay button, #overlay a');
    const nav = e.code === 'Tab' || (onControl && (e.code === 'Enter' || e.code === 'Space'));
    if (!nav && !e.ctrlKey && !e.metaKey && !e.altKey && !/^F\d+$/.test(e.key)) {
      e.preventDefault();
      const d = /^Digit([1-9])$/.exec(e.code); // 1-9: start at that landmark
      if (d && PLACES[+d[1] - 1]) goTo(+d[1] - 1);
      resume(esc);
    }
  } else if (player.active) {
    if (esc) escape();
    else if (e.code === 'KeyP') {
      e.preventDefault(); // or the "p" lands in the search field that show() focuses
      openPois();
    } else if (e.code === 'KeyT') {
      e.preventDefault(); // or the "t" lands in the search field that show() focuses
      openSearch();
    } else if (e.code === 'KeyM') enterMouseMode();
    else if (e.code === 'KeyX') info.close();
    else if (e.code === 'KeyC') toggleStats();
    else if (e.code === 'KeyK') toggleCompass();
  } else if (mouseMode) {
    if (esc) escape();
    else if (e.code === 'KeyM') enterPlay();
    else if (e.code === 'KeyT') {
      e.preventDefault();
      openSearch();
    } else if (e.code === 'KeyX') info.close();
    else if (e.code === 'KeyC') toggleStats();
    else if (e.code === 'KeyK') toggleCompass();
  }
});
document.addEventListener('mousedown', (e) => {
  if (touchUi) return; // taps on panels; the scene itself is handled by TouchControls
  if (e.target.closest('#compass')) return; // opens the address search
  if (search.open) {
    if (e.button === 0 && !e.target.closest('#search-panel')) closeSearchOutside();
    return;
  }
  if (e.button === 2) {
    if (player.active || mouseMode) info.close();
  } else if (e.button === 0) {
    if (player.active) {
      if (!player.locked) player.lock(); // soft play: this click lets the browser lock again
      info.click();
    } else if (mouseMode && e.target === renderer.domElement) enterPlay(); // not on a panel or link
  }
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

const touch = new TouchControls(renderer.domElement, {
  player,
  camera,
  aimDistance: () => info.aimDistance(),
  onTap: () => (search.open ? closeSearchOutside() : player.active && (info.open ? info.close() : info.click())),
  onTwoFingerTap: () => player.active && escape(),
});

// controller: Start = menu, RB / A = info, LB / B = close/back, Y = noclip, d-pad up/down = speed, LS click = sprint,
// Back = stats, d-pad left/right = previous/next landmark (RT/LT fly up and down, see gamepad.js)
const gamepads = new Gamepads(player);
gamepads.onPress = (b) => {
  if (settings.open) {
    if (b === BTN.B || b === BTN.LB || b === BTN.START) closeSettings();
  } else if (legalOpen()) {
    if (b === BTN.B || b === BTN.LB || b === BTN.START) closeLegal();
  } else if (search.open) {
    if (b === BTN.B || b === BTN.LB || b === BTN.START) closeSearch();
  } else if (pois.open) {
    if (b === BTN.B || b === BTN.LB || b === BTN.START) closePois();
  } else if (menuOpen() || mouseMode) {
    enterPlay(); // any button
  } else if (player.active) {
    if (b === BTN.START) showMenu();
    else if (b === BTN.RB || b === BTN.A) info.click();
    else if (b === BTN.LB || b === BTN.B) info.close();
    else if (b === BTN.Y) player.toggleNoclip();
    else if (b === BTN.UP || b === BTN.DOWN) player.changeSpeed(b === BTN.UP ? 1 : -1);
    else if (b === (gamepads.swapSticks ? BTN.RS : BTN.LS)) player.sprinting = true; // click the moving stick
    else if (b === BTN.BACK) toggleStats();
    else if (b === BTN.LEFT || b === BTN.RIGHT) goTo((place + (b === BTN.RIGHT ? 1 : PLACES.length - 1)) % PLACES.length);
  }
};
// ---- settings (stored per browser) ----------------------------------------------------------
const settings = new Settings({ controllerName: () => gamepads.current?.id ?? null });
function applySetting(k, v) {
  if (k === 'lang') {
    setLang(v);
    if (settings.open) settings.render();
    if (pois.open) pois.renderList();
  } else if (k === 'range') {
    chunks.setRange(v);
    const far = viewDistance(v);
    scene.fog.far = far;
    scene.fog.near = far * 0.35;
    camera.far = far * 2.3;
    camera.updateProjectionMatrix();
    pois.setRange(far);
    streets.setRange(far);
  } else if (k === 'resolution') renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * v);
  else if (k === 'fov') player.baseFov = v;
  else if (k === 'speed') player.speedIdx = v;
  else if (k === 'lookSens') player.lookSens = v;
  else if (k === 'padInvertY') gamepads.invertY = v;
  else if (k === 'padSwapUpDown') gamepads.swapUpDown = v;
  else if (k === 'padSwapSticks') gamepads.swapSticks = v;
  else if (k === 'touchInvertX') touch.invertX = v;
  else if (k === 'touchInvertY') touch.invertY = v;
  else if (k === 'touchInvertLift') touch.invertLift = v;
  else if (k === 'showLookRing') document.getElementById('look-ring').classList.toggle('hidden', !v);
  else if (k === 'padDrone') gamepads.drone = v;
  else if (k === 'showStats') hud.classList.toggle('hidden', !v);
  else if (k === 'showCompass') compass.setVisible(v);
  else if (k === 'showStreetNames') streets.setVisible(v);
  else if (k === 'streetNamesHeight') streets.setHeight(v);
  else if (k === 'compassCorner') compass.setCorner(v);
}
// the menu's control lists show the inputs as currently set up
const CONTROL_KEYS = ['padSwapSticks', 'padInvertY', 'padSwapUpDown', 'padDrone'];
function controlText(key) {
  const s = settings.values;
  if (key === 'pad.1' && s.padDrone)
    return ['pad.1.drone', { thr: s.padSwapSticks ? 'R' : 'L', rp: s.padSwapSticks ? 'L' : 'R', inv: s.padInvertY ? tText('pad.inverted') : '' }];
  if (key === 'pad.2' && s.padDrone) return ['pad.2.drone'];
  if (key === 'pad.1')
    return [key, { move: s.padSwapSticks ? 'R' : 'L', look: s.padSwapSticks ? 'L' : 'R', inv: s.padInvertY ? tText('pad.inverted') : '' }];
  if (key === 'pad.2')
    return [key, { up: s.padSwapUpDown ? 'LT' : 'RT', down: s.padSwapUpDown ? 'RT' : 'LT', sprint: s.padSwapSticks ? 'R3' : 'L3' }];
  return [key];
}
for (const [k, v] of Object.entries(settings.values)) applySetting(k, v);
setResolver(controlText);
settings.onChange = (k, v) => {
  applySetting(k, v);
  if (CONTROL_KEYS.includes(k)) refresh();
};

// sights are on by default; screenshot/debug helpers: ?poi=MUSEUMOGD,SEHENSWUERDIGOGD (replaces the default)  &info (click after load)
const startPois = params.get('poi') ?? 'SEHENSWUERDIGOGD';
pois.ready.then(() => startPois.split(',').forEach((id) => id && pois.toggle(id, true)));
if (params.has('info')) setTimeout(() => info.click(), 20000);
if (params.has('panel')) setTimeout(() => pois.show(), 5000);
window.addEventListener('beforeunload', (e) => {
  // guard against an accidental Ctrl+W (close tab) while flying with W
  if (player.active) e.preventDefault();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let hudT = 0, hashT = 0;
function updateHud(now) {
  if (now - hudT < 200) return;
  hudT = now;
  const p = player.pos;
  const [lon, lat] = worldToLonLat(p.x, p.z);
  const g = terrain.heightAt(p.x, p.z);
  const mode = tText(player.noclip ? 'hud.noclip' : 'hud.flying');
  // remember speed changes from the wheel or the d-pad
  if (player.speedIdx !== settings.get('speed')) settings.set('speed', player.speedIdx);
  hud.innerHTML =
    `${lat.toFixed(5)}, ${lon.toFixed(5)}<br>` +
    `${tText('hud.alt', { y: Number.isNaN(p.y) ? '…' : p.y.toFixed(1) })}` +
    `${g !== null && !Number.isNaN(p.y) ? ' · ' + tText('hud.above', { h: (p.y - g).toFixed(1) }) : ''}<br>` +
    `${mode}${player.sprinting ? ' · Sprint' : ''} · ${tText('hud.speed')} ×${player.speedMult}<br>` +
    `${tText('hud.buildings')}: ${chunks.stats.buildings} · ${tText('hud.loading')}: ${chunks.pending}` +
    (gamepads.current ? `<br>Controller: ${gamepads.current.id.replace(/[<&]/g, '')} (${gamepads.current.mapping || tText('hud.nonstandard')})` : '');
  if (now - hashT > 2000 && !Number.isNaN(p.y)) {
    hashT = now;
    const ah = g !== null ? (p.y - g).toFixed(1) : 40;
    history.replaceState(null, '', `#${lat.toFixed(5)},${lon.toFixed(5)},${ah},${player.yaw.toFixed(2)},${player.pitch.toFixed(2)}`);
  }
}

// ---- loop ---------------------------------------------------------------------------------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  gamepads.update(dt);
  touch.update(dt);
  player.update(dt);
  chunks.update(player.pos);
  riesenrad.update(dt);
  pois.update(dt);
  search.update(dt);
  streets.update(dt, camera);
  info.update(dt, player.active || shot);
  updateHud(now);
  compass.update(player.yaw);
  followSun();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__wien = { player, chunks, terrain, camera, pois, streets, info, riesenrad, search };

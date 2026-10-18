import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import RAPIER from 'rapier';
import { TYPES, PALETTE, CATEGORIES, buildPiece, woodMaterial, ensureWoodUVs, ports, applyTransform, pointTangent } from './pieces.js';
import { Sim } from './sim.js';
import { DEMO } from './demo.js';
import { SETTINGS, defaultSettings } from './settings.js';
import { SAMPLES, instantiate } from './samples.js';

await RAPIER.init();
const $ = (id) => document.getElementById(id);
const rad = THREE.MathUtils.degToRad, deg = THREE.MathUtils.radToDeg;

// ---------- scene ----------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(devicePixelRatio); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
const scene = new THREE.Scene(); scene.background = new THREE.Color('#e9eef3');
scene.fog = new THREE.Fog('#e9eef3', 60, 160);
// Image-based fill from a soft studio environment, plus a warm key light and cool sky bounce.
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
scene.add(new THREE.HemisphereLight('#dfeaff', '#b8a68c', 0.7));
const sun = new THREE.DirectionalLight('#fff3e0', 2.4); sun.position.set(14, 28, 10); sun.castShadow = true;
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, far: 90 });
sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02; sun.shadow.radius = 4;
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: '#f4f1ec', roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -0.01; ground.receiveShadow = true; scene.add(ground);
const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500); camera.rotation.order = 'YXZ';

function resize() { const r = canvas.parentElement.getBoundingClientRect(); renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
new ResizeObserver(resize).observe(canvas.parentElement);

// ---------- resizable panels ----------
// Drag the edges of the parts list, the properties panel and the stats panel; sizes are remembered.
{
  const css = document.body.style, LIM = { left: [120, 600], right: [180, 700], hud: [60, 600] };
  const set = (k, v) => { v = Math.round(Math.min(LIM[k][1], Math.max(LIM[k][0], v))); css.setProperty('--' + k, v + 'px'); try { localStorage.setItem('panel-' + k, v); } catch {} };
  for (const k of Object.keys(LIM)) { try { const v = localStorage.getItem('panel-' + k); if (v) set(k, +v); } catch {} }
  const hook = (id, k, f) => $(id).addEventListener('pointerdown', (e) => {
    e.preventDefault(); const el = $(id); el.classList.add('drag'); el.setPointerCapture(e.pointerId);
    const move = (ev) => set(k, f(ev)), up = () => { el.classList.remove('drag'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  });
  hook('splitL', 'left', (e) => e.clientX);
  hook('splitR', 'right', (e) => innerWidth - e.clientX);
  hook('splitH', 'hud', (e) => innerHeight - e.clientY);
}

// ---------- first-person camera ----------
// Hold right mouse to look around; WASD to fly, E/Q up/down, Shift to go faster, wheel to dolly.
const look = { yaw: 0, pitch: 0, active: false };
const keys = new Set();
function lookAt(target) {
  camera.lookAt(target);
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ'); look.yaw = e.y; look.pitch = e.x;
}
const forward = () => new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => { if (e.button === 2) { look.active = true; canvas.requestPointerLock?.(); } });
addEventListener('mouseup', (e) => { if (e.button === 2 && look.active) { look.active = false; document.exitPointerLock?.(); } });
addEventListener('mousemove', (e) => {
  if (!look.active) return;
  if (ride.on) { ride.yaw -= e.movementX * 0.0025; ride.pitch = THREE.MathUtils.clamp(ride.pitch - e.movementY * 0.0025, -1.2, 1.2); return; }
  look.yaw -= e.movementX * 0.0025;
  look.pitch = THREE.MathUtils.clamp(look.pitch - e.movementY * 0.0025, -1.55, 1.55);
});
const follow = { target: null, dist: 5 };
// Ride: the camera sits inside one marble and faces where it is rolling; right-drag glances around (it springs back).
const ride = { on: false, id: null, heading: new THREE.Vector3(0, 0, -1), yaw: 0, pitch: 0 };
canvas.addEventListener('wheel', (e) => { e.preventDefault(); if (ride.on) return; if (follow.target) { follow.dist = THREE.MathUtils.clamp(follow.dist * (e.deltaY > 0 ? 1.15 : 0.87), 1.5, 40); return; } camera.position.addScaledVector(forward(), -Math.sign(e.deltaY) * (keys.has('shift') ? 3 : 1)); }, { passive: false });
addEventListener('blur', () => keys.clear());
function updateCamera(dt) {
  camera.rotation.set(look.pitch, look.yaw, 0);
  const f = forward(), r = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), v = new THREE.Vector3();
  if (keys.has('w')) v.add(f); if (keys.has('s')) v.sub(f);
  if (keys.has('d')) v.add(r); if (keys.has('a')) v.sub(r);
  if (keys.has('e')) v.y += 1; if (keys.has('q')) v.y -= 1;
  if (v.lengthSq()) camera.position.addScaledVector(v.normalize(), dt * (keys.has('shift') ? 24 : 8));
}

// ---------- document state ----------
let pieces = [], groups = new Map(), selected = null, selPoint = -1, nextId = 1;
let undoStack = [], redoStack = [], sim = null, paused = false, filePath = null, dirty = false;
let settings = defaultSettings();
let mode = 'move', connect = null; // connect: null | { from: {piece, port} | null }
const handles = new THREE.Group(); scene.add(handles);
const portMarks = new THREE.Group(); scene.add(portMarks);
let selBox = null;

function toast(msg, ms = 1800) { const t = $('toast'); t.textContent = msg; t.style.opacity = 1; clearTimeout(toast.h); if (ms) toast.h = setTimeout(() => (t.style.opacity = 0), ms); }
const snapshot = () => JSON.stringify(pieces);
let autoT = 0;
function markDirty(d = true) {
  dirty = d; clearTimeout(autoT);
  if (d) autoT = setTimeout(autoSave, 2000); else try { localStorage.removeItem('autosave'); } catch {}
  showTitle();
}
// Auto save: a track with a file is written back to it; an untitled one is kept as a backup offered on next launch.
async function autoSave() {
  if (!dirty || !$('chkAuto').checked) return;
  const data = serialize();
  if (filePath && window.files?.write) { try { await window.files.write(filePath, data); markDirty(false); toast('Auto-saved'); } catch (err) { toast('Auto save failed: ' + err.message); } }
  else try { localStorage.setItem('autosave', data); } catch {}
}
function showTitle(d = dirty) { window.files?.setDirty?.(d); document.title = `${d ? '• ' : ''}${filePath ? filePath.split(/[\\/]/).pop() : 'Untitled'} — Marble Lab`; }
function pushUndo() { markDirty(); undoStack.push(snapshot()); if (undoStack.length > 200) undoStack.shift(); redoStack = []; }
function restore(json) { const keep = selected?.id; load(JSON.parse(json), false); select(pieces.find((p) => p.id === keep) || null); }
function undo() { if (!undoStack.length || sim) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length || sim) return; undoStack.push(snapshot()); restore(redoStack.pop()); }

function rebuild(p) {
  const old = groups.get(p.id); if (old) { scene.remove(old); }
  const g = buildPiece(p); scene.add(g); groups.set(p.id, g);
  if (selected === p) refreshSelectionVisuals();
  if (connect) showPorts();
}
function retransform(p) { const g = groups.get(p.id); applyTransform(p, g); g.updateMatrixWorld(true); refreshSelectionVisuals(); }
function load(list, resetHistory = true) {
  for (const g of groups.values()) scene.remove(g);
  groups.clear(); pieces = list; nextId = Math.max(0, ...list.map((p) => p.id)) + 1;
  for (const p of pieces) rebuild(p);
  if (resetHistory) { undoStack = []; redoStack = []; }
  select(null);
}
function addPiece(type, over = {}) {
  pushUndo();
  const t = camera.position.clone().addScaledVector(forward(), 8), sn = (v) => Math.round(v);
  const p = { id: nextId++, type, pos: [sn(t.x), Math.max(0.5, sn(t.y)), sn(t.z)], rotX: 0, rotY: 0, rotZ: 0, scale: [1, 1, 1], ...TYPES[type].defaults(), ...structuredClone(over) };
  pieces.push(p); rebuild(p); select(p);
}
function deletePiece(p) { pushUndo(); scene.remove(groups.get(p.id)); groups.delete(p.id); pieces = pieces.filter((x) => x !== p); select(null); }
function duplicate(p) { pushUndo(); const c = structuredClone(p); c.id = nextId++; c.pos = [p.pos[0] + 1, p.pos[1], p.pos[2] + 1]; pieces.push(c); rebuild(c); select(c); }

// ---------- selection ----------
function refreshSelectionVisuals() {
  handles.clear(); if (selBox) { scene.remove(selBox); selBox = null; }
  placeGizmo();
  if (!selected || sim) return;
  const g = groups.get(selected.id); g.updateMatrixWorld(true);
  selBox = new THREE.BoxHelper(g, '#ffb300'); scene.add(selBox);
  if (TYPES[selected.type].editPoints) {
    selected.points.forEach((pt, i) => {
      const h = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), new THREE.MeshBasicMaterial({ color: i === selPoint ? '#ff6a3d' : '#ffd84d', depthTest: false }));
      h.renderOrder = 10; h.position.set(...pt).applyMatrix4(g.matrixWorld); h.userData.pointIndex = i; handles.add(h);
    });
  }
}
function select(p, point = -1) { selected = p; selPoint = point; refreshSelectionVisuals(); renderProps(); }

// ---------- properties panel ----------
const fmt = (v) => Math.round(v * 1000) / 1000;
// Angles always latch to 15° steps, snap toggle or not.
const snapA = (v) => { const a = Math.round(v / 15) * 15; return ((a % 360) + 540) % 360 - 180 || 0; };
// Path end directions are stored as vectors but edited as yaw (around Y, 0° = +X) and pitch (up/down).
const dirToYP = (d) => [deg(Math.atan2(-d[2], d[0])), deg(Math.asin(THREE.MathUtils.clamp(d[1] / (Math.hypot(...d) || 1), -1, 1)))];
const ypToDir = (y, pt) => [Math.cos(rad(pt)) * Math.cos(rad(y)), Math.sin(rad(pt)), -Math.cos(rad(pt)) * Math.sin(rad(y))].map(fmt);
function row(label, ...inputs) { const d = document.createElement('div'); d.className = inputs.length > 1 ? 'row row3' : 'row'; const l = document.createElement('label'); l.textContent = label; d.append(l, ...inputs); return d; }
function numInput(value, step, onChange, min, max) {
  const i = document.createElement('input'); i.type = 'number'; i.value = fmt(value); i.step = step ?? 0.1;
  if (min !== undefined) i.min = min; if (max !== undefined) i.max = max;
  i.onchange = () => { const v = parseFloat(i.value); if (!isNaN(v)) onChange(v); }; return i;
}
function edit(fn) { pushUndo(); fn(); rebuild(selected); renderProps(); }

// With nothing selected the panel edits the test settings for the whole track.
function paramInput(d, obj, apply) {
  let inp;
  if (d.type === 'select') {
    inp = document.createElement('select');
    for (const [v, l] of d.options) { const o = document.createElement('option'); o.value = v; o.textContent = l; inp.append(o); }
    inp.value = obj[d.key]; inp.onchange = () => apply(() => (obj[d.key] = typeof d.options[0][0] === 'number' ? Number(inp.value) : inp.value));
  } else if (d.type === 'bool') {
    inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!obj[d.key]; inp.onchange = () => apply(() => (obj[d.key] = inp.checked));
  } else if (d.type === 'text') {
    inp = document.createElement('input'); inp.type = 'text'; inp.value = obj[d.key] || ''; inp.onchange = () => apply(() => (obj[d.key] = inp.value));
  } else if (d.type === 'piece') {
    // Pick another part of a given type (e.g. the lift a gate follows).
    inp = document.createElement('select');
    for (const [v, l] of [[0, 'None'], ...pieces.filter((x) => x.type === d.of).map((x) => [x.id, `${TYPES[x.type].label} #${x.id}`])]) {
      const o = document.createElement('option'); o.value = v; o.textContent = l; inp.append(o);
    }
    inp.value = obj[d.key] || 0; inp.onchange = () => apply(() => (obj[d.key] = Number(inp.value)));
  } else if (d.type === 'color') {
    inp = document.createElement('input'); inp.type = 'color'; inp.value = obj[d.key]; inp.onchange = () => apply(() => (obj[d.key] = inp.value));
  } else if (d.label.includes('°') && !d.label.includes('°/s')) {
    const lo = Math.ceil(d.min / 15) * 15, hi = Math.floor(d.max / 15) * 15;
    inp = numInput(obj[d.key], 15, (v) => apply(() => (obj[d.key] = Math.min(hi, Math.max(lo, Math.round(v / 15) * 15)))), lo, hi);
  } else inp = numInput(obj[d.key], d.step, (v) => apply(() => (obj[d.key] = Math.min(d.max, Math.max(d.min, v)))), d.min, d.max);
  return row(d.label, inp);
}
function renderSettings(body) {
  body.innerHTML = '<p class="hint">Nothing selected — these are the test settings for the whole track. Per-spawner marble options are on each Spawner.</p>';
  const apply = (fn) => { fn(); markDirty(); };
  for (const [title, list] of SETTINGS) {
    const h3 = document.createElement('h3'); h3.textContent = title; h3.style.marginTop = '12px'; body.append(h3);
    for (const d of list) body.append(paramInput(d, settings, apply));
  }
  const b = document.createElement('button'); b.textContent = 'Reset to defaults'; b.onclick = () => { settings = defaultSettings(); markDirty(); renderProps(); };
  const w = document.createElement('div'); w.className = 'btns'; w.append(b); body.append(w);
}
function renderProps() {
  const body = $('propBody'); body.innerHTML = '';
  if (!selected) { renderSettings(body); return; }
  const p = selected, T = TYPES[p.type];
  p.scale ??= [1, 1, 1];
  const h = document.createElement('div'); h.innerHTML = `<span class="tag">${T.label}</span> <span class="hint">#${p.id}</span>`; body.append(h);
  body.append(row('Location', ...[0, 1, 2].map((i) => numInput(p.pos[i], 0.25, (v) => edit(() => (p.pos[i] = snapV(v)))))));
  body.append(row('Rotation°', ...['rotX', 'rotY', 'rotZ'].map((k) => numInput(p[k] || 0, 15, (v) => edit(() => (p[k] = snapA(v)))))));
  body.append(row('Scale', ...[0, 1, 2].map((i) => numInput(p.scale[i], 0.1, (v) => edit(() => (p.scale[i] = Math.max(0.05, v))), 0.05))));
  const defs = T.defaults(); for (const d of T.params) if (p[d.key] === undefined) p[d.key] = defs[d.key]; // older files
  for (const d of T.params) body.append(paramInput(d, p, edit));
  if (T.editPoints) {
    const h3 = document.createElement('h3'); h3.textContent = 'Control points'; h3.style.marginTop = '12px'; body.append(h3);
    p.points.forEach((pt, i) => {
      const box = document.createElement('div'); box.className = 'pt'; if (i === selPoint) box.style.borderColor = '#ff6a3d';
      const r = document.createElement('div'); r.className = 'row'; const n = document.createElement('label'); n.textContent = i; r.append(n);
      [0, 1, 2].forEach((k) => r.append(numInput(pt[k], 0.025, (v) => edit(() => (pt[k] = snapP(v))))));
      box.append(r, row('Roll°', numInput(pt[3] || 0, 15, (v) => edit(() => (pt[3] = snapA(v))))),
        row('Width ×', numInput(pt[4] ?? 1, 0.05, (v) => edit(() => { pt[3] ??= 0; pt[4] = Math.min(5, Math.max(0.3, v)); pt[5] ??= 1; }), 0.3, 5)),
        row('Height ×', numInput(pt[5] ?? 1, 0.05, (v) => edit(() => { pt[3] ??= 0; pt[4] ??= 1; pt[5] = Math.min(5, Math.max(0.3, v)); }), 0.3, 5)));
      if (i === 0 || i === p.points.length - 1) {
        // End points also carry the direction the track leaves/enters at that end.
        const dk = i === 0 ? 'startDir' : 'endDir', [yw, pc] = dirToYP(ports(p)[i === 0 ? 0 : 1].dir);
        box.append(row('Aim yaw°', numInput(snapA(yw), 15, (v) => edit(() => (p[dk] = ypToDir(snapA(v), snapA(pc)))))),
          row('Aim pitch°', numInput(snapA(pc), 15, (v) => edit(() => (p[dk] = ypToDir(snapA(yw), Math.max(-90, Math.min(90, snapA(v)))))))));
      } box.onclick = (e) => { if (e.target.tagName !== 'INPUT') select(p, i); }; body.append(box);
    });
    const btns = document.createElement('div'); btns.className = 'btns';
    const b = (label, fn) => { const x = document.createElement('button'); x.textContent = label; x.onclick = fn; btns.append(x); };
    b('+ Point at end', () => edit(() => {
      const a = p.points.at(-1), z = p.points.at(-2) || [a[0] - 1, a[1], a[2]];
      p.points.push([a[0] + (a[0] - z[0]) * 0.8, a[1] + (a[1] - z[1]) * 0.8, a[2] + (a[2] - z[2]) * 0.8].map(fmt)); selPoint = p.points.length - 1;
    }));
    if (selPoint >= 0) {
      b('+ Insert after', () => edit(() => {
        const a = p.points[selPoint], z = p.points[selPoint + 1];
        if (!z) return; p.points.splice(selPoint + 1, 0, [0, 1, 2, 3, 4, 5].map((k) => fmt(((a[k] ?? (k > 3 ? 1 : 0)) + (z[k] ?? (k > 3 ? 1 : 0))) / 2))); selPoint++;
      }));
      if (p.points.length > 2) b('Delete point', () => edit(() => { p.points.splice(selPoint, 1); selPoint = -1; }));
      const dk = selPoint === 0 ? 'startDir' : selPoint === p.points.length - 1 ? 'endDir' : null;
      if (dk && p[dk]) b('Reset end direction', () => edit(() => delete p[dk]));
      b('Whole part', () => select(p));
    }
    body.append(btns);
  }
  const btns = document.createElement('div'); btns.className = 'btns';
  const dup = document.createElement('button'); dup.textContent = 'Duplicate'; dup.onclick = () => duplicate(p);
  const del = document.createElement('button'); del.textContent = 'Delete'; del.onclick = () => deletePiece(p);
  btns.append(dup, del); body.append(btns);
}

// ---------- palette ----------
// Grouped by category; the search box filters on name, description and category.
function renderPalette() {
  const q = $('partSearch').value.trim().toLowerCase(), list = $('partList'); list.innerHTML = '';
  let shown = 0;
  for (const [cat, title] of Object.entries(CATEGORIES)) {
    const items = PALETTE.filter((e) => e.cat === cat && (!q || `${e.label} ${e.desc} ${title}`.toLowerCase().includes(q)));
    if (!items.length) continue;
    const h = document.createElement('div'); h.className = 'cat'; h.textContent = title; list.append(h);
    for (const e of items) {
      const b = document.createElement('button'); b.title = e.desc; b.disabled = !!sim;
      b.innerHTML = `${e.label}${q ? `<small>${e.desc}</small>` : ''}`;
      b.onclick = () => { if (!sim) addPiece(e.type, e.over); };
      list.append(b); shown++;
    }
  }
  $('partNone').hidden = shown > 0;
}
$('partSearch').addEventListener('input', renderPalette);
$('partSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const b = $('partList').querySelector('button:not(:disabled)'); if (b) { b.click(); $('partSearch').blur(); } }
  if (e.key === 'Escape') { $('partSearch').value = ''; renderPalette(); $('partSearch').blur(); }
});
renderPalette();

// ---------- help ----------
const K = (...k) => k.map((x) => `<kbd>${x}</kbd>`).join(' + ');
const HELP = {
  'Getting started': `
    <p>Marble Lab is for building marble runs and testing them with real physics. Only the marbles are simulated;
    tracks stay put and moving parts (lifts, seesaws, wheels…) follow scripted motion.</p>
    <h4>Sample courses</h4><p>The <b>Samples</b> button lists ready-made courses. <b>Open</b> one to look at and test it, or <b>Merge in</b>
    to add its parts beside your own track (undo with ${K('Ctrl', 'Z')}).</p>
    <h4>Your first run</h4>
    <ol><li>Add a <b>Spawner</b> from the Testing group and place it above where the run starts.</li>
    <li>Add track: ramps, spirals, funnels… Join them with <b>Quick connect</b> (${K('C')}) or bridge gaps with <b>Bridge</b> (${K('B')}).</li>
    <li>Put a <b>Finish</b> zone at the end.</li>
    <li>Press <b>▶ Test</b> (${K('Space')}). Parts turn to wood while the test runs. Press <b>■ Stop</b> to keep editing.</li></ol>
    <p>Save with ${K('Ctrl', 'S')}; <b>Save as</b> (${K('Ctrl', 'Shift', 'S')}) writes a new copy. Files are <code>.marble</code> (JSON), so you can share them.
    You can also drop a file onto the window to open it.</p>`,
  Camera: `
    <table><tr><td>Look around</td><td>hold right mouse and move</td></tr>
    <tr><td>Fly</td><td>${K('W')} ${K('A')} ${K('S')} ${K('D')}, ${K('E')} up, ${K('Q')} down, hold ${K('Shift')} to go faster</td></tr>
    <tr><td>Dolly</td><td>mouse wheel</td></tr>
    <tr><td>Focus on selection</td><td>${K('F')}</td></tr></table>
    <h4>Ride</h4><p>Tick <b>Ride</b> while testing to sit inside a marble and see the track from its point of view. <b>W A S D</b> gives it a gentle push
    (relative to where you face), <b>Tab</b> hops into the next marble, and right-drag glances around. Your marble is marked <b>you</b> in the results.</p>
    <h4>Follow mode</h4><p>Tick <b>Follow</b> while testing to chase the lead marble. Right-drag still turns the view around it and the wheel changes the distance.</p>`,
  Building: `
    <p>Click a part to select it. Parts are never dragged directly: use the gizmo.</p>
    <table><tr><td><b>Move</b> ${K('G')}</td><td>Drag an arrow to slide along X (red), Y (green) or Z (blue). With <b>Snap</b> on, positions land on 0.25.</td></tr>
    <tr><td><b>Rotate</b> ${K('R')}</td><td>Drag a ring. Angles always latch to 15°.</td></tr>
    <tr><td><b>Scale</b> ${K('T')}</td><td>Drag a cube to stretch along the part's own axis; the grey centre cube scales evenly.</td></tr></table>
    <h4>Shaping paths</h4>
    <p>Click a yellow dot on a path to select that point. Move works on the point alone.
    With Rotate, <b>middle points roll</b> (bank) the track, and the <b>first and last points</b> get three rings that aim the end of the track
    (blue = roll, green = left/right, red = up/down). With Scale, a point gets two handles that set the track's <b>width</b> (red) and <b>height</b> (green) there; the grey cube does both, and the track blends smoothly to its neighbours. In the Properties panel each point has its coordinates, roll, width ×, height ×, and for the ends, aim yaw and pitch.</p>
    <p>Use <b>+ Point at end</b>, <b>+ Insert after</b> and <b>Delete point</b> to add or remove points. Click the part body (or <b>Whole part</b>) to go back to the whole part.</p>
    <h4>Properties</h4><p>Everything about a part (size, shape, colours, speeds) is in the Properties panel. With nothing selected the panel shows the test settings for the whole track.</p>
    <p>Drag the edges of the side and bottom panels to resize them.</p>`,
  Tools: `
    <h4>Quick connect ${K('C')}</h4><p>Every part's openings show as cyan dots with arrows. Click an opening, then an opening on another part:
    the second part turns (around the vertical) and moves so the two line up, sitting slightly lower so marbles drop onto it.
    If the second part is a spline, it isn't moved: just the clicked end is pulled to the opening and aimed into it.</p>
    <h4>Bridge ${K('B')}</h4><p>Click the opening a marble leaves from, then the one it should arrive at. A curved enclosed tube is built between them.
    It's an ordinary path afterwards, so you can reshape it or change its profile.</p>
    <p>${K('Esc')} cancels either tool.</p>`,
  Parts: () => Object.entries(CATEGORIES).map(([cat, title]) => `<h4>${title}</h4><table>` +
    PALETTE.filter((e) => e.cat === cat).map((e) => `<tr><td><b>${e.label}</b></td><td>${e.desc}</td></tr>`).join('') + '</table>').join(''),
  Testing: `
    <p>Press <b>▶ Test</b> to drop marbles from every Spawner. <b>Pause</b>, change the <b>Speed</b> (0.25×–4×), and toggle <b>Trails</b> and <b>Follow</b>.</p>
    <p>The bottom panel lists each marble: status (rolling, finished, stuck, fell off), time, speed, top speed, distance, height dropped,
    and a split time for each <b>Checkpoint</b>.</p>
    <h4>Settings</h4><p>Click empty space so nothing is selected to see the test settings: gravity, physics rate, whether marbles hit each other,
    rolling resistance, air drag, what counts as stuck or lost, trail length, and whether finished marbles are removed.
    Marble size, weight, bounce, friction and launch speed are set on each Spawner. Settings are saved with the track.</p>
    <h4>Tips</h4><ul><li>Enclosed profiles (tubes) keep fast marbles from flying off.</li>
    <li>If marbles get stuck, check for gaps or lips between parts; Bridge is the easiest fix.</li>
    <li>Loops need about 10 m/s going in: a drop of roughly 7 units, or a Booster or Kicker just before the loop.</li></ul>`,
  Shortcuts: `
    <table><tr><td>${K('Space')}</td><td>Test / pause</td></tr><tr><td>${K('G')} ${K('R')} ${K('T')}</td><td>Move / rotate / scale</td></tr>
    <tr><td>${K('C')} / ${K('B')}</td><td>Quick connect / Bridge</td></tr><tr><td>${K('/')}</td><td>Search parts (${K('Enter')} adds the first match)</td></tr>
    <tr><td>${K('Del')}</td><td>Delete part or path point</td></tr><tr><td>${K('Ctrl', 'D')}</td><td>Duplicate</td></tr>
    <tr><td>${K('Ctrl', 'Z')} / ${K('Ctrl', 'Shift', 'Z')}</td><td>Undo / redo</td></tr><tr><td>${K('Ctrl', 'S')} / ${K('Ctrl', 'Shift', 'S')}</td><td>Save / save as</td></tr>
    <tr><td>${K('F')}</td><td>Focus selection</td></tr><tr><td>${K('Esc')}</td><td>Cancel tool / deselect</td></tr><tr><td>${K('F1')} or ${K('?')}</td><td>This help</td></tr></table>`,
};
let helpTab = 'Getting started';
function showHelpTab(t) {
  helpTab = t; const h = HELP[t]; $('helpBody').innerHTML = typeof h === 'function' ? h() : h;
  for (const b of $('helpTabs').children) b.classList.toggle('active', b.textContent === t);
}
for (const t of Object.keys(HELP)) { const b = document.createElement('button'); b.textContent = t; b.onclick = () => showHelpTab(t); $('helpTabs').append(b); }
function toggleHelp(on = $('help').hidden) { $('help').hidden = !on; if (on) { keys.clear(); showHelpTab(helpTab); } }
$('btnHelp').onclick = () => toggleHelp(true); $('helpClose').onclick = () => toggleHelp(false);
$('help').addEventListener('pointerdown', (e) => { if (e.target === $('help')) toggleHelp(false); });

// ---------- transform gizmo (move / rotate / scale) ----------
// Parts and path points are never dragged directly: clicking selects, then the gizmo handles transform.
// Path points: the first and last offer Move and Rotate (aims the track's end); middle points offer Move and Roll (banks the track).
// The whole part gets Move, Rotate and Scale.
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let drag = null;
function setRay(e) { const r = canvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera); }
const snapOn = () => $('chkSnap').checked;
const snapV = (v) => (snapOn() ? Math.round(v * 4) / 4 : fmt(v)); // positions snap to 0.25
const snapP = (v) => (snapOn() ? Math.round(v * 40) / 40 : fmt(v)); // spline points snap to 0.025
const AXES = [[0, '#e53935'], [1, '#43a047'], [2, '#1e88e5']];
const UNIT = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

function gizmoPart(obj, axis, color) { obj.traverse((o) => { o.renderOrder = 20; o.userData.axis = axis; o.userData.baseColor = color; }); return obj; }
const hitMat = new THREE.MeshBasicMaterial({ visible: false });
function arrow(axis, color, tip) {
  const a = new THREE.Group(), mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 10), mat); shaft.position.y = 0.5;
  const head = new THREE.Mesh(tip === 'cube' ? new THREE.BoxGeometry(0.2, 0.2, 0.2) : new THREE.ConeGeometry(0.11, 0.3, 16), mat); head.position.y = 1.12;
  const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.35, 8), hitMat); hit.position.y = 0.67;
  a.add(shaft, head, hit); a.quaternion.setFromUnitVectors(UNIT[1], UNIT[axis]);
  return gizmoPart(a, axis, color);
}
function ring(axis, color) {
  const r = new THREE.Group();
  // Rings live in the scene (depth-tested, fixed world size) rather than floating on top like the arrows.
  r.add(new THREE.Mesh(new THREE.TorusGeometry(1, 0.03, 8, 96), new THREE.MeshBasicMaterial({ color })));
  r.add(new THREE.Mesh(new THREE.TorusGeometry(1, 0.12, 6, 48), hitMat));
  r.quaternion.setFromUnitVectors(UNIT[2], UNIT[axis]);
  gizmoPart(r, axis, color); r.traverse((o) => (o.renderOrder = 0));
  return r;
}
const gizmos = { move: new THREE.Group(), rotate: new THREE.Group(), scale: new THREE.Group(), roll: new THREE.Group(), pscale: new THREE.Group() };
gizmos.pscale.add(arrow(0, '#e53935', 'cube'), arrow(1, '#43a047', 'cube'),
  gizmoPart(new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), new THREE.MeshBasicMaterial({ color: '#9e9e9e', depthTest: false })), 3, '#9e9e9e'));
gizmos.roll.add(ring(2, '#fb8c00')); gizmos.roll.scale.setScalar(1.1);
for (const [a, c] of AXES) { gizmos.move.add(arrow(a, c)); gizmos.rotate.add(ring(a, c)); gizmos.scale.add(arrow(a, c, 'cube')); }
gizmos.scale.add(gizmoPart(new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), new THREE.MeshBasicMaterial({ color: '#9e9e9e', depthTest: false })), 3, '#9e9e9e'));
const gizmo = new THREE.Group(); gizmo.visible = false; scene.add(gizmo);
for (const g of Object.values(gizmos)) gizmo.add(g);

const isEndPoint = () => selPoint === 0 || selPoint === selected.points.length - 1;
// Orientation of the track at its selected end: blue (Z) = along the track, so that ring is Roll;
// green (Y) = the track's up, red (X) = its side — both include the end's current roll.
function endFrame(p, g) {
  const pt = ports(p)[selPoint === 0 ? 0 : 1];
  const T = new THREE.Vector3(...pt.dir).transformDirection(g.matrixWorld); if (selPoint === 0) T.negate(); // along increasing points
  return trackFrame(p, T);
}
// Track frame at the selected point for a direction T: X = side (width), Y = up (height), Z = along; includes the point's roll.
function trackFrame(p, T) {
  let up = UNIT[1].clone(); if (Math.abs(T.dot(up)) > 0.95) up = UNIT[0].clone();
  const side = new THREE.Vector3().crossVectors(up, T).normalize(); up.crossVectors(T, side).normalize();
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, up, T));
  return new THREE.Quaternion().setFromAxisAngle(T, -rad(p.points[selPoint][3] || 0)).multiply(q);
}
function activeMode() { return selPoint < 0 ? mode : mode === 'scale' ? 'pscale' : mode !== 'rotate' ? 'move' : isEndPoint() ? 'rotate' : 'roll'; }
function placeGizmo() {
  gizmo.visible = !!selected && !sim && !connect;
  if (!gizmo.visible) return;
  for (const [k, g] of Object.entries(gizmos)) g.visible = k === activeMode();
  const g = groups.get(selected.id); g.updateMatrixWorld(true);
  if (selPoint >= 0) gizmo.position.set(...selected.points[selPoint]).applyMatrix4(g.matrixWorld); else gizmo.position.copy(g.position);
  // Scale works on the part's own axes, so that gizmo follows its rotation; move/rotate stay world-aligned.
  gizmo.quaternion.copy(activeMode() === 'scale' ? g.quaternion : new THREE.Quaternion());
  if (activeMode() === 'roll') {
    const t = new THREE.Vector3(...pointTangent(selected.points, selPoint)).transformDirection(g.matrixWorld);
    gizmo.quaternion.setFromUnitVectors(UNIT[2], t); // ring wraps around the track's direction at this point
  }
  if (activeMode() === 'rotate' && selPoint >= 0) gizmo.quaternion.copy(endFrame(selected, g));
  if (activeMode() === 'pscale') gizmo.quaternion.copy(trackFrame(selected, new THREE.Vector3(...pointTangent(selected.points, selPoint)).transformDirection(g.matrixWorld)));
  // Ring size is set by what is being rotated: around the part's bounds, or a fixed size around a path point.
  const R0 = selPoint >= 0 ? 1.2 : THREE.MathUtils.clamp(new THREE.Box3().setFromObject(g).getBoundingSphere(new THREE.Sphere()).radius * 0.9, 0.8, 12);
  if (!drag) gizmos.rotate.scale.setScalar(R0); // keep the ring steady while it is being dragged
}
function setMode(m) {
  mode = m; if (connect) endConnect();
  for (const k of ['move', 'rotate', 'scale']) $('mode-' + k).classList.toggle('active', k === m);
  placeGizmo();
}
// Parameter along the line O + D*t closest to the mouse ray.
function axisParam(O, D) {
  const P = ray.ray.origin, Rd = ray.ray.direction, w = O.clone().sub(P);
  const b = D.dot(Rd), d = D.dot(w), e2 = Rd.dot(w), den = 1 - b * b;
  return Math.abs(den) < 1e-6 ? null : (b * e2 - d) / den;
}
// Angle of the mouse around axis D through O, measured in the plane perpendicular to D.
function ringAngle(O, D) {
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(D, O), hit = ray.ray.intersectPlane(plane, new THREE.Vector3());
  if (!hit) return null;
  const b1 = Math.abs(D.y) < 0.9 ? new THREE.Vector3().crossVectors(UNIT[1], D).normalize() : new THREE.Vector3().crossVectors(UNIT[0], D).normalize();
  const b2 = new THREE.Vector3().crossVectors(D, b1), v = hit.sub(O);
  return Math.atan2(v.dot(b2), v.dot(b1));
}
function pickGizmo() { return gizmo.visible ? ray.intersectObjects(gizmos[activeMode()].children, true)[0] : null; }

function beginGizmoDrag(hit, e) {
  const axis = hit.object.userData.axis, O = gizmo.position.clone(), g = groups.get(selected.id), m = activeMode();
  const D = axis < 3 ? UNIT[axis].clone().applyQuaternion(gizmo.quaternion) : null;
  drag = { m, axis, O, D, g, started: false, y0: e.clientY };
  if (m === 'move') { drag.t0 = axisParam(O, D); drag.start = selPoint >= 0 ? O.clone() : new THREE.Vector3(...selected.pos); }
  if (m === 'rotate' || m === 'roll') {
    // Seen nearly edge-on the ring's plane is useless for picking an angle, so fall back to horizontal mouse motion.
    drag.screen = Math.abs(ray.ray.direction.dot(D)) < 0.2; drag.x0 = e.clientX; drag.acc = 0;
    drag.a0 = drag.screen ? 0 : ringAngle(O, D); drag.prev = drag.a0; drag.q0 = g.quaternion.clone(); if (m === 'roll') drag.r0 = selected.points[selPoint][3] || 0;
    if (selPoint >= 0) drag.r0 = selected.points[selPoint][3] || 0;
    if (m === 'rotate' && selPoint >= 0) drag.dir0 = new THREE.Vector3(...ports(selected)[selPoint === 0 ? 0 : 1].dir).transformDirection(g.matrixWorld); }
  if (m === 'scale') { drag.t0 = D ? axisParam(O, D) : 0; drag.s0 = [...(selected.scale || [1, 1, 1])]; }
  if (m === 'pscale') { const pt = selected.points[selPoint]; drag.t0 = D ? axisParam(O, D) : 0; drag.s0 = [pt[4] ?? 1, pt[5] ?? 1]; }
  if ((!['scale', 'pscale'].includes(m) || D) && (drag.t0 === null || drag.a0 === null)) drag = null;
  canvas.setPointerCapture(e.pointerId);
}
function gizmoDrag(e) {
  const p = selected;
  if (!drag.started) { pushUndo(); drag.started = true; }
  if (drag.m === 'move') {
    const t = axisParam(drag.O, drag.D); if (t === null) return;
    if (selPoint < 0) { p.pos[drag.axis] = snapV(drag.start.getComponent(drag.axis) + t - drag.t0); retransform(p); }
    else {
      const w = drag.start.clone(); w.setComponent(drag.axis, w.getComponent(drag.axis) + t - drag.t0);
      const l = drag.g.worldToLocal(w), old = p.points[selPoint]; p.points[selPoint] = [...[l.x, l.y, l.z].map(snapP), ...old.slice(3)]; rebuild(p); // keep roll and width/height scale
    }
  } else if (drag.m === 'rotate' || drag.m === 'roll') {
    let d;
    if (drag.screen) d = (e.clientX - drag.x0) * 0.01;
    else {
      const a = ringAngle(drag.O, drag.D); if (a === null) return;
      let step = a - drag.prev; step -= Math.round(step / (2 * Math.PI)) * 2 * Math.PI; // unwrap across ±180°
      drag.acc += step; drag.prev = a; d = drag.acc;
    } d = rad(Math.round(deg(d) / 15) * 15); // rotation always latches to 15°
    if (drag.m === 'roll' || (selPoint >= 0 && drag.axis === 2)) {
      const pt = p.points[selPoint]; pt[3] = snapA(drag.r0 - deg(d));
      rebuild(p); return;
    }
    if (selPoint >= 0) {
      // Aim the end of the track: turn its outward direction, leave every point where it is.
      const w = drag.dir0.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(drag.D, d));
      const l = w.transformDirection(drag.g.matrixWorld.clone().invert());
      const [yw, pc] = dirToYP([l.x, l.y, l.z]); p[selPoint === 0 ? 'startDir' : 'endDir'] = ypToDir(snapA(yw), snapA(pc));
      rebuild(p); return;
    }
    const q = new THREE.Quaternion().setFromAxisAngle(drag.D, d).multiply(drag.q0);
    const eu = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    p.rotX = snapA(deg(eu.x)); p.rotY = snapA(deg(eu.y)); p.rotZ = snapA(deg(eu.z)); retransform(p);
  } else {
    let f;
    if (drag.D) { const t = axisParam(drag.O, drag.D); if (t === null || Math.abs(drag.t0) < 1e-3) return; f = t / drag.t0; }
    else f = Math.exp((drag.y0 - e.clientY) * 0.006);
    const sn = (v) => Math.max(0.05, snapOn() ? Math.round(v * 20) / 20 : fmt(v));
    if (drag.m === 'pscale') {
      // Width/height of the track cross-section at this point only.
      const pt = p.points[selPoint], [w, h] = drag.s0.map((s, i) => (drag.axis === 3 || drag.axis === i ? Math.min(5, Math.max(0.3, sn(s * f))) : s));
      pt[3] ??= 0; pt[4] = w; pt[5] = h; rebuild(p); return;
    }
    p.scale = drag.s0.map((s, i) => (drag.axis === 3 || drag.axis === i ? sn(s * f) : s)); retransform(p);
  }
}

// ---------- quick connect ----------
// Click near an opening of the first part, then near an opening of the second: the second part is turned
// (about the vertical axis) and moved so its chosen opening lines up with the first part's.
function portWorld(p, i) {
  const g = groups.get(p.id); g.updateMatrixWorld(true); const pt = ports(p)[i];
  return { pos: new THREE.Vector3(...pt.pos).applyMatrix4(g.matrixWorld), dir: new THREE.Vector3(...pt.dir).transformDirection(g.matrixWorld) };
}
function showPorts() {
  portMarks.clear(); if (!connect) return;
  for (const p of pieces) ports(p).forEach((_, i) => {
    const w = portWorld(p, i), chosen = connect.from && connect.from.piece === p && connect.from.port === i;
    const m = new THREE.Mesh(new THREE.SphereGeometry(chosen ? 0.24 : 0.17, 16, 12), new THREE.MeshBasicMaterial({ color: chosen ? '#ff6a3d' : '#00acc1', depthTest: false }));
    m.renderOrder = 15; m.position.copy(w.pos); m.userData.port = { piece: p, port: i }; portMarks.add(m);
    const a = new THREE.ArrowHelper(w.dir, w.pos, 0.7, chosen ? '#ff6a3d' : '#00acc1', 0.2, 0.12);
    a.traverse((o) => { if (o.material) { o.material.depthTest = false; o.renderOrder = 15; } }); portMarks.add(a);
  });
}
// kind 'snap' moves the second part onto the first; kind 'bridge' builds a new tube between two openings.
const toolBtn = (kind) => $(kind === 'snap' ? 'btnConnect' : 'btnBridge');
function startConnect(kind = 'snap') {
  if (sim) return;
  if (connect) endConnect();
  connect = { kind, from: null }; toolBtn(kind).classList.add('active'); placeGizmo(); showPorts();
  toast(kind === 'snap' ? 'Quick connect: click the opening to connect FROM' : 'Bridge: click the opening the marble leaves from', 0);
}
function endConnect() { if (connect) toolBtn(connect.kind).classList.remove('active'); connect = null; portMarks.clear(); placeGizmo(); }
function cancelConnect() { endConnect(); toast('Cancelled'); }
function toggleTool(kind) { const same = connect?.kind === kind; if (connect) cancelConnect(); if (!same) startConnect(kind); }
function bridge(from, to) {
  const A = portWorld(from.piece, from.port), B = portWorld(to.piece, to.port), len = A.pos.distanceTo(B.pos);
  if (B.pos.y > A.pos.y + 0.05) toast('Warning: the bridge goes uphill, marbles may not make it', 3000);
  const r = TYPES.path.defaults().width / 2, k = Math.min(1.5, len / 3);
  // Ports are given at the opening's floor (or centre, for vertical openings). The tube is swept around its
  // centre line, so lift it by its radius on sideways openings; ends overlap 0.15 into each part to avoid a gap.
  const centre = (P) => P.pos.clone().addScaledVector(P.dir, -0.15).add(new THREE.Vector3(0, r * (1 - Math.abs(P.dir.y)), 0));
  const a = centre(A), b = centre(B);
  const world = [a, a.clone().addScaledVector(A.dir, k), b.clone().addScaledVector(B.dir, k), b];
  pushUndo();
  const p = { id: nextId++, type: 'path', pos: a.toArray().map(fmt), rotX: 0, rotY: 0, rotZ: 0, scale: [1, 1, 1], ...TYPES.path.defaults(),
    profile: 'tube', centered: true, startDir: A.dir.clone().negate().toArray().map(fmt), endDir: B.dir.clone().negate().toArray().map(fmt), points: world.map((w) => [w.x - a.x, w.y - a.y, w.z - a.z].map(fmt)) };
  pieces.push(p); rebuild(p); endConnect(); select(p); toast('Bridge tube created');
}
function pickPort() {
  const mh = ray.intersectObjects(portMarks.children.filter((m) => m.userData.port))[0];
  if (mh) return mh.object.userData.port;
  const hit = ray.intersectObjects([...groups.values()], true)[0]; if (!hit) return null;
  const piece = pieces.find((x) => x.id === hit.object.userData.pieceId), n = ports(piece).length; if (!n) return null;
  let best = 0; for (let i = 1; i < n; i++) if (portWorld(piece, i).pos.distanceTo(hit.point) < portWorld(piece, best).pos.distanceTo(hit.point)) best = i;
  return { piece, port: best };
}
function connectClick() {
  const pk = pickPort(); if (!pk) return;
  if (!connect.from) { connect.from = pk; showPorts(); toast(connect.kind === 'snap' ? 'Now click the opening on the part to attach' : 'Now click the opening the marble should arrive at', 0); return; }
  if (pk.piece === connect.from.piece) { connect.from = pk; showPorts(); return; }
  if (connect.kind === 'bridge') { bridge(connect.from, pk); return; }
  const A = portWorld(connect.from.piece, connect.from.port), B = pk.piece;
  pushUndo();
  // Sit B's opening just below A's so the marble drops onto it rather than hitting a lip.
  const drop = A.dir.y < -0.7 ? 0.35 : 0.06;
  const target = A.pos.clone().add(new THREE.Vector3(0, -drop, 0));
  if (B.type === 'path') {
    // Splines stretch instead of moving: only the clicked end goes to the opening, aimed back into it.
    const i = pk.port === 0 ? 0 : B.points.length - 1, g = groups.get(B.id), inv = g.matrixWorld.clone().invert();
    const l = target.clone().applyMatrix4(inv);
    B.points[i] = [l.x, l.y, l.z, ...B.points[i].slice(3)].map((v, k) => (k < 3 ? fmt(v) : v));
    const d = A.dir.clone().negate().transformDirection(inv); // B's end points out of B, i.e. into A
    B[i === 0 ? 'startDir' : 'endDir'] = d.toArray().map(fmt);
    rebuild(B);
    // A centred tube's opening isn't exactly at its end point; nudge the point so the opening lands on target.
    const off = target.clone().sub(portWorld(B, pk.port).pos).transformDirection(inv).multiplyScalar(target.distanceTo(portWorld(B, pk.port).pos));
    if (off.length() > 1e-3) { B.points[i] = B.points[i].map((v, k) => (k < 3 ? fmt(v + off.getComponent(k)) : v)); rebuild(B); }
    endConnect(); select(B, i); toast('Spline end connected');
    return;
  }
  let bw = portWorld(B, pk.port);
  // Turn B so its opening faces back into A's opening (horizontal directions only, so tracks stay upright).
  const want = A.dir.clone().negate();
  if (Math.hypot(want.x, want.z) > 0.3 && Math.hypot(bw.dir.x, bw.dir.z) > 0.3) {
    B.rotY = snapA((B.rotY || 0) + deg(Math.atan2(want.x, want.z) - Math.atan2(bw.dir.x, bw.dir.z)));
    retransform(B); bw = portWorld(B, pk.port);
  }
  B.pos = B.pos.map((v, i) => fmt(v + target.getComponent(i) - bw.pos.getComponent(i)));
  retransform(B);
  endConnect(); select(B); toast('Connected');
}

// ---------- mouse ----------
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || sim) return;
  setRay(e);
  if (connect) { connectClick(); return; }
  // Path points win over the gizmo, so the first point (which sits on the part's origin) can still be picked.
  const hh = ray.intersectObjects(handles.children)[0];
  if (hh && hh.object.userData.pointIndex !== selPoint) { select(selected, hh.object.userData.pointIndex); return; }
  const gh = pickGizmo();
  if (gh) { beginGizmoDrag(gh, e); return; }
  if (hh) return;
  const hit = ray.intersectObjects([...groups.values()], true).find((h) => h.object.visible);
  if (!hit) { select(null); return; }
  select(pieces.find((x) => x.id === hit.object.userData.pieceId)); // clicking the body always selects the whole part
});
canvas.addEventListener('pointermove', (e) => {
  if (look.active) return;
  setRay(e);
  if (drag) { gizmoDrag(e); return; }
  const gh = pickGizmo();
  gizmo.traverse((o) => o.material?.color?.set(gh && o.userData.axis === gh.object.userData.axis ? '#ffb300' : o.userData.baseColor));
  canvas.style.cursor = gh ? 'grab' : connect ? 'crosshair' : '';
});
canvas.addEventListener('pointerup', () => { if (drag?.started) { renderProps(); if (selPoint < 0) rebuild(selected); } drag = null; });

addEventListener('keydown', (e) => {
  if (e.key === 'F1') { e.preventDefault(); toggleHelp(); return; }
  if (!$('help').hidden) { if (e.key === 'Escape') toggleHelp(false); return; }
  if (!$('samples').hidden) { if (e.key === 'Escape') toggleSamples(false); return; }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === '?') { toggleHelp(true); return; }
  if (e.key === '/') { e.preventDefault(); $('partSearch').focus(); $('partSearch').select(); return; }
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); e.shiftKey ? saveAs() : save(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); if (selected && !sim) duplicate(selected); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if ('wasdqe'.includes(k) || k === 'shift') { keys.add(k); return; }
  if (k === 'tab' && ride.on) { e.preventDefault(); rideNext(); return; }
  if (k === ' ') { e.preventDefault(); sim ? togglePause() : play(); return; }
  if (k === 'escape') { if (connect) cancelConnect(); else select(null); return; }
  if (sim) return;
  if (k === 'g') setMode('move'); else if (k === 'r') setMode('rotate'); else if (k === 't') setMode('scale');
  else if (k === 'c') toggleTool('snap'); else if (k === 'b') toggleTool('bridge');
  else if (k === 'f' && selected) { const c = new THREE.Box3().setFromObject(groups.get(selected.id)).getCenter(new THREE.Vector3()); camera.position.copy(c).add(forward().multiplyScalar(-8)); lookAt(c); }
  else if (selected && (k === 'delete' || k === 'backspace')) { if (selPoint >= 0 && selected.points?.length > 2) edit(() => { selected.points.splice(selPoint, 1); selPoint = -1; }); else deletePiece(selected); }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
for (const k of ['move', 'rotate', 'scale']) $('mode-' + k).onclick = () => setMode(k);
$('btnConnect').onclick = () => toggleTool('snap'); $('btnBridge').onclick = () => toggleTool('bridge');

// ---------- simulation ----------
function setRunning(running) {
  $('btnPlay').disabled = running; $('btnStop').disabled = !running; $('btnPause').disabled = !running;
  for (const id of ['btnSamples', 'btnNew', 'btnOpen', 'btnUndo', 'btnRedo', 'btnConnect', 'btnBridge', 'mode-move', 'mode-rotate', 'mode-scale']) $(id).disabled = running;
  document.querySelectorAll('#partList button').forEach((b) => (b.disabled = running)); $('partSearch').disabled = running;
  $('propBody').style.pointerEvents = running ? 'none' : ''; $('propBody').style.opacity = running ? 0.5 : 1;
}
// While testing, every part is shown in light-brown wood; the edit colours come back on stop.
function applyWood(on) {
  for (const p of pieces) {
    if (p.type === 'spawner' || p.type === 'finish' || p.type === 'checkpoint') continue; // markers keep their look
    groups.get(p.id).traverse((o) => {
      if (!o.isMesh) return;
      if (on) { o.userData.edit = { mat: o.material, geo: o.geometry }; o.material = woodMaterial(o.material.transparent); o.geometry = ensureWoodUVs(o.geometry); }
      else if (o.userData.edit) { o.material = o.userData.edit.mat; o.geometry = o.userData.edit.geo; delete o.userData.edit; }
    });
  }
}
function play() {
  if (sim) return;
  if (!pieces.some((p) => p.type === 'spawner')) { toast('Add a Marble spawner first'); return; }
  if (connect) cancelConnect();
  ride.id = null; applyWood(true); sim = new Sim(RAPIER, scene, pieces, groups, settings); sim.trails = $('chkTrails').checked; paused = false;
  refreshSelectionVisuals(); setRunning(true); $('btnPause').textContent = 'Pause';
}
function stop() { if (!sim) return; sim.dispose(); sim = null; applyWood(false); setRunning(false); refreshSelectionVisuals(); $('hudTime').textContent = 'Edit mode'; }
function togglePause() { paused = !paused; $('btnPause').textContent = paused ? 'Resume' : 'Pause'; }
$('btnPlay').onclick = play; $('btnStop').onclick = stop; $('btnPause').onclick = togglePause;
$('chkTrails').onchange = () => sim && (sim.trails = $('chkTrails').checked);

const STATUS = { rolling: '<span>rolling</span>', finished: '<span class="ok">finished</span>', stuck: '<span class="bad">stuck</span>', lost: '<span class="bad">fell off</span>' };
function renderHud() {
  if (!sim) { $('hudTable').innerHTML = `<span class="hint">${pieces.length} parts. Press Test (Space) to drop marbles.</span>`; return; }
  const ms = sim.marbles, fin = ms.filter((m) => m.status === 'finished');
  const best = fin.length ? Math.min(...fin.map((m) => m.finishT)) : null;
  $('hudTime').innerHTML = `t = ${sim.time.toFixed(2)} s &nbsp; · &nbsp; marbles ${ms.length} &nbsp; · &nbsp; finished ${fin.length}` +
    (best !== null ? ` &nbsp; · &nbsp; best ${best.toFixed(2)} s` : '') + (sim.done ? ' &nbsp; · &nbsp; <b>run complete</b>' : '') + (paused ? ' &nbsp; · &nbsp; paused' : '');
  const cps = sim.checkpoints.map((c) => c.p);
  $('hudTable').innerHTML = '<table><tr><th>#</th><th>Status</th><th>Time s</th><th>Speed m/s</th><th>Max m/s</th><th>Distance m</th><th>Drop m</th>' +
    cps.map((c) => `<th>${c.name || 'CP #' + c.id} s</th>`).join('') + '</tr>' +
    ms.map((m) => `<tr><td><span style="color:${m.color}">●</span> ${m.id}${ride.on && m.id === ride.id ? ' <b>you</b>' : ''}</td><td>${STATUS[m.status]}</td>` +
      `<td>${(m.finishT ?? m.endT ?? sim.time - m.spawnT).toFixed(2)}</td><td>${(m.body ? m.v : m.finishV ?? 0).toFixed(2)}</td>` +
      `<td>${m.vmax.toFixed(2)}</td><td>${m.dist.toFixed(2)}</td><td>${(m.startY - m.pos.y).toFixed(2)}</td>` +
      cps.map((c) => `<td>${m.splits[c.id] !== undefined ? m.splits[c.id].toFixed(2) : '–'}</td>`).join('') + '</tr>').join('') + '</table>';
}

// ---------- files ----------
function serialize() {
  const target = camera.position.clone().add(forward());
  return JSON.stringify({ app: 'marble-lab', version: 3, camera: { pos: camera.position.toArray(), target: target.toArray() }, settings, pieces }, null, 1);
}
// Save writes straight back to the current file; Save as (or the first save) asks where.
async function save() {
  if (!filePath || !window.files?.write) return saveAs();
  await window.files.write(filePath, serialize()); markDirty(false); toast('Saved ' + filePath);
}
async function saveAs() {
  if (!window.files) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([serialize()])); a.download = 'track.marble'; a.click(); return; }
  const r = await window.files.save({ name: filePath || 'track.marble', data: serialize(), filters: [{ name: 'Marble track', extensions: ['marble'] }] });
  if (r) { filePath = r; markDirty(false); toast('Saved ' + r); }
}
function loadDoc(doc) {
  if (!Array.isArray(doc.pieces)) throw new Error('Not a marble track file');
  stop(); if (connect) cancelConnect(); settings = { ...defaultSettings(), ...(doc.settings || {}) }; load(doc.pieces);
  if (doc.camera) { camera.position.fromArray(doc.camera.pos); lookAt(new THREE.Vector3().fromArray(doc.camera.target)); }
}
const okToDiscard = () => !dirty || confirm('This track has unsaved changes. Discard them?');
async function open() {
  if (!window.files || !okToDiscard()) return;
  const r = await window.files.open(); if (!r) return;
  try { loadDoc(JSON.parse(r.data)); filePath = r.path; markDirty(false); toast('Opened ' + r.path); } catch (err) { toast('Could not open: ' + err.message); }
}
$('btnSave').onclick = save; $('btnSaveAs').onclick = saveAs; $('btnOpen').onclick = open;
$('btnNew').onclick = () => { if (dirty ? okToDiscard() : confirm('Start a new empty track?')) { pushUndo(); settings = defaultSettings(); load([], false); filePath = null; markDirty(false); } };
$('btnUndo').onclick = undo; $('btnRedo').onclick = redo;
$('btnShot').onclick = async () => {
  renderer.render(scene, camera);
  const data = canvas.toDataURL('image/png').split(',')[1];
  if (window.files) { const r = await window.files.save({ name: 'marble-track.png', data, binary: true, filters: [{ name: 'PNG', extensions: ['png'] }] }); if (r) toast('Saved ' + r); }
};
canvas.addEventListener('dragover', (e) => e.preventDefault());
canvas.addEventListener('drop', async (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && okToDiscard()) try { loadDoc(JSON.parse(await f.text())); filePath = null; markDirty(false); } catch (err) { toast('Could not open: ' + err.message); } });

// ---------- sample courses ----------
function openSample(smp) {
  if (!okToDiscard()) return;
  loadDoc({ camera: smp.camera, pieces: instantiate(smp, 1) }); filePath = null; markDirty(false); toggleSamples(false); toast('Opened sample: ' + smp.name);
}
// Sample of the day: fetched fresh from sample.marble at the root of the GitHub repo on every click.
const DAILY_URL = 'https://raw.githubusercontent.com/Sluplersfe/marble-lab/main/sample.marble';
async function openDaily() {
  if (sim) { toast('Stop the test first'); return; }
  if (!okToDiscard()) return;
  toast('Downloading sample of the day…');
  try {
    const r = await fetch(DAILY_URL + '?t=' + Date.now(), { cache: 'no-store' }); // the query skips GitHub's CDN cache
    if (!r.ok) throw new Error('HTTP ' + r.status);
    loadDoc(JSON.parse(await r.text())); filePath = null; markDirty(false); toast('Opened sample of the day');
  } catch (err) { toast('Could not load sample of the day: ' + err.message); }
}
$('btnDaily').onclick = openDaily;
// Merge: add the sample's parts (fresh ids, links kept) beside the current track, clear of it, and look at them.
function mergeSample(smp) {
  if (sim) return;
  const added = instantiate(smp, nextId);
  const cur = new THREE.Box3(); for (const g of groups.values()) cur.expandByObject(g);
  const xs = added.map((p) => p.pos[0]), zs = added.map((p) => p.pos[2]);
  const off = cur.isEmpty() ? [0, 0, 0] : [Math.ceil(cur.max.x + 6 - Math.min(...xs)), 0, Math.round((cur.min.z + cur.max.z) / 2 - (Math.min(...zs) + Math.max(...zs)) / 2)];
  pushUndo();
  for (const p of added) { p.pos = p.pos.map((v, i) => fmt(v + off[i])); pieces.push(p); rebuild(p); }
  nextId = Math.max(nextId, ...added.map((p) => p.id + 1));
  camera.position.fromArray(smp.camera.pos.map((v, i) => v + off[i])); lookAt(new THREE.Vector3(...smp.camera.target.map((v, i) => v + off[i])));
  select(null); toggleSamples(false); toast(`Merged ${smp.name}: ${added.length} parts added (Ctrl+Z to undo)`);
}
for (const smp of SAMPLES) {
  const row = document.createElement('div'); row.className = 'sample';
  row.innerHTML = `<div><b>${smp.name}</b><p class="hint">${smp.desc}</p></div>`;
  const o = document.createElement('button'); o.textContent = 'Open'; o.title = 'Replace the current track with this sample'; o.onclick = () => openSample(smp);
  const m = document.createElement('button'); m.textContent = 'Merge in'; m.title = 'Add this sample beside your current track'; m.onclick = () => mergeSample(smp);
  row.append(o, m); $('samplesBody').append(row);
}
function toggleSamples(on = $('samples').hidden) { if (on && sim) { toast('Stop the test first'); return; } $('samples').hidden = !on; if (on) keys.clear(); }
$('btnSamples').onclick = () => toggleSamples(true); $('samplesClose').onclick = () => toggleSamples(false);
$('samples').addEventListener('pointerdown', (e) => { if (e.target === $('samples')) toggleSamples(false); });

// ---------- ride a marble ----------
const live = () => sim ? sim.marbles.filter((x) => x.body && x.status !== 'finished') : [];
function rideTarget() {
  const ms = live(); if (!ms.length) return null;
  let m = ms.find((x) => x.id === ride.id);
  if (!m) { m = ms[0]; ride.id = m.id; }
  return m;
}
function rideNext() {
  const ms = live(); if (!ms.length) return;
  const i = ms.findIndex((x) => x.id === ride.id);
  ride.id = ms[(i + 1) % ms.length].id; toast('Riding marble ' + ride.id);
}
function rideCamera(m, dt) {
  if (!ride.on) { ride.on = true; ride.heading.copy(forward()); ride.yaw = ride.pitch = 0; follow.target = null; }
  const v = m.body.linvel(), vel = new THREE.Vector3(v.x, v.y, v.z);
  if (vel.length() > 0.3) ride.heading.lerp(vel.normalize(), 1 - Math.exp(-dt * 5)).normalize(); // smooth so bumps don't shake the view
  if (!look.active) { const k = Math.exp(-dt * 3); ride.yaw *= k; ride.pitch *= k; } // glance springs back
  const yaw = Math.atan2(-ride.heading.x, -ride.heading.z), pitch = THREE.MathUtils.clamp(Math.asin(ride.heading.y), -0.7, 0.7);
  camera.rotation.set(pitch + ride.pitch, yaw + ride.yaw, 0);
  camera.position.copy(m.mesh.position).y += m.radius * 0.25;
  // You don't see your own marble or its trail.
  for (const x of sim.marbles) if (x.mesh) { x.mesh.visible = x !== m; x.trail.visible = sim.trails && x !== m; }
  // WASD rolls the marble relative to where you face (flat, so it can't fly).
  const f = new THREE.Vector3(-Math.sin(yaw + ride.yaw), 0, -Math.cos(yaw + ride.yaw)), r = new THREE.Vector3(-f.z, 0, f.x), d = new THREE.Vector3();
  if (keys.has('w')) d.add(f); if (keys.has('s')) d.sub(f); if (keys.has('d')) d.add(r); if (keys.has('a')) d.sub(r);
  sim.steer = d.lengthSq() ? { m, dir: d.normalize() } : null;
}
function endRide() {
  ride.on = false; if (sim) { sim.steer = null; for (const x of sim.marbles) if (x.mesh) x.mesh.visible = true; }
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ'); look.yaw = e.y; look.pitch = e.x; // carry on from this view
}
$('chkRide').onchange = () => { $('chkRide').blur(); if (!$('chkRide').checked && ride.on) endRide(); }; // blur so WASD and Tab reach the ride

// ---------- loop ----------
try { const c = localStorage.getItem('chkAuto'); if (c) $('chkAuto').checked = c === '1'; } catch {}
$('chkAuto').onchange = () => { try { localStorage.setItem('chkAuto', $('chkAuto').checked ? '1' : '0'); } catch {} if ($('chkAuto').checked && dirty) autoSave(); };
let backup = null; try { backup = localStorage.getItem('autosave'); } catch {}
if (backup && confirm('Restore the untitled track that was auto-saved last time?')) { try { loadDoc(JSON.parse(backup)); markDirty(true); } catch { loadDoc(structuredClone(DEMO)); } }
else { loadDoc(structuredClone(DEMO)); try { localStorage.removeItem('autosave'); } catch {} }
setMode('move');
let last = performance.now(), hudT = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (sim && !paused) sim.step(dt, parseFloat($('selSpeed').value));
  const rider = sim && $('chkRide').checked ? rideTarget() : null;
  if (ride.on && !rider) endRide();
  const m = !rider && sim && $('chkFollow').checked && sim.marbles.find((x) => x.body);
  if (rider) rideCamera(rider, dt);
  else if (m) {
    // Chase cam: orbit the lead marble. Right-drag still turns the view (the camera swings around the marble),
    // the wheel changes the distance; WASD movement is ignored while following.
    if (!follow.target) { follow.target = m.mesh.position.clone(); lookAt(m.mesh.position); follow.dist = Math.min(8, camera.position.distanceTo(m.mesh.position)); }
    follow.target.lerp(m.mesh.position, 0.12);
    camera.rotation.set(look.pitch, look.yaw, 0);
    camera.position.copy(follow.target).addScaledVector(forward(), -follow.dist);
  } else { follow.target = null; updateCamera(dt); }
  if (gizmo.visible) { const k = camera.position.distanceTo(gizmo.position) * 0.09; gizmos.move.scale.setScalar(k); gizmos.scale.scale.setScalar(k); gizmos.pscale.scale.setScalar(k); }
  if ((hudT += dt) > 0.1) { hudT = 0; renderHud(); }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__app = { get sim() { return sim; }, get pieces() { return pieces; }, play, stop, loadDoc };

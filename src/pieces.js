// Part definitions: parameter schemas, geometry builders and (for moving parts) scripted controllers.
// Only marbles are physically simulated; moving parts are kinematic and driven by the controllers below.
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const rad = THREE.MathUtils.degToRad;

const matCache = new Map();
export function material(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial({
      color, roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide,
      transparent: opts.opacity !== undefined, opacity: opts.opacity ?? 1, depthWrite: opts.opacity === undefined,
    }));
  }
  return matCache.get(key);
}

// Light-brown wood used for every part while a test is running.
let woodTex = null;
function woodTexture() {
  if (woodTex) return woodTex;
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const x = c.getContext('2d');
  x.fillStyle = '#d8b88a'; x.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 140; i++) {
    const y = Math.random() * 512, amp = 2 + Math.random() * 6, f = 0.004 + Math.random() * 0.01, ph = Math.random() * 6;
    x.strokeStyle = Math.random() < 0.5 ? `rgba(150,105,60,${0.08 + Math.random() * 0.18})` : `rgba(240,215,175,${0.1 + Math.random() * 0.2})`;
    x.lineWidth = 0.6 + Math.random() * 2.2; x.beginPath();
    for (let s = 0; s <= 512; s += 8) { const yy = y + Math.sin(s * f + ph) * amp; s ? x.lineTo(s, yy) : x.moveTo(s, yy); }
    x.stroke();
  }
  woodTex = new THREE.CanvasTexture(c);
  woodTex.colorSpace = THREE.SRGBColorSpace; woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping; woodTex.anisotropy = 8;
  return woodTex;
}
const woodMats = {};
export function woodMaterial(transparent) {
  const k = transparent ? 't' : 'o';
  woodMats[k] ??= new THREE.MeshStandardMaterial({
    map: woodTexture(), color: '#ffffff', roughness: 0.62, metalness: 0, side: THREE.DoubleSide,
    transparent, opacity: transparent ? 0.45 : 1, depthWrite: !transparent,
  });
  return woodMats[k];
}

// Box-style UVs from world-ish positions so the grain tiles evenly on swept/lathe geometry.
export function ensureWoodUVs(geom) {
  if (geom.userData.woodUV) return geom.userData.woodUV;
  const g = geom.clone(), p = g.attributes.position; g.computeVertexNormals();
  const n = g.attributes.normal, uv = new Float32Array(p.count * 2), s = 0.35;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    const [u, v] = ay >= ax && ay >= az ? [p.getX(i), p.getZ(i)] : ax >= az ? [p.getZ(i), p.getY(i)] : [p.getX(i), p.getY(i)];
    uv[i * 2] = u * s; uv[i * 2 + 1] = v * s;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geom.userData.woodUV = g;
  return g;
}

function mesh(geom, color, { collide = true, opacity, friction = 0.5, restitution = 0.25 } = {}) {
  const m = new THREE.Mesh(geom, material(color, { opacity }));
  m.castShadow = opacity === undefined; m.receiveShadow = true;
  m.userData.collide = collide;
  m.userData.phys = { friction, restitution };
  return m;
}

// ---------- path sweeping ----------
function profileFor(kind, w, h) {
  const r = w / 2;
  switch (kind) {
    case 'gutter': {
      const pts = [];
      if (h > r) pts.push([-r, h]);
      for (let i = 0; i <= 12; i++) { const a = Math.PI + (i / 12) * Math.PI; pts.push([r * Math.cos(a), r + r * Math.sin(a)]); }
      if (h > r) pts.push([r, h]);
      return { pts, closed: false };
    }
    case 'boxtube': { const H = Math.max(h, w); return { pts: [[-r, 0], [r, 0], [r, H], [-r, H]], closed: true }; }
    case 'tube': {
      const pts = [];
      for (let i = 0; i < 18; i++) { const a = -Math.PI / 2 + (i / 18) * Math.PI * 2; pts.push([r * Math.cos(a), r + r * Math.sin(a)]); }
      return { pts, closed: true };
    }
    default: return { pts: [[-r, h], [-r, 0], [r, 0], [r, h]], closed: false };
  }
}

// centered: the path runs through the middle of the profile instead of along its floor, so the
// result does not depend on how the curve's frame happens to be oriented (used for bridge tubes).
// centered: the path runs through the middle of the profile instead of along its floor, so the
// result does not depend on how the curve's frame happens to be oriented (used for bridge tubes).
// ends: optional outward directions { start, end } for the first/last point; otherwise they follow the neighbours.
export function sweep(points, profileKind, w, h, centered = false, ends = {}) {
  let { pts: prof, closed } = profileFor(profileKind, w, h);
  if (centered) { const mid = (Math.min(...prof.map((q) => q[1])) + Math.max(...prof.map((q) => q[1]))) / 2; prof = prof.map(([a, b]) => [a, b - mid]); }
  const enclosed = profileKind === 'tube' || profileKind === 'boxtube';
  // Hidden guide points beyond each end set the direction the track leaves/enters at its ends.
  const P = points.map(v3), L = P.length;
  const ghost = (end, next, dir) => end.clone().add((dir ? v3(dir).normalize() : end.clone().sub(next).normalize()).multiplyScalar(end.distanceTo(next)));
  const curve = new THREE.CatmullRomCurve3([ghost(P[0], P[1], ends.start), ...P, ghost(P[L - 1], P[L - 2], ends.end)], false, 'centripetal');
  // Per-point extras: [3] roll in degrees, [4] width scale, [5] height scale; all eased between points.
  const M = L + 2, rolls = points.map((q) => rad(q[3] || 0)), sw = points.map((q) => q[4] ?? 1), sh = points.map((q) => q[5] ?? 1);
  const samples = []; // [t, roll]
  for (let j = 0; j < L - 1; j++) {
    // Enough samples for both length (0.1 apart) and turning (≤1.5° between samples): on tight curves a coarser
    // mesh is a run of flat facets, and a marble loses energy bumping across each facet edge.
    const t0 = (j + 1) / (M - 1), t1 = (j + 2) / (M - 1);
    let turn = 0; for (let q = 0; q < 8; q++) turn += curve.getTangent(t0 + ((t1 - t0) * q) / 8).angleTo(curve.getTangent(t0 + ((t1 - t0) * (q + 1)) / 8));
    const k = Math.max(2, Math.ceil(P[j].distanceTo(P[j + 1]) / 0.1), Math.ceil(turn / rad(1.5)));
    for (let i = j ? 1 : 0; i <= k; i++) {
      const f = i / k, e = f * f * (3 - 2 * f), mix = (a) => a[j] + (a[j + 1] - a[j]) * e;
      samples.push([(j + 1 + f) / (M - 1), mix(rolls), mix(sw), mix(sh)]);
    }
  }
  const n = samples.length - 1, m = prof.length, pos = [], idx = [];
  let S = null;
  for (const [t, roll, kw, kh] of samples) {
    const C = curve.getPoint(t), T = curve.getTangent(t).normalize();
    const upOk = Math.abs(T.y) < 0.9;
    if (!S) S = new THREE.Vector3().crossVectors(T, upOk ? UP : new THREE.Vector3(1, 0, 0)).normalize();
    else S.addScaledVector(T, -S.dot(T)).normalize(); // parallel transport
    if (!enclosed && upOk) S.crossVectors(T, UP).normalize(); // keep open tracks level
    let N = new THREE.Vector3().crossVectors(S, T).normalize(), Sr = S;
    if (roll) {
      const c = Math.cos(roll), sn = Math.sin(roll);
      Sr = S.clone().multiplyScalar(c).addScaledVector(N, sn); N = N.clone().multiplyScalar(c).addScaledVector(S, -sn);
    }
    for (let [s, u] of prof) { s *= kw; u *= kh; pos.push(C.x + Sr.x * s + N.x * u, C.y + Sr.y * s + N.y * u, C.z + Sr.z * s + N.z * u); }
  }
  const segs = closed ? m : m - 1;
  for (let i = 0; i < n; i++) for (let j = 0; j < segs; j++) {
    const a = i * m + j, b = i * m + (j + 1) % m, c = (i + 1) * m + j, d = (i + 1) * m + (j + 1) % m;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

function spiralPoints(p) {
  const pts = [], steps = Math.max(8, Math.round(p.turns * 16)), A = p.turns * Math.PI * 2;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * A;
    pts.push([p.radius * Math.cos(a) - p.radius, -p.drop * (i / steps), p.radius * Math.sin(a) * (p.clockwise ? -1 : 1)]);
  }
  return pts;
}

// ---------- common param blocks ----------
const PROFILE = { key: 'profile', label: 'Profile', type: 'select', options: [['channel', 'Open channel'], ['gutter', 'Round gutter'], ['boxtube', 'Box tube (enclosed)'], ['tube', 'Round tube (enclosed)']] };
const TRACK = [PROFILE,
  { key: 'width', label: 'Inner width', min: 0.5, max: 3, step: 0.05 },
  { key: 'wall', label: 'Wall height', min: 0.1, max: 2, step: 0.05 },
  { key: 'friction', label: 'Friction', min: 0, max: 1.5, step: 0.05 },
  { key: 'color', label: 'Color', type: 'color' }];
const trackDefaults = { profile: 'channel', width: 1.0, wall: 0.4, friction: 0.4, color: '#4f7dbf' };

function trackMesh(p, pts) {
  const enclosed = p.profile === 'tube' || p.profile === 'boxtube';
  return mesh(sweep(pts, p.profile, p.width, p.wall, p.centered, { start: p.startDir, end: p.endDir }), p.color, { opacity: enclosed ? 0.35 : undefined, friction: p.friction });
}

function post(group, x, z, top, bottom = 0) {
  const h = top - bottom; if (h <= 0.05) return;
  const m = mesh(new THREE.CylinderGeometry(0.06, 0.06, h, 8), '#5b6370', { collide: false });
  m.position.set(x, bottom + h / 2, z); group.add(m);
}


// ---------- generated shapes ----------
function loopPoints(p) {
  // Lead in along +X, one vertical loop drifting sideways so the track clears itself, lead out along +X.
  // Shift sideways by enough that the way down clears the lead-in and the way up clears the lead-out (~3/4 of the shift each).
  const R = p.radius, off = (p.width + 0.25) / 0.75, pts = [[-p.lead, 0.15, 0]];
  for (let i = 0; i <= 16; i++) { const a = -Math.PI / 2 + (i / 16) * Math.PI * 2; pts.push([R * Math.cos(a), R + R * Math.sin(a), off * (i / 16)]); }
  pts.push([p.lead, -0.15, off]);
  return pts;
}
function zigzagPoints(p) {
  const pts = [], r = p.spacing / 2;
  for (let i = 0; i < p.legs; i++) {
    const fwd = i % 2 === 0, x0 = fwd ? 0 : p.legLength, x1 = fwd ? p.legLength : 0, y0 = -i * (p.legDrop + 0.3), z = i * p.spacing;
    pts.push([x0, y0, z], [x1, y0 - p.legDrop, z]);
    if (i < p.legs - 1) pts.push([x1 + (fwd ? r : -r), y0 - p.legDrop - 0.15, z + r]); // U-turn
  }
  return pts;
}
// Peg positions for the peg board, spaced so a marble of the given size always fits between pegs, rows and walls.
function pegLayout(p) {
  const W = p.width, H = p.height, d = p.depth, pr = p.pegRadius, clr = p.clearance;
  const cols = Math.max(1, Math.min(p.cols, Math.floor(W / (clr + 2 * pr + 0.02)))), sp = W / cols;
  // Staggered rows: neighbours on the diagonal must also be at least a marble apart.
  const dy = Math.max(0.45, Math.sqrt(Math.max(0, (clr + 2 * pr + 0.04) ** 2 - (sp / 2) ** 2)));
  // Wall triangles stick in on the rows whose edge pegs are left out; their tips stay a marble's width from the nearest peg.
  const tri = cols > 1 ? Math.min(0.45, 1.5 * sp - pr - clr - 0.02) : 0;
  const pegs = [], triangles = [];
  for (let r = 0; r < p.rows; r++) {
    const y = H - 0.5 - r * dy; if (y < 0.5) break;
    if (r % 2 === 0) {
      for (let c = 1; c < cols - 1; c++) pegs.push([-W / 2 + sp * (c + 0.5), y]); // edge pegs left out: too close to the walls
      if (cols === 1) pegs.push([0, y]);
      if (tri > 0.12) triangles.push(y);
    } else for (let c = 1; c < cols; c++) pegs.push([-W / 2 + sp * c, y]);
  }
  // Reverse funnel: from a narrow inlet at the top, two 45° walls widen out to the board's sides at the top of the peg field.
  const inlet = clr / 2 + 0.15, top = p.distributor ? H + (W / 2 - inlet) : H;
  return { W, H, d, sp, dy, cols, pegs, triangles, tri, top, inlet };
}

// Mesh from quads [a, b, c, d] or triangles [a, b, c] (THREE.Vector3s, in order around the face).
function quadsGeo(quads) {
  const pos = [];
  for (const [a, b, c, d] of quads) for (const v of d ? [a, b, c, a, c, d] : [a, b, c]) pos.push(v.x, v.y, v.z); // 3 points = a triangle
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals();
  return geo;
}
// Sloping tray along +X whose width goes from w0 (at x = 0) to w1 (at x = len), with side walls.
function trayGeo(len, w0, w1, drop) {
  const V = (x, z) => new THREE.Vector3(x, -drop * (x / len), z), up = 0.5;
  const a = V(0, -w0 / 2), b = V(len, -w1 / 2), c = V(len, w1 / 2), d = V(0, w0 / 2);
  const wall = (p, q) => [p, q, q.clone().setY(q.y + up), p.clone().setY(p.y + up)];
  return quadsGeo([[a, b, c, d], wall(a, b), wall(d, c)]);
}

// ---------- part types ----------
export const TYPES = {
  path: {
    label: 'Path', editPoints: true,
    defaults: () => ({ ...trackDefaults, points: [[0, 0, 0], [4, -1, 0]] }),
    params: TRACK,
    build(p, g) { g.add(trackMesh(p, p.points)); },
  },
  spiral: {
    label: 'Spiral',
    defaults: () => ({ ...trackDefaults, profile: 'gutter', wall: 0.6, radius: 2.5, turns: 2, drop: 4, clockwise: false }),
    params: [{ key: 'radius', label: 'Radius', min: 0.8, max: 10, step: 0.1 }, { key: 'turns', label: 'Turns', min: 0.25, max: 10, step: 0.25 },
      { key: 'drop', label: 'Drop', min: 0.2, max: 30, step: 0.1 }, { key: 'clockwise', label: 'Clockwise', type: 'bool' }, ...TRACK],
    build(p, g) { g.add(trackMesh(p, spiralPoints(p))); post(g, -p.radius, 0, 0, -p.drop - 1); },
  },
  funnel: {
    label: 'Funnel',
    defaults: () => ({ radius: 2.5, height: 1.6, hole: 0.45, spout: 0.6, friction: 0.3, color: '#bf8a4f' }),
    params: [{ key: 'radius', label: 'Top radius', min: 0.8, max: 8, step: 0.1 }, { key: 'height', label: 'Height', min: 0.3, max: 6, step: 0.1 },
      { key: 'hole', label: 'Hole radius', min: 0.3, max: 2, step: 0.05 }, { key: 'spout', label: 'Spout length', min: 0, max: 3, step: 0.1 },
      { key: 'friction', label: 'Friction', min: 0, max: 1.5, step: 0.05 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      const prof = [new THREE.Vector2(p.hole, -p.spout), new THREE.Vector2(p.hole, 0), new THREE.Vector2(p.radius, p.height), new THREE.Vector2(p.radius, p.height + 0.3)];
      g.add(mesh(new THREE.LatheGeometry(prof, 40), p.color, { friction: p.friction }));
    },
  },
  pegboard: {
    label: 'Peg board',
    desc: 'Plinko board behind glass. Optional reverse-funnel top; triangles on the side walls steer marbles back into the pegs.',
    defaults: () => ({ width: 5, height: 5, depth: 0.95, rows: 8, cols: 5, pegRadius: 0.08, clearance: 0.8, bounce: 0.5, distributor: true, color: '#6f6fbf' }),
    params: [{ key: 'width', label: 'Width', min: 1, max: 20, step: 0.1 }, { key: 'height', label: 'Peg field height', min: 1, max: 20, step: 0.1 },
      { key: 'depth', label: 'Gap depth', min: 0.4, max: 2, step: 0.05 }, { key: 'rows', label: 'Rows (max)', min: 1, max: 40, step: 1 },
      { key: 'cols', label: 'Columns (max)', min: 1, max: 40, step: 1 }, { key: 'pegRadius', label: 'Peg radius', min: 0.03, max: 0.4, step: 0.01 },
      { key: 'clearance', label: 'Fits marbles up to', min: 0.2, max: 2, step: 0.05 }, { key: 'distributor', label: 'Funnel top', type: 'bool' },
      { key: 'bounce', label: 'Peg bounce', min: 0, max: 1.2, step: 0.05 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      const L = pegLayout(p), { W, H, d, top } = L;
      const box = (sx, sy, sz, x, y, z, color = p.color, o) => { const m = mesh(new THREE.BoxGeometry(sx, sy, sz), color, o); m.position.set(x, y, z); g.add(m); return m; };
      box(W, top, 0.06, 0, top / 2, -d / 2 - 0.03);
      box(W, top, 0.06, 0, top / 2, d / 2 + 0.03, '#9fc7ff', { opacity: 0.18 });
      for (const sx of [-1, 1]) box(0.06, H, d + 0.12, sx * (W / 2 + 0.03), H / 2, 0);
      const pegGeo = new THREE.CylinderGeometry(p.pegRadius, p.pegRadius, d, 12); pegGeo.rotateX(Math.PI / 2);
      for (const [x, y] of L.pegs) { const peg = mesh(pegGeo, '#d9d9e6', { restitution: p.bounce, friction: 0.2 }); peg.position.set(x, y, 0); g.add(peg); }
      // Side triangles: the upper face slopes down and inward, so a marble rolling down a wall is turned back toward the middle.
      const z0 = -d / 2, z1 = d / 2, V = (x, y, z) => new THREE.Vector3(x, y, z), quads = [];
      for (const y of L.triangles) for (const sx of [-1, 1]) {
        const wx = sx * W / 2, tip = sx * (W / 2 - L.tri), a = [wx, y + 0.3], b = [tip, y], c = [wx, y - 0.3];
        quads.push([V(...a, z1), V(...b, z1), V(...c, z1)], [V(...a, z0), V(...c, z0), V(...b, z0)]);
        for (const [u, v] of [[a, b], [b, c]]) quads.push([V(...u, z0), V(...v, z0), V(...v, z1), V(...u, z1)]);
      }
      if (quads.length) g.add(mesh(quadsGeo(quads), p.color));
      if (p.distributor) {
        const wall = (x1, y1, x2, y2) => {
          const len = Math.hypot(x2 - x1, y2 - y1), m = box(len + 0.06, 0.06, d + 0.12, (x1 + x2) / 2, (y1 + y2) / 2, 0);
          m.rotation.z = Math.atan2(y2 - y1, x2 - x1);
        };
        for (const sx of [-1, 1]) wall(sx * L.inlet, top, sx * (W / 2 + 0.03), H);
      }
    },
  },
  bumper: {
    label: 'Bumper',
    defaults: () => ({ radius: 0.4, height: 0.5, bounce: 1.1, color: '#e0503c' }),
    params: [{ key: 'radius', label: 'Radius', min: 0.1, max: 3, step: 0.05 }, { key: 'height', label: 'Height', min: 0.1, max: 3, step: 0.05 },
      { key: 'bounce', label: 'Bounce', min: 0, max: 1.6, step: 0.05 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) { const m = mesh(new THREE.CylinderGeometry(p.radius, p.radius, p.height, 24), p.color, { restitution: p.bounce, friction: 0.1 }); m.position.y = p.height / 2; g.add(m); },
  },
  block: {
    label: 'Block / ramp plate',
    defaults: () => ({ sx: 2, sy: 0.2, sz: 2, tilt: 0, roll: 0, friction: 0.5, color: '#7a8696' }),
    params: [{ key: 'sx', label: 'Size X', min: 0.05, max: 30, step: 0.05 }, { key: 'sy', label: 'Size Y', min: 0.05, max: 30, step: 0.05 },
      { key: 'sz', label: 'Size Z', min: 0.05, max: 30, step: 0.05 }, { key: 'tilt', label: 'Tilt (Z°)', min: -90, max: 90, step: 15 },
      { key: 'roll', label: 'Roll (X°)', min: -90, max: 90, step: 15 },
      { key: 'friction', label: 'Friction', min: 0, max: 1.5, step: 0.05 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) { const m = mesh(new THREE.BoxGeometry(p.sx, p.sy, p.sz), p.color, { friction: p.friction }); m.rotation.set(rad(p.roll), 0, rad(p.tilt)); g.add(m); },
  },
  seesaw: {
    label: 'Seesaw',
    defaults: () => ({ length: 3, width: 1.0, maxAngle: 15, rest: 1, speed: 120, color: '#5fae6b' }),
    params: [{ key: 'length', label: 'Length', min: 1, max: 10, step: 0.1 }, { key: 'width', label: 'Width', min: 0.5, max: 3, step: 0.05 },
      { key: 'maxAngle', label: 'Max angle °', min: 15, max: 45, step: 15 },
      { key: 'rest', label: 'Rest side', type: 'select', options: [[1, 'Left (−X) down'], [-1, 'Right (+X) down'], [0, 'Level']] },
      { key: 'speed', label: 'Tip speed °/s', min: 10, max: 720, step: 10 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      post(g, 0, 0, -0.05, -1.5);
      const mv = new THREE.Object3D(); g.add(mv); g.userData.moving = mv;
      mv.add(mesh(sweep([[-p.length / 2, 0, 0], [p.length / 2, 0, 0]], 'channel', p.width, 0.3), p.color));
      mv.rotation.z = rad(p.maxAngle) * Number(p.rest);
    },
    control(p, g, s, dt, marbles, sim) {
      const mv = g.userData.moving, L = p.length / 2; let torque = 0;
      for (const m of marbles) {
        const l = mv.worldToLocal(m.pos.clone());
        if (Math.abs(l.x) < L && Math.abs(l.z) < p.width / 2 + 0.1 && l.y > -0.2 && l.y < 1) torque += l.x * m.mass;
      }
      const target = torque ? -Math.sign(torque) * rad(p.maxAngle) : rad(p.maxAngle) * Number(p.rest);
      const step = rad(p.speed) * dt, d = target - mv.rotation.z;
      mv.rotation.z += Math.abs(d) < step ? d : Math.sign(d) * step;
    },
  },
  splitter: {
    label: 'Splitter (alternating)',
    defaults: () => ({ length: 2, width: 2, slope: 15, angle: 30, color: '#c9a640' }),
    params: [{ key: 'length', label: 'Length', min: 0.8, max: 6, step: 0.1 }, { key: 'width', label: 'Width', min: 1, max: 5, step: 0.05 },
      { key: 'slope', label: 'Slope °', min: 0, max: 45, step: 15 }, { key: 'angle', label: 'Flap angle °', min: 15, max: 45, step: 15 },
      { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      // Marbles enter at the origin moving toward +X; the flap swings to send each one down the other side.
      const body = new THREE.Object3D(); body.rotation.z = -rad(p.slope); g.add(body);
      const floor = mesh(new THREE.BoxGeometry(p.length + 0.4, 0.06, p.width), '#7a8696'); floor.position.set(p.length / 2 - 0.2, -0.03, 0); body.add(floor);
      for (const sz of [-1, 1]) { const w = mesh(new THREE.BoxGeometry(p.length + 0.4, 0.45, 0.06), '#7a8696'); w.position.set(p.length / 2 - 0.2, 0.22, sz * p.width / 2); body.add(w); }
      const mv = new THREE.Object3D(); body.add(mv); g.userData.moving = mv;
      const flap = new THREE.BoxGeometry(p.length * 0.75, 0.45, 0.06); flap.translate(p.length * 0.375, 0.22, 0);
      mv.add(mesh(flap, p.color)); mv.rotation.y = rad(p.angle);
    },
    control(p, g, s, dt, marbles, sim) {
      const mv = g.userData.moving; s.inside ??= new Set(); s.side ??= 1; s.flips ??= 0;
      const now = new Set(); let sweep = false;
      for (const m of marbles) {
        const l = mv.worldToLocal(m.pos.clone());
        if (l.x > -0.3 && l.x < p.length * 0.8 && Math.abs(l.z) < p.width / 2 && l.y > -0.2 && l.y < 1) { now.add(m.id); if (l.x > -m.radius) sweep = true; }
      }
      for (const id of s.inside) if (!now.has(id)) s.flips++; // a marble just left: flip
      s.inside = now;
      // Swing only when no marble is beside the flap, or it would be shut into the pocket between the flap and the wall.
      if (s.flips && !sweep) { if (s.flips % 2) s.side = -s.side; s.flips = 0; }
      const target = rad(p.angle) * s.side, step = rad(240) * dt, d = target - mv.rotation.y;
      mv.rotation.y += Math.abs(d) < step ? d : Math.sign(d) * step;
    },
  },
  lift: {
    label: 'Lift (elevator)',
    defaults: () => ({ height: 5, speed: 2, dump: 60, settle: 0.6, gate: true, color: '#b05fbf' }),
    params: [{ key: 'height', label: 'Lift height', min: 2.5, max: 40, step: 0.1 }, { key: 'speed', label: 'Speed', min: 0.3, max: 10, step: 0.1 },
      { key: 'dump', label: 'Dump angle °', min: 30, max: 75, step: 15 }, { key: 'settle', label: 'Load wait s', min: 0, max: 10, step: 0.1 },
      { key: 'gate', label: 'Entry gate', type: 'bool' }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      // Cup (x from -1 to 0) pivots on its +X edge: it waits at the bottom, rises, tips toward +X, and returns.
      for (const z of [-0.62, 0.62]) { const r = mesh(new THREE.BoxGeometry(0.08, p.height + 1.4, 0.08), '#5b6370', { collide: false }); r.position.set(-1.12, (p.height + 1.4) / 2 - 0.2, z); g.add(r); }
      const mv = new THREE.Object3D(); g.add(mv); g.userData.moving = mv;
      // [size x, y, z, centre x, y, z] — solid floor and walls taller than a marble; the +X lip keeps it in while rising.
      const parts = [[1.06, 0.2, 1.1, -0.5, -0.1, 0], [0.1, 0.9, 1.1, -1.03, 0.45, 0], [1.06, 0.9, 0.1, -0.5, 0.45, -0.55], [1.06, 0.9, 0.1, -0.5, 0.45, 0.55],
        [0.08, 0.22, 1.1, -0.01, 0.11, 0]];
      for (const [sx, sy, sz, x, y, z] of parts) { const b = mesh(new THREE.BoxGeometry(sx, sy, sz), p.color); b.position.set(x, y, z); mv.add(b); }
      // Built-in inlet on the open (+X) side, ending above the lip so marbles drop into the cup.
      g.add(mesh(sweep([[2.6, 0.62, 0], [0.12, 0.36, 0]], 'channel', 1.0, 0.4), '#7a8696'));
      if (p.gate) {
        for (const z of [-0.57, 0.57]) { const post = mesh(new THREE.BoxGeometry(0.08, 1.5, 0.08), '#5b6370', { collide: false }); post.position.set(1.2, 1.2, z); g.add(post); }
        const door = new THREE.Object3D(); door.position.set(1.2, 0, 0); g.add(door); g.userData.door = door;
        const plate = mesh(new THREE.BoxGeometry(0.08, 0.7, 0.98), '#d84315'); plate.position.y = 0.86; door.add(plate);
        // Escapement pin (used when marbles collide): rises from the inlet floor into the gap behind the front marble.
        const pin = new THREE.Object3D(); pin.position.set(2, -1, 0); g.add(pin); g.userData.pin = pin;
        const finger = mesh(new THREE.BoxGeometry(0.06, 0.4, 0.9), '#d84315'); finger.position.y = -0.2; pin.add(finger);
        g.userData.movers = [mv, door, pin];
      }
    },
    // Cycle: wait (door open, marbles roll in) -> once the cup has marbles that have settled and nothing is still
    // on its way in, close the door -> up -> tip -> hold until empty -> untip -> down -> wait.
    control(p, g, s, dt, marbles, sim) {
      const mv = g.userData.moving, door = g.userData.door; s.state ??= 'wait'; s.t ??= 0; s.t += dt;
      const L = (m) => g.worldToLocal(m.pos.clone());
      const inCup = marbles.filter((m) => { const l = mv.worldToLocal(m.pos.clone()); return l.x > -1 && l.x < 0.05 && Math.abs(l.z) < 0.55 && l.y > -0.1 && l.y < 1; });
      const incoming = marbles.some((m) => { const l = L(m); return m.v > 0.3 && l.x >= 0.05 && l.x < 1.15 && Math.abs(l.z) < 0.6 && l.y > -0.2 && l.y < 1.5; });
      // Marbles never collide inside a lift (see Sim.groupsFor), so they overlap and all ride together; one-per-trip escapement is off.
      const onePerTrip = false, pin = g.userData.pin;
      const floorY = (x) => 0.36 + 0.26 * (x - 0.12) / 2.48; // inlet floor height
      s.esc ??= 'idle'; s.escT = (s.escT ?? 0) + dt;
      if (onePerTrip) {
        // idle -> (cup empty, front marble resting at the door) pin up behind it -> door open -> it passes -> door shut -> pin down.
        const front = marbles.map((m) => ({ m, l: L(m) })).filter(({ l }) => l.x > 1.2 && l.x < 1.9 && Math.abs(l.z) < 0.6 && l.y < 1.4).sort((a, b) => a.l.x - b.l.x)[0];
        const toPin = (y, k) => { const d = y - pin.position.y, st = 2 * dt; pin.position.y += Math.abs(d) < st ? d : Math.sign(d) * st; return Math.abs(d) < 1e-3 && k(); };
        if (s.esc === 'idle' && s.state === 'wait' && !s.loaded && front && front.m.v < 0.2) {
          const r = front.m.radius, x = front.l.x + r; pin.position.set(x, floorY(x) - 0.06, 0); s.esc = 'pin'; s.escT = 0;
        } else if (s.esc === 'pin') toPin(floorY(pin.position.x) + 0.17, () => { s.esc = 'release'; s.escT = 0; });
        else if (s.esc === 'release') { if (!front || front.l.x < 1.2 || s.escT > 3) { s.esc = 'shut'; s.escT = 0; } }
        else if (s.esc === 'shut') { if (door.position.y <= 0.001) toPin(floorY(pin.position.x) - 0.06, () => { pin.position.y = -1; s.esc = 'idle'; }); }
      }
      const underDoor = marbles.some((m) => { const l = L(m); return Math.abs(l.x - 1.2) < 0.45 && Math.abs(l.z) < 0.6 && l.y > 0 && l.y < 1.4; });
      const tilt = rad(p.dump), w = rad(90) * dt;
      s.loaded = inCup.length > 0;
      const go = (st) => { s.state = st; s.t = 0; s.vel = 0; };
      // Ease in and out at under 1 g so the marble stays seated instead of being thrown when the cup stops.
      const travel = (to) => {
        const A = 6, dist = to - mv.position.y, dir = Math.sign(dist);
        s.vel = Math.min(p.speed, (s.vel ?? 0) + A * dt, Math.sqrt(2 * A * Math.abs(dist)));
        const step = s.vel * dt;
        if (Math.abs(dist) <= Math.max(step, 1e-4)) { mv.position.y = to; return true; }
        mv.position.y += dir * step; return false;
      };
      switch (s.state) {
        case 'wait':
          if (!s.loaded || incoming || inCup.some((m) => m.v > 0.4) || (onePerTrip && s.esc !== 'idle')) s.t = 0; // restart the settle timer
          else if (s.t >= p.settle) go(door ? 'closing' : 'up');
          break;
        case 'closing': if (door.position.y <= 0.001) go('up'); else if (!s.loaded) go('wait'); break;
        case 'up': if (travel(p.height)) go('tilt'); break;
        case 'tilt': mv.rotation.z = Math.max(-tilt, mv.rotation.z - w); if (mv.rotation.z <= -tilt) go('hold'); break;
        case 'hold': if ((!s.loaded && s.t > 0.4) || s.t > 4) go('untilt'); break;
        case 'untilt': mv.rotation.z = Math.min(0, mv.rotation.z + w); if (mv.rotation.z >= 0) go('down'); break;
        case 'down': if (travel(0)) go('wait'); break;
      }
      if (door) {
        // Open only while the cup is waiting at the bottom; never slide down onto a marble.
        const open = s.state === 'wait' && (onePerTrip ? s.esc === 'release' : true);
        const target = open ? 0.95 : 0, step = 3 * dt, d = target - door.position.y;
        if (!(d < 0 && underDoor)) door.position.y += Math.abs(d) < step ? d : Math.sign(d) * step;
      }
    },
  },
  gate: {
    label: 'Gate',
    defaults: () => ({ width: 1.0, mode: 'oneByOne', interval: 2, openTime: 1, closedTime: 2, color: '#d84315' }),
    params: [{ key: 'mode', label: 'Opens', type: 'select', options: [['oneByOne', 'One marble every interval'], ['timer', 'On a timer']] },
      { key: 'interval', label: 'Interval s', min: 0.1, max: 60, step: 0.1 },
      { key: 'openTime', label: 'Timer open s', min: 0.1, max: 60, step: 0.1 }, { key: 'closedTime', label: 'Timer closed s', min: 0.1, max: 60, step: 0.1 },
      { key: 'width', label: 'Inner width', min: 0.5, max: 3, step: 0.05 }, { key: 'color', label: 'Door color', type: 'color' }],
    build(p, g) {
      // A short channel (marbles travel along +X) with a door at x = 0 that slides up to open.
      g.add(mesh(sweep([[-0.5, 0, 0], [0.5, 0, 0]], 'channel', p.width, 0.4), '#7a8696'));
      for (const z of [-1, 1]) { const post = mesh(new THREE.BoxGeometry(0.08, 1.5, 0.08), '#5b6370', { collide: false }); post.position.set(0, 0.75, z * (p.width / 2 + 0.06)); g.add(post); }
      const mv = new THREE.Object3D(); g.add(mv); g.userData.moving = mv;
      const door = mesh(new THREE.BoxGeometry(0.06, 0.62, p.width - 0.02), p.color); door.position.y = 0.32; mv.add(door);
    },
    control(p, g, s, dt, marbles, sim) {
      const mv = g.userData.moving; s.t = (s.t ?? 0) + dt; s.lastX ??= new Map();
      let passed = false;
      for (const m of marbles) {
        const l = g.worldToLocal(m.pos.clone()), was = s.lastX.get(m.id);
        if (Math.abs(l.z) < p.width / 2 && l.y > -0.3 && l.y < 1 && was !== undefined && was < 0 && l.x >= 0) passed = true;
        s.lastX.set(m.id, l.x);
      }
      if (p.mode === 'timer') s.open = s.t % (p.openTime + p.closedTime) < p.openTime;
      else {
        if (passed) { s.open = false; s.t = 0; }
        else if (!s.open && s.t >= p.interval) s.open = true;
      }
      const target = s.open ? 0.9 : 0, step = 3 * dt, d = target - mv.position.y;
      const under = marbles.some((m) => { const l = g.worldToLocal(m.pos.clone()); return Math.abs(l.x) < 0.45 && Math.abs(l.z) < p.width / 2 + 0.1 && l.y > -0.1 && l.y < 1.2; });
      if (!(d < 0 && under)) mv.position.y += Math.abs(d) < step ? d : Math.sign(d) * step; // never close onto a marble
    },
  },
  booster: {
    label: 'Booster',
    defaults: () => ({ length: 2, width: 1.0, accel: 15, maxSpeed: 8, color: '#00897b' }),
    params: [{ key: 'length', label: 'Length', min: 0.5, max: 10, step: 0.1 }, { key: 'width', label: 'Inner width', min: 0.5, max: 3, step: 0.05 },
      { key: 'accel', label: 'Push m/s²', min: 0, max: 100, step: 1 }, { key: 'maxSpeed', label: 'Up to m/s', min: 0.5, max: 40, step: 0.5 },
      { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      // Flat channel along +X; marbles inside are pushed along +X until they reach the target speed.
      g.add(mesh(sweep([[0, 0, 0], [p.length, 0, 0]], 'channel', p.width, 0.4), '#7a8696'));
      const n = Math.max(1, Math.floor(p.length / 0.6));
      for (let i = 0; i < n; i++) {
        const c = mesh(new THREE.ConeGeometry(0.12, 0.3, 3), p.color, { collide: false }); c.rotation.z = -Math.PI / 2; c.scale.z = 0.25;
        c.position.set((i + 0.5) * (p.length / n), 0.012, 0); g.add(c);
      }
    },
    act(p, g, s, dt, marbles) {
      const dir = new THREE.Vector3(1, 0, 0).transformDirection(g.matrixWorld);
      for (const m of marbles) {
        const l = g.worldToLocal(m.pos.clone());
        if (l.x < 0 || l.x > p.length || Math.abs(l.z) > p.width / 2 || l.y < -0.2 || l.y > 0.8) continue;
        const v = m.body.linvel(), along = v.x * dir.x + v.y * dir.y + v.z * dir.z;
        if (along >= p.maxSpeed) continue;
        const dv = Math.min(p.accel * dt, p.maxSpeed - along);
        m.body.applyImpulse({ x: dir.x * dv * m.mass, y: dir.y * dv * m.mass, z: dir.z * dv * m.mass }, true);
      }
    },
  },
  checkpoint: {
    label: 'Checkpoint',
    defaults: () => ({ name: '', sx: 1.2, sy: 1.2, sz: 1.2 }),
    params: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'sx', label: 'Size X', min: 0.3, max: 30, step: 0.1 }, { key: 'sy', label: 'Size Y', min: 0.3, max: 30, step: 0.1 }, { key: 'sz', label: 'Size Z', min: 0.3, max: 30, step: 0.1 }],
    build(p, g) {
      const geo = new THREE.BoxGeometry(p.sx, p.sy, p.sz);
      g.add(mesh(geo, '#1e88e5', { collide: false, opacity: 0.12 }));
      g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: '#1e88e5' })));
    },
  },
  loop: {
    label: 'Loop-the-loop',
    desc: 'A vertical loop in a tube. Marbles need about 10 m/s going in (roughly a 7-unit drop, or a Booster/Kicker).',
    defaults: () => ({ ...trackDefaults, profile: 'tube', radius: 1.1, lead: 2 }),
    params: [{ key: 'radius', label: 'Loop radius', min: 0.8, max: 8, step: 0.1 }, { key: 'lead', label: 'Lead in/out', min: 0.5, max: 10, step: 0.1 }, ...TRACK],
    build(p, g) { g.add(trackMesh(p, loopPoints(p))); },
  },
  zigzag: {
    label: 'Zigzag',
    desc: 'Switchback ramp: straight legs joined by U-turns, dropping as it goes.',
    defaults: () => ({ ...trackDefaults, wall: 0.5, legs: 4, legLength: 5, legDrop: 0.6, spacing: 2 }),
    params: [{ key: 'legs', label: 'Legs', min: 2, max: 20, step: 1 }, { key: 'legLength', label: 'Leg length', min: 1, max: 20, step: 0.25 },
      { key: 'legDrop', label: 'Drop per leg', min: 0.1, max: 5, step: 0.05 }, { key: 'spacing', label: 'Leg spacing', min: 1.2, max: 6, step: 0.1 }, ...TRACK],
    build(p, g) { g.add(trackMesh(p, zigzagPoints(p))); },
  },
  stairs: {
    label: 'Stairs',
    desc: 'Marbles bounce down a flight of steps between two walls.',
    defaults: () => ({ steps: 6, run: 0.8, rise: 0.4, width: 1.0, color: '#8d6e63' }),
    params: [{ key: 'steps', label: 'Steps', min: 2, max: 40, step: 1 }, { key: 'run', label: 'Step length', min: 0.3, max: 3, step: 0.05 },
      { key: 'rise', label: 'Step drop', min: 0.05, max: 2, step: 0.05 }, { key: 'width', label: 'Inner width', min: 0.5, max: 3, step: 0.05 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      for (let i = 0; i < p.steps; i++) {
        const st = mesh(new THREE.BoxGeometry(p.run, 0.2, p.width), p.color); st.position.set(i * p.run + p.run / 2, -i * p.rise - 0.1, 0); g.add(st);
        for (const z of [-1, 1]) { const w = mesh(new THREE.BoxGeometry(p.run, 0.7, 0.06), '#7a8696'); w.position.set(i * p.run + p.run / 2, -i * p.rise + 0.35, z * (p.width / 2 + 0.03)); g.add(w); }
      }
    },
  },
  basin: {
    label: 'Basin',
    desc: 'Closed bowl that collects marbles: a dead end for the end of a run.',
    defaults: () => ({ radius: 1.6, depth: 0.8, color: '#90a4ae' }),
    params: [{ key: 'radius', label: 'Radius', min: 0.6, max: 10, step: 0.1 }, { key: 'depth', label: 'Depth', min: 0.3, max: 5, step: 0.1 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      const prof = [new THREE.Vector2(0.001, 0), new THREE.Vector2(p.radius * 0.55, 0.04), new THREE.Vector2(p.radius * 0.92, p.depth * 0.45), new THREE.Vector2(p.radius, p.depth)];
      g.add(mesh(new THREE.LatheGeometry(prof, 40), p.color));
    },
  },
  trampoline: {
    label: 'Trampoline',
    desc: 'Very bouncy pad. Tilt it to throw marbles toward the next part.',
    defaults: () => ({ size: 1.5, tilt: 0, bounce: 1.2, color: '#f06292' }),
    params: [{ key: 'size', label: 'Size', min: 0.5, max: 6, step: 0.1 }, { key: 'tilt', label: 'Tilt (Z°)', min: -60, max: 60, step: 15 },
      { key: 'bounce', label: 'Bounce', min: 0.5, max: 1.6, step: 0.05 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      const pad = mesh(new THREE.BoxGeometry(p.size, 0.08, p.size), p.color, { restitution: p.bounce, friction: 0.2 }); pad.rotation.z = rad(p.tilt); g.add(pad);
      post(g, 0, 0, -0.04, -0.8);
    },
  },
  merge: {
    label: 'Merge tray',
    desc: 'Wide tray that narrows into one lane: joins two (or more) tracks.',
    defaults: () => ({ length: 3, wide: 3, narrow: 1.0, drop: 0.5, color: '#78909c' }),
    params: [{ key: 'length', label: 'Length', min: 1, max: 10, step: 0.25 }, { key: 'wide', label: 'Wide end', min: 1.5, max: 10, step: 0.25 },
      { key: 'narrow', label: 'Narrow end', min: 0.5, max: 3, step: 0.05 }, { key: 'drop', label: 'Drop', min: 0, max: 5, step: 0.05 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) { g.add(mesh(trayGeo(p.length, p.wide, p.narrow, p.drop), p.color)); },
  },
  fork: {
    label: 'Fork (random split)',
    desc: 'One lane widens around a wedge: each marble goes left or right by chance.',
    defaults: () => ({ length: 3, wide: 2.6, narrow: 1.0, drop: 0.5, color: '#78909c' }),
    params: [{ key: 'length', label: 'Length', min: 1.5, max: 10, step: 0.25 }, { key: 'wide', label: 'Wide end', min: 1.6, max: 10, step: 0.25 },
      { key: 'narrow', label: 'Narrow end', min: 0.5, max: 3, step: 0.05 }, { key: 'drop', label: 'Drop', min: 0, max: 5, step: 0.05 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      const geo = trayGeo(p.length, p.narrow, p.wide, p.drop);
      // V-shaped divider from an apex 40% along to the wide end.
      const ax = p.length * 0.4, y = (x) => -p.drop * (x / p.length), V = (x, z) => new THREE.Vector3(x, y(x), z), up = 0.5;
      const wall = (a, b) => [a, b, b.clone().setY(b.y + up), a.clone().setY(a.y + up)];
      g.add(mesh(geo, p.color));
      g.add(mesh(quadsGeo([wall(V(ax, 0), V(p.length, -0.12)), wall(V(ax, 0), V(p.length, 0.12)), wall(V(p.length, -0.12), V(p.length, 0.12))]), '#546e7a'));
    },
  },
  wheel: {
    label: 'Paddle wheel',
    desc: 'Turning wheel with paddles. Marbles dropped on top are carried round and let out underneath.',
    defaults: () => ({ radius: 1.5, paddles: 8, width: 1.0, rpm: 12, color: '#6d4c41' }),
    params: [{ key: 'radius', label: 'Radius', min: 0.6, max: 6, step: 0.1 }, { key: 'paddles', label: 'Paddles', min: 3, max: 24, step: 1 },
      { key: 'width', label: 'Width', min: 0.5, max: 3, step: 0.05 }, { key: 'rpm', label: 'Speed rpm', min: -60, max: 60, step: 1 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      post(g, 0, -p.width / 2 - 0.2, 0, -p.radius - 1);
      const mv = new THREE.Object3D(); g.add(mv); g.userData.moving = mv;
      const hub = mesh(new THREE.CylinderGeometry(0.25, 0.25, p.width, 16), '#5b6370'); hub.rotation.x = Math.PI / 2; mv.add(hub);
      for (let i = 0; i < p.paddles; i++) {
        const a = (i / p.paddles) * Math.PI * 2, pd = mesh(new THREE.BoxGeometry(p.radius - 0.25, 0.08, p.width), p.color);
        pd.position.set(Math.cos(a) * (p.radius + 0.25) / 2, Math.sin(a) * (p.radius + 0.25) / 2, 0); pd.rotation.z = a; mv.add(pd);
      }
      for (const z of [-1, 1]) { const plate = mesh(new THREE.CylinderGeometry(p.radius, p.radius, 0.04, 40), '#9fc7ff', { opacity: 0.2 }); plate.rotation.x = Math.PI / 2; plate.position.z = z * (p.width / 2 + 0.02); mv.add(plate); }
    },
    control(p, g, s, dt) { g.userData.moving.rotation.z -= (p.rpm / 60) * Math.PI * 2 * dt; },
  },
  turntable: {
    label: 'Turntable',
    desc: 'Spinning dish with a gap in its rim: marbles circle until the gap lets them out.',
    defaults: () => ({ radius: 2, rpm: 15, gap: 45, color: '#5c6bc0' }),
    params: [{ key: 'radius', label: 'Radius', min: 1, max: 8, step: 0.1 }, { key: 'rpm', label: 'Speed rpm', min: -60, max: 60, step: 1 },
      { key: 'gap', label: 'Rim gap °', min: 0, max: 90, step: 15 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      post(g, 0, 0, -0.1, -1.5);
      const mv = new THREE.Object3D(); g.add(mv); g.userData.moving = mv;
      const disc = mesh(new THREE.CylinderGeometry(p.radius, p.radius, 0.1, 48), p.color); disc.position.y = -0.05; mv.add(disc);
      const n = 24, segA = (Math.PI * 2) / n, gap = rad(p.gap);
      for (let i = 0; i < n; i++) {
        const a = (i + 0.5) * segA; if (a < gap) continue;
        const seg = mesh(new THREE.BoxGeometry(0.08, 0.45, 2 * p.radius * Math.sin(segA / 2) + 0.02), '#3949ab');
        seg.position.set(Math.cos(a) * p.radius, 0.22, -Math.sin(a) * p.radius); seg.rotation.y = a; mv.add(seg);
      }
    },
    control(p, g, s, dt) { g.userData.moving.rotation.y += (p.rpm / 60) * Math.PI * 2 * dt; },
  },
  trapdoor: {
    label: 'Trapdoor',
    desc: 'Channel whose floor swings open on a timer, dropping whatever is on it.',
    defaults: () => ({ length: 2, width: 1.0, openTime: 1, closedTime: 3, color: '#a1887f' }),
    params: [{ key: 'length', label: 'Length', min: 0.8, max: 6, step: 0.1 }, { key: 'width', label: 'Inner width', min: 0.5, max: 3, step: 0.05 },
      { key: 'openTime', label: 'Open s', min: 0.2, max: 30, step: 0.1 }, { key: 'closedTime', label: 'Closed s', min: 0.2, max: 30, step: 0.1 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      for (const z of [-1, 1]) { const w = mesh(new THREE.BoxGeometry(p.length, 0.5, 0.06), '#7a8696'); w.position.set(p.length / 2, 0.2, z * (p.width / 2 + 0.03)); g.add(w); }
      const mv = new THREE.Object3D(); g.add(mv); g.userData.moving = mv; // hinge along the far (+X) end
      mv.position.set(p.length, 0, 0);
      const fl = mesh(new THREE.BoxGeometry(p.length, 0.08, p.width), p.color); fl.position.set(-p.length / 2, -0.04, 0); mv.add(fl);
    },
    control(p, g, s, dt) {
      s.t = (s.t ?? 0) + dt; const open = s.t % (p.openTime + p.closedTime) >= p.closedTime;
      const mv = g.userData.moving, target = open ? rad(75) : 0, st = rad(300) * dt, d = target - mv.rotation.z;
      mv.rotation.z += Math.abs(d) < st ? d : Math.sign(d) * st;
    },
  },
  conveyor: {
    label: 'Conveyor',
    desc: 'Belt that carries marbles along at a set speed, uphill too.',
    defaults: () => ({ length: 4, width: 1.0, slope: 15, speed: 2, color: '#455a64' }),
    params: [{ key: 'length', label: 'Length', min: 1, max: 20, step: 0.25 }, { key: 'width', label: 'Inner width', min: 0.5, max: 3, step: 0.05 },
      { key: 'slope', label: 'Slope °', min: -45, max: 45, step: 15 }, { key: 'speed', label: 'Belt m/s', min: -10, max: 10, step: 0.1 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      const body = new THREE.Object3D(); body.rotation.z = rad(p.slope); g.add(body); g.userData.belt = body;
      const belt = mesh(new THREE.BoxGeometry(p.length, 0.1, p.width), p.color, { friction: 1.2 }); belt.position.set(p.length / 2, -0.05, 0); body.add(belt);
      for (const z of [-1, 1]) { const w = mesh(new THREE.BoxGeometry(p.length, 0.5, 0.06), '#7a8696'); w.position.set(p.length / 2, 0.25, z * (p.width / 2 + 0.03)); body.add(w); }
      for (let x = 0.3; x < p.length; x += 0.5) { const c = mesh(new THREE.BoxGeometry(0.05, 0.012, p.width * 0.8), '#cfd8dc', { collide: false }); c.position.set(x, 0.006, 0); body.add(c); }
    },
    act(p, g, s, dt, marbles) {
      const body = g.userData.belt; body.updateMatrixWorld(true);
      const dir = new THREE.Vector3(1, 0, 0).transformDirection(body.matrixWorld);
      for (const m of marbles) {
        const l = body.worldToLocal(m.pos.clone());
        if (l.x < 0 || l.x > p.length || Math.abs(l.z) > p.width / 2 || l.y < -0.1 || l.y > m.radius * 2 + 0.2) continue;
        // Hold the marble's speed along the belt at the belt speed; leave sideways/vertical motion to the physics.
        const v = m.body.linvel(), along = v.x * dir.x + v.y * dir.y + v.z * dir.z, k = p.speed - along;
        m.body.setLinvel({ x: v.x + dir.x * k, y: v.y + dir.y * k, z: v.z + dir.z * k }, true);
      }
    },
  },
  pendulum: {
    label: 'Pendulum hammer',
    desc: 'Swinging hammer that knocks marbles about. Hang it across a track.',
    defaults: () => ({ length: 2.5, amplitude: 60, period: 2, color: '#ef6c00' }),
    params: [{ key: 'length', label: 'Arm length', min: 0.8, max: 10, step: 0.1 }, { key: 'amplitude', label: 'Swing °', min: 15, max: 90, step: 15 },
      { key: 'period', label: 'Period s', min: 0.4, max: 10, step: 0.1 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      // Pivot at the top (local origin); it swings across X so it sweeps over a track running along X under it.
      const beam = mesh(new THREE.BoxGeometry(0.1, 0.1, 2.4), '#5b6370', { collide: false }); g.add(beam);
      const mv = new THREE.Object3D(); g.add(mv); g.userData.moving = mv;
      const arm = mesh(new THREE.BoxGeometry(0.06, p.length, 0.06), '#5b6370'); arm.position.y = -p.length / 2; mv.add(arm);
      const head = mesh(new THREE.BoxGeometry(0.35, 0.35, 0.7), p.color, { restitution: 0.6 }); head.position.y = -p.length; mv.add(head);
    },
    control(p, g, s, dt) { s.t = (s.t ?? 0) + dt; g.userData.moving.rotation.x = rad(p.amplitude) * Math.sin((s.t / p.period) * Math.PI * 2); },
  },
  kicker: {
    label: 'Kicker',
    desc: 'Launch pad: any marble that rolls in is fired off at a set speed and angle.',
    defaults: () => ({ length: 1.2, width: 1.0, speed: 6, angle: 30, color: '#c62828' }),
    params: [{ key: 'length', label: 'Length', min: 0.5, max: 4, step: 0.1 }, { key: 'width', label: 'Inner width', min: 0.5, max: 3, step: 0.05 },
      { key: 'speed', label: 'Launch m/s', min: 0.5, max: 30, step: 0.5 }, { key: 'angle', label: 'Launch angle °', min: 0, max: 90, step: 15 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      g.add(mesh(sweep([[0, 0, 0], [p.length, 0, 0]], 'channel', p.width, 0.4), '#7a8696'));
      const pad = mesh(new THREE.BoxGeometry(p.length * 0.6, 0.02, p.width * 0.7), p.color, { collide: false }); pad.position.set(p.length * 0.5, 0.012, 0); g.add(pad);
    },
    act(p, g, s, dt, marbles) {
      s.fired ??= new Set();
      const dir = new THREE.Vector3(Math.cos(rad(p.angle)), Math.sin(rad(p.angle)), 0).transformDirection(g.matrixWorld);
      for (const m of marbles) {
        const l = g.worldToLocal(m.pos.clone());
        const inside = l.x > p.length * 0.3 && l.x < p.length && Math.abs(l.z) < p.width / 2 && l.y > -0.1 && l.y < m.radius * 2 + 0.2;
        if (inside && !s.fired.has(m.id)) { s.fired.add(m.id); m.body.setLinvel({ x: dir.x * p.speed, y: dir.y * p.speed, z: dir.z * p.speed }, true); }
        else if (!inside) s.fired.delete(m.id);
      }
    },
  },
  portal: {
    label: 'Portal',
    desc: 'An entry portal sends marbles to its linked exit portal, coming out along the exit\'s +X at the same speed.',
    defaults: () => ({ role: 'entry', link: 0, size: 1.2, color: '#8e24aa' }),
    params: [{ key: 'role', label: 'Role', type: 'select', options: [['entry', 'Entry'], ['exit', 'Exit']] },
      { key: 'link', label: 'Exit portal', type: 'piece', of: 'portal' }, { key: 'size', label: 'Size', min: 0.6, max: 4, step: 0.1 }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      const ring = mesh(new THREE.TorusGeometry(p.size / 2, 0.06, 10, 40), p.role === 'exit' ? '#00acc1' : p.color, { collide: false }); ring.rotation.y = Math.PI / 2; ring.position.y = p.size / 2; g.add(ring);
      const film = mesh(new THREE.CircleGeometry(p.size / 2, 32), p.role === 'exit' ? '#00acc1' : p.color, { collide: false, opacity: 0.25 }); film.rotation.y = Math.PI / 2; film.position.y = p.size / 2; g.add(film);
    },
    act(p, g, s, dt, marbles, sim) {
      if (p.role !== 'entry' || !p.link) return;
      const out = sim.groups.get(p.link); if (!out) return;
      for (const m of marbles) {
        const l = g.worldToLocal(m.pos.clone());
        if (Math.abs(l.x) > 0.25 || Math.abs(l.z) > p.size / 2 || l.y < 0 || l.y > p.size) continue;
        const v = m.body.linvel(), spd = Math.hypot(v.x, v.y, v.z), dir = new THREE.Vector3(1, 0, 0).transformDirection(out.matrixWorld);
        const at = new THREE.Vector3(0.4, p.size / 2, 0).applyMatrix4(out.matrixWorld);
        m.body.setTranslation(at, true); m.body.setLinvel({ x: dir.x * spd, y: dir.y * spd, z: dir.z * spd }, true);
        m.pos.copy(at); m.last.copy(at); // don't count the jump as distance travelled
      }
    },
  },
  spawner: {
    label: 'Marble spawner',
    defaults: () => ({ count: 5, interval: 1.2, radius: 0.35, density: 1, bounce: 0.3, friction: 0.4, launchSpeed: 0, spread: 0.02, color: '#e8e8f0', randomColors: true }),
    params: [{ key: 'count', label: 'Count', min: 1, max: 200, step: 1 }, { key: 'interval', label: 'Interval s', min: 0.05, max: 20, step: 0.05 },
      { key: 'radius', label: 'Marble radius', min: 0.08, max: 0.6, step: 0.01 }, { key: 'density', label: 'Density', min: 0.1, max: 10, step: 0.1 },
      { key: 'bounce', label: 'Bounciness', min: 0, max: 1, step: 0.05 },
      { key: 'friction', label: 'Marble friction', min: 0, max: 2, step: 0.05 },
      { key: 'launchSpeed', label: 'Launch m/s (+X)', min: 0, max: 30, step: 0.1 },
      { key: 'spread', label: 'Drop spread', min: 0, max: 2, step: 0.01 },
      { key: 'randomColors', label: 'Random colors', type: 'bool' }, { key: 'color', label: 'Color', type: 'color' }],
    build(p, g) {
      const ring = mesh(new THREE.TorusGeometry(p.radius + 0.15, 0.04, 8, 24), '#ffcc4d', { collide: false }); ring.rotation.x = Math.PI / 2; g.add(ring);
      const cone = mesh(new THREE.ConeGeometry(0.15, 0.35, 12), '#ffcc4d', { collide: false }); cone.rotation.x = Math.PI; cone.position.y = 0.55; g.add(cone);
      const ghost = mesh(new THREE.SphereGeometry(p.radius, 16, 12), p.color, { collide: false, opacity: 0.4 }); g.add(ghost);
    },
  },
  finish: {
    label: 'Finish zone',
    defaults: () => ({ sx: 2, sy: 1.5, sz: 2 }),
    params: [{ key: 'sx', label: 'Size X', min: 0.3, max: 30, step: 0.1 }, { key: 'sy', label: 'Size Y', min: 0.3, max: 30, step: 0.1 }, { key: 'sz', label: 'Size Z', min: 0.3, max: 30, step: 0.1 }],
    build(p, g) {
      const geo = new THREE.BoxGeometry(p.sx, p.sy, p.sz);
      g.add(mesh(geo, '#3ccf6a', { collide: false, opacity: 0.15 }));
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: '#3ccf6a' })); g.add(e);
    },
  },
};

// Palette entries: label + type + overrides (path presets share the 'path' type).
// Parts palette: label, type, overrides, category, description. Path presets share the 'path' type.
const PT = (label, cat, desc, points, extra = {}) => ({ label, type: 'path', over: { points, ...extra }, cat, desc });
export const PALETTE = [
  PT('Straight ramp', 'Track', 'Plain sloping channel.', [[0, 0, 0], [5, -1, 0]]),
  PT('Curve', 'Track', 'A gentle bend.', [[0, 0, 0], [3, -0.6, 0], [4.5, -1.2, 2]]),
  PT('S-bend', 'Track', 'Left-right wiggle.', [[0, 0, 0], [2.5, -0.5, 1.5], [5, -1, -1.5], [7.5, -1.5, 0]]),
  PT('U-turn', 'Track', 'Half-circle that sends marbles back the way they came.', [[0, 0, 0], [2, -0.3, 0], [3, -0.6, 1], [2, -0.9, 2], [0, -1.2, 2]], { wall: 0.6 }),
  PT('Wave', 'Track', 'Up-and-down humps; marbles need some speed to clear them.', [[0, 0, 0], [2, -1, 0], [3.5, -0.6, 0], [5, -1.8, 0], [6.5, -1.4, 0], [8, -2.6, 0]]),
  PT('Jump ramp', 'Track', 'Kicks up at the end to launch marbles through the air.', [[0, 0, 0], [3, -1.6, 0], [4.5, -1.8, 0], [5.6, -1.3, 0]]),
  PT('Drop tube', 'Track', 'Enclosed tube that drops steeply.', [[0, 0, 0], [0.6, -0.3, 0], [0.9, -2, 0], [1.6, -3.6, 0], [3, -4, 0]], { profile: 'tube' }),
  PT('Long tube', 'Track', 'Long enclosed tube, good for crossing gaps.', [[0, 0, 0], [5, -0.8, 0], [10, -1.6, 0]], { profile: 'tube' }),
  PT('Free-form path', 'Track', 'Start shaping your own track from a few points.', [[0, 0, 0], [2, -0.4, 0], [4, -0.8, 1], [6, -1.2, 0]]),
  { label: 'Spiral', type: 'spiral', cat: 'Track', desc: 'Corkscrew going round and down.' },
  { label: 'Helix tube', type: 'spiral', over: { profile: 'tube', turns: 3, radius: 2, drop: 5 }, cat: 'Track', desc: 'Enclosed spiral; marbles can\'t fly out.' },
  { label: 'Loop-the-loop', type: 'loop', cat: 'Track' },
  { label: 'Zigzag', type: 'zigzag', cat: 'Track' },
  { label: 'Stairs', type: 'stairs', cat: 'Track' },
  { label: 'Funnel', type: 'funnel', cat: 'Shapes', desc: 'Collects marbles from above and drops them out of a spout.' },
  { label: 'Bowl', type: 'funnel', over: { radius: 4, height: 1.2, hole: 0.5, spout: 0.4 }, cat: 'Shapes', desc: 'Wide shallow funnel; marbles circle for a long time.' },
  { label: 'Basin', type: 'basin', cat: 'Shapes' },
  { label: 'Merge tray', type: 'merge', cat: 'Shapes' },
  { label: 'Fork', type: 'fork', cat: 'Shapes' },
  { label: 'Peg board', type: 'pegboard', cat: 'Shapes', desc: 'Plinko board with a glass front.' },
  { label: 'Bumper', type: 'bumper', cat: 'Shapes', desc: 'Springy post that bounces marbles away.' },
  { label: 'Trampoline', type: 'trampoline', cat: 'Shapes' },
  { label: 'Block / plate', type: 'block', cat: 'Shapes', desc: 'Box you can size and tilt: platforms, ramps, walls.' },
  { label: 'Wall', type: 'block', over: { sx: 3, sy: 1, sz: 0.1 }, cat: 'Shapes', desc: 'Thin upright wall.' },
  { label: 'Seesaw', type: 'seesaw', cat: 'Mechanisms', desc: 'Tips toward the side a marble is on and lets it roll off there.' },
  { label: 'Splitter', type: 'splitter', cat: 'Mechanisms', desc: 'Flap that flips after every marble, alternating left and right.' },
  { label: 'Lift', type: 'lift', cat: 'Mechanisms', desc: 'Elevator with a gated inlet: carries marbles up and tips them out.' },
  { label: 'Paddle wheel', type: 'wheel', cat: 'Mechanisms' },
  { label: 'Turntable', type: 'turntable', cat: 'Mechanisms' },
  { label: 'Trapdoor', type: 'trapdoor', cat: 'Mechanisms' },
  { label: 'Pendulum hammer', type: 'pendulum', cat: 'Mechanisms' },
  { label: 'Gate', type: 'gate', cat: 'Flow', desc: 'Door that lets marbles through one at a time or on a timer.' },
  { label: 'Booster', type: 'booster', cat: 'Flow', desc: 'Pushes marbles along until they reach a target speed.' },
  { label: 'Conveyor', type: 'conveyor', cat: 'Flow' },
  { label: 'Kicker', type: 'kicker', cat: 'Flow' },
  { label: 'Portal', type: 'portal', cat: 'Flow', desc: 'Teleporter. Add two, set one to Exit, and link the Entry to it.' },
  { label: 'Spawner', type: 'spawner', cat: 'Test', desc: 'Drops marbles when you press Test. Set count, size, weight, launch speed.' },
  { label: 'Checkpoint', type: 'checkpoint', cat: 'Test', desc: 'Records split times for each marble.' },
  { label: 'Finish', type: 'finish', cat: 'Test', desc: 'Marbles that reach it are timed and counted as finished.' },
].map((e) => ({ over: {}, ...e, desc: e.desc || TYPES[e.type].desc || '' }));
export const CATEGORIES = { Track: 'Track', Shapes: 'Shapes & obstacles', Mechanisms: 'Mechanisms', Flow: 'Flow control', Test: 'Testing' };

// Connection ports in piece-local space: where a marble enters/leaves and the outward direction.
const dirTo = (a, b) => { const d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], l = Math.hypot(...d) || 1; return d.map((v) => v / l); };
const unit = (d) => { const l = Math.hypot(d[0], d[1], d[2]) || 1; return [d[0] / l, d[1] / l, d[2] / l]; };
const pathPorts = (pts, sd, ed) => [{ pos: pts[0], dir: sd ? unit(sd) : dirTo(pts[0], pts[1]) }, { pos: pts.at(-1), dir: ed ? unit(ed) : dirTo(pts.at(-1), pts.at(-2)) }];
export function ports(p) {
  switch (p.type) {
    case 'path': {
      const ps = pathPorts(p.points, p.startDir, p.endDir);
      // A centred tube's opening floor sits half a width below its path (unless the end points straight up/down).
      if (p.centered) for (const q of ps) q.pos = [q.pos[0], q.pos[1] - (p.width / 2) * (1 - Math.abs(q.dir[1])), q.pos[2]];
      return ps;
    }
    case 'spiral': return pathPorts(spiralPoints(p));
    case 'funnel': return [{ pos: [0, p.height, 0], dir: [0, 1, 0] }, { pos: [0, -p.spout, 0], dir: [0, -1, 0] }];
    case 'pegboard': return [{ pos: [0, pegLayout(p).top, 0], dir: [0, 1, 0] }, { pos: [0, 0, 0], dir: [0, -1, 0] }];
    case 'seesaw': return [{ pos: [-p.length / 2, 0, 0], dir: [-1, 0, 0] }, { pos: [p.length / 2, 0, 0], dir: [1, 0, 0] }];
    case 'splitter': {
      const c = Math.cos(rad(p.slope)), s = Math.sin(rad(p.slope)), L = p.length + 0.2;
      return [{ pos: [0, 0, 0], dir: [-c, s, 0] }, { pos: [L * c, -L * s, -p.width / 4], dir: [c, -s, 0] }, { pos: [L * c, -L * s, p.width / 4], dir: [c, -s, 0] }];
    }
    case 'gate': return [{ pos: [-0.5, 0, 0], dir: [-1, 0, 0] }, { pos: [0.5, 0, 0], dir: [1, 0, 0] }];
    case 'booster': return [{ pos: [0, 0, 0], dir: [-1, 0, 0] }, { pos: [p.length, 0, 0], dir: [1, 0, 0] }];
    case 'loop': { const q = loopPoints(p); return pathPorts(q); }
    case 'zigzag': return pathPorts(zigzagPoints(p));
    case 'stairs': return [{ pos: [0, 0, 0], dir: [-1, 0, 0] }, { pos: [p.steps * p.run, -(p.steps - 1) * p.rise, 0], dir: [1, 0, 0] }];
    case 'basin': return [{ pos: [0, p.depth, 0], dir: [0, 1, 0] }];
    case 'trampoline': return [{ pos: [0, 0.04, 0], dir: [0, 1, 0] }];
    case 'merge': return [{ pos: [0, 0, -p.wide / 4], dir: [-1, 0, 0] }, { pos: [0, 0, p.wide / 4], dir: [-1, 0, 0] }, { pos: [p.length, -p.drop, 0], dir: [1, 0, 0] }];
    case 'fork': return [{ pos: [0, 0, 0], dir: [-1, 0, 0] }, { pos: [p.length, -p.drop, -p.wide / 4], dir: [1, 0, 0] }, { pos: [p.length, -p.drop, p.wide / 4], dir: [1, 0, 0] }];
    case 'wheel': return [{ pos: [0, p.radius, 0], dir: [0, 1, 0] }, { pos: [0, -p.radius, 0], dir: [0, -1, 0] }];
    case 'turntable': return [{ pos: [0, 0, 0], dir: [0, 1, 0] }];
    case 'trapdoor': return [{ pos: [0, 0, 0], dir: [-1, 0, 0] }, { pos: [p.length, 0, 0], dir: [1, 0, 0] }, { pos: [p.length / 2, -0.6, 0], dir: [0, -1, 0] }];
    case 'conveyor': { const c = Math.cos(rad(p.slope)), sn = Math.sin(rad(p.slope)); return [{ pos: [0, 0, 0], dir: [-c, -sn, 0] }, { pos: [p.length * c, p.length * sn, 0], dir: [c, sn, 0] }]; }
    case 'kicker': return [{ pos: [0, 0, 0], dir: [-1, 0, 0] }, { pos: [p.length, 0, 0], dir: [1, 0, 0] }];
    case 'portal': return [{ pos: [0, 0, 0], dir: p.role === 'exit' ? [1, 0, 0] : [-1, 0, 0] }];
    case 'lift': return [{ pos: [2.6, 0.62, 0], dir: [1, 0, 0] }, { pos: [0.1, p.height, 0], dir: [1, 0, 0] }];
    case 'spawner': return [{ pos: [0, 0, 0], dir: [0, -1, 0] }];
    case 'finish': return [{ pos: [0, p.sy / 2, 0], dir: [0, 1, 0] }];
    case 'block': return [{ pos: [0, p.sy / 2, 0], dir: [0, 1, 0] }];
    default: return [];
  }
}

// Local direction of a path through control point i (used to orient the roll ring).
export function pointTangent(points, i) {
  const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
  return dirTo(b, a);
}

export function applyTransform(p, g) {
  g.position.set(...p.pos);
  g.rotation.set(rad(p.rotX || 0), rad(p.rotY || 0), rad(p.rotZ || 0), 'YXZ');
  g.scale.set(...(p.scale || [1, 1, 1]));
}

export function buildPiece(p) {
  const g = new THREE.Group();
  applyTransform(p, g);
  TYPES[p.type].build(p, g);
  g.userData.pieceId = p.id;
  g.traverse((o) => { o.userData.pieceId = p.id; });
  return g;
}

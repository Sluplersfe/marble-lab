// Track generator: adds random parts one at a time onto the last opening, tests each new part with real
// physics (marbles start where they left the previous part), and keeps it only if they make it through.
// Parts that fail are retried with new random choices; after too many failures it backs up a part.
import * as THREE from 'three';
import { TYPES, ports, buildPiece } from './pieces.js';
import { Sim } from './sim.js';
import { defaultSettings } from './settings.js';

const V = (a) => new THREE.Vector3(...a);
const VOX = 0.5; // occupancy grid cell, used to keep new parts out of old ones
const key = (v) => `${Math.floor(v.x / VOX)},${Math.floor(v.y / VOX)},${Math.floor(v.z / VOX)}`;
const ang = (v) => Math.atan2(-v.z, v.x); // rotating about Y by θ adds θ to this angle
const snap15 = (deg) => Math.round(deg / 15) * 15;
const r3 = (v) => Math.round(v * 1000) / 1000;

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Points spread over every surface of a part (triangles split until small), for the overlap check.
function surfacePoints(g) {
  const out = [], a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const split = (p, q, r, depth) => {
    if (depth > 6 || Math.max(p.distanceTo(q), q.distanceTo(r), r.distanceTo(p)) < VOX * 0.7) { out.push(p.clone().add(q).add(r).divideScalar(3)); return; }
    const pq = p.clone().lerp(q, 0.5), qr = q.clone().lerp(r, 0.5), rp = r.clone().lerp(p, 0.5);
    split(p, pq, rp, depth + 1); split(pq, q, qr, depth + 1); split(rp, qr, r, depth + 1); split(pq, qr, rp, depth + 1);
  };
  g.updateMatrixWorld(true);
  g.traverse((o) => {
    if (!o.isMesh || !o.userData.collide) return;
    const pos = o.geometry.attributes.position, idx = o.geometry.index, n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const at = (k) => (idx ? idx.getX(i + k) : i + k);
      a.fromBufferAttribute(pos, at(0)).applyMatrix4(o.matrixWorld); b.fromBufferAttribute(pos, at(1)).applyMatrix4(o.matrixWorld); c.fromBufferAttribute(pos, at(2)).applyMatrix4(o.matrixWorld);
      split(a.clone(), b.clone(), c.clone(), 0);
    }
  });
  return out;
}

function portWorld(p, g, i) {
  const q = ports(p).at(i); g.updateMatrixWorld(true);
  return { pos: V(q.pos).applyMatrix4(g.matrixWorld), dir: V(q.dir).transformDirection(g.matrixWorld) };
}

const between = (rng, a, b) => a + (b - a) * rng();
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
function weighted(rng, list) {
  const total = list.reduce((s, [, w]) => s + w, 0); let x = rng() * total;
  for (const [v, w] of list) if ((x -= w) <= 0) return v;
  return list[0][0];
}

export class Generator {
  constructor(R, opts) {
    this.R = R; this.o = { count: 10, seed: Date.now() % 1e9, lifts: true, pegboards: true, loops: true, ...opts };
    this.rng = mulberry32(this.o.seed); this.nextId = 1; this.tests = 0; this.cancelled = false;
    this.marble = TYPES.spawner.defaults();
  }

  piece(type, over) { return { id: this.nextId++, type, pos: [0, 0, 0], rotX: 0, rotY: 0, rotZ: 0, scale: [1, 1, 1], ...TYPES[type].defaults(), ...over }; }

  chooseType(top) {
    if (top.piece.type === 'pegboard') return 'funnel'; // something wide must catch a peg board
    const fast = top.state.vel.length() > 7, o = this.o;
    return weighted(this.rng, [['path', 5], ['spiral', 1.5], ['funnel', 1], ['zigzag', 1], ['stairs', 0.7], ['booster', 0.6],
      ['pegboard', o.pegboards ? 0.6 : 0], ['loop', o.loops && fast ? 1.2 : 0], ['lift', o.lifts ? 0.5 : 0]]);
  }

  // A random ramp that starts at the last opening and carries on in the same direction.
  makePath(st) {
    const rng = this.rng, Dh = st.D.clone().setY(0), vertical = Dh.length() < 0.3;
    let h = vertical ? pick(rng, [V([1, 0, 0]), V([-1, 0, 0]), V([0, 0, 1]), V([0, 0, -1])]) : Dh.normalize();
    const start = vertical ? st.X.clone().add(V([0, -0.5, 0])).addScaledVector(h, -0.3) : st.X.clone().add(V([0, -0.06, 0]));
    const pts = [[0, 0, 0]], cur = new THREE.Vector3(), segs = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < segs; i++) {
      if (i > 0) h = h.clone().applyAxisAngle(V([0, 1, 0]), THREE.MathUtils.degToRad(pick(rng, [0, 0, 30, -30, 45, -45, 90, -90])));
      const len = between(rng, 2.5, 4.5);
      cur.addScaledVector(h, len).y -= len * between(rng, 0.12, 0.25);
      pts.push(cur.toArray().map(r3));
    }
    const profile = vertical ? pick(rng, ['channel', 'gutter']) : pick(rng, ['channel', 'gutter', 'gutter', 'tube']);
    const first = V(pts[1]).setY(0).normalize();
    return this.piece('path', { pos: start.toArray().map(r3), profile, wall: 0.6, points: pts, startDir: first.negate().toArray().map(r3) });
  }

  makePart(type, st) {
    const rng = this.rng;
    if (type === 'path') return this.makePath(st);
    const over = {
      spiral: () => ({ radius: between(rng, 2, 3), turns: pick(rng, [1, 1.5, 2, 2.5]), drop: between(rng, 3, 5), clockwise: rng() < 0.5, wall: 1.1 }),
      funnel: () => ({ radius: st.after === 'pegboard' ? st.wide / 2 + 0.8 : between(rng, 2, 3) }),
      zigzag: () => ({ legs: 2 + Math.floor(rng() * 3), legLength: between(rng, 3, 5), legDrop: between(rng, 0.5, 0.8) }),
      stairs: () => ({ steps: 4 + Math.floor(rng() * 5) }),
      booster: () => ({}),
      pegboard: () => ({ rows: 6 + Math.floor(rng() * 3) }),
      loop: () => ({}),
      lift: () => ({ height: Math.round(between(rng, 3, 6)) }),
    }[type]();
    const p = this.piece(type, over);
    const e = ports(p)[0], ePos = V(e.pos), eDir = V(e.dir);
    const horizontal = Math.abs(eDir.y) < 0.7, Dh = st.D.clone().setY(0), vertical = Dh.length() < 0.3;
    let rot;
    if (horizontal) { const t = vertical ? pick(rng, [V([1, 0, 0]), V([-1, 0, 0]), V([0, 0, 1]), V([0, 0, -1])]) : Dh.normalize().negate(); rot = ang(t) - ang(eDir.clone().setY(0)); }
    else rot = pick(rng, [0, 0.5, 1, 1.5]) * Math.PI;
    p.rotY = snap15(THREE.MathUtils.radToDeg(rot));
    const R = new THREE.Euler(0, THREE.MathUtils.degToRad(p.rotY), 0, 'YXZ'), Re = ePos.clone().applyEuler(R), Rd = eDir.clone().applyEuler(R);
    let off;
    if (!horizontal) { // catches a falling marble: put it under where the marble lands
      const vh = st.vel.clone().setY(0); off = vh.multiplyScalar(0.3).clampLength(0, 1.2).add(V([0, -0.5, 0]));
    } else off = vertical ? Rd.clone().setY(0).normalize().multiplyScalar(-0.5).add(V([0, -0.45, 0])) : V([0, -0.06, 0]);
    p.pos = st.X.clone().sub(Re).add(off).toArray().map(r3);
    return p;
  }

  makeFinish(st, tries) {
    const vh = st.vel.clone().setY(0).multiplyScalar(0.25 + 0.1 * tries).clampLength(0, 2.5);
    const c = st.X.clone().add(vh).add(V([0, -1.2 - 0.2 * tries, 0]));
    return this.piece('finish', { pos: c.toArray().map(r3), sx: 3, sy: 2, sz: 3 });
  }

  // Run marbles through prev + cand, starting where they left prev. Resolves to the crossing state or null.
  async test(prev, cand, st, isFinish) {
    this.tests++;
    const scene = new THREE.Scene(), groups = new Map();
    const sp = this.piece('spawner', { pos: st.spawnPos.toArray(), count: 0 });
    const list = [prev, cand, sp].filter(Boolean);
    for (const p of list) groups.set(p.id, buildPiece(p));
    const sim = new Sim(this.R, scene, list, groups, { ...defaultSettings(), marblesHit: false, removeFinished: false, stuckTime: 1e9 });
    try {
      for (let j = 0; j < 3; j++) {
        sim.spawn(sim.spawners[0]); const m = sim.marbles.at(-1);
        const p0 = st.spawnPos.clone().add(V([(this.rng() - 0.5) * 0.06, 0, (this.rng() - 0.5) * 0.06]));
        // Each test marble arrives a little faster or slower, so a part only passes if it isn't a knife-edge.
        m.body.setTranslation(p0, true); m.body.setLinvel(st.vel.clone().multiplyScalar(1 + (j - 1) * 0.12), true); m.body.setAngvel(st.spin, true);
        m.pos.copy(p0); m.last.copy(p0);
      }
      const ex = isFinish ? null : portWorld(cand, groups.get(cand.id), -1);
      const tol = cand.type === 'pegboard' ? cand.width / 2 + 0.3 : 1.3;
      const reached = new Map(), traj = [], d = new THREE.Vector3();
      const steps = Math.round(25 / sim.h);
      for (let i = 0; i < steps; i++) {
        sim.tick();
        if (i % 12 === 0) traj.push(sim.marbles[0].pos.clone());
        for (const m of sim.marbles) {
          if (reached.has(m)) continue;
          if (m.status === 'lost' || m.stillT > (cand.type === 'lift' ? 10 : 2.5)) return null; // a lift's queue may wait for the cup
          if (isFinish) { if (m.status === 'finished') reached.set(m, null); continue; }
          d.copy(m.pos).sub(ex.pos); const along = d.dot(ex.dir), lat = d.addScaledVector(ex.dir, -along).length();
          if (along > 0 && along < 1.5 && lat < tol) { const v = m.body.linvel(), w = m.body.angvel(); reached.set(m, { pos: m.pos.clone(), vel: V([v.x, v.y, v.z]), spin: V([w.x, w.y, w.z]) }); }
        }
        if (reached.size === sim.marbles.length) {
          const first = reached.get(sim.marbles[0]);
          return { traj, state: isFinish ? null : { X: ex.pos, D: ex.dir, spawnPos: first.pos, vel: first.vel, spin: first.spin, after: cand.type, wide: cand.width } };
        }
        if (i % 400 === 0) await new Promise((r) => setTimeout(r));
        if (this.cancelled) return null;
      }
      return null;
    } finally { sim.dispose(); }
  }

  overlaps(points, top) {
    for (const v of points) {
      const o = this.occ.get(key(v));
      if (o !== undefined && o !== top && v.distanceTo(this.stack[top].state.X) > 1.5) return true;
    }
    return false;
  }
  claim(points, idx) { for (const v of points) { const k = key(v); if (!this.occ.has(k)) this.occ.set(k, idx); } }
  release(idx) { for (const [k, o] of this.occ) if (o === idx) this.occ.delete(k); }

  // Add parts until there are o.count, then a finish zone. Returns the finish piece, or null if it gave up.
  async grow(onProgress, maxTests) {
    const o = this.o;
    while (!this.cancelled && this.tests < maxTests) {
      const top = this.stack.length - 1, T = this.stack[top];
      if (T.fails > 14) { // stuck here: drop the last part and try again from the one before
        if (top === 0) { T.fails = 0; continue; }
        this.stack.pop(); this.release(top); this.stack[top - 1].fails++; continue;
      }
      const placed = this.stack.length - 1, done = placed >= o.count;
      onProgress(`Placed ${placed} / ${o.count} parts · ${this.tests} tests`);
      const cand = done ? this.makeFinish(T.state, T.fails) : this.makePart(this.chooseType(T), T.state);
      const pts = done ? [] : surfacePoints(buildPiece(cand));
      if (this.overlaps(pts, top)) { T.fails++; continue; }
      const res = await this.test(top ? T.piece : null, cand, T.state, done);
      if (!res || this.overlaps(res.traj, top)) { T.fails++; continue; }
      if (done) return cand;
      this.claim(pts, top + 1); this.claim(res.traj, top + 1);
      this.stack.push({ piece: cand, state: res.state, fails: 0 });
    }
    return null;
  }

  // Build, then test-run the whole track with the real settings. If marbles are lost, cut the track back to
  // just before the first part they fell from and grow it again from there.
  async run(onProgress = () => {}) {
    const maxTests = this.o.count * 80 + 150;
    const spawner = this.piece('spawner', { count: 5 });
    this.stack = [{ piece: spawner, state: { X: V([0, 0, 0]), D: V([0, -1, 0]), spawnPos: V([0, 0, 0]), vel: V([0, 0, 0]), spin: V([0, 0, 0]) }, fails: 0 }];
    this.occ = new Map();
    let pieces = null;
    for (let repair = 0; repair < 8; repair++) {
      const finish = await this.grow(onProgress, maxTests);
      if (!finish) break;
      pieces = [...this.stack.map((s) => s.piece), finish];
      onProgress(`Test-running the whole track (${pieces.length - 2} parts)…`);
      const v = await verify(this.R, pieces, this.o.settings || defaultSettings());
      this.result = v;
      if (v.finished === v.total || this.cancelled) break;
      const cut = THREE.MathUtils.clamp(v.badIndex, 1, this.stack.length - 1);
      while (this.stack.length > cut) { this.release(this.stack.length - 1); this.stack.pop(); }
      this.stack.at(-1).fails++;
    }
    if (!pieces) return null;
    // Sit the lowest part on the floor, centred.
    const box = new THREE.Box3(); for (const p of pieces) box.expandByObject(buildPiece(p));
    for (const p of pieces) p.pos = [r3(p.pos[0] - box.min.x / 2 - box.max.x / 2), r3(p.pos[1] - box.min.y), r3(p.pos[2] - box.min.z / 2 - box.max.z / 2)];
    return pieces;
  }
}

// Full run of a track with the real settings: how many of the spawner's marbles finish, and (when some don't)
// the index of the first part a failed marble got to last, i.e. where the track goes wrong.
export async function verify(R, pieces, settings) {
  const scene = new THREE.Scene(), groups = new Map();
  for (const p of pieces) groups.set(p.id, buildPiece(p));
  const boxes = pieces.map((p) => new THREE.Box3().setFromObject(groups.get(p.id)).expandByScalar(0.4));
  const sim = new Sim(R, scene, pieces, groups, { ...settings, removeFinished: false });
  const furthest = new Map();
  try {
    for (let i = 0; i < 180 / sim.h && !(sim.done && sim.time > 2); i++) {
      sim.tick();
      if (i % 12 === 0) for (const m of sim.marbles) if (m.body) { for (let k = boxes.length - 1; k > (furthest.get(m) ?? 0); k--) if (boxes[k].containsPoint(m.pos)) { furthest.set(m, k); break; } }
      if (i % 400 === 0) await new Promise((r) => setTimeout(r));
    }
    const bad = sim.marbles.filter((m) => m.status !== 'finished');
    return { finished: sim.marbles.length - bad.length, total: sim.marbles.length, badIndex: Math.min(...bad.map((m) => furthest.get(m) ?? 1)) };
  } finally { sim.dispose(); }
}

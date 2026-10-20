// Physics run: marbles are Rapier dynamic bodies; track parts are fixed trimeshes; moving parts are kinematic.
import * as THREE from 'three';
import { TYPES, noCollideZones, funnelNeckTop } from './pieces.js';

const PALETTE = ['#e84a5f', '#4ab8e8', '#f2c14e', '#6fdc8c', '#b57ee8', '#f28b4e', '#e8e8f0', '#3fd1c6'];

function marbleTexture(color) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, 128, 64);
  x.fillStyle = '#ffffff55'; x.fillRect(0, 26, 128, 6); x.fillStyle = '#00000044'; x.fillRect(60, 0, 8, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function bake(mesh, matrix) {
  const g = mesh.geometry, src = g.attributes.position, v = new THREE.Vector3();
  const verts = new Float32Array(src.count * 3);
  for (let i = 0; i < src.count; i++) { v.fromBufferAttribute(src, i).applyMatrix4(matrix); verts.set([v.x, v.y, v.z], i * 3); }
  let idx = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: src.count }, (_, i) => i);
  return { verts, idx };
}

export class Sim {
  constructor(R, scene, pieces, groups, settings) {
    this.R = R; this.scene = scene; this.pieces = pieces; this.groups = groups; this.s = settings;
    this.h = 1 / settings.stepRate;
    this.world = new R.World({ x: 0, y: -settings.gravity, z: 0 });
    this.world.timestep = this.h;
    try { this.world.numSolverIterations = settings.solverIterations; } catch {}
    this.time = 0; this.acc = 0; this.marbles = []; this.nextId = 1; this.done = false;
    this.trails = true;
    const fixed = this.world.createRigidBody(R.RigidBodyDesc.fixed());
    const flags = R.TriMeshFlags?.FIX_INTERNAL_EDGES_TWO_SIDED ?? 0;
    this.kin = []; this.spawners = []; this.finishes = []; this.checkpoints = []; this.actors = [];
    let minY = 0; this.liftBoxes = []; this.necks = []; this.spheres = [];
    for (const p of pieces) {
      const g = groups.get(p.id); g.updateMatrixWorld(true);
      // A part can have several kinematic pieces (e.g. a lift's cup and its entry door); each gets its own body.
      const movers = g.userData.movers || (g.userData.moving ? [g.userData.moving] : []);
      const box = new THREE.Box3().setFromObject(g); minY = Math.min(minY, box.min.y);
      if (p.type === 'lift') this.liftBoxes.push(box.clone().expandByScalar(0.3)); // marbles pass through each other here
      for (const z of noCollideZones(p)) { const sc = g.matrixWorld.getMaxScaleOnAxis(); for (const c of z.pts) this.spheres.push({ c: c.clone().applyMatrix4(g.matrixWorld), r: z.r * sc }); }
      if (p.type === 'funnel') this.necks.push({ p, inv: g.matrixWorld.clone().invert(), k: 1 / Math.max(1e-6, Math.abs(g.matrixWorld.getMaxScaleOnAxis())) });
      if (p.type === 'spawner') this.spawners.push({ p, emitted: 0, next: 0 });
      if (p.type === 'finish') this.finishes.push({ p, inv: g.matrixWorld.clone().invert() });
      if (p.type === 'checkpoint') this.checkpoints.push({ p, inv: g.matrixWorld.clone().invert() });
      if (TYPES[p.type].act) this.actors.push({ p, g, state: {} });
      const ms = movers.map((obj) => {
        const pos = new THREE.Vector3(), q = new THREE.Quaternion(); obj.matrixWorld.decompose(pos, q, new THREE.Vector3());
        const body = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z).setRotation(q));
        const inv = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1)).invert(); // body has no scale; bake it into the shapes
        return { obj, body, inv, home: { pos: obj.position.clone(), rot: obj.rotation.clone() } };
      });
      if (ms.length) this.kin.push({ p, g, state: {}, movers: ms });
      g.traverse((o) => {
        if (!o.isMesh || !o.userData.collide) return;
        let owner = null; for (let a = o; a && !owner; a = a.parent) owner = ms.find((x) => x.obj === a) || null;
        const m = owner ? new THREE.Matrix4().multiplyMatrices(owner.inv, o.matrixWorld) : o.matrixWorld;
        let d;
        if (o.geometry.type === 'BoxGeometry') {
          // Boxes become solid cuboids: a marble pushed by a moving cup or door can't slip through a solid the way it can through a thin surface.
          const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(); m.decompose(pos, q, sc);
          const { width, height, depth } = o.geometry.parameters;
          d = R.ColliderDesc.cuboid(Math.abs(width * sc.x) / 2, Math.abs(height * sc.y) / 2, Math.abs(depth * sc.z) / 2).setTranslation(pos.x, pos.y, pos.z).setRotation(q);
        } else { const { verts, idx } = bake(o, m); d = R.ColliderDesc.trimesh(verts, idx, flags); }
        d = d.setFriction(o.userData.phys.friction).setRestitution(o.userData.phys.restitution)
          .setRestitutionCombineRule(R.CoefficientCombineRule.Max);
        this.world.createCollider(d, owner ? owner.body : fixed);
      });
    }
    this.minY = minY - settings.fallDepth;
    this.marbleGroup = new THREE.Group(); scene.add(this.marbleGroup);
  }

  spawn(sp) {
    const R = this.R, p = sp.p, g = this.groups.get(p.id);
    const S = this.s, spread = (p.spread ?? 0.02) * 2;
    const pos = new THREE.Vector3((Math.random() - 0.5) * spread, 0, (Math.random() - 0.5) * spread).applyMatrix4(g.matrixWorld);
    const vel = new THREE.Vector3(1, 0, 0).transformDirection(g.matrixWorld).multiplyScalar(p.launchSpeed || 0); // launched along the spawner's +X
    const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setLinvel(vel.x, vel.y, vel.z)
      .setCcdEnabled(S.ccd).setAngularDamping(S.rollingResistance).setLinearDamping(S.airDrag)
      .setCanSleep(false)); // never freeze a slow marble: gates, lifts and seesaws may set it moving again
    const col = this.world.createCollider(R.ColliderDesc.ball(p.radius).setDensity(p.density).setFriction(p.friction ?? 0.4).setRestitution(p.bounce)
      // Marbles are in group 2 and only collide with group 1 (the track), so they pass through each other.
      .setCollisionGroups(this.groupsFor(pos, p.radius) & ~0x2), body); // starts as a ghost; tick() turns collisions on once it is clear
    const id = this.nextId++;
    const color = p.randomColors ? PALETTE[(id - 1) % PALETTE.length] : p.color;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(p.radius, 24, 16), new THREE.MeshStandardMaterial({ map: marbleTexture(color), roughness: S.marbleRoughness, metalness: S.marbleMetalness }));
    mesh.castShadow = true; this.marbleGroup.add(mesh);
    const trailGeo = new THREE.BufferGeometry(); trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(S.trailLength * 3), 3)); trailGeo.setDrawRange(0, 0);
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 })); trail.frustumCulled = false;
    this.marbleGroup.add(trail);
    this.marbles.push({ id, body, mesh, trail, trailN: 0, color, col, groups: col.collisionGroups(), mass: col.mass(), pos: pos.clone(), last: pos.clone(), spawnT: this.time,
      radius: p.radius, dist: 0, v: 0, vmax: 0, splits: {}, status: 'rolling', stillT: 0, startY: pos.y, finishT: null });
  }

  // Marbles are in group 2. They hit the track (group 1) and, with "Hit each other" on, each other, except inside lifts
  // (so the cup takes several at once) and in the narrow part of a funnel where two marbles can't fit side by side.
  inNeck(pos, r) {
    const l = new THREE.Vector3();
    for (const { p, inv, k } of this.necks) {
      l.copy(pos).applyMatrix4(inv); const rl = r * k; // marble radius in the funnel's own units
      const narrowTop = funnelNeckTop(p, rl);
      if (l.y < -p.spout - rl || l.y > Math.min(p.height, narrowTop) + rl) continue;
      const wall = l.y <= 0 ? p.hole : p.hole + (p.radius - p.hole) * Math.min(1, l.y / p.height);
      if (Math.hypot(l.x, l.z) < wall + rl) return true;
    }
    for (const { c, r: zr } of this.spheres) if (c.distanceToSquared(pos) < zr * zr) return true; // spline points marked "No collisions"
    return false;
  }
  groupsFor(pos, r = 0) {
    const ghost = !this.s.marblesHit || this.liftBoxes.some((b) => b.containsPoint(pos)) || this.inNeck(pos, r);
    return ghost ? (0x0002 << 16) | 0x0001 : (0x0002 << 16) | 0x0003;
  }

  stateOf(id) { return this.kin.find((k) => k.p.id === id)?.state; }

  remove(m) { this.world.removeRigidBody(m.body); m.body = null; this.marbleGroup.remove(m.mesh); m.mesh.geometry.dispose(); }

  step(dt, speed) {
    const H = this.h, N = this.s.trailLength;
    this.acc = Math.min(this.acc + dt * speed, H * 40);
    while (this.acc >= H) { this.acc -= H; this.tick(); }
    const tmp = new THREE.Vector3();
    for (const m of this.marbles) {
      if (!m.body) continue;
      const t = m.body.translation(), r = m.body.rotation();
      m.mesh.position.set(t.x, t.y, t.z); m.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      m.trail.visible = this.trails;
      if (this.trails && (m.trailN === 0 || tmp.fromArray(m.trail.geometry.attributes.position.array, ((m.trailN - 1) % N) * 3).distanceTo(m.mesh.position) > 0.08)) {
        const a = m.trail.geometry.attributes.position;
        if (m.trailN >= N) { a.array.copyWithin(0, 3); m.trailN = N - 1; }
        a.setXYZ(m.trailN++, t.x, t.y, t.z); a.needsUpdate = true; m.trail.geometry.setDrawRange(0, m.trailN);
      }
    }
  }

  tick() {
    const H = this.h, S = this.s;
    this.time += H;
    const live = this.marbles.filter((m) => m.body);
    for (const k of this.kin) {
      TYPES[k.p.type].control(k.p, k.g, k.state, H, live, this);
      for (const mv of k.movers) {
        mv.obj.updateMatrixWorld(true);
        const pos = new THREE.Vector3(), q = new THREE.Quaternion(); mv.obj.matrixWorld.decompose(pos, q, new THREE.Vector3());
        mv.body.setNextKinematicTranslation(pos); mv.body.setNextKinematicRotation(q);
      }
    }
    for (const sp of this.spawners) if (sp.emitted < sp.p.count && this.time >= sp.next) { this.spawn(sp); sp.emitted++; sp.next = this.time + sp.p.interval; }
    for (const a of this.actors) TYPES[a.p.type].act(a.p, a.g, a.state, H, live, this); // parts that push marbles
    if (this.steer?.m.body) { const m = this.steer.m, k = m.mass * S.steerAccel * H; m.body.applyImpulse({ x: this.steer.dir.x * k, y: 0, z: this.steer.dir.z * k }, true); } // Ride mode pushes
    this.world.step();
    const lp = new THREE.Vector3();
    for (const m of live) {
      const t = m.body.translation(); m.pos.set(t.x, t.y, t.z);
      let gr = this.groupsFor(m.pos, m.radius);
      // A marble leaving a lift stays a ghost until it no longer overlaps another, or the two would be shoved apart violently.
      if (gr !== m.groups && (gr & 0x2) && live.some((o) => o !== m && o.body && o.pos.distanceTo(m.pos) < o.radius + m.radius)) gr = m.groups;
      if (gr !== m.groups) { m.col.setCollisionGroups(gr); m.groups = gr; }
      m.dist += m.pos.distanceTo(m.last); m.last.copy(m.pos);
      const lv = m.body.linvel(); m.v = Math.hypot(lv.x, lv.y, lv.z); m.vmax = Math.max(m.vmax, m.v);
      if (m.status === 'finished') continue; // kept rolling because "Remove finished" is off
      if (m.v < S.stuckSpeed) { m.stillT += H; if (m.stillT > S.stuckTime) m.status = 'stuck'; } else { m.stillT = 0; if (m.status === 'stuck') m.status = 'rolling'; }
      if (m.pos.y < this.minY) { m.status = 'lost'; m.endT = this.time - m.spawnT; this.remove(m); continue; }
      for (const c of this.checkpoints) {
        if (m.splits[c.p.id] !== undefined) continue;
        lp.copy(m.pos).applyMatrix4(c.inv);
        if (Math.abs(lp.x) < c.p.sx / 2 && Math.abs(lp.y) < c.p.sy / 2 && Math.abs(lp.z) < c.p.sz / 2) m.splits[c.p.id] = this.time - m.spawnT;
      }
      for (const f of this.finishes) {
        lp.copy(m.pos).applyMatrix4(f.inv);
        if (Math.abs(lp.x) < f.p.sx / 2 && Math.abs(lp.y) < f.p.sy / 2 && Math.abs(lp.z) < f.p.sz / 2) {
          m.status = 'finished'; m.finishT = this.time - m.spawnT; m.finishV = m.v; if (S.removeFinished) this.remove(m); break;
        }
      }
    }
    const pending = this.spawners.some((s) => s.emitted < s.p.count);
    this.done = !pending && this.marbles.every((m) => !m.body || m.status === 'stuck' || m.status === 'finished');
  }

  dispose() {
    this.scene.remove(this.marbleGroup);
    this.marbleGroup.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); });
    for (const k of this.kin) for (const mv of k.movers) { mv.obj.position.copy(mv.home.pos); mv.obj.rotation.copy(mv.home.rot); }
    this.world.free();
  }
}

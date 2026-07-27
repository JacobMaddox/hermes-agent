import * as THREE from 'three';
import { scratch } from '../core/loop.js';
import { clamp } from '../core/rng.js';

// Effects.
//
// Everything is pooled and budgeted: one Points object for all particles, one
// InstancedMesh for all decals, one for all tracers. Nothing is allocated at
// fire time, so a sustained firefight costs the same as a single shot.
//
// Surface type comes from the physics hit, so a round striking marble throws
// pale dust and one striking metal throws orange sparks — the feedback loop
// that tells the player what they are shooting at.

const SURFACE_FX = {
  stone: { colour: 0xcfc6b4, spark: 0.12, dust: 1.0, decal: 0x3a352c },
  rubble: { colour: 0xc3b8a4, spark: 0.08, dust: 1.2, decal: 0x332e26 },
  metal: { colour: 0xffc46a, spark: 1.0, dust: 0.25, decal: 0x1d1d20 },
  wood: { colour: 0xb08050, spark: 0.05, dust: 0.7, decal: 0x2a1c10 },
  cloth: { colour: 0xd0c0a0, spark: 0.0, dust: 0.5, decal: 0x241f2e },
  glass: { colour: 0xcfe8ff, spark: 0.4, dust: 0.3, decal: 0x2a3540 },
  foliage: { colour: 0x6fa356, spark: 0.0, dust: 0.6, decal: 0x1d2a16 },
  aether: { colour: 0x63c4ff, spark: 0.9, dust: 0.4, decal: 0x123044 },
  flesh: { colour: 0xff6a3a, spark: 0.3, dust: 0.2, decal: 0x2a0d08 }
};

const PARTICLE_VS = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColour;
  varying float vAlpha;
  varying vec3 vColour;
  void main() {
    vAlpha = aAlpha;
    vColour = aColour;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Perspective size attenuation, clamped so near particles cannot fill the
    // screen and far ones stay above a pixel.
    gl_PointSize = clamp(aSize * 320.0 / max(-mv.z, 0.1), 1.0, 128.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FS = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColour;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = dot(d, d);
    if (r > 0.25) discard;
    // Soft round falloff with a hot core.
    float a = smoothstep(0.25, 0.0, r);
    gl_FragColor = vec4(vColour * (0.6 + a * 0.9), a * vAlpha);
  }
`;

export class FxSystem {
  constructor() {
    this.particles = null;
    this._pCount = 0;
    this._decalIndex = 0;
    this._tracers = [];
    this._flashes = [];
  }

  async init() {
    const q = this.ctx.quality;
    this._budget = q.particleBudget;
    this._buildParticles(this._budget);
    this._buildDecals(q.decalBudget);
    this._buildTracers(64);
    this._buildMuzzleFlash();
  }

  async ready() {
    const bus = this.ctx.bus;
    bus.on('bullet:impact', (e) => this.impact(e.point, e.normal, e.surface, e.fromPlayer));
    bus.on('explosion', (e) => this.explosion(e.point, e.radius));
    bus.on('actor:death', (e) => this.actorDeath(e));
  }

  // ── Particles ─────────────────────────────────────────────────────────

  _buildParticles(n) {
    const geo = new THREE.BufferGeometry();
    this._pPos = new Float32Array(n * 3);
    this._pVel = new Float32Array(n * 3);
    this._pLife = new Float32Array(n);
    this._pMaxLife = new Float32Array(n);
    this._pSize = new Float32Array(n);
    this._pSize0 = new Float32Array(n);
    this._pAlpha = new Float32Array(n);
    this._pColour = new Float32Array(n * 3);
    this._pDrag = new Float32Array(n);
    this._pGrav = new Float32Array(n);

    // Park unused particles far below the world instead of branching in the
    // shader; the depth test discards them for free.
    for (let i = 0; i < n; i++) this._pPos[i * 3 + 1] = -100000;

    geo.setAttribute('position', new THREE.BufferAttribute(this._pPos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this._pSize, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this._pAlpha, 1));
    geo.setAttribute('aColour', new THREE.BufferAttribute(this._pColour, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    this.particles = new THREE.Points(geo, mat);
    this.particles.frustumCulled = false;
    this.particles.renderOrder = 10;
    this.ctx.scene.add(this.particles);
    this._pNext = 0;
  }

  emit(x, y, z, vx, vy, vz, opts) {
    const i = this._pNext;
    this._pNext = (this._pNext + 1) % this._budget;
    const i3 = i * 3;
    this._pPos[i3] = x; this._pPos[i3 + 1] = y; this._pPos[i3 + 2] = z;
    this._pVel[i3] = vx; this._pVel[i3 + 1] = vy; this._pVel[i3 + 2] = vz;
    const life = opts.life || 0.6;
    this._pLife[i] = life;
    this._pMaxLife[i] = life;
    this._pSize0[i] = opts.size || 0.05;
    this._pSize[i] = opts.size || 0.05;
    this._pAlpha[i] = opts.alpha !== undefined ? opts.alpha : 1;
    this._pDrag[i] = opts.drag !== undefined ? opts.drag : 2.2;
    this._pGrav[i] = opts.gravity !== undefined ? opts.gravity : 9;
    const c = opts.colour;
    this._pColour[i3] = ((c >> 16) & 255) / 255;
    this._pColour[i3 + 1] = ((c >> 8) & 255) / 255;
    this._pColour[i3 + 2] = (c & 255) / 255;
  }

  _updateParticles(dt) {
    const n = this._budget;
    const pos = this._pPos, vel = this._pVel;
    let live = 0;
    for (let i = 0; i < n; i++) {
      if (this._pLife[i] <= 0) continue;
      live++;
      this._pLife[i] -= dt;
      const i3 = i * 3;
      if (this._pLife[i] <= 0) {
        pos[i3 + 1] = -100000;
        this._pAlpha[i] = 0;
        continue;
      }
      const drag = Math.max(0, 1 - this._pDrag[i] * dt);
      vel[i3] *= drag;
      vel[i3 + 1] = vel[i3 + 1] * drag - this._pGrav[i] * dt;
      vel[i3 + 2] *= drag;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;

      const t = this._pLife[i] / this._pMaxLife[i];
      // Grow then fade — smoke expands, sparks shrink. Encoded in the sign of
      // the initial size so we do not need a per-particle behaviour flag.
      this._pAlpha[i] = t * t;
      this._pSize[i] = this._pSize0[i] * (this._pGrav[i] < 2 ? (2 - t) : (0.4 + t * 0.6));
    }
    this._liveParticles = live;
    const g = this.particles.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aColour.needsUpdate = true;
  }

  // ── Decals ────────────────────────────────────────────────────────────

  _buildDecals(n) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4
    });
    const inst = new THREE.InstancedMesh(geo, mat, n);
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    inst.count = n;
    inst.frustumCulled = false;
    inst.renderOrder = 5;

    // Start every slot collapsed to zero scale.
    const m = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < n; i++) inst.setMatrixAt(i, m);
    inst.instanceMatrix.needsUpdate = true;

    this.ctx.scene.add(inst);
    this.decals = inst;
    this._decalBudget = n;
  }

  addDecal(point, normal, size, colour) {
    const i = this._decalIndex;
    this._decalIndex = (this._decalIndex + 1) % this._decalBudget;

    const m = scratch.m0;
    const up = Math.abs(normal.y) > 0.95 ? scratch.v0.set(1, 0, 0) : scratch.v0.set(0, 1, 0);
    const z = scratch.v1.copy(normal).normalize();
    const x = scratch.v2.crossVectors(up, z).normalize();
    const y = scratch.v3.crossVectors(z, x);
    const s = size * (0.8 + this.ctx.rng.next() * 0.5);
    // Random roll so repeated hits on one wall do not read as stamped copies.
    const roll = this.ctx.rng.range(0, Math.PI * 2);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const xr = scratch.v4.copy(x).multiplyScalar(cr).addScaledVector(y, sr);
    const yr = scratch.v5.copy(y).multiplyScalar(cr).addScaledVector(x, -sr);

    m.set(
      xr.x * s, yr.x * s, z.x, point.x + normal.x * 0.012,
      xr.y * s, yr.y * s, z.y, point.y + normal.y * 0.012,
      xr.z * s, yr.z * s, z.z, point.z + normal.z * 0.012,
      0, 0, 0, 1
    );
    this.decals.setMatrixAt(i, m);
    scratch.color0.setHex(colour);
    this.decals.setColorAt(i, scratch.color0);
    this.decals.instanceMatrix.needsUpdate = true;
    if (this.decals.instanceColor) this.decals.instanceColor.needsUpdate = true;
  }

  // ── Tracers ───────────────────────────────────────────────────────────

  _buildTracers(n) {
    const geo = new THREE.CylinderGeometry(0.018, 0.006, 1, 5, 1, true);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0, -0.5);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xfff0c0,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    });
    const inst = new THREE.InstancedMesh(geo, mat, n);
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    inst.frustumCulled = false;
    inst.count = n;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < n; i++) inst.setMatrixAt(i, zero);
    this.ctx.scene.add(inst);
    this.tracerMesh = inst;
    this._tracerBudget = n;
    this._tracerPool = [];
    for (let i = 0; i < n; i++) this._tracerPool.push({ active: false, slot: i });
  }

  // Tracers travel: a round drawn instantly from muzzle to impact reads as a
  // laser. This flies a short bright segment along the path at speed.
  addTracer(from, to, speed = 340, thickness = 1) {
    let t = null;
    for (const c of this._tracerPool) if (!c.active) { t = c; break; }
    if (!t) return;
    t.active = true;
    t.from = from.clone();
    t.to = to.clone();
    t.dist = from.distanceTo(to);
    t.travelled = 0;
    t.speed = speed;
    t.length = Math.min(6, Math.max(1.6, t.dist * 0.22));
    t.thickness = thickness;
    this._tracers.push(t);
  }

  _updateTracers(dt) {
    const m = scratch.m0;
    const dir = scratch.v0;
    const head = scratch.v1;
    const zero = scratch.m1.makeScale(0, 0, 0);

    for (let i = this._tracers.length - 1; i >= 0; i--) {
      const t = this._tracers[i];
      t.travelled += t.speed * dt;
      if (t.travelled - t.length > t.dist) {
        this.tracerMesh.setMatrixAt(t.slot, zero);
        t.active = false;
        this._tracers.splice(i, 1);
        continue;
      }
      dir.subVectors(t.to, t.from).normalize();
      const headD = Math.min(t.travelled, t.dist);
      const tailD = Math.max(0, t.travelled - t.length);
      const len = headD - tailD;
      if (len <= 0.01) {
        this.tracerMesh.setMatrixAt(t.slot, zero);
        continue;
      }
      head.copy(t.from).addScaledVector(dir, headD);
      m.identity();
      m.lookAt(head, scratch.v2.copy(head).sub(dir), scratch.v3.set(0, 1, 0));
      m.setPosition(head);
      m.scale(scratch.v4.set(t.thickness, t.thickness, len));
      this.tracerMesh.setMatrixAt(t.slot, m);
    }
    this.tracerMesh.instanceMatrix.needsUpdate = true;
  }

  // ── Muzzle flash ──────────────────────────────────────────────────────

  _buildMuzzleFlash() {
    const geo = new THREE.PlaneGeometry(0.5, 0.5);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd489,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    this.muzzleQuad = new THREE.Mesh(geo, mat);
    this.muzzleQuad.renderOrder = 20;
    this.muzzleQuad.visible = false;

    this.muzzleLight = new THREE.PointLight(0xffc070, 0, 14, 2);
    this.ctx.scene.add(this.muzzleLight);
    this._muzzleT = 0;

    // A second permanent light for blasts. Both stay in the scene at zero
    // intensity between uses: three keys shader permutations on the visible
    // light count, so adding and removing lights would recompile every lit
    // material in the level mid-firefight.
    this.blastLight = new THREE.PointLight(0xff8a3a, 0, 24, 2);
    this.ctx.scene.add(this.blastLight);
    this._blastT = 0;
  }

  // `parent` lets the weapon attach the flash to the viewmodel so it tracks
  // the barrel exactly; world-space shots pass null.
  muzzleFlash(worldPos, parent, scale = 1) {
    if (parent && this.muzzleQuad.parent !== parent) {
      parent.add(this.muzzleQuad);
    }
    this.muzzleQuad.visible = true;
    this.muzzleQuad.material.opacity = 1;
    this.muzzleQuad.scale.setScalar(scale * this.ctx.rng.range(0.85, 1.3));
    this.muzzleQuad.rotation.z = this.ctx.rng.range(0, Math.PI * 2);
    this.muzzleLight.position.copy(worldPos);
    this.muzzleLight.intensity = 9 * scale;
    this._muzzleT = 0.055;
  }

  // ── Composite effects ─────────────────────────────────────────────────

  impact(point, normal, surface, fromPlayer) {
    const fx = SURFACE_FX[surface] || SURFACE_FX.stone;
    const rng = this.ctx.rng;
    const n = Math.round(9 * (this.ctx.quality.particleBudget / 2400 + 0.5));

    // Dust puff along the surface normal.
    for (let i = 0; i < n * fx.dust; i++) {
      const sp = rng.range(1.2, 4.5);
      this.emit(
        point.x, point.y, point.z,
        normal.x * sp + rng.spread(1.7),
        normal.y * sp + rng.spread(1.7) + 0.6,
        normal.z * sp + rng.spread(1.7),
        {
          colour: fx.colour, size: rng.range(0.035, 0.11), life: rng.range(0.35, 0.85),
          drag: 3.4, gravity: 1.2, alpha: 0.55
        }
      );
    }
    // Sparks: fast, hot, gravity-bound, short-lived.
    for (let i = 0; i < n * fx.spark; i++) {
      const sp = rng.range(5, 13);
      this.emit(
        point.x, point.y, point.z,
        normal.x * sp + rng.spread(5),
        normal.y * sp + rng.spread(5),
        normal.z * sp + rng.spread(5),
        {
          colour: 0xffb347, size: rng.range(0.014, 0.032), life: rng.range(0.18, 0.5),
          drag: 1.1, gravity: 22, alpha: 1
        }
      );
    }

    if (surface !== 'flesh') this.addDecal(point, normal, 0.19, fx.decal);
  }

  explosion(point, radius) {
    const rng = this.ctx.rng;
    const budget = this.ctx.quality.particleBudget;
    const n = Math.round(clamp(budget / 28, 24, 90));

    for (let i = 0; i < n; i++) {
      const dir = scratch.v0.set(rng.spread(1), rng.spread(1), rng.spread(1)).normalize();
      const sp = rng.range(3, 16) * (radius / 3);
      this.emit(
        point.x, point.y, point.z,
        dir.x * sp, dir.y * sp + 2, dir.z * sp,
        {
          colour: i % 3 === 0 ? 0xffd08a : 0xff6a22,
          size: rng.range(0.1, 0.42), life: rng.range(0.4, 1.1),
          drag: 2.6, gravity: -1.2, alpha: 0.85
        }
      );
    }
    // Lingering smoke: negative gravity so it rises, low drag so it drifts.
    for (let i = 0; i < n * 0.6; i++) {
      const dir = scratch.v0.set(rng.spread(1), rng.range(0, 1), rng.spread(1)).normalize();
      this.emit(
        point.x, point.y, point.z,
        dir.x * rng.range(1, 5), dir.y * rng.range(1, 4), dir.z * rng.range(1, 5),
        {
          colour: 0x2a2a2e,
          size: rng.range(0.3, 0.8), life: rng.range(1.2, 2.4),
          drag: 1.4, gravity: -0.8, alpha: 0.35
        }
      );
    }

    this.blastLight.position.copy(point);
    this.blastLight.distance = radius * 6;
    this._blastT = 0.36;
    this.ctx.get('render').setFlash(clamp(radius * 0.05, 0.04, 0.18));
  }

  actorDeath(e) {
    const rng = this.ctx.rng;
    const phys = this.ctx.get('physics');
    const point = e.point;

    // Burst.
    for (let i = 0; i < 34; i++) {
      const dir = scratch.v0.set(rng.spread(1), rng.spread(1), rng.spread(1)).normalize();
      const sp = rng.range(3, 12);
      this.emit(point.x, point.y, point.z, dir.x * sp, dir.y * sp + 3, dir.z * sp, {
        colour: i % 4 === 0 ? 0xffcf7a : 0xff4a18,
        size: rng.range(0.05, 0.2), life: rng.range(0.3, 0.9),
        drag: 2.2, gravity: 3, alpha: 0.9
      });
    }

    // Real debris with gravity and bounce, unlike round 1's straight-flying
    // shards that were secretly enemy projectiles.
    const mat = new THREE.MeshStandardMaterial({
      color: 0x24262e, metalness: 0.85, roughness: 0.4,
      emissive: 0xff3a12, emissiveIntensity: 0.7,
      transparent: true, opacity: 1
    });
    const count = Math.min(12, Math.round(this.ctx.quality.debrisBudget / 12));
    for (let i = 0; i < count; i++) {
      const s = rng.range(0.09, 0.24);
      const geo = new THREE.BoxGeometry(s, s * rng.range(0.5, 1.4), s * rng.range(0.5, 1.4));
      const mesh = new THREE.Mesh(geo, mat.clone());
      mesh.castShadow = true;
      const dir = scratch.v0.set(rng.spread(1), rng.range(0.2, 1), rng.spread(1)).normalize();
      phys.spawnDebris(mesh, point, dir.multiplyScalar(rng.range(4, 11)), {
        life: rng.range(5, 9), radius: s * 0.6, bounce: 0.34,
        onExpire: (d) => { d.mesh.geometry.dispose(); d.mesh.material.dispose(); }
      });
    }

    this.ctx.get('render').setFlash(0.03);
  }

  update(dt) {
    this._updateParticles(dt);
    this._updateTracers(dt);

    if (this._muzzleT > 0) {
      this._muzzleT -= dt;
      const t = clamp(this._muzzleT / 0.055, 0, 1);
      this.muzzleQuad.material.opacity = t;
      this.muzzleLight.intensity = 9 * t;
      if (this._muzzleT <= 0) {
        this.muzzleQuad.visible = false;
        this.muzzleLight.intensity = 0;
      }
    }

    if (this._blastT > 0) {
      this._blastT -= dt;
      const t = clamp(this._blastT / 0.36, 0, 1);
      // Squared falloff so the blast punches hard and dies fast.
      this.blastLight.intensity = 26 * t * t;
      if (this._blastT <= 0) this.blastLight.intensity = 0;
    }
  }

  reset() {
    for (let i = 0; i < this._budget; i++) {
      this._pLife[i] = 0;
      this._pAlpha[i] = 0;
      this._pPos[i * 3 + 1] = -100000;
    }
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const t of this._tracerPool) {
      t.active = false;
      this.tracerMesh.setMatrixAt(t.slot, zero);
    }
    this._tracers.length = 0;
    for (let i = 0; i < this._decalBudget; i++) this.decals.setMatrixAt(i, zero);
    this.decals.instanceMatrix.needsUpdate = true;
    this.tracerMesh.instanceMatrix.needsUpdate = true;
  }
}

export { SURFACE_FX };

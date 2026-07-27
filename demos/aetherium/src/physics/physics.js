import * as THREE from 'three';
import { scratch } from '../core/loop.js';
import { clamp } from '../core/rng.js';
import { VOID_Y } from '../world/world.js';

// Physics.
//
// Round 1 had no collision at all beyond a top-surface lookup, so you could
// walk through every column, wall and dome in the level. This is a real solver:
// a uniform-grid broadphase over the world's colliders, vertical-capsule
// resolution with step-up and slide, ray casts for hitscan and AI vision, and
// gravity-driven debris.
//
// Everything runs on the fixed 120Hz step so behaviour does not change with
// frame rate.

const CELL = 8;
const SKIN = 0.02;
const MAX_SUBSTEP = 0.35;

export class PhysicsSystem {
  constructor() {
    this.colliders = [];
    this.grid = new Map();
    this.debris = [];
    this._candidates = [];
    this._hit = {
      hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(),
      distance: 0, collider: null, surface: 'stone'
    };
  }

  async init() {
    // Colliders come from the world, which builds during its own init.
  }

  async ready() {
    this.colliders = this.ctx.get('world').colliders;
    this._rebuildGrid();
  }

  _rebuildGrid() {
    this.grid.clear();
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      const b = this._bounds(c);
      const x0 = Math.floor(b.minX / CELL), x1 = Math.floor(b.maxX / CELL);
      const z0 = Math.floor(b.minZ / CELL), z1 = Math.floor(b.maxZ / CELL);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const key = x * 73856093 ^ z * 19349663;
          let list = this.grid.get(key);
          if (!list) this.grid.set(key, (list = []));
          list.push(c);
        }
      }
    }
  }

  _bounds(c) {
    if (c.type === 'cyl') {
      return {
        minX: c.x - c.radius, maxX: c.x + c.radius,
        minY: c.minY, maxY: c.maxY,
        minZ: c.z - c.radius, maxZ: c.z + c.radius
      };
    }
    return c;
  }

  // Gather colliders whose cells overlap the query box. The candidate list is
  // reused, and a per-query stamp prevents a collider spanning several cells
  // from being tested more than once.
  query(minX, minZ, maxX, maxZ) {
    const out = this._candidates;
    out.length = 0;
    this._stamp = (this._stamp || 0) + 1;
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL), z1 = Math.floor(maxZ / CELL);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const list = this.grid.get(x * 73856093 ^ z * 19349663);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (c._stamp === this._stamp) continue;
          c._stamp = this._stamp;
          if (c.active === false) continue;
          out.push(c);
        }
      }
    }
    return out;
  }

  // ── Character movement ────────────────────────────────────────────────

  // Moves a vertical capsule by `delta`, resolving against the world.
  // `state` is mutated with grounded / groundSurface / hitWall / steppedUp.
  moveCapsule(pos, radius, height, delta, state) {
    state.grounded = false;
    state.hitWall = false;
    state.steppedUp = 0;
    state.groundSurface = 'stone';

    // Horizontal first, in substeps small enough that a fast player cannot
    // tunnel through a wall between two frames.
    const hLen = Math.hypot(delta.x, delta.z);
    const steps = Math.max(1, Math.ceil(hLen / MAX_SUBSTEP));
    const sx = delta.x / steps;
    const sz = delta.z / steps;
    for (let i = 0; i < steps; i++) {
      pos.x += sx;
      pos.z += sz;
      this._resolveHorizontal(pos, radius, height, state);
    }

    // Then vertical.
    pos.y += delta.y;
    this._resolveVertical(pos, radius, height, state, delta.y);
    return state;
  }

  _resolveHorizontal(pos, radius, height, state) {
    const feet = pos.y;
    const head = pos.y + height;
    const list = this.query(pos.x - radius - 0.5, pos.z - radius - 0.5,
      pos.x + radius + 0.5, pos.z + radius + 0.5);

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      // Vertical overlap test with a small tolerance, so standing exactly on a
      // surface is not read as colliding with its side.
      if (c.maxY <= feet + 0.06 || c.minY >= head - 0.02) continue;

      if (c.type === 'cyl') {
        const dx = pos.x - c.x;
        const dz = pos.z - c.z;
        const d = Math.hypot(dx, dz);
        const minD = radius + c.radius;
        if (d >= minD || d < 1e-6) continue;
        // Step up onto low obstacles instead of being stopped by a kerb.
        if (c.climbable && c.maxY - feet <= state.stepHeight && this._hasHeadroom(pos, radius, height, c.maxY)) {
          pos.y = c.maxY + SKIN;
          state.steppedUp = c.maxY - feet;
          continue;
        }
        const push = (minD - d) + SKIN;
        pos.x += (dx / d) * push;
        pos.z += (dz / d) * push;
        state.hitWall = true;
        state.wallNormal.set(dx / d, 0, dz / d);
      } else {
        // Closest point on the box footprint to the capsule axis.
        const cx = clamp(pos.x, c.minX, c.maxX);
        const cz = clamp(pos.z, c.minZ, c.maxZ);
        const dx = pos.x - cx;
        const dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;

        if (d2 >= radius * radius) {
          // Outside the inflated footprint entirely.
          if (d2 > 1e-9) continue;
        }

        if (c.climbable && c.maxY - feet <= state.stepHeight && c.maxY > feet &&
          this._hasHeadroom(pos, radius, height, c.maxY)) {
          pos.y = c.maxY + SKIN;
          state.steppedUp = c.maxY - feet;
          continue;
        }

        if (d2 > 1e-9) {
          const d = Math.sqrt(d2);
          const push = (radius - d) + SKIN;
          pos.x += (dx / d) * push;
          pos.z += (dz / d) * push;
          state.wallNormal.set(dx / d, 0, dz / d);
        } else {
          // Centre is inside the footprint: eject along the shallowest axis.
          const pxPos = c.maxX - pos.x + radius;
          const pxNeg = pos.x - c.minX + radius;
          const pzPos = c.maxZ - pos.z + radius;
          const pzNeg = pos.z - c.minZ + radius;
          const m = Math.min(pxPos, pxNeg, pzPos, pzNeg);
          if (m === pxPos) { pos.x = c.maxX + radius + SKIN; state.wallNormal.set(1, 0, 0); }
          else if (m === pxNeg) { pos.x = c.minX - radius - SKIN; state.wallNormal.set(-1, 0, 0); }
          else if (m === pzPos) { pos.z = c.maxZ + radius + SKIN; state.wallNormal.set(0, 0, 1); }
          else { pos.z = c.minZ - radius - SKIN; state.wallNormal.set(0, 0, -1); }
        }
        state.hitWall = true;
      }
    }
  }

  _hasHeadroom(pos, radius, height, newFeet) {
    const list = this.query(pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius);
    const head = newFeet + height;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.minY >= head - 0.05 || c.maxY <= newFeet + 0.05) continue;
      if (c.type === 'cyl') {
        if (Math.hypot(pos.x - c.x, pos.z - c.z) < radius + c.radius) return false;
      } else if (pos.x + radius > c.minX && pos.x - radius < c.maxX &&
        pos.z + radius > c.minZ && pos.z - radius < c.maxZ) {
        return false;
      }
    }
    return true;
  }

  _resolveVertical(pos, radius, height, state, dy) {
    const list = this.query(pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius);
    let bestTop = -Infinity;
    let bestSurface = 'stone';
    let ceiling = Infinity;

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      let overlaps;
      if (c.type === 'cyl') {
        overlaps = Math.hypot(pos.x - c.x, pos.z - c.z) < radius + c.radius;
      } else {
        const cx = clamp(pos.x, c.minX, c.maxX);
        const cz = clamp(pos.z, c.minZ, c.maxZ);
        overlaps = (pos.x - cx) ** 2 + (pos.z - cz) ** 2 < radius * radius;
      }
      if (!overlaps) continue;

      // Surfaces at or just below the feet are ground candidates.
      if (c.maxY <= pos.y + Math.max(0.12, -dy) + SKIN && c.maxY > bestTop) {
        bestTop = c.maxY;
        bestSurface = c.surface;
      }
      // Surfaces above the head are ceiling candidates.
      if (c.minY >= pos.y + height - SKIN && c.minY < ceiling) {
        ceiling = c.minY;
      }
    }

    if (dy <= 0 && bestTop > -Infinity && pos.y <= bestTop + Math.max(0.12, -dy)) {
      pos.y = bestTop;
      state.grounded = true;
      state.groundSurface = bestSurface;
    }
    if (dy > 0 && ceiling < Infinity && pos.y + height > ceiling) {
      pos.y = ceiling - height - SKIN;
      state.hitCeiling = true;
    }
  }

  // Height of the highest walkable surface under a point, or null. Used by the
  // nav-grid bake and by AI when placing itself.
  groundAt(x, z, fromY = 200, maxDrop = 400) {
    const list = this.query(x - 0.1, z - 0.1, x + 0.1, z + 0.1);
    let best = null;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.maxY > fromY) continue;
      if (c.maxY < fromY - maxDrop) continue;
      let inside;
      if (c.type === 'cyl') inside = Math.hypot(x - c.x, z - c.z) <= c.radius;
      else inside = x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ;
      if (inside && (best === null || c.maxY > best.y)) {
        best = { y: c.maxY, surface: c.surface, collider: c };
      }
    }
    return best;
  }

  // ── Ray casting ───────────────────────────────────────────────────────

  // Ray against world colliders. Returns the shared hit record — copy anything
  // you need to keep. `ignoreSight` skips colliders flagged as not blocking
  // line of sight (parapets, railings) for AI vision queries.
  raycast(origin, dir, maxDist = 200, sightOnly = false) {
    const hit = this._hit;
    hit.hit = false;
    hit.distance = maxDist;
    hit.collider = null;

    // March the broadphase grid rather than testing every collider in the map.
    const step = CELL * 0.85;
    const n = Math.ceil(maxDist / step);
    this._stamp = (this._stamp || 0) + 1;
    let best = maxDist;

    for (let s = 0; s <= n; s++) {
      const t = Math.min(maxDist, s * step);
      const px = origin.x + dir.x * t;
      const pz = origin.z + dir.z * t;
      const gx = Math.floor(px / CELL);
      const gz = Math.floor(pz / CELL);

      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const list = this.grid.get((gx + ox) * 73856093 ^ (gz + oz) * 19349663);
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const c = list[i];
            if (c._stamp === this._stamp) continue;
            c._stamp = this._stamp;
            if (c.active === false) continue;
            if (sightOnly && c.blocksSight === false) continue;
            const d = c.type === 'cyl'
              ? this._rayCylinder(origin, dir, c, best)
              : this._rayBox(origin, dir, c, best);
            if (d !== null && d < best) {
              best = d;
              hit.hit = true;
              hit.distance = d;
              hit.collider = c;
              hit.surface = c.surface;
              hit.point.set(origin.x + dir.x * d, origin.y + dir.y * d, origin.z + dir.z * d);
              hit.normal.copy(this._lastNormal);
            }
          }
        }
      }
      // Once we have a hit closer than the next cell boundary, nothing further
      // along the ray can beat it.
      if (hit.hit && best < t) break;
    }
    return hit;
  }

  _rayBox(o, d, c, maxT) {
    let tmin = 0;
    let tmax = maxT;
    let nx = 0, ny = 0, nz = 0;

    for (const axis of [0, 1, 2]) {
      const od = axis === 0 ? o.x : axis === 1 ? o.y : o.z;
      const dd = axis === 0 ? d.x : axis === 1 ? d.y : d.z;
      const lo = axis === 0 ? c.minX : axis === 1 ? c.minY : c.minZ;
      const hi = axis === 0 ? c.maxX : axis === 1 ? c.maxY : c.maxZ;

      if (Math.abs(dd) < 1e-8) {
        if (od < lo || od > hi) return null;
        continue;
      }
      const inv = 1 / dd;
      let t1 = (lo - od) * inv;
      let t2 = (hi - od) * inv;
      let sign = -1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sign = 1; }
      if (t1 > tmin) {
        tmin = t1;
        nx = axis === 0 ? sign : 0;
        ny = axis === 1 ? sign : 0;
        nz = axis === 2 ? sign : 0;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    if (tmin <= 0) return null;
    this._lastNormal.set(nx, ny, nz);
    return tmin;
  }

  _rayCylinder(o, d, c, maxT) {
    const ox = o.x - c.x;
    const oz = o.z - c.z;
    const a = d.x * d.x + d.z * d.z;
    if (a < 1e-9) return null;
    const b = 2 * (ox * d.x + oz * d.z);
    const cc = ox * ox + oz * oz - c.radius * c.radius;
    const disc = b * b - 4 * a * cc;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    let t = (-b - sq) / (2 * a);
    if (t <= 0) t = (-b + sq) / (2 * a);
    if (t <= 0 || t > maxT) return null;
    const y = o.y + d.y * t;
    if (y < c.minY || y > c.maxY) {
      // Try the caps.
      const capY = d.y > 0 ? c.minY : c.maxY;
      const tc = (capY - o.y) / (d.y || 1e-9);
      if (tc <= 0 || tc > maxT) return null;
      const px = o.x + d.x * tc - c.x;
      const pz = o.z + d.z * tc - c.z;
      if (px * px + pz * pz > c.radius * c.radius) return null;
      this._lastNormal.set(0, d.y > 0 ? -1 : 1, 0);
      return tc;
    }
    const hx = o.x + d.x * t - c.x;
    const hz = o.z + d.z * t - c.z;
    const inv = 1 / Math.hypot(hx, hz);
    this._lastNormal.set(hx * inv, 0, hz * inv);
    return t;
  }

  // Cheap boolean visibility test, ignoring geometry flagged as see-through.
  lineOfSight(from, to, padding = 0.25) {
    const dir = scratch.v3.subVectors(to, from);
    const dist = dir.length();
    if (dist < 0.01) return true;
    dir.multiplyScalar(1 / dist);
    const hit = this.raycast(from, dir, dist - padding, true);
    return !hit.hit;
  }

  // ── Debris ────────────────────────────────────────────────────────────

  // Round 1 pushed death shards into the projectile array with zero gravity, so
  // they flew in straight lines and ran player-collision every frame. These are
  // real ballistic bodies with bounce, friction, angular velocity and a budget.
  spawnDebris(mesh, position, velocity, opts = {}) {
    const budget = this.ctx.quality.debrisBudget;
    if (this.debris.length >= budget) {
      const old = this.debris.shift();
      this.ctx.scene.remove(old.mesh);
      if (old.onExpire) old.onExpire(old);
    }
    mesh.position.copy(position);
    this.ctx.scene.add(mesh);
    this.debris.push({
      mesh,
      vel: velocity.clone(),
      angVel: new THREE.Vector3(
        this.ctx.rng.spread(9), this.ctx.rng.spread(9), this.ctx.rng.spread(9)
      ),
      life: opts.life || 6,
      maxLife: opts.life || 6,
      radius: opts.radius || 0.12,
      bounce: opts.bounce !== undefined ? opts.bounce : 0.32,
      friction: opts.friction !== undefined ? opts.friction : 0.72,
      onExpire: opts.onExpire || null,
      resting: false
    });
  }

  fixedUpdate(step) {
    const g = 24;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= step;
      if (d.life <= 0 || d.mesh.position.y < VOID_Y) {
        this.ctx.scene.remove(d.mesh);
        if (d.onExpire) d.onExpire(d);
        this.debris.splice(i, 1);
        continue;
      }
      if (d.resting) continue;

      d.vel.y -= g * step;
      const p = d.mesh.position;
      const nx = p.x + d.vel.x * step;
      const ny = p.y + d.vel.y * step;
      const nz = p.z + d.vel.z * step;

      const ground = this.groundAt(nx, nz, p.y + d.radius + 0.5, 4);
      if (ground && ny - d.radius <= ground.y && d.vel.y <= 0) {
        p.set(nx, ground.y + d.radius, nz);
        d.vel.y = -d.vel.y * d.bounce;
        d.vel.x *= d.friction;
        d.vel.z *= d.friction;
        d.angVel.multiplyScalar(d.friction);
        // Park bodies that have essentially stopped, so a hundred settled
        // shards cost nothing.
        if (Math.abs(d.vel.y) < 0.6 && d.vel.lengthSq() < 0.5) {
          d.resting = true;
          d.vel.set(0, 0, 0);
        }
      } else {
        p.set(nx, ny, nz);
      }

      d.mesh.rotation.x += d.angVel.x * step;
      d.mesh.rotation.y += d.angVel.y * step;
      d.mesh.rotation.z += d.angVel.z * step;
    }
  }

  update(dt) {
    // Fade debris out over its last second rather than popping it away.
    for (let i = 0; i < this.debris.length; i++) {
      const d = this.debris[i];
      if (d.life < 1 && d.mesh.material.transparent) {
        d.mesh.material.opacity = d.life;
      }
    }
  }

  reset() {
    for (const d of this.debris) this.ctx.scene.remove(d.mesh);
    this.debris.length = 0;
  }
}

PhysicsSystem.prototype._lastNormal = new THREE.Vector3();

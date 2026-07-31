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

// ── Collider shapes ───────────────────────────────────────────────────────
//
// Four kinds, and the reason there are four is worth stating. Axis-aligned
// boxes are cheap and correct for architecture that runs along the world axes,
// which most of this level does. They are badly wrong for anything diagonal:
// the AABB of a 2.5m plank at 45 degrees is a 5.3m square, so a diagonal bridge
// built from per-segment boxes has every segment sitting inside its
// neighbours' volumes. That is what made bridges impassable.
//
//   box   axis-aligned, blocks horizontally, walkable on top
//   obox  yaw-rotated box — same, without the diagonal inflation
//   cyl   vertical cylinder, for columns
//   ramp  oriented sloped surface, GROUND ONLY — never blocks horizontally,
//         so there is no step-up to be refused and no seam to catch on

// Surface height of a ramp at a world point, or null if outside its footprint.
export function rampSurfaceY(c, x, z) {
  const px = x - c.x;
  const pz = z - c.z;
  const u = px * c.dx + pz * c.dz;        // along the run
  const v = -px * c.dz + pz * c.dx;       // across it
  if (u < -c.halfLen || u > c.halfLen) return null;
  if (v < -c.halfWidth || v > c.halfWidth) return null;
  const t = (u + c.halfLen) / (2 * c.halfLen);
  let y = c.y0 + (c.y1 - c.y0) * t;
  if (c.arch) y += c.arch * Math.sin(t * Math.PI);
  return y;
}

// World offset -> oriented-box local space (rotate by -yaw).
function oboxLocalX(c, px, pz) { return px * c.cos + pz * c.sin; }
function oboxLocalZ(c, px, pz) { return -px * c.sin + pz * c.cos; }

// Does the capsule footprint overlap this collider's footprint?
//
// The comparisons are `<=`, not `<`, and that matters: `groundAt` is a point
// query and passes radius 0, so a strict `<` would compare `0 < 0` and report
// that a point sitting squarely inside a box is outside it. That is exactly
// what happened on the first pass — the navigation grid collapsed from 7000
// walkable cells to 439 because every point query missed.
function overlapsFootprint(c, x, z, radius) {
  if (c.type === 'cyl') {
    const dx = x - c.x, dz = z - c.z;
    const r = radius + c.radius;
    return dx * dx + dz * dz <= r * r;
  }
  if (c.type === 'obox') {
    const px = x - c.x, pz = z - c.z;
    const lx = oboxLocalX(c, px, pz);
    const lz = oboxLocalZ(c, px, pz);
    const qx = lx - clamp(lx, -c.hx, c.hx);
    const qz = lz - clamp(lz, -c.hz, c.hz);
    return qx * qx + qz * qz <= radius * radius;
  }
  if (c.type === 'ramp') return rampSurfaceY(c, x, z) !== null;
  const cx = clamp(x, c.minX, c.maxX);
  const cz = clamp(z, c.minZ, c.maxZ);
  const dx = x - cx, dz = z - cz;
  return dx * dx + dz * dz <= radius * radius;
}

// Top surface of a collider under a point, or null when the point is outside.
function topAt(c, x, z, radius) {
  if (c.type === 'ramp') return rampSurfaceY(c, x, z);
  return overlapsFootprint(c, x, z, radius) ? c.maxY : null;
}

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
      const c = this._prepare(this.colliders[i]);
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
    if (c.type === 'obox') {
      const ex = c.hx * Math.abs(c.cos) + c.hz * Math.abs(c.sin);
      const ez = c.hx * Math.abs(c.sin) + c.hz * Math.abs(c.cos);
      return {
        minX: c.x - ex, maxX: c.x + ex,
        minY: c.minY, maxY: c.maxY,
        minZ: c.z - ez, maxZ: c.z + ez
      };
    }
    if (c.type === 'ramp') {
      const ex = c.halfLen * Math.abs(c.dx) + c.halfWidth * Math.abs(c.dz);
      const ez = c.halfLen * Math.abs(c.dz) + c.halfWidth * Math.abs(c.dx);
      return {
        minX: c.x - ex, maxX: c.x + ex,
        minY: c.minY, maxY: c.maxY,
        minZ: c.z - ez, maxZ: c.z + ez
      };
    }
    return c;
  }

  // Normalises the shorthand each collider factory emits into the derived
  // fields the solver expects. Called once at bake time, not per frame.
  _prepare(c) {
    if (c.type === 'obox' && c.cos === undefined) {
      c.cos = Math.cos(c.yaw);
      c.sin = Math.sin(c.yaw);
      c.minY = c.y - c.hy;
      c.maxY = c.y + c.hy;
    }
    if (c.type === 'ramp' && c.minY === undefined) {
      const lo = Math.min(c.y0, c.y1);
      const hi = Math.max(c.y0, c.y1) + Math.max(0, c.arch || 0);
      c.minY = lo - (c.thickness || 1.0);
      c.maxY = hi;
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

    // Ground snapping. Only when we were already on the ground and are not
    // moving upward — otherwise this would cancel jumps.
    if (!state.grounded && state.wasGrounded && delta.y <= 0) {
      this._snapToGround(pos, radius, height, state, state.stepHeight);
    }
    return state;
  }

  _resolveHorizontal(pos, radius, height, state) {
    const feet = pos.y;
    const head = pos.y + height;
    const list = this.query(pos.x - radius - 0.5, pos.z - radius - 0.5,
      pos.x + radius + 0.5, pos.z + radius + 0.5);

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      // Ramps are walkable surfaces, never walls. This is the whole point of
      // the type: there is no side to be stopped by, so a sloped bridge cannot
      // trap you no matter how it is oriented.
      if (c.type === 'ramp') continue;

      // Vertical overlap test with a small tolerance, so standing exactly on a
      // surface is not read as colliding with its side.
      if (c.maxY <= feet + 0.06 || c.minY >= head - 0.02) continue;

      if (c.type === 'obox') {
        const px = pos.x - c.x;
        const pz = pos.z - c.z;
        const lx = oboxLocalX(c, px, pz);
        const lz = oboxLocalZ(c, px, pz);
        const qx = lx - clamp(lx, -c.hx, c.hx);
        const qz = lz - clamp(lz, -c.hz, c.hz);
        const d2 = qx * qx + qz * qz;
        if (d2 >= radius * radius && d2 > 1e-9) continue;

        if (c.climbable && c.maxY - feet <= state.stepHeight && c.maxY > feet &&
          this._hasHeadroom(pos, radius, height, c.maxY, state.stepHeight)) {
          pos.y = c.maxY + SKIN;
          state.steppedUp = c.maxY - feet;
          continue;
        }

        // Resolve in the box's own frame, then rotate the push back out.
        let nx, nz;
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2);
          const push = (radius - d) + SKIN;
          nx = (qx / d) * push;
          nz = (qz / d) * push;
        } else {
          const pxPos = c.hx - lx + radius;
          const pxNeg = lx + c.hx + radius;
          const pzPos = c.hz - lz + radius;
          const pzNeg = lz + c.hz + radius;
          const m = Math.min(pxPos, pxNeg, pzPos, pzNeg);
          if (m === pxPos) { nx = pxPos; nz = 0; }
          else if (m === pxNeg) { nx = -pxNeg; nz = 0; }
          else if (m === pzPos) { nx = 0; nz = pzPos; }
          else { nx = 0; nz = -pzNeg; }
        }
        const wx = nx * c.cos - nz * c.sin;
        const wz = nx * c.sin + nz * c.cos;
        pos.x += wx;
        pos.z += wz;
        const wl = Math.hypot(wx, wz) || 1;
        state.wallNormal.set(wx / wl, 0, wz / wl);
        state.hitWall = true;
        continue;
      }

      if (c.type === 'cyl') {
        const dx = pos.x - c.x;
        const dz = pos.z - c.z;
        const d = Math.hypot(dx, dz);
        const minD = radius + c.radius;
        if (d >= minD || d < 1e-6) continue;
        // Step up onto low obstacles instead of being stopped by a kerb.
        if (c.climbable && c.maxY - feet <= state.stepHeight &&
          this._hasHeadroom(pos, radius, height, c.maxY, state.stepHeight)) {
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
          this._hasHeadroom(pos, radius, height, c.maxY, state.stepHeight)) {
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

  // Can the capsule stand with its feet at `newFeet` without being inside
  // something?
  //
  // The subtlety that broke bridges: a collider whose top is only slightly
  // above the new foot height is not a ceiling, it is the next step. The
  // original test rejected any collider with `maxY > newFeet`, so the next
  // deck segment up an arch vetoed the step onto the one before it — and
  // because diagonal segments have wildly inflated bounds, that segment
  // genuinely did overlap where you were standing. Anything you could also
  // step onto is skipped.
  _hasHeadroom(pos, radius, height, newFeet, stepHeight = 0) {
    const list = this.query(pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius);
    const head = newFeet + height;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.type === 'ramp') continue;              // walkable, never a ceiling
      if (c.minY >= head - 0.05) continue;          // entirely above the head
      if (c.maxY <= newFeet + 0.05) continue;       // entirely below the feet
      if (c.climbable !== false && c.maxY <= newFeet + stepHeight) continue;
      if (overlapsFootprint(c, pos.x, pos.z, radius)) return false;
    }
    return true;
  }

  // Probe downward for a surface within `maxDrop` of the feet.
  //
  // Without this the player leaves the ground on every downward step and every
  // arch crest, which reads as a constant series of little hops. Real
  // controllers stick to the ground unless you jump.
  _snapToGround(pos, radius, height, state, maxDrop) {
    const list = this.query(pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius);
    let best = -Infinity;
    let surface = 'stone';
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const top = topAt(c, pos.x, pos.z, radius);
      if (top === null) continue;
      if (top > pos.y + 0.02 || top < pos.y - maxDrop) continue;
      if (top > best) { best = top; surface = c.surface; }
    }
    if (best === -Infinity) return false;
    pos.y = best;
    state.grounded = true;
    state.groundSurface = surface;
    return true;
  }

  _resolveVertical(pos, radius, height, state, dy) {
    const list = this.query(pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius);
    let bestTop = -Infinity;
    let bestSurface = 'stone';
    let ceiling = Infinity;

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      // Ramps report the height of the slope directly under the capsule, so
      // walking one is a continuous surface rather than a run of steps.
      const top = topAt(c, pos.x, pos.z, radius);
      if (top === null) continue;

      // Surfaces at or just below the feet are ground candidates.
      if (top <= pos.y + Math.max(0.12, -dy) + SKIN && top > bestTop) {
        bestTop = top;
        bestSurface = c.surface;
      }
      // Surfaces above the head are ceiling candidates. A ramp has no
      // underside you can hit your head on in this level.
      if (c.type !== 'ramp' && c.minY >= pos.y + height - SKIN && c.minY < ceiling) {
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
      // Radius 0 — this is a point query, not a capsule.
      const top = topAt(c, x, z, 0);
      if (top === null) continue;
      if (top > fromY || top < fromY - maxDrop) continue;
      if (best === null || top > best.y) {
        best = { y: top, surface: c.surface, collider: c };
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
            const d = c.type === 'cyl' ? this._rayCylinder(origin, dir, c, best)
              : c.type === 'obox' ? this._rayObox(origin, dir, c, best)
                : c.type === 'ramp' ? this._rayRamp(origin, dir, c, best)
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

  // An oriented box is a plain slab test in the box's own frame.
  _rayObox(o, d, c, maxT) {
    const px = o.x - c.x;
    const pz = o.z - c.z;
    const lo = {
      x: oboxLocalX(c, px, pz),
      y: o.y - c.y,
      z: oboxLocalZ(c, px, pz)
    };
    const ld = {
      x: oboxLocalX(c, d.x, d.z),
      y: d.y,
      z: oboxLocalZ(c, d.x, d.z)
    };
    const local = {
      minX: -c.hx, maxX: c.hx,
      minY: -c.hy, maxY: c.hy,
      minZ: -c.hz, maxZ: c.hz
    };
    const t = this._rayBox(lo, ld, local, maxT);
    if (t === null) return null;
    // _lastNormal is in box space; rotate it back to world.
    const n = this._lastNormal;
    const nx = n.x * c.cos - n.z * c.sin;
    const nz = n.x * c.sin + n.z * c.cos;
    n.set(nx, n.y, nz);
    return t;
  }

  // Ramps have no closed-form intersection, so march the ray and find where it
  // first drops below the surface, then bisect for a usable point. Accurate to
  // a few centimetres, which is well inside what bullets and vision need.
  _rayRamp(o, d, c, maxT) {
    const b = this._bounds(c);
    // Cheap reject against the ramp's AABB first.
    if (this._rayBox(o, d, b, maxT) === null) {
      const inside = o.x >= b.minX && o.x <= b.maxX && o.y >= b.minY &&
        o.y <= b.maxY && o.z >= b.minZ && o.z <= b.maxZ;
      if (!inside) return null;
    }

    const STEP = 0.35;
    let prevT = 0;
    let prevAbove = null;
    for (let t = 0; t <= maxT; t = Math.min(t + STEP, maxT)) {
      const x = o.x + d.x * t;
      const y = o.y + d.y * t;
      const z = o.z + d.z * t;
      const s = rampSurfaceY(c, x, z);
      if (s !== null) {
        const above = y >= s;
        if (prevAbove === true && !above) {
          // Crossed the surface between prevT and t — bisect.
          let lo = prevT, hi = t;
          for (let k = 0; k < 8; k++) {
            const mid = (lo + hi) * 0.5;
            const my = o.y + d.y * mid;
            const ms = rampSurfaceY(c, o.x + d.x * mid, o.z + d.z * mid);
            if (ms === null || my >= ms) lo = mid; else hi = mid;
          }
          if (hi <= 0 || hi > maxT) return null;
          this._lastNormal.set(0, 1, 0);
          return hi;
        }
        prevAbove = above;
      } else {
        prevAbove = null;
      }
      prevT = t;
      if (t >= maxT) break;
    }
    return null;
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

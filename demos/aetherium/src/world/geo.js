import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

// Geometry kit.
//
// Two jobs here. First, every primitive comes out with UVs already scaled to
// world metres, so a 40m floor tiles its texture 40/tile times instead of
// stretching one copy across the whole slab — the failure mode that makes
// procedural textures look like flat paint.
//
// Second, the Builder batches everything by material and merges it into one
// mesh per surface at the end. A 200m city assembled as individual meshes is
// ~1500 draw calls; merged it is about fifteen.

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();

// Scale a box's UVs per face so the texture tiles at `tile` metres.
export function boxGeo(w, h, d, tile = 2) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // BoxGeometry emits faces in order +X, -X, +Y, -Y, +Z, -Z, four verts each.
  const faceDims = [
    [d, h], [d, h],
    [w, d], [w, d],
    [w, h], [w, h]
  ];
  for (let f = 0; f < 6; f++) {
    const [fu, fv] = faceDims[f];
    const su = fu / tile;
    const sv = fv / tile;
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      uv.setXY(idx, uv.getX(idx) * su, uv.getY(idx) * sv);
    }
  }
  uv.needsUpdate = true;
  return g;
}

export function cylGeo(rTop, rBot, h, seg = 16, tile = 2, openEnded = false) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, openEnded);
  const uv = g.attributes.uv;
  const circumference = Math.PI * (rTop + rBot);
  const su = circumference / tile;
  const sv = h / tile;
  // The side is the first group; caps follow. Scaling every UV by the side
  // factors leaves caps slightly off, which is invisible on a column.
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  uv.needsUpdate = true;
  return g;
}

export function sphereGeo(r, wSeg, hSeg, tile = 2, phiStart, phiLen, thetaStart, thetaLen) {
  const g = new THREE.SphereGeometry(r, wSeg, hSeg, phiStart, phiLen, thetaStart, thetaLen);
  const uv = g.attributes.uv;
  const s = (Math.PI * 2 * r) / tile;
  const t = (Math.PI * r) / tile;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * t);
  uv.needsUpdate = true;
  return g;
}

export function coneGeo(r, h, seg, tile = 2) {
  const g = new THREE.ConeGeometry(r, h, seg);
  const uv = g.attributes.uv;
  const s = (Math.PI * 2 * r) / tile;
  const t = h / tile;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * t);
  uv.needsUpdate = true;
  return g;
}

export function torusGeo(r, tube, radSeg, tubSeg, arc, tile = 2) {
  const g = new THREE.TorusGeometry(r, tube, radSeg, tubSeg, arc);
  const uv = g.attributes.uv;
  const s = (Math.PI * 2 * r) / tile;
  const t = (Math.PI * 2 * tube) / tile;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * t);
  uv.needsUpdate = true;
  return g;
}

// Lathe profile revolved around Y — used for balustrades, urns and finials,
// where a cylinder reads as a pipe and a real profile reads as carved stone.
export function latheGeo(points, seg = 12, tile = 2) {
  const pts = points.map((p) => new THREE.Vector2(p[0], p[1]));
  const g = new THREE.LatheGeometry(pts, seg);
  const uv = g.attributes.uv;
  let maxR = 0;
  for (const p of points) maxR = Math.max(maxR, p[0]);
  const s = (Math.PI * 2 * maxR) / tile;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s);
  uv.needsUpdate = true;
  return g;
}

// Merge a list of { geometry, material, matrix } into one mesh per material.
//
// Used for anything built from many small primitives that never move relative
// to each other — the first-person weapon, a drone chassis. A rifle assembled
// as fifty meshes is fifty draw calls every frame, and nine drones on screen
// turn that into a real cost for no benefit; merged it is three.
//
// Geometries are disposed after merging. Anything that has to animate on its
// own must be added as a separate mesh rather than passed in here.
export function mergeByMaterial(entries) {
  const byMaterial = new Map();
  for (const e of entries) {
    // mergeGeometries requires every input to agree on indexing, and Three's
    // polyhedron primitives (Octahedron, Icosahedron) come out non-indexed
    // while Box, Cylinder and Torus come out indexed. Flatten them all.
    let g = e.geometry.clone();
    if (g.index) g = g.toNonIndexed();
    if (e.matrix) g.applyMatrix4(e.matrix);
    for (const key of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv'].includes(key)) g.deleteAttribute(key);
    }
    if (!g.attributes.uv) {
      // mergeGeometries requires a matching attribute set across the batch.
      const count = g.attributes.position.count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    let list = byMaterial.get(e.material);
    if (!list) byMaterial.set(e.material, (list = []));
    list.push(g);
  }

  const out = [];
  for (const [material, geos] of byMaterial) {
    let merged = null;
    try {
      merged = BufferGeometryUtils.mergeGeometries(geos, false);
    } catch (err) {
      console.warn('[geo] merge failed, keeping parts separate:', err.message);
    }
    if (merged) {
      merged.computeBoundingSphere();
      out.push(new THREE.Mesh(merged, material));
      geos.forEach((g) => g.dispose());
    } else {
      for (const g of geos) out.push(new THREE.Mesh(g, material));
    }
  }
  return out;
}

export function makeMatrix(pos, rot, scale) {
  _e.set(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0);
  _q.setFromEuler(_e);
  _v.set(scale ? scale[0] : 1, scale ? scale[1] : 1, scale ? scale[2] : 1);
  _m.compose(new THREE.Vector3(pos[0], pos[1], pos[2]), _q, _v);
  return _m.clone();
}

// Collider surface tags drive footstep audio, impact particles and decal
// colour. Keeping them on the collider rather than the mesh means the physics
// hit already knows what it struck.
export const SURFACE_TAGS = [
  'stone', 'metal', 'wood', 'cloth', 'foliage', 'glass', 'rubble', 'aether'
];

export class Builder {
  constructor(ctx) {
    this.ctx = ctx;
    this._batches = new Map();
    this.colliders = [];
    this.meshes = [];
    this._count = 0;
  }

  // Queue a geometry into its material batch with a world transform baked in.
  add(geometry, material, matrix) {
    let list = this._batches.get(material);
    if (!list) this._batches.set(material, (list = []));
    // Same indexing caveat as mergeByMaterial: everything must agree, so
    // flatten to non-indexed before the batch sees it.
    let g = geometry.clone();
    if (g.index) g = g.toNonIndexed();
    if (matrix) g.applyMatrix4(matrix);
    // Merging requires identical attribute sets; drop anything exotic.
    for (const key of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv'].includes(key)) g.deleteAttribute(key);
    }
    list.push(g);
    this._count++;
    return g;
  }

  // Axis-aligned box collider. `pos` is the centre.
  box(pos, size, surface = 'stone', opts = {}) {
    this.colliders.push({
      type: 'box',
      minX: pos[0] - size[0] / 2, maxX: pos[0] + size[0] / 2,
      minY: pos[1] - size[1] / 2, maxY: pos[1] + size[1] / 2,
      minZ: pos[2] - size[2] / 2, maxZ: pos[2] + size[2] / 2,
      surface,
      climbable: opts.climbable !== false,
      blocksSight: opts.blocksSight !== false
    });
    return this.colliders[this.colliders.length - 1];
  }

  // Yaw-rotated box. Use this for anything that does not run along a world
  // axis — a diagonal parapet emitted as an AABB inflates enormously and eats
  // the walkway beside it.
  obox(pos, size, yaw, surface = 'stone', opts = {}) {
    this.colliders.push({
      type: 'obox',
      x: pos[0], y: pos[1], z: pos[2],
      hx: size[0] / 2, hy: size[1] / 2, hz: size[2] / 2,
      yaw,
      surface,
      climbable: opts.climbable !== false,
      blocksSight: opts.blocksSight !== false
    });
    return this.colliders[this.colliders.length - 1];
  }

  // An oriented sloped surface: walkable, never a wall.
  //
  // `from` and `to` are the centres of the two ends. `arch` raises the middle,
  // matching the visible camber of a bridge deck. One of these replaces a run
  // of stepped boxes, which is what makes sloped traversal continuous rather
  // than a sequence of ledges to be climbed.
  ramp(from, to, width, surface = 'stone', opts = {}) {
    const dx = to[0] - from[0];
    const dz = to[2] - from[2];
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return null;
    this.colliders.push({
      type: 'ramp',
      x: (from[0] + to[0]) / 2,
      z: (from[2] + to[2]) / 2,
      dx: dx / len, dz: dz / len,
      halfLen: len / 2,
      halfWidth: width / 2,
      y0: from[1], y1: to[1],
      arch: opts.arch || 0,
      thickness: opts.thickness || 1.2,
      surface,
      climbable: true,
      blocksSight: opts.blocksSight !== false,
      active: opts.active !== false
    });
    return this.colliders[this.colliders.length - 1];
  }

  // Vertical cylinder collider — columns resolve much better against this than
  // against a square box, and the map is full of columns.
  cylinder(pos, radius, height, surface = 'stone', opts = {}) {
    this.colliders.push({
      type: 'cyl',
      x: pos[0], z: pos[2],
      minY: pos[1] - height / 2, maxY: pos[1] + height / 2,
      radius,
      surface,
      climbable: opts.climbable !== false,
      blocksSight: opts.blocksSight !== false
    });
    return this.colliders[this.colliders.length - 1];
  }

  // A slab: visible geometry plus a matching collider, the common case for
  // every floor, wall and step in the level.
  slab(materialName, pos, size, surface = 'stone', tile) {
    const mats = this.ctx.get('materials');
    const mat = mats.get(materialName);
    const t = tile || mats.tileOf(materialName);
    this.add(boxGeo(size[0], size[1], size[2], t), mat, makeMatrix(pos));
    this.box(pos, size, surface);
  }

  finish(scene) {
    for (const [material, geos] of this._batches) {
      if (!geos.length) continue;
      let merged;
      try {
        merged = BufferGeometryUtils.mergeGeometries(geos, false);
      } catch (err) {
        console.warn(`[world] merge failed for ${material.name}, falling back:`, err.message);
        merged = null;
      }
      geos.forEach((g) => g.dispose());
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `batch:${material.name}`;
      // Merged batches span the whole map, so per-object culling can only ever
      // cost time here.
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.meshes.push(mesh);
    }
    this._batches.clear();
    return this.meshes;
  }

  get pieceCount() {
    return this._count;
  }
}

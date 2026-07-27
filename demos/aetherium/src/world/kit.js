import * as THREE from 'three';
import { boxGeo, cylGeo, sphereGeo, coneGeo, torusGeo, latheGeo, makeMatrix } from './geo.js';

// Modular building kit.
//
// Levels are assembled from these rather than from raw primitives, which is
// what keeps the architecture coherent across five districts. Every piece
// takes an rng so instances vary — the round-1 world repeated one identical
// column twenty-five times, and identical repetition is the fastest way to
// make a scene read as computer-generated.

const Y = new THREE.Vector3(0, 1, 0);

export class Kit {
  constructor(builder, ctx, rng) {
    this.b = builder;
    this.ctx = ctx;
    this.rng = rng;
    this.mats = ctx.get('materials');
    this._cache = new Map();
  }

  mat(name) {
    return this.mats.get(name);
  }

  // Geometry cache: a fluted column is expensive to build and we place
  // hundreds, so build one per distinct spec and reuse the buffer.
  cached(key, fn) {
    let g = this._cache.get(key);
    if (!g) this._cache.set(key, (g = fn()));
    return g;
  }

  // ── Floors and structure ──────────────────────────────────────────────

  // An island: cloudstone underside tapering into the void, dressed top
  // surface, and a lip so the edge reads as carved rather than sliced.
  island(cx, cy, cz, w, d, opts = {}) {
    const b = this.b;
    const rng = this.rng;
    const topMat = this.mat(opts.top || 'marbleFloor');
    const rockMat = this.mat('cloudstone');
    const deckH = opts.deckH || 1.2;

    // Deck.
    b.add(boxGeo(w, deckH, d, this.mats.tileOf(opts.top || 'marbleFloor')),
      topMat, makeMatrix([cx, cy - deckH / 2, cz]));
    b.box([cx, cy - deckH / 2, cz], [w, deckH, d], 'stone');

    // Rock mass below, stepping inward so the silhouette tapers.
    const steps = opts.rockSteps || 5;
    let rw = w, rd = d, ry = cy - deckH;
    for (let i = 0; i < steps; i++) {
      const h = 1.6 + i * 1.5 + rng.range(0, 1.2);
      rw *= 0.86 + rng.range(-0.03, 0.03);
      rd *= 0.86 + rng.range(-0.03, 0.03);
      ry -= h / 2;
      b.add(boxGeo(rw, h, rd, 3.5), rockMat, makeMatrix(
        [cx + rng.spread(0.8), ry, cz + rng.spread(0.8)],
        [rng.spread(0.02), rng.range(0, 0.4), rng.spread(0.02)]
      ));
      ry -= h / 2;
    }
    // A ragged point at the very bottom.
    b.add(coneGeo(Math.min(rw, rd) * 0.5, 14 + rng.range(0, 8), 6, 3.5), rockMat,
      makeMatrix([cx, ry - 7, cz], [Math.PI, 0, 0]));

    // Edge lip.
    if (opts.lip !== false) {
      const lipH = 0.35;
      const lipMat = this.mat('marble');
      for (const [sx, sz, lw, ld] of [
        [0, d / 2, w, 0.6], [0, -d / 2, w, 0.6],
        [w / 2, 0, 0.6, d], [-w / 2, 0, 0.6, d]
      ]) {
        b.add(boxGeo(lw, lipH, ld, 3), lipMat,
          makeMatrix([cx + sx, cy + lipH / 2, cz + sz]));
      }
    }
    return { cx, cy, cz, w, d };
  }

  // Fluted Doric-ish column with entasis: the shaft swells slightly at a third
  // of its height. Straight cylinders are the single clearest "primitive" tell.
  column(x, y, z, h, r = 0.42, opts = {}) {
    const b = this.b;
    const rng = this.rng;
    const matName = opts.material || 'marble';
    const mat = this.mat(matName);
    const flutes = opts.flutes !== false;
    const key = `col:${matName}:${h.toFixed(2)}:${r.toFixed(2)}:${flutes}`;

    const geoms = this.cached(key, () => {
      const parts = [];
      // Shaft as stacked segments with a swelling radius.
      const segs = 6;
      for (let i = 0; i < segs; i++) {
        const t0 = i / segs;
        const t1 = (i + 1) / segs;
        const rr = (t) => r * (1 + 0.055 * Math.sin(Math.PI * Math.min(1, t * 1.15)) - t * 0.13);
        const g = cylGeo(rr(t1), rr(t0), h / segs, flutes ? 20 : 12, 1.6, true);
        g.translate(0, h * (t0 + t1) / 2, 0);
        parts.push(g);
      }
      // Flutes: shallow vertical grooves cut as thin negative-space boxes. We
      // cannot CSG here, so they are added as darker recessed strips that read
      // correctly at gameplay distance.
      if (flutes) {
        const n = 16;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const g = boxGeo(r * 0.16, h * 0.9, r * 0.1, 1.2);
          g.translate(Math.cos(a) * r * 0.97, h * 0.5, Math.sin(a) * r * 0.97);
          parts.push(g);
        }
      }
      // Base torus and square plinth.
      const base = torusGeo(r * 1.05, r * 0.16, 6, 16, Math.PI * 2, 1.2);
      base.rotateX(Math.PI / 2);
      base.translate(0, r * 0.18, 0);
      parts.push(base);
      const plinth = boxGeo(r * 2.5, r * 0.34, r * 2.5, 1.5);
      plinth.translate(0, r * 0.17, 0);
      parts.push(plinth);
      // Capital: echinus curve plus square abacus.
      const ech = cylGeo(r * 1.5, r * 0.95, r * 0.55, 16, 1.5);
      ech.translate(0, h + r * 0.27, 0);
      parts.push(ech);
      const ab = boxGeo(r * 3.0, r * 0.32, r * 3.0, 1.5);
      ab.translate(0, h + r * 0.7, 0);
      parts.push(ab);
      return parts;
    });

    // Instance rotation varies so the flutes never line up between columns.
    const m = makeMatrix([x, y, z], [0, rng.range(0, Math.PI * 2), 0]);
    for (const g of geoms) b.add(g, mat, m);
    b.cylinder([x, y + h / 2, z], r * 1.25, h + r, 'stone');
    return { x, y, z, h, r };
  }

  // Fallen / broken column for the ruined district.
  brokenColumn(x, y, z, len, r = 0.42, angle = 0) {
    const b = this.b;
    const rng = this.rng;
    const mat = this.mat('marble');
    const drums = Math.max(2, Math.floor(len / 1.4));
    let acc = 0;
    for (let i = 0; i < drums; i++) {
      const dh = len / drums * rng.range(0.75, 1.15);
      const g = cylGeo(r * rng.range(0.94, 1.02), r * rng.range(0.94, 1.02), dh, 14, 1.6);
      const off = acc + dh / 2;
      const drift = i * rng.range(0.02, 0.09);
      b.add(g, mat, makeMatrix(
        [x + Math.cos(angle) * off + rng.spread(0.18), y + r + rng.range(0, 0.1), z + Math.sin(angle) * off + rng.spread(0.18)],
        [Math.PI / 2 + rng.spread(0.06), -angle + rng.spread(drift), rng.spread(0.05)]
      ));
      acc += dh;
    }
    b.box([x + Math.cos(angle) * len / 2, y + r, z + Math.sin(angle) * len / 2],
      [Math.abs(Math.cos(angle)) * len + r * 2, r * 2, Math.abs(Math.sin(angle)) * len + r * 2], 'stone');
  }

  // Semicircular arch built from wedge voussoirs.
  arch(x, y, z, span, thickness, depth, rotY = 0, matName = 'marble') {
    const b = this.b;
    const mat = this.mat(matName);
    const r = span / 2;
    const n = 11;
    const key = `arch:${span}:${thickness}:${depth}:${n}`;
    const parts = this.cached(key, () => {
      const out = [];
      for (let i = 0; i < n; i++) {
        const a0 = Math.PI * (i / n);
        const a1 = Math.PI * ((i + 1) / n);
        const am = (a0 + a1) / 2;
        const w = (a1 - a0) * (r + thickness / 2) * 1.06;
        const g = boxGeo(w, thickness, depth, 1.8);
        g.rotateZ(am - Math.PI / 2);
        g.translate(Math.cos(am) * (r + thickness / 2), Math.sin(am) * (r + thickness / 2), 0);
        out.push(g);
      }
      return out;
    });
    const m = makeMatrix([x, y, z], [0, rotY, 0]);
    for (const g of parts) b.add(g, mat, m);

    // Impost blocks either side, so the arch springs from something.
    for (const s of [-1, 1]) {
      const px = x + Math.cos(rotY) * s * (r + thickness / 2);
      const pz = z - Math.sin(rotY) * s * (r + thickness / 2);
      b.box([px, y - 0.01, pz], [thickness * 1.2, 0.02, depth], 'stone');
    }
  }

  // A run of steps. Each tread gets a collider so the player controller can
  // step up it naturally instead of needing a ramp special case.
  stairs(x, y, z, width, rise, run, count, dirX, dirZ, matName = 'marble') {
    const b = this.b;
    const mat = this.mat(matName);
    const tile = this.mats.tileOf(matName);
    const len = Math.hypot(dirX, dirZ) || 1;
    const dx = dirX / len;
    const dz = dirZ / len;
    const px = -dz;
    const pz = dx;

    for (let i = 0; i < count; i++) {
      const cx = x + dx * (run * (i + 0.5));
      const cz = z + dz * (run * (i + 0.5));
      const cy = y + rise * (i + 0.5);
      // Each step is a full-height block down to the previous tread, so there
      // are no gaps to fall through.
      const h = rise;
      const sizeX = Math.abs(dx) > Math.abs(dz) ? run : width;
      const sizeZ = Math.abs(dx) > Math.abs(dz) ? width : run;
      b.add(boxGeo(sizeX, h, sizeZ, tile), mat, makeMatrix([cx, cy, cz]));
      b.box([cx, cy, cz], [sizeX, h, sizeZ], 'stone');
    }
    return {
      topX: x + dx * run * count,
      topY: y + rise * count,
      topZ: z + dz * run * count
    };
  }

  // Balustrade: plinth, turned balusters, coping rail. Waist height so it
  // reads as cover but you can still shoot over it.
  balustrade(x, y, z, length, rotY = 0, matName = 'marble') {
    const b = this.b;
    const rng = this.rng;
    const mat = this.mat(matName);
    const h = 1.05;
    const baluster = this.cached('baluster', () =>
      latheGeo([[0.0, 0], [0.11, 0], [0.11, 0.08], [0.06, 0.16], [0.09, 0.3],
      [0.07, 0.48], [0.05, 0.6], [0.09, 0.68], [0.11, 0.74], [0.0, 0.74]], 10, 1.2));

    const m = makeMatrix([x, y, z], [0, rotY, 0]);
    // Plinth + coping run the full length.
    const plinth = boxGeo(length, 0.18, 0.42, 2.4);
    plinth.translate(0, 0.09, 0);
    b.add(plinth, mat, m);
    const coping = boxGeo(length, 0.16, 0.5, 2.4);
    coping.translate(0, h - 0.08, 0);
    b.add(coping, mat, m);

    const n = Math.max(2, Math.round(length / 0.5));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const g = baluster.clone();
      g.scale(1, (h - 0.26) / 0.74, 1);
      g.translate((t - 0.5) * length, 0.18, 0);
      b.add(g, mat, m);
      g.dispose();
    }

    const cos = Math.cos(rotY), sin = Math.sin(rotY);
    b.box([x, y + h / 2, z],
      [Math.abs(cos) * length + Math.abs(sin) * 0.5, h, Math.abs(sin) * length + Math.abs(cos) * 0.5],
      'stone', { blocksSight: false });
  }

  // ── Props ─────────────────────────────────────────────────────────────

  planter(x, y, z, size = 2.0) {
    const b = this.b;
    const rng = this.rng;
    const stone = this.mat('sandstone');
    const leaf = this.mat('foliage');

    const bowl = latheGeo([
      [0, 0], [size * 0.5, 0], [size * 0.52, 0.12], [size * 0.44, 0.3],
      [size * 0.46, 0.62], [size * 0.5, 0.74], [size * 0.44, 0.76], [size * 0.4, 0.2], [0, 0.18]
    ], 14, 2);
    b.add(bowl, stone, makeMatrix([x, y, z], [0, rng.range(0, 6.28), 0]));
    bowl.dispose();
    b.cylinder([x, y + 0.38, z], size * 0.52, 0.76, 'stone');

    // Foliage as overlapping cones at varied tilt — a bush, not a christmas
    // tree, because no two are the same height or lean.
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.range(0, 1);
      const rad = rng.range(0, size * 0.3);
      const hh = rng.range(0.7, 1.5) * (size / 2);
      const g = coneGeo(rng.range(0.22, 0.4) * size, hh, 6, 1);
      b.add(g, leaf, makeMatrix(
        [x + Math.cos(a) * rad, y + 0.6 + hh / 2, z + Math.sin(a) * rad],
        [rng.spread(0.35), rng.range(0, 6.28), rng.spread(0.35)]
      ));
      g.dispose();
    }
  }

  crate(x, y, z, size = 0.9, rotY = null) {
    const b = this.b;
    const rng = this.rng;
    const mat = this.mat('wood');
    const r = rotY === null ? rng.range(0, Math.PI * 2) : rotY;
    const s = size * rng.range(0.85, 1.15);
    const m = makeMatrix([x, y + s / 2, z], [0, r, 0]);
    const body = boxGeo(s, s, s, 1.2);
    b.add(body, mat, m);
    body.dispose();
    // Corner battens.
    for (const [ox, oz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const g = boxGeo(s * 0.11, s * 1.02, s * 0.11, 1);
      g.translate(ox * s * 0.47, 0, oz * s * 0.47);
      b.add(g, mat, m);
      g.dispose();
    }
    b.box([x, y + s / 2, z], [s * 1.15, s, s * 1.15], 'wood');
  }

  barrel(x, y, z) {
    const b = this.b;
    const rng = this.rng;
    const wood = this.mat('wood');
    const band = this.mat('darkMetal');
    const h = rng.range(0.9, 1.1);
    const r = 0.36;
    const m = makeMatrix([x, y, z], [0, rng.range(0, 6.28), 0]);
    const body = latheGeo([
      [0, 0], [r * 0.85, 0], [r * 1.05, h * 0.3], [r * 1.05, h * 0.7],
      [r * 0.85, h], [0, h]
    ], 14, 1.2);
    b.add(body, wood, m);
    body.dispose();
    for (const t of [0.22, 0.78]) {
      const g = torusGeo(r * 1.03, 0.035, 5, 14, Math.PI * 2, 0.8);
      g.rotateX(Math.PI / 2);
      g.translate(0, h * t, 0);
      b.add(g, band, m);
      g.dispose();
    }
    b.cylinder([x, y + h / 2, z], r * 1.1, h, 'wood');
  }

  // Market stall: posts, counter, sloped awning, hanging cloth.
  stall(x, y, z, rotY = 0, w = 2.6, d = 1.8) {
    const b = this.b;
    const rng = this.rng;
    const wood = this.mat('wood');
    const cloth = this.mat('banner');
    const m = makeMatrix([x, y, z], [0, rotY, 0]);
    const postH = 2.3;

    for (const [ox, oz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const g = boxGeo(0.12, postH, 0.12, 1);
      g.translate(ox * w / 2, postH / 2, oz * d / 2);
      b.add(g, wood, m);
      g.dispose();
    }
    // Counter.
    const counter = boxGeo(w + 0.2, 0.12, d * 0.55, 1.2);
    counter.translate(0, 1.0, -d * 0.2);
    b.add(counter, wood, m);
    counter.dispose();
    const apron = boxGeo(w + 0.2, 0.9, 0.08, 1.2);
    apron.translate(0, 0.5, -d * 0.2 - d * 0.27);
    b.add(apron, wood, m);
    apron.dispose();

    // Sloped awning, tilted toward the street.
    const awn = boxGeo(w + 0.7, 0.06, d + 0.6, 1);
    awn.rotateX(-0.24);
    awn.translate(0, postH + 0.12, 0.1);
    b.add(awn, cloth, m);
    awn.dispose();
    // Scalloped valance.
    const val = boxGeo(w + 0.7, 0.3, 0.05, 0.8);
    val.translate(0, postH - 0.02, d / 2 + 0.34);
    b.add(val, cloth, m);
    val.dispose();

    const cos = Math.cos(rotY), sin = Math.sin(rotY);
    const bw = Math.abs(cos) * w + Math.abs(sin) * d;
    const bd = Math.abs(sin) * w + Math.abs(cos) * d;
    // Only the counter blocks movement; the awning is overhead.
    b.box([x, y + 0.55, z], [bw, 1.1, bd * 0.6], 'wood', { blocksSight: false });
  }

  banner(x, y, z, w, h, rotY = 0) {
    const b = this.b;
    const cloth = this.mat('banner');
    const rod = this.mat('bronze');
    const m = makeMatrix([x, y, z], [0, rotY, 0]);
    const g = boxGeo(w, h, 0.04, 1);
    g.translate(0, -h / 2, 0);
    b.add(g, cloth, m);
    g.dispose();
    const r = cylGeo(0.045, 0.045, w + 0.3, 8, 1);
    r.rotateZ(Math.PI / 2);
    b.add(r, rod, m);
    r.dispose();
  }

  statue(x, y, z, scale = 1, rotY = 0) {
    const b = this.b;
    const rng = this.rng;
    const stone = this.mat('marble');
    const base = this.mat('sandstone');
    const m = makeMatrix([x, y, z], [0, rotY, 0], [scale, scale, scale]);

    // Plinth.
    const p = boxGeo(1.5, 0.9, 1.5, 2);
    p.translate(0, 0.45, 0);
    b.add(p, base, m);
    p.dispose();
    const p2 = boxGeo(1.2, 0.2, 1.2, 2);
    p2.translate(0, 1.0, 0);
    b.add(p2, base, m);
    p2.dispose();

    // Robed figure: a lathe body gives folds a cylinder never will.
    const body = latheGeo([
      [0, 0], [0.55, 0], [0.5, 0.25], [0.42, 0.7], [0.38, 1.15],
      [0.34, 1.6], [0.3, 1.95], [0.24, 2.15], [0, 2.2]
    ], 14, 1.6);
    body.translate(0, 1.1, 0);
    b.add(body, stone, m);
    body.dispose();

    const head = sphereGeo(0.22, 16, 12, 1.2);
    head.scale(1, 1.18, 0.92);
    head.translate(0, 3.45, 0);
    b.add(head, stone, m);
    head.dispose();

    // One raised arm, one at rest.
    const armA = cylGeo(0.09, 0.075, 0.95, 8, 1.2);
    armA.rotateZ(-0.9);
    armA.translate(0.42, 2.75, 0.05);
    b.add(armA, stone, m);
    armA.dispose();
    const armB = cylGeo(0.085, 0.07, 0.9, 8, 1.2);
    armB.rotateZ(0.22);
    armB.translate(-0.34, 2.6, 0.02);
    b.add(armB, stone, m);
    armB.dispose();

    b.cylinder([x, y + 1.8 * scale, z], 0.75 * scale, 3.6 * scale, 'stone');
  }

  lamp(x, y, z, height = 3.2) {
    const b = this.b;
    const metal = this.mat('bronze');
    const glass = this.mat('lamp');
    const post = cylGeo(0.07, 0.11, height, 10, 1.5);
    post.translate(0, height / 2, 0);
    b.add(post, metal, makeMatrix([x, y, z]));
    post.dispose();
    const cage = latheGeo([[0, 0], [0.22, 0.05], [0.26, 0.22], [0.18, 0.42], [0, 0.46]], 8, 1);
    cage.translate(0, height, 0);
    b.add(cage, glass, makeMatrix([x, y, z]));
    cage.dispose();
    b.cylinder([x, y + height / 2, z], 0.16, height, 'metal', { blocksSight: false });
    return new THREE.Vector3(x, y + height + 0.2, z);
  }

  rubblePile(x, y, z, radius = 2, count = 14) {
    const b = this.b;
    const rng = this.rng;
    const mat = this.mat('rubble');
    let maxH = 0;
    for (let i = 0; i < count; i++) {
      const a = rng.range(0, Math.PI * 2);
      const rr = rng.range(0, radius) * rng.range(0.4, 1);
      const s = rng.range(0.25, 0.8) * (1 - rr / radius * 0.5);
      const h = y + s * 0.4 + rng.range(0, radius * 0.35) * (1 - rr / radius);
      maxH = Math.max(maxH, h + s / 2 - y);
      const g = boxGeo(s * rng.range(0.7, 1.6), s, s * rng.range(0.7, 1.6), 1.5);
      b.add(g, mat, makeMatrix(
        [x + Math.cos(a) * rr, h, z + Math.sin(a) * rr],
        [rng.spread(0.6), rng.range(0, 6.28), rng.spread(0.6)]
      ));
      g.dispose();
    }
    // One collider for the mound rather than one per chunk.
    b.box([x, y + maxH * 0.45, z], [radius * 1.7, maxH * 0.9, radius * 1.7], 'rubble');
  }

  // Chest-high cover block — the AI's cover system scores these.
  coverBlock(x, y, z, w = 1.6, h = 1.15, d = 0.8, rotY = 0, matName = 'sandstone') {
    const b = this.b;
    const mat = this.mat(matName);
    const g = boxGeo(w, h, d, this.mats.tileOf(matName));
    g.translate(0, h / 2, 0);
    b.add(g, mat, makeMatrix([x, y, z], [0, rotY, 0]));
    g.dispose();
    const cap = boxGeo(w + 0.14, 0.1, d + 0.14, 2);
    cap.translate(0, h + 0.05, 0);
    b.add(cap, this.mat('marble'), makeMatrix([x, y, z], [0, rotY, 0]));
    cap.dispose();
    const cos = Math.abs(Math.cos(rotY)), sin = Math.abs(Math.sin(rotY));
    const c = b.box([x, y + h / 2, z],
      [cos * w + sin * d, h, sin * w + cos * d], 'stone');
    c.isCover = true;
    return c;
  }

  // Aether pool: emissive liquid in a stone basin. The demo's light source of
  // choice underground, and the fiction's power supply.
  aetherPool(x, y, z, radius = 2.2) {
    const b = this.b;
    const stone = this.mat('sandstone');
    const glow = this.mat('aether');
    const rim = latheGeo([
      [radius * 0.82, 0], [radius, 0], [radius * 1.04, 0.3], [radius * 0.96, 0.42],
      [radius * 0.86, 0.36], [radius * 0.82, 0.1]
    ], 20, 2);
    b.add(rim, stone, makeMatrix([x, y, z]));
    rim.dispose();
    const surf = cylGeo(radius * 0.86, radius * 0.86, 0.08, 20, 2);
    surf.translate(0, 0.22, 0);
    b.add(surf, glow, makeMatrix([x, y, z]));
    surf.dispose();
    b.cylinder([x, y + 0.2, z], radius * 1.04, 0.42, 'stone', { blocksSight: false });
    return new THREE.Vector3(x, y + 0.6, z);
  }
}

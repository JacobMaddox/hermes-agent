import { lerp, clamp, smoothstep } from '../core/rng.js';

// Surface definitions.
//
// Each surface is a pure function sampled per-texel over the unit square. It
// writes into a reused output array — returning an object per pixel would
// allocate a million short-lived objects per texture and stall on GC.
//
// out[0..2] = albedo rgb in 0..1
// out[3]    = height in 0..1  (drives the normal map and the cavity AO)
// out[4]    = roughness in 0..1
//
// Every sampler draws from tiling fbm so the result wraps seamlessly, and every
// one carries a fine detail layer that still reads at half a metre — the thing
// round 1 was missing entirely, which is why its surfaces looked like clay.

const TAU = Math.PI * 2;

function detail(noise, u, v, scale, period) {
  return noise.tiling(u * scale, v * scale, period, 3, 2.1, 0.55);
}

// Sharp, directional veining. Distorting the sample coordinates by a lower
// frequency field is what gives marble its wandering, non-repetitive character
// instead of regular stripes.
function veins(noise, u, v, scale, warp, period) {
  const wx = noise.tiling(u * scale * 0.5, v * scale * 0.5, period, 3) * warp;
  const wy = noise.tiling(u * scale * 0.5 + 5.3, v * scale * 0.5 + 1.7, period, 3) * warp;
  const n = noise.ridged((u + wx) * scale, (v + wy) * scale, period * scale, 3);
  return n;
}

// Rectangular masonry courses with an offset every other row. Returns
// { mortar, brickId, edge } so the caller can tint per brick and darken joints.
function masonry(u, v, cols, rows, jointW) {
  const ry = v * rows;
  const row = Math.floor(ry);
  const fy = ry - row;
  const offset = (row & 1) * 0.5;
  const rx = u * cols + offset;
  const col = Math.floor(rx);
  const fx = rx - col;

  const dx = Math.min(fx, 1 - fx);
  const dy = Math.min(fy, 1 - fy);
  const edge = Math.min(dx * cols, dy * rows);
  const mortar = 1 - smoothstep(jointW, jointW * 2.4, edge);
  const brickId = (Math.imul(col + 1, 73856093) ^ Math.imul(row + 1, 19349663)) >>> 0;
  return { mortar, brickId, edge };
}

function hashUnit(id) {
  let h = id >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const SURFACES = {
  // ── Architecture ───────────────────────────────────────────────────────
  marble: {
    tile: 3.0,
    metalness: 0.02,
    sample(u, v, noise, out) {
      const vein = veins(noise, u, v, 4.5, 0.22, 4);
      const grain = detail(noise, u, v, 26, 26);
      const blot = noise.tiling(u * 2, v * 2, 2, 3);

      // Warm off-white base, cool grey veins, faint honey blotching.
      const base = 0.86 + blot * 0.05;
      const veinMask = smoothstep(0.55, 0.9, vein);
      let r = lerp(base, 0.55, veinMask * 0.75);
      let g = lerp(base * 0.985, 0.56, veinMask * 0.72);
      let b = lerp(base * 0.945, 0.60, veinMask * 0.66);
      r += grain * 0.022; g += grain * 0.02; b += grain * 0.018;

      out[0] = clamp(r, 0.02, 0.92);
      out[1] = clamp(g, 0.02, 0.92);
      out[2] = clamp(b, 0.02, 0.92);
      // Veins sit slightly proud; polished stone wears down around them.
      out[3] = 0.5 + vein * 0.22 + grain * 0.1;
      out[4] = clamp(0.22 + veinMask * 0.2 + grain * 0.08, 0.06, 0.75);
    }
  },

  marbleFloor: {
    tile: 4.0,
    metalness: 0.02,
    sample(u, v, noise, out) {
      // Large square tiles with a chamfered joint and per-tile colour drift.
      const m = masonry(u, v, 4, 4, 0.012);
      const tint = hashUnit(m.brickId);
      const vein = veins(noise, u, v, 6, 0.18, 6);
      const grain = detail(noise, u, v, 30, 30);
      const wear = smoothstep(0.35, 0.9, noise.tiling(u * 3.5, v * 3.5, 3, 4));

      const base = 0.80 + tint * 0.1;
      const veinMask = smoothstep(0.6, 0.92, vein) * 0.55;
      let r = lerp(base, 0.5, veinMask);
      let g = lerp(base * 0.99, 0.51, veinMask);
      let b = lerp(base * 0.955, 0.55, veinMask);

      // Joints: dark, recessed, slightly dirty.
      r = lerp(r, 0.2, m.mortar); g = lerp(g, 0.19, m.mortar); b = lerp(b, 0.175, m.mortar);
      r += grain * 0.018; g += grain * 0.016; b += grain * 0.014;

      out[0] = clamp(r, 0.02, 0.9);
      out[1] = clamp(g, 0.02, 0.9);
      out[2] = clamp(b, 0.02, 0.9);
      out[3] = clamp(0.72 - m.mortar * 0.6 + grain * 0.08, 0, 1);
      // Foot traffic polishes tile centres and leaves joints rough.
      out[4] = clamp(0.3 - wear * 0.14 + m.mortar * 0.4 + grain * 0.06, 0.05, 0.95);
    }
  },

  sandstone: {
    tile: 2.5,
    metalness: 0.0,
    sample(u, v, noise, out) {
      const strata = noise.tiling(u * 1.2, v * 7.5, 7, 4);
      const pit = detail(noise, u, v, 40, 40);
      const coarse = noise.tiling(u * 9, v * 9, 9, 3);
      const s = 0.5 + strata * 0.5;

      let r = lerp(0.72, 0.86, s) + coarse * 0.05;
      let g = lerp(0.60, 0.73, s) + coarse * 0.045;
      let b = lerp(0.46, 0.57, s) + coarse * 0.04;
      const pits = smoothstep(0.45, 0.85, pit);
      r -= pits * 0.1; g -= pits * 0.09; b -= pits * 0.07;

      out[0] = clamp(r, 0.02, 0.9);
      out[1] = clamp(g, 0.02, 0.9);
      out[2] = clamp(b, 0.02, 0.9);
      out[3] = clamp(0.5 + strata * 0.25 - pits * 0.3 + coarse * 0.12, 0, 1);
      out[4] = clamp(0.74 + pit * 0.14, 0.35, 0.98);
    }
  },

  cloudstone: {
    // The pale, porous rock the islands are cut from. Reads soft at distance,
    // reveals a bubbled cavity structure up close.
    tile: 3.5,
    metalness: 0.0,
    sample(u, v, noise, out) {
      const big = noise.tiling(u * 2.2, v * 2.2, 2, 4);
      const bubbles = noise.tiling(u * 14, v * 14, 14, 2);
      const fine = detail(noise, u, v, 45, 45);
      const cav = smoothstep(0.25, 0.75, bubbles);

      const base = 0.66 + big * 0.13;
      let r = base + 0.03, g = base + 0.015, b = base * 0.99;
      r -= cav * 0.2; g -= cav * 0.2; b -= cav * 0.19;
      r += fine * 0.03; g += fine * 0.03; b += fine * 0.03;

      out[0] = clamp(r, 0.02, 0.88);
      out[1] = clamp(g, 0.02, 0.88);
      out[2] = clamp(b, 0.02, 0.88);
      out[3] = clamp(0.55 + big * 0.3 - cav * 0.45 + fine * 0.1, 0, 1);
      out[4] = clamp(0.8 - cav * 0.12 + fine * 0.08, 0.4, 0.99);
    }
  },

  brick: {
    tile: 2.0,
    metalness: 0.0,
    sample(u, v, noise, out) {
      const m = masonry(u, v, 6, 12, 0.05);
      const tint = hashUnit(m.brickId);
      const grain = detail(noise, u, v, 34, 34);
      const grime = noise.tiling(u * 3, v * 3, 3, 4);

      // Warm terracotta with generous per-brick variation.
      let r = lerp(0.44, 0.62, tint) + grain * 0.05;
      let g = lerp(0.26, 0.36, tint) + grain * 0.04;
      let b = lerp(0.20, 0.27, tint) + grain * 0.03;

      // Pale lime mortar.
      r = lerp(r, 0.62, m.mortar); g = lerp(g, 0.60, m.mortar); b = lerp(b, 0.56, m.mortar);
      // Grime pools in the joints and the lower part of each course.
      const dirt = smoothstep(0.3, 0.8, grime) * (0.3 + m.mortar * 0.7);
      r *= 1 - dirt * 0.3; g *= 1 - dirt * 0.28; b *= 1 - dirt * 0.24;

      out[0] = clamp(r, 0.02, 0.85);
      out[1] = clamp(g, 0.02, 0.85);
      out[2] = clamp(b, 0.02, 0.85);
      out[3] = clamp(0.75 - m.mortar * 0.62 + grain * 0.12, 0, 1);
      out[4] = clamp(0.82 + grain * 0.1 - m.mortar * 0.05, 0.45, 0.99);
    }
  },

  // ── Metals ────────────────────────────────────────────────────────────
  gold: {
    tile: 2.0,
    metalness: 1.0,
    sample(u, v, noise, out) {
      // Hammered leaf: shallow dimples, micro-scratches, tarnish in the pits.
      const dimple = noise.tiling(u * 11, v * 11, 11, 2);
      const scratch = Math.abs(noise.tiling(u * 60, v * 6, 60, 2));
      const tarnish = smoothstep(0.5, 0.95, noise.tiling(u * 4, v * 4, 4, 4));
      const d = smoothstep(-0.3, 0.6, dimple);

      let r = 1.0, g = 0.79, b = 0.36;
      r = lerp(r * 0.82, r, d);
      g = lerp(g * 0.78, g, d);
      b = lerp(b * 0.7, b, d);
      // Tarnish pushes toward a dull olive rather than grey — gold does not go
      // grey, it goes green-brown. Kept light: at half strength the whole dome
      // read olive rather than gold, which is the wrong silhouette entirely for
      // the thing the whole level points at.
      r = lerp(r, 0.72, tarnish * 0.22);
      g = lerp(g, 0.55, tarnish * 0.22);
      b = lerp(b, 0.26, tarnish * 0.22);

      out[0] = clamp(r, 0.05, 1.0);
      out[1] = clamp(g, 0.05, 1.0);
      out[2] = clamp(b, 0.05, 1.0);
      out[3] = clamp(0.5 + dimple * 0.35 + scratch * 0.08, 0, 1);
      // Anisotropic-looking scratch roughness is what stops metal reading flat.
      out[4] = clamp(0.14 + tarnish * 0.22 + (1 - scratch) * 0.09, 0.05, 0.6);
    }
  },

  bronze: {
    tile: 2.0,
    metalness: 1.0,
    sample(u, v, noise, out) {
      const patinaN = noise.tiling(u * 5, v * 5, 5, 4);
      const drip = noise.tiling(u * 3, v * 14, 3, 3);
      const cast = detail(noise, u, v, 28, 28);
      // Verdigris creeps down from the top and pools in recesses.
      const patina = clamp(smoothstep(0.1, 0.7, patinaN) * 0.7 + smoothstep(0.4, 0.9, drip) * 0.5, 0, 1);

      let r = lerp(0.55, 0.29, patina);
      let g = lerp(0.36, 0.56, patina);
      let b = lerp(0.20, 0.47, patina);
      r += cast * 0.03; g += cast * 0.03; b += cast * 0.03;

      out[0] = clamp(r, 0.03, 0.9);
      out[1] = clamp(g, 0.03, 0.9);
      out[2] = clamp(b, 0.03, 0.9);
      out[3] = clamp(0.5 + cast * 0.3 + patina * 0.15, 0, 1);
      out[4] = clamp(0.26 + patina * 0.55 + cast * 0.08, 0.1, 0.95);
    }
  },

  darkMetal: {
    tile: 1.5,
    metalness: 1.0,
    sample(u, v, noise, out) {
      // Brushed steel plate with panel lines and rivets.
      const brush = noise.tiling(u * 140, v * 5, 140, 2);
      const panel = masonry(u, v, 2, 3, 0.02);
      const wear = smoothstep(0.55, 0.95, noise.tiling(u * 7, v * 7, 7, 4));
      const rust = smoothstep(0.7, 1.0, noise.tiling(u * 9 + 3.1, v * 9, 9, 4));

      let base = 0.30 + brush * 0.045;
      let r = base, g = base * 1.005, b = base * 1.03;
      r = lerp(r, 0.16, panel.mortar); g = lerp(g, 0.16, panel.mortar); b = lerp(b, 0.17, panel.mortar);
      // Exposed edges polish bright; rust blooms orange.
      r = lerp(r, 0.5, wear * 0.35); g = lerp(g, 0.5, wear * 0.35); b = lerp(b, 0.52, wear * 0.35);
      r = lerp(r, 0.38, rust); g = lerp(g, 0.2, rust); b = lerp(b, 0.11, rust);

      out[0] = clamp(r, 0.02, 0.85);
      out[1] = clamp(g, 0.02, 0.85);
      out[2] = clamp(b, 0.02, 0.85);
      out[3] = clamp(0.7 - panel.mortar * 0.55 + brush * 0.08, 0, 1);
      out[4] = clamp(0.34 - wear * 0.16 + rust * 0.45 + Math.abs(brush) * 0.12, 0.08, 0.95);
    }
  },

  dronePlate: {
    tile: 1.0,
    metalness: 0.95,
    sample(u, v, noise, out) {
      // Syndicate armour: tight hex-ish faceting, dark anodised finish.
      const facet = noise.tiling(u * 16, v * 16, 16, 1);
      const seam = masonry(u, v, 5, 5, 0.035);
      const scuff = smoothstep(0.6, 0.95, noise.tiling(u * 22, v * 22, 22, 3));
      const micro = detail(noise, u, v, 60, 60);

      let base = 0.13 + facet * 0.03;
      let r = base * 1.02, g = base, b = base * 1.14;
      r = lerp(r, 0.05, seam.mortar); g = lerp(g, 0.05, seam.mortar); b = lerp(b, 0.06, seam.mortar);
      r = lerp(r, 0.42, scuff * 0.5); g = lerp(g, 0.42, scuff * 0.5); b = lerp(b, 0.45, scuff * 0.5);
      r += micro * 0.012; g += micro * 0.012; b += micro * 0.012;

      out[0] = clamp(r, 0.01, 0.7);
      out[1] = clamp(g, 0.01, 0.7);
      out[2] = clamp(b, 0.01, 0.7);
      out[3] = clamp(0.68 - seam.mortar * 0.5 + facet * 0.2, 0, 1);
      out[4] = clamp(0.32 - scuff * 0.18 + micro * 0.1, 0.08, 0.8);
    }
  },

  gunmetal: {
    tile: 0.6,
    metalness: 0.9,
    sample(u, v, noise, out) {
      // The player's rifle body: fine bead-blast, machined edge polish.
      const blast = detail(noise, u, v, 90, 90);
      const mill = noise.tiling(u * 200, v * 3, 200, 1);
      const edge = smoothstep(0.65, 0.98, noise.tiling(u * 12, v * 12, 12, 3));

      let base = 0.22 + blast * 0.04 + mill * 0.012;
      let r = base * 0.99, g = base, b = base * 1.08;
      r = lerp(r, 0.62, edge * 0.4); g = lerp(g, 0.63, edge * 0.4); b = lerp(b, 0.68, edge * 0.4);

      out[0] = clamp(r, 0.02, 0.8);
      out[1] = clamp(g, 0.02, 0.8);
      out[2] = clamp(b, 0.02, 0.8);
      out[3] = clamp(0.5 + blast * 0.4, 0, 1);
      out[4] = clamp(0.42 - edge * 0.26 + blast * 0.14, 0.08, 0.85);
    }
  },

  // ── Organics and cloth ────────────────────────────────────────────────
  foliage: {
    tile: 1.0,
    metalness: 0.0,
    sample(u, v, noise, out) {
      const clump = noise.tiling(u * 6, v * 6, 6, 4);
      const leaf = noise.tiling(u * 26, v * 26, 26, 2);
      const dry = smoothstep(0.45, 0.9, noise.tiling(u * 3.5, v * 3.5, 3, 3));

      let r = 0.13 + clump * 0.07 + leaf * 0.035;
      let g = 0.30 + clump * 0.13 + leaf * 0.06;
      let b = 0.12 + clump * 0.05 + leaf * 0.025;
      // Sun-scorched tips go gold, which is what keeps foliage from reading
      // as a single flat green mass.
      r = lerp(r, 0.46, dry * 0.5); g = lerp(g, 0.40, dry * 0.42); b = lerp(b, 0.16, dry * 0.3);

      out[0] = clamp(r, 0.02, 0.8);
      out[1] = clamp(g, 0.02, 0.8);
      out[2] = clamp(b, 0.02, 0.8);
      out[3] = clamp(0.5 + leaf * 0.4, 0, 1);
      out[4] = clamp(0.66 + leaf * 0.16, 0.35, 0.95);
    }
  },

  banner: {
    tile: 1.0,
    metalness: 0.0,
    sample(u, v, noise, out) {
      // Woven cloth: visible warp/weft at close range, dye variation at range.
      const warp = Math.sin(u * TAU * 90) * 0.5 + 0.5;
      const weft = Math.sin(v * TAU * 90) * 0.5 + 0.5;
      const weave = (warp * 0.5 + weft * 0.5);
      const dye = noise.tiling(u * 4, v * 4, 4, 4);
      const fade = smoothstep(0.3, 0.95, noise.tiling(u * 2, v * 6, 2, 3));

      // Deep indigo with a gold-thread wash.
      let r = 0.10 + dye * 0.05, g = 0.13 + dye * 0.05, b = 0.34 + dye * 0.09;
      r = lerp(r, 0.55, fade * 0.35); g = lerp(g, 0.44, fade * 0.3); b = lerp(b, 0.18, fade * 0.15);
      const w = (weave - 0.5) * 0.06;
      r += w; g += w; b += w;

      out[0] = clamp(r, 0.02, 0.85);
      out[1] = clamp(g, 0.02, 0.85);
      out[2] = clamp(b, 0.02, 0.85);
      out[3] = clamp(0.45 + weave * 0.4 + dye * 0.1, 0, 1);
      out[4] = clamp(0.85 - fade * 0.08, 0.55, 0.99);
    }
  },

  wood: {
    tile: 1.5,
    metalness: 0.0,
    sample(u, v, noise, out) {
      // Ring grain: a low-frequency field pushed through fract() gives rings
      // that bend around knots instead of running as straight stripes.
      const warpX = noise.tiling(u * 2, v * 2, 2, 3) * 0.25;
      const rings = Math.abs(((v + warpX) * 14) % 1 - 0.5) * 2;
      const grain = noise.tiling(u * 4, v * 70, 70, 2);
      const knot = smoothstep(0.78, 0.98, noise.tiling(u * 3, v * 3, 3, 3));

      const t = clamp(rings * 0.8 + grain * 0.18, 0, 1);
      let r = lerp(0.36, 0.20, t);
      let g = lerp(0.24, 0.12, t);
      let b = lerp(0.14, 0.07, t);
      r = lerp(r, 0.12, knot); g = lerp(g, 0.07, knot); b = lerp(b, 0.04, knot);

      out[0] = clamp(r, 0.02, 0.8);
      out[1] = clamp(g, 0.02, 0.8);
      out[2] = clamp(b, 0.02, 0.8);
      out[3] = clamp(0.6 - t * 0.35 - knot * 0.2, 0, 1);
      out[4] = clamp(0.7 + t * 0.16 + knot * 0.1, 0.4, 0.98);
    }
  },

  rubble: {
    tile: 2.0,
    metalness: 0.0,
    sample(u, v, noise, out) {
      const chunks = noise.tiling(u * 10, v * 10, 10, 3);
      const dust = detail(noise, u, v, 50, 50);
      const shard = smoothstep(0.55, 0.9, noise.tiling(u * 20, v * 20, 20, 2));

      const base = 0.44 + chunks * 0.16 + dust * 0.05;
      let r = base * 1.03, g = base * 0.99, b = base * 0.93;
      r = lerp(r, 0.76, shard * 0.45); g = lerp(g, 0.74, shard * 0.45); b = lerp(b, 0.70, shard * 0.45);

      out[0] = clamp(r, 0.02, 0.85);
      out[1] = clamp(g, 0.02, 0.85);
      out[2] = clamp(b, 0.02, 0.85);
      out[3] = clamp(0.4 + chunks * 0.5 + shard * 0.2 + dust * 0.1, 0, 1);
      out[4] = clamp(0.88 + dust * 0.08, 0.6, 1.0);
    }
  }
};

export const SURFACE_NAMES = Object.keys(SURFACES);

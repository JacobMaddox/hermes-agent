// Deterministic RNG. Nothing in gameplay or world generation calls
// Math.random(); everything draws from a seeded stream so a given seed always
// produces the same archipelago, the same patrol routes and the same texture
// grain. That is what makes the screenshot captures in tools/ reproducible.
//
// mulberry32: small, fast, good enough distribution for content generation.

export class Rng {
  constructor(seed = 0x9e3779b9) {
    this.seed = seed >>> 0;
    this._s = this.seed;
  }

  reset(seed = this.seed) {
    this.seed = seed >>> 0;
    this._s = this.seed;
  }

  // [0, 1)
  next() {
    this._s = (this._s + 0x6d2b79f5) >>> 0;
    let t = this._s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // [min, max)
  range(min, max) {
    return min + this.next() * (max - min);
  }

  // integer in [min, max]
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  // [-a, a]
  spread(a) {
    return (this.next() * 2 - 1) * a;
  }

  bool(chance = 0.5) {
    return this.next() < chance;
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  // Approximately gaussian via sum of uniforms; used for recoil and spread so
  // shots cluster toward the centre instead of distributing flat.
  gaussian() {
    return (this.next() + this.next() + this.next() - 1.5) * 1.1547;
  }

  // A fresh independent stream, so one subsystem drawing more numbers can never
  // shift another subsystem's sequence.
  fork(salt = 0) {
    return new Rng((Math.imul(this._s ^ salt, 0x85ebca6b) ^ 0xc2b2ae35) >>> 0);
  }
}

// Deterministic value noise + fbm, shared by the material bakery and the world
// builder. Separate from Rng because it must be sampleable at arbitrary
// coordinates rather than sequential.
export class Noise2D {
  constructor(seed = 1337) {
    const rng = new Rng(seed);
    this.p = new Uint8Array(512);
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    rng.shuffle(perm);
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
  }

  _grad(hash, x, y) {
    switch (hash & 3) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      default: return -x - y;
    }
  }

  // Perlin-style gradient noise in [-1, 1].
  sample(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const p = this.p;
    const aa = p[p[X] + Y];
    const ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y];
    const bb = p[p[X + 1] + Y + 1];
    const x1 = lerp(this._grad(aa, xf, yf), this._grad(ba, xf - 1, yf), u);
    const x2 = lerp(this._grad(ab, xf, yf - 1), this._grad(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  }

  // Tiling fbm: samples on a torus of period `period` so the resulting texture
  // wraps seamlessly. Every material in the bakery relies on this.
  tiling(x, y, period, octaves = 4, lacunarity = 2, gain = 0.5) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let freq = 1;
    for (let o = 0; o < octaves; o++) {
      const pf = period * freq;
      // Blend four shifted samples so the seam at the period boundary cancels.
      const fx = x * freq;
      const fy = y * freq;
      const a = this.sample(fx, fy);
      const b = this.sample(fx - pf, fy);
      const c = this.sample(fx, fy - pf);
      const d = this.sample(fx - pf, fy - pf);
      const wx = x / period;
      const wy = y / period;
      const n = lerp(lerp(a, b, wx), lerp(c, d, wx), wy);
      sum += n * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  // Ridged variant — sharp creases, used for marble veining and rock strata.
  ridged(x, y, period, octaves = 4) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let freq = 1;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.tiling(x * freq, y * freq, period * freq, 1));
      sum += n * n * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Frame-rate independent exponential smoothing.
//
// The naive form of this is `lerp(current, target, dt * rate)`, which is fine
// at 60fps and catastrophic the moment a frame takes longer than 1/rate
// seconds: the interpolant exceeds 1, the value overshoots past the target,
// and on the next long frame it overshoots back further. On a stutter that
// shows up as the camera snapping to a wild angle.
//
// `1 - exp(-rate * dt)` is the same curve, is exactly equivalent at small dt,
// and can never exceed 1 no matter how long the frame was.
export function damp(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

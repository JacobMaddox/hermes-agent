import * as THREE from 'three';

// Fixed-timestep simulation with a variable-rate render.
//
// Physics, the player controller and AI all step at FIXED_HZ so behaviour is
// frame-rate independent and reproducible. Rendering and visual interpolation
// run once per animation frame. The accumulator is clamped so a tab-away or a
// long GC pause cannot produce a hundred catch-up steps in one frame (the
// "spiral of death").

export const FIXED_HZ = 120;
export const FIXED_STEP = 1 / FIXED_HZ;
const MAX_STEPS_PER_FRAME = 8;
const MAX_FRAME_DT = 0.25;

export class Loop {
  constructor(ctx, renderFn) {
    this.ctx = ctx;
    this.renderFn = renderFn;
    this._acc = 0;
    this._last = 0;
    this._raf = 0;
    this._running = false;
    this._onFrame = this._frame.bind(this);

    // Rolling frame-time window for the perf HUD and dynamic resolution.
    this.frameTimes = new Float32Array(120);
    this._ftIndex = 0;
    this.avgFrameMs = 16.7;
    this.fps = 60;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    this._acc = 0;
    this._raf = requestAnimationFrame(this._onFrame);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _frame(now) {
    if (!this._running) return;
    this._raf = requestAnimationFrame(this._onFrame);

    let dt = (now - this._last) / 1000;
    this._last = now;
    if (!isFinite(dt) || dt < 0) dt = 0;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;

    const ctx = this.ctx;
    ctx.time.dt = dt;
    ctx.time.elapsed += dt;
    ctx.time.frame++;

    if (!ctx.paused) {
      this._acc += dt;
      let steps = 0;
      while (this._acc >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
        ctx.fixedUpdate(FIXED_STEP);
        this._acc -= FIXED_STEP;
        steps++;
      }
      // Drop any residue we could not simulate rather than banking it.
      if (steps === MAX_STEPS_PER_FRAME) this._acc = 0;

      ctx.update(dt);
      ctx.lateUpdate(dt);
    }

    this.renderFn(dt);

    const frameMs = performance.now() - now;
    this.frameTimes[this._ftIndex] = frameMs;
    this._ftIndex = (this._ftIndex + 1) % this.frameTimes.length;
    // Cheap EMA rather than re-averaging the window every frame.
    this.avgFrameMs += (frameMs - this.avgFrameMs) * 0.05;
    this.fps = 1000 / Math.max(this.avgFrameMs, 0.5);
  }

  // Sorted percentile over the window — used by tools/playtest.mjs to report a
  // frame-time distribution rather than a misleading mean.
  percentile(p) {
    const arr = Array.from(this.frameTimes).filter((v) => v > 0).sort((a, b) => a - b);
    if (!arr.length) return 0;
    return arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  }
}

// Preallocated scratch objects. Subsystems borrow these inside update loops
// instead of allocating, which is what keeps the frame time flat — a new
// Vector3 per enemy per frame is what turns a smooth 60 into a sawtooth.
export const scratch = {
  v0: new THREE.Vector3(),
  v1: new THREE.Vector3(),
  v2: new THREE.Vector3(),
  v3: new THREE.Vector3(),
  v4: new THREE.Vector3(),
  v5: new THREE.Vector3(),
  q0: new THREE.Quaternion(),
  q1: new THREE.Quaternion(),
  m0: new THREE.Matrix4(),
  m1: new THREE.Matrix4(),
  box0: new THREE.Box3(),
  box1: new THREE.Box3(),
  ray: new THREE.Ray(),
  color0: new THREE.Color(),
  euler0: new THREE.Euler()
};

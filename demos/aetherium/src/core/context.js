// Runtime service locator. Subsystems never import one another directly; they
// resolve each other through the context at update time. This keeps the
// dependency graph acyclic and lets any subsystem be swapped or stubbed.

export class Context {
  constructor() {
    this._systems = new Map();
    this._order = [];
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.bus = null;
    this.rng = null;
    this.quality = null;
    this.time = { elapsed: 0, dt: 0, frame: 0 };
    this.paused = false;
  }

  register(name, system) {
    if (this._systems.has(name)) throw new Error(`system already registered: ${name}`);
    this._systems.set(name, system);
    this._order.push(name);
    system.ctx = this;
    system.name = name;
    return system;
  }

  get(name) {
    const s = this._systems.get(name);
    if (!s) throw new Error(`unknown system: ${name}`);
    return s;
  }

  // Optional lookup — returns null instead of throwing. Used for subsystems
  // that a quality preset may have disabled entirely.
  tryGet(name) {
    return this._systems.get(name) || null;
  }

  async initAll() {
    for (const name of this._order) {
      const s = this._systems.get(name);
      if (s.init) await s.init();
    }
  }

  // Called once after every subsystem has initialised, for cross-wiring that
  // needs the whole graph present (collider bake, navgrid bake, env probe).
  async readyAll() {
    for (const name of this._order) {
      const s = this._systems.get(name);
      if (s.ready) await s.ready();
    }
  }

  fixedUpdate(step) {
    for (const name of this._order) {
      const s = this._systems.get(name);
      if (s.fixedUpdate) s.fixedUpdate(step);
    }
  }

  update(dt) {
    for (const name of this._order) {
      const s = this._systems.get(name);
      if (s.update) s.update(dt);
    }
  }

  lateUpdate(dt) {
    for (const name of this._order) {
      const s = this._systems.get(name);
      if (s.lateUpdate) s.lateUpdate(dt);
    }
  }

  reset() {
    for (const name of this._order) {
      const s = this._systems.get(name);
      if (s.reset) s.reset();
    }
  }
}

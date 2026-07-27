import { WORLD_BOUNDS } from '../world/world.js';

// Navigation grid.
//
// Baked once from the physics colliders: for every cell we find the highest
// walkable surface and check there is standing room above it. The world is
// deliberately built so no walkable surface sits directly above another, which
// is what lets a 2D grid represent it without the AI ever pathing through a
// floor.
//
// A* uses a binary heap and reuses its arrays between queries — pathfinding
// happens often enough that allocating a fresh open set per call would show up
// in the frame time.

export const CELL_SIZE = 1.25;
const MAX_STEP_UP = 0.62;
const MAX_DROP = 3.2;
const AGENT_HEIGHT = 1.9;
const AGENT_RADIUS = 0.5;

export class NavGrid {
  constructor(physics) {
    this.physics = physics;
    this.minX = WORLD_BOUNDS.minX;
    this.minZ = WORLD_BOUNDS.minZ;
    this.cols = Math.ceil((WORLD_BOUNDS.maxX - WORLD_BOUNDS.minX) / CELL_SIZE);
    this.rows = Math.ceil((WORLD_BOUNDS.maxZ - WORLD_BOUNDS.minZ) / CELL_SIZE);
    const n = this.cols * this.rows;

    this.walkable = new Uint8Array(n);
    this.height = new Float32Array(n);
    this.cover = new Uint8Array(n);

    // A* working sets, allocated once.
    this._g = new Float32Array(n);
    this._f = new Float32Array(n);
    this._came = new Int32Array(n);
    this._closed = new Uint8Array(n);
    this._openMark = new Uint8Array(n);
    this._heap = new Int32Array(n);
    this._heapSize = 0;
    this._stamp = new Uint32Array(n);
    this._epoch = 0;
    this._path = [];
  }

  index(cx, cz) {
    return cz * this.cols + cx;
  }

  cellOf(x, z) {
    const cx = Math.floor((x - this.minX) / CELL_SIZE);
    const cz = Math.floor((z - this.minZ) / CELL_SIZE);
    if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) return -1;
    return this.index(cx, cz);
  }

  worldX(i) { return this.minX + (i % this.cols + 0.5) * CELL_SIZE; }
  worldZ(i) { return this.minZ + (Math.floor(i / this.cols) + 0.5) * CELL_SIZE; }
  worldY(i) { return this.height[i]; }

  bake(onProgress) {
    const phys = this.physics;
    for (let cz = 0; cz < this.rows; cz++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const i = this.index(cx, cz);
        const x = this.minX + (cx + 0.5) * CELL_SIZE;
        const z = this.minZ + (cz + 0.5) * CELL_SIZE;
        const ground = phys.groundAt(x, z, 400, 600);
        if (!ground) continue;
        // Reject anything without standing room, so drones never path into a
        // half-height gap under a bridge deck.
        if (!phys._hasHeadroom({ x, z }, AGENT_RADIUS, AGENT_HEIGHT, ground.y + 0.05)) continue;
        this.walkable[i] = 1;
        this.height[i] = ground.y;
        if (ground.collider && ground.collider.isCover) this.cover[i] = 1;
      }
      if (onProgress && cz % 24 === 0) onProgress(cz / this.rows);
    }

    // Erode the border by one cell: an agent whose centre sits exactly on the
    // last walkable cell has half its body over the void.
    const eroded = this.walkable.slice();
    for (let cz = 0; cz < this.rows; cz++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const i = this.index(cx, cz);
        if (!this.walkable[i]) continue;
        let open = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, nz = cz + dz;
            if (nx < 0 || nz < 0 || nx >= this.cols || nz >= this.rows) { open++; continue; }
            const j = this.index(nx, nz);
            if (!this.walkable[j]) open++;
            else if (Math.abs(this.height[j] - this.height[i]) > MAX_DROP) open++;
          }
        }
        if (open >= 4) eroded[i] = 0;
      }
    }
    this.walkable = eroded;

    this.walkableCount = 0;
    for (let i = 0; i < this.walkable.length; i++) if (this.walkable[i]) this.walkableCount++;
    return this.walkableCount;
  }

  _linkable(from, to) {
    if (!this.walkable[to]) return false;
    const dy = this.height[to] - this.height[from];
    // Up is limited by step height, down by what a drone will commit to.
    if (dy > MAX_STEP_UP) return false;
    if (dy < -MAX_DROP) return false;
    return true;
  }

  // Nearest walkable cell to a world point, searching outward in rings.
  nearest(x, z, maxRings = 12) {
    const cx = Math.floor((x - this.minX) / CELL_SIZE);
    const cz = Math.floor((z - this.minZ) / CELL_SIZE);
    for (let r = 0; r <= maxRings; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= this.cols || nz >= this.rows) continue;
          const i = this.index(nx, nz);
          if (this.walkable[i]) return i;
        }
      }
    }
    return -1;
  }

  // ── A* ────────────────────────────────────────────────────────────────

  _heapPush(i) {
    const heap = this._heap;
    const f = this._f;
    let n = this._heapSize++;
    heap[n] = i;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (f[heap[p]] <= f[heap[n]]) break;
      const t = heap[p]; heap[p] = heap[n]; heap[n] = t;
      n = p;
    }
  }

  _heapPop() {
    const heap = this._heap;
    const f = this._f;
    const top = heap[0];
    this._heapSize--;
    if (this._heapSize > 0) {
      heap[0] = heap[this._heapSize];
      let n = 0;
      for (;;) {
        const l = n * 2 + 1;
        const r = l + 1;
        let m = n;
        if (l < this._heapSize && f[heap[l]] < f[heap[m]]) m = l;
        if (r < this._heapSize && f[heap[r]] < f[heap[m]]) m = r;
        if (m === n) break;
        const t = heap[m]; heap[m] = heap[n]; heap[n] = t;
        n = m;
      }
    }
    return top;
  }

  // Returns an array of {x, y, z} waypoints, already string-pulled, or null.
  findPath(fromX, fromZ, toX, toZ, maxNodes = 4000) {
    const start = this.nearest(fromX, fromZ);
    const goal = this.nearest(toX, toZ);
    if (start < 0 || goal < 0) return null;
    if (start === goal) {
      return [{ x: this.worldX(goal), y: this.height[goal], z: this.worldZ(goal) }];
    }

    this._epoch++;
    const epoch = this._epoch;
    const stamp = this._stamp;
    const g = this._g, f = this._f, came = this._came, closed = this._closed;
    this._heapSize = 0;

    stamp[start] = epoch;
    g[start] = 0;
    f[start] = this._h(start, goal);
    came[start] = -1;
    closed[start] = 0;
    this._heapPush(start);

    let expanded = 0;
    const gx = goal % this.cols;
    const gz = (goal / this.cols) | 0;

    while (this._heapSize > 0) {
      const cur = this._heapPop();
      if (closed[cur] === 1 && stamp[cur] === epoch) continue;
      closed[cur] = 1;
      if (cur === goal) return this._reconstruct(cur, came, epoch, stamp);
      if (++expanded > maxNodes) break;

      const cx = cur % this.cols;
      const cz = (cur / this.cols) | 0;

      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= this.cols || nz >= this.rows) continue;
          const nb = this.index(nx, nz);
          if (!this._linkable(cur, nb)) continue;
          // Do not cut corners diagonally through a blocked pair.
          if (dx !== 0 && dz !== 0) {
            if (!this.walkable[this.index(cx + dx, cz)] || !this.walkable[this.index(cx, cz + dz)]) continue;
          }
          if (stamp[nb] === epoch && closed[nb] === 1) continue;

          const step = (dx !== 0 && dz !== 0) ? 1.41421 : 1;
          const climb = Math.abs(this.height[nb] - this.height[cur]) * 0.6;
          const tentative = g[cur] + step + climb;

          if (stamp[nb] !== epoch) {
            stamp[nb] = epoch;
            closed[nb] = 0;
            g[nb] = Infinity;
          }
          if (tentative < g[nb]) {
            g[nb] = tentative;
            came[nb] = cur;
            f[nb] = tentative + this._h2(nx, nz, gx, gz);
            this._heapPush(nb);
          }
        }
      }
    }
    return null;
  }

  _h(i, goal) {
    return this._h2(i % this.cols, (i / this.cols) | 0, goal % this.cols, (goal / this.cols) | 0);
  }

  // Octile distance — admissible for 8-way movement, and much better guidance
  // than Manhattan when diagonals are allowed.
  _h2(ax, az, bx, bz) {
    const dx = Math.abs(ax - bx);
    const dz = Math.abs(az - bz);
    return (dx + dz) + (1.41421 - 2) * Math.min(dx, dz);
  }

  _reconstruct(goal, came, epoch, stamp) {
    const raw = [];
    let cur = goal;
    let guard = 0;
    while (cur >= 0 && guard++ < 10000) {
      raw.push(cur);
      cur = came[cur];
    }
    raw.reverse();

    // String pulling: drop any waypoint the agent can walk straight past.
    const out = this._path;
    out.length = 0;
    let anchor = 0;
    out.push(this._point(raw[0]));
    for (let i = 2; i < raw.length; i++) {
      if (!this._clearLine(raw[anchor], raw[i])) {
        anchor = i - 1;
        out.push(this._point(raw[anchor]));
      }
    }
    out.push(this._point(raw[raw.length - 1]));
    return out.slice();
  }

  _point(i) {
    return { x: this.worldX(i), y: this.height[i], z: this.worldZ(i) };
  }

  // Bresenham-ish walk between two cells, rejecting the line if it crosses
  // anything unwalkable or a height change too large to traverse.
  _clearLine(a, b) {
    let x0 = a % this.cols, z0 = (a / this.cols) | 0;
    const x1 = b % this.cols, z1 = (b / this.cols) | 0;
    const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
    const sx = x0 < x1 ? 1 : -1;
    const sz = z0 < z1 ? 1 : -1;
    let err = dx - dz;
    let prev = a;
    let guard = 0;
    for (;;) {
      if (guard++ > 512) return false;
      if (x0 === x1 && z0 === z1) return true;
      const e2 = err * 2;
      if (e2 > -dz) { err -= dz; x0 += sx; }
      if (e2 < dx) { err += dx; z0 += sz; }
      if (x0 < 0 || z0 < 0 || x0 >= this.cols || z0 >= this.rows) return false;
      const i = this.index(x0, z0);
      if (!this._linkable(prev, i)) return false;
      prev = i;
    }
  }
}

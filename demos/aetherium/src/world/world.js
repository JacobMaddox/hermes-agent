import * as THREE from 'three';
import { Builder, boxGeo, cylGeo, sphereGeo, coneGeo, torusGeo, makeMatrix } from './geo.js';
import { Kit } from './kit.js';

// Elysium Prime — the archipelago.
//
// Five islands over a cloud sea, roughly 190 x 210 metres corner to corner,
// against round 1's single ~50m terrace. Layout is deliberately 2.5D: no
// walkable surface sits directly above another walkable surface, which lets the
// navigation grid stay two-dimensional without the AI ever pathing through a
// floor. That is a level-design constraint, and every district respects it.
//
// Progression: Landing -> Market -> Ruins -> (restore the span) -> Temple, with
// the Vaults hanging off the Market as the reinforcement route.

export const DISTRICTS = {
  landing: { x: 0, y: 14, z: 86, w: 40, d: 30, name: 'Landing Terrace' },
  market: { x: 0, y: 6, z: 16, w: 68, d: 64, name: 'Market Tier' },
  vaults: { x: -62, y: -8, z: 16, w: 36, d: 34, name: 'Sunken Vaults' },
  ruins: { x: 78, y: 10, z: -20, w: 56, d: 50, name: 'Ruined District' },
  temple: { x: 0, y: 26, z: -82, w: 56, d: 48, name: 'Temple Plateau' }
};

// The apron is a separate lower island north of the plateau, joined to it by
// the grand stair. It has to sit clear of the plateau footprint: the first
// pass tucked it under the plateau's edge, which buried the stair inside the
// deck and left the finale physically unreachable.
export const TEMPLE_APRON = { x: 0, y: 14, z: -36, w: 26, d: 18 };

export const WORLD_BOUNDS = { minX: -86, maxX: 112, minZ: -112, maxZ: 108 };
// Anything below this is unrecoverable; the player subsystem uses it for the
// fall-out check instead of round 1's magic `y < 3`.
export const VOID_Y = -70;

export class WorldSystem {
  constructor() {
    this.colliders = [];
    this.coverPoints = [];
    this.spawns = {};
    this.beacons = [];
    this.lights = [];
    this.span = null;
    this.props = new THREE.Group();
  }

  async init() {
    const ctx = this.ctx;
    const rng = ctx.rng.fork(0xa37);
    const builder = new Builder(ctx);
    const kit = new Kit(builder, ctx, rng);
    this.builder = builder;
    this.kit = kit;
    this.rng = rng;

    ctx.scene.add(this.props);

    this._buildLanding(kit, builder, rng);
    this._buildMarket(kit, builder, rng);
    this._buildVaults(kit, builder, rng);
    this._buildRuins(kit, builder, rng);
    this._buildTemple(kit, builder, rng);
    this._buildConnections(kit, builder, rng);

    builder.finish(ctx.scene);
    this.colliders = builder.colliders;
    this._placeLights();

    if (ctx.onProgress) ctx.onProgress(1, 'Raising Elysium Prime');
  }

  // ── Landing Terrace ───────────────────────────────────────────────────
  _buildLanding(kit, b, rng) {
    const D = DISTRICTS.landing;
    kit.island(D.x, D.y, D.z, D.w, D.d, { top: 'marbleFloor', rockSteps: 4 });

    // Colonnade along the two long edges, open to the south where the stair
    // is. An even count either side of the axis, so the centreline is a gap —
    // an odd count puts a column dead in front of the gate and blocks the
    // approach both visually and physically.
    for (const i of [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5]) {
      kit.column(D.x + i * 6.6, D.y, D.z - D.d / 2 + 2.5, 5.2, 0.44);
      kit.column(D.x + i * 6.6, D.y, D.z + D.d / 2 - 2.5, 5.2, 0.44);
    }
    // Architrave tying the colonnade together.
    for (const sz of [-1, 1]) {
      const g = boxGeo(D.w - 6, 0.7, 1.1, 3);
      b.add(g, kit.mat('marble'),
        makeMatrix([D.x, D.y + 5.9, D.z + sz * (D.d / 2 - 2.5)]));
      g.dispose();
      b.box([D.x, D.y + 5.9, D.z + sz * (D.d / 2 - 2.5)], [D.w - 6, 0.7, 1.1], 'stone');
    }

    // Balustrade around the rim, broken where the stairs leave.
    kit.balustrade(D.x - 12, D.y, D.z - D.d / 2 + 0.4, 14, 0);
    kit.balustrade(D.x + 12, D.y, D.z - D.d / 2 + 0.4, 14, 0);
    kit.balustrade(D.x, D.y, D.z + D.d / 2 - 0.4, D.w - 2, 0);
    kit.balustrade(D.x - D.w / 2 + 0.4, D.y, D.z, D.d - 2, Math.PI / 2);
    kit.balustrade(D.x + D.w / 2 - 0.4, D.y, D.z, D.d - 2, Math.PI / 2);

    // Arched gate framing the descent.
    kit.arch(D.x, D.y + 4.4, D.z - D.d / 2 + 2.5, 5.5, 0.8, 1.6, 0);

    kit.planter(D.x - 13, D.y, D.z + 6, 2.2);
    kit.planter(D.x + 13, D.y, D.z + 6, 2.2);
    kit.planter(D.x - 13, D.y, D.z - 4, 1.9);
    kit.planter(D.x + 13, D.y, D.z - 4, 1.9);

    kit.statue(D.x - 7, D.y, D.z + 11, 1.0, 0.35);
    kit.statue(D.x + 7, D.y, D.z + 11, 1.0, -0.35);

    this.lights.push({ pos: kit.lamp(D.x - 16, D.y, D.z - 8), colour: 0xffd9a0, intensity: 2.2, range: 14 });
    this.lights.push({ pos: kit.lamp(D.x + 16, D.y, D.z - 8), colour: 0xffd9a0, intensity: 2.2, range: 14 });

    // The moored skiff: reads as how you arrived.
    this._skiff(kit, b, D.x + D.w / 2 + 3.6, D.y - 1.2, D.z + 4, rng);

    // Light cover so the tutorial fight has shape.
    kit.coverBlock(D.x - 5, D.y, D.z - 2, 1.8, 1.1, 0.9, 0.1);
    kit.coverBlock(D.x + 5, D.y, D.z - 2, 1.8, 1.1, 0.9, -0.1);
    kit.crate(D.x - 9, D.y, D.z + 1, 0.95);
    kit.crate(D.x - 9.9, D.y + 0.95, D.z + 1.3, 0.7);
    kit.barrel(D.x + 9.4, D.y, D.z + 1);

    this.spawns.player = new THREE.Vector3(D.x, D.y + 1.8, D.z + 10);
    this.spawns.landing = [
      new THREE.Vector3(D.x - 11, D.y, D.z - 6),
      new THREE.Vector3(D.x + 12, D.y, D.z - 3),
      new THREE.Vector3(D.x + 2, D.y, D.z - 9)
    ];
  }

  _skiff(kit, b, x, y, z, rng) {
    const wood = kit.mat('wood');
    const metal = kit.mat('bronze');
    const m = makeMatrix([x, y, z], [0, 0.12, 0.04]);
    // Hull as a stretched, tapered lathe rotated on its side.
    const hull = new THREE.LatheGeometry([
      new THREE.Vector2(0, 0), new THREE.Vector2(0.9, 0.6), new THREE.Vector2(1.15, 1.8),
      new THREE.Vector2(1.05, 3.4), new THREE.Vector2(0.55, 4.6), new THREE.Vector2(0, 5.0)
    ], 12);
    hull.rotateZ(Math.PI / 2);
    hull.scale(1.7, 1, 1);
    hull.translate(-4, 0, 0);
    b.add(hull, wood, m);
    hull.dispose();

    const deck = boxGeo(7.6, 0.14, 2.0, 1.4);
    deck.translate(-0.4, 0.85, 0);
    b.add(deck, wood, m);
    deck.dispose();

    const mast = cylGeo(0.07, 0.1, 4.6, 8, 1.4);
    mast.translate(-1.2, 3.0, 0);
    b.add(mast, wood, m);
    mast.dispose();

    // Aether ring — the thing that keeps it aloft.
    const ring = torusGeo(1.15, 0.11, 8, 20, Math.PI * 2, 1.2);
    ring.rotateX(Math.PI / 2);
    ring.translate(-4.2, 0.3, 0);
    b.add(ring, metal, m);
    ring.dispose();
    const core = sphereGeo(0.34, 14, 10, 1);
    core.translate(-4.2, 0.3, 0);
    b.add(core, kit.mat('aether'), m);
    core.dispose();

    b.box([x - 3.5, y + 0.5, z], [8, 1.6, 2.6], 'wood');
    this.lights.push({
      pos: new THREE.Vector3(x - 4.2, y + 0.3, z), colour: 0x49b6ff, intensity: 2.6, range: 12
    });
  }

  // ── Market Tier ───────────────────────────────────────────────────────
  _buildMarket(kit, b, rng) {
    const D = DISTRICTS.market;
    kit.island(D.x, D.y, D.z, D.w, D.d, { top: 'marbleFloor', rockSteps: 6 });

    // Central plaza inlay.
    const inlay = cylGeo(9, 9, 0.06, 40, 3);
    b.add(inlay, kit.mats.variant('marbleFloor', { color: new THREE.Color(0xcfa653) }),
      makeMatrix([D.x, D.y + 0.04, D.z + 2]));
    inlay.dispose();

    // Fountain at the centre.
    const fountainPos = kit.aetherPool(D.x, D.y, D.z + 2, 3.0);
    this.lights.push({ pos: fountainPos, colour: 0x4fb2ff, intensity: 3.4, range: 22 });
    kit.column(D.x, D.y + 0.4, D.z + 2, 2.6, 0.3, { flutes: false });
    const bowl = new THREE.LatheGeometry([
      new THREE.Vector2(0, 0), new THREE.Vector2(1.3, 0.25), new THREE.Vector2(1.15, 0.5),
      new THREE.Vector2(0.2, 0.42), new THREE.Vector2(0, 0.4)
    ], 18);
    bowl.translate(0, 3.1, 0);
    b.add(bowl, kit.mat('bronze'), makeMatrix([D.x, D.y + 0.4, D.z + 2]));
    bowl.dispose();

    // Two blocks of enterable buildings flanking a street that runs north-south.
    this._building(kit, b, D.x - 20, D.y, D.z + 14, 14, 10, 5.2, 0, rng);
    this._building(kit, b, D.x + 20, D.y, D.z + 14, 14, 10, 5.2, Math.PI, rng);
    this._building(kit, b, D.x - 21, D.y, D.z - 12, 12, 12, 6.4, Math.PI / 2, rng);
    this._building(kit, b, D.x + 21, D.y, D.z - 12, 12, 12, 6.4, -Math.PI / 2, rng);

    // Market stalls lining the street, alternating sides and orientation.
    const stallZ = [-2, 4, 10, 16, 22];
    for (let i = 0; i < stallZ.length; i++) {
      kit.stall(D.x - 9.5, D.y, D.z + stallZ[i], Math.PI / 2 + rng.spread(0.06));
      kit.stall(D.x + 9.5, D.y, D.z + stallZ[i] + 3, -Math.PI / 2 + rng.spread(0.06));
    }

    // Awning banners strung between the building blocks.
    for (let i = 0; i < 5; i++) {
      kit.banner(D.x - 14 + i * 7, D.y + 6.4, D.z + 8, 1.6, 2.6, rng.spread(0.1));
    }

    // Clutter, weighted toward the alleys rather than the open street.
    const clutter = Math.round(26 * this.ctx.quality.propDensity);
    for (let i = 0; i < clutter; i++) {
      const side = rng.bool() ? -1 : 1;
      const x = D.x + side * rng.range(12, 30);
      const z = D.z + rng.range(-28, 28);
      if (rng.bool(0.55)) kit.crate(x, D.y, z, rng.range(0.7, 1.1));
      else kit.barrel(x, D.y, z);
      if (rng.bool(0.3)) kit.crate(x + rng.spread(0.6), D.y + 0.9, z + rng.spread(0.6), 0.68);
    }

    // Cover for the mid-map firefight.
    const coverSpots = [
      [-6, -8, 0.2], [7, -6, -0.3], [-14, 2, 1.5], [15, 6, 1.2],
      [-3, -18, 0], [5, -20, 0.4], [-18, -22, 0.8], [17, -24, -0.6],
      [0, 24, 0], [-12, 28, 0.5], [13, 27, -0.4]
    ];
    for (const [ox, oz, rot] of coverSpots) {
      kit.coverBlock(D.x + ox, D.y, D.z + oz, 1.9, 1.15, 0.85, rot);
    }

    for (const [ox, oz] of [[-24, 26], [24, 26], [-24, -26], [24, -26], [0, -28]]) {
      this.lights.push({
        pos: kit.lamp(D.x + ox, D.y, D.z + oz, 3.6),
        colour: 0xffd39a, intensity: 2.4, range: 16
      });
    }

    kit.planter(D.x - 12, D.y, D.z + 30, 2.4);
    kit.planter(D.x + 12, D.y, D.z + 30, 2.4);

    // Rim balustrade, opened where the stairs and bridge attach.
    kit.balustrade(D.x - 18, D.y, D.z + D.d / 2 - 0.4, 26, 0);
    kit.balustrade(D.x + 18, D.y, D.z + D.d / 2 - 0.4, 26, 0);
    kit.balustrade(D.x, D.y, D.z - D.d / 2 + 0.4, D.w - 4, 0);
    kit.balustrade(D.x - D.w / 2 + 0.4, D.y, D.z + 14, 30, Math.PI / 2);
    kit.balustrade(D.x + D.w / 2 - 0.4, D.y, D.z + 14, 30, Math.PI / 2);
    kit.balustrade(D.x + D.w / 2 - 0.4, D.y, D.z - 20, 18, Math.PI / 2);

    this.spawns.market = [
      new THREE.Vector3(D.x - 8, D.y, D.z + 20),
      new THREE.Vector3(D.x + 9, D.y, D.z + 12),
      new THREE.Vector3(D.x - 16, D.y, D.z - 4),
      new THREE.Vector3(D.x + 15, D.y, D.z - 2),
      new THREE.Vector3(D.x - 4, D.y, D.z - 16),
      new THREE.Vector3(D.x + 6, D.y, D.z - 22),
      new THREE.Vector3(D.x - 22, D.y, D.z - 24),
      new THREE.Vector3(D.x + 20, D.y, D.z - 26)
    ];
    this.objectives = this.objectives || {};
    this.objectives.marketExit = new THREE.Vector3(D.x, D.y + 1.7, D.z - D.d / 2 + 4);
  }

  // A shell with a doorway, windows, an interior floor and a roof you can
  // reach. Interiors matter: they are what turn a street into a place to fight.
  _building(kit, b, x, y, z, w, d, h, rotY, rng) {
    const wall = 'brick';
    const mat = kit.mat(wall);
    const tile = kit.mats.tileOf(wall);
    const m = makeMatrix([x, y, z], [0, rotY, 0]);
    const t = 0.45;

    const cos = Math.cos(rotY), sin = Math.sin(rotY);
    const local = (lx, lz) => [x + lx * cos + lz * sin, z - lx * sin + lz * cos];

    // Back and side walls solid; front wall split around a doorway.
    const back = boxGeo(w, h, t, tile);
    back.translate(0, h / 2, -d / 2);
    b.add(back, mat, m);
    back.dispose();
    const [bx, bz] = local(0, -d / 2);
    b.box([bx, y + h / 2, bz], [Math.abs(cos) * w + Math.abs(sin) * t, h, Math.abs(sin) * w + Math.abs(cos) * t], 'stone');

    for (const s of [-1, 1]) {
      const side = boxGeo(t, h, d, tile);
      side.translate(s * w / 2, h / 2, 0);
      b.add(side, mat, m);
      side.dispose();
      const [sx, sz] = local(s * w / 2, 0);
      b.box([sx, y + h / 2, sz], [Math.abs(cos) * t + Math.abs(sin) * d, h, Math.abs(sin) * t + Math.abs(cos) * d], 'stone');
    }

    // Front: two piers and a lintel, leaving a 2.4m doorway.
    const doorW = 2.4;
    const pierW = (w - doorW) / 2;
    for (const s of [-1, 1]) {
      const pier = boxGeo(pierW, h, t, tile);
      pier.translate(s * (doorW / 2 + pierW / 2), h / 2, d / 2);
      b.add(pier, mat, m);
      pier.dispose();
      const [px, pz] = local(s * (doorW / 2 + pierW / 2), d / 2);
      b.box([px, y + h / 2, pz],
        [Math.abs(cos) * pierW + Math.abs(sin) * t, h, Math.abs(sin) * pierW + Math.abs(cos) * t], 'stone');
    }
    const lintel = boxGeo(doorW + 0.6, h - 2.6, t, tile);
    lintel.translate(0, 2.6 + (h - 2.6) / 2, d / 2);
    b.add(lintel, mat, m);
    lintel.dispose();
    const [lx, lz] = local(0, d / 2);
    b.box([lx, y + 2.6 + (h - 2.6) / 2, lz],
      [Math.abs(cos) * (doorW + 0.6) + Math.abs(sin) * t, h - 2.6, Math.abs(sin) * (doorW + 0.6) + Math.abs(cos) * t], 'stone');

    // Interior floor sits on the deck; roof is walkable.
    const roof = boxGeo(w + 0.8, 0.4, d + 0.8, tile);
    roof.translate(0, h + 0.2, 0);
    b.add(roof, kit.mat('sandstone'), m);
    roof.dispose();
    b.box([x, y + h + 0.2, z],
      [Math.abs(cos) * (w + 0.8) + Math.abs(sin) * (d + 0.8), 0.4,
      Math.abs(sin) * (w + 0.8) + Math.abs(cos) * (d + 0.8)], 'stone');

    // Roof parapet, so the rooftop route reads as usable.
    for (const [ox, oz, lw, ld] of [
      [0, (d + 0.8) / 2, w + 0.8, 0.3], [0, -(d + 0.8) / 2, w + 0.8, 0.3],
      [(w + 0.8) / 2, 0, 0.3, d + 0.8], [-(w + 0.8) / 2, 0, 0.3, d + 0.8]
    ]) {
      const g = boxGeo(lw, 0.7, ld, tile);
      g.translate(ox, h + 0.75, oz);
      b.add(g, kit.mat('sandstone'), m);
      g.dispose();
    }

    // Exterior stair to the roof, on the side away from the street.
    const stairSide = rng.bool() ? -1 : 1;
    const [sx0, sz0] = local(stairSide * (w / 2 + 0.6), -d / 2 + 0.5);
    kit.stairs(sx0, y, sz0, 1.4, 0.36, 0.42, Math.ceil((h + 0.4) / 0.36),
      -sin * 0 + 0, 1, 'sandstone');

    // Interior: a lamp and a little furniture so it is not an empty box.
    const [ix, iz] = local(0, 0);
    this.lights.push({
      pos: new THREE.Vector3(ix, y + h - 0.8, iz),
      colour: 0xffc98a, intensity: 2.0, range: Math.max(w, d) * 1.1
    });
    kit.crate(ix + rng.spread(2), y, iz + rng.spread(2), 0.85);
    kit.barrel(ix + rng.spread(2.5), y, iz + rng.spread(2.5));
  }

  // ── Sunken Vaults ─────────────────────────────────────────────────────
  _buildVaults(kit, b, rng) {
    const D = DISTRICTS.vaults;
    kit.island(D.x, D.y, D.z, D.w, D.d, { top: 'marbleFloor', rockSteps: 5, lip: false });

    const wallMat = kit.mat('sandstone');
    const h = 6.0;
    const t = 0.7;

    // Enclosed hall: four walls with two openings, a coffered ceiling.
    const walls = [
      [0, -D.d / 2 + t / 2, D.w, t],
      [-D.w / 2 + t / 2, 0, t, D.d],
      [D.w / 2 - t / 2, 0, t, D.d]
    ];
    for (const [ox, oz, ww, dd] of walls) {
      const g = boxGeo(ww, h, dd, kit.mats.tileOf('sandstone'));
      g.translate(ox, h / 2, oz);
      b.add(g, wallMat, makeMatrix([D.x, D.y, D.z]));
      g.dispose();
      b.box([D.x + ox, D.y + h / 2, D.z + oz], [ww, h, dd], 'stone');
    }
    // North wall with a 5m entrance for the stair to land in.
    for (const s of [-1, 1]) {
      const seg = (D.w - 5) / 2;
      const g = boxGeo(seg, h, t, kit.mats.tileOf('sandstone'));
      g.translate(s * (2.5 + seg / 2), h / 2, D.d / 2 - t / 2);
      b.add(g, wallMat, makeMatrix([D.x, D.y, D.z]));
      g.dispose();
      b.box([D.x + s * (2.5 + seg / 2), D.y + h / 2, D.z + D.d / 2 - t / 2], [seg, h, t], 'stone');
    }

    const ceil = boxGeo(D.w, 0.6, D.d, 3);
    ceil.translate(0, h + 0.3, 0);
    b.add(ceil, wallMat, makeMatrix([D.x, D.y, D.z]));
    ceil.dispose();
    b.box([D.x, D.y + h + 0.3, D.z], [D.w, 0.6, D.d], 'stone');

    // Vaulted arcade down the middle, columns doubling as cover.
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        if (i === 0 && j === 0) continue;
        kit.column(D.x + i * 10, D.y, D.z + j * 10, h - 0.9, 0.5, { material: 'sandstone', flutes: false });
      }
    }
    for (let i = -1; i <= 1; i++) {
      kit.arch(D.x + i * 10, D.y + h - 0.9, D.z - 10, 8, 0.6, 1.0, Math.PI / 2, 'sandstone');
      kit.arch(D.x + i * 10, D.y + h - 0.9, D.z + 10, 8, 0.6, 1.0, Math.PI / 2, 'sandstone');
    }

    // Aether pools are the only light down here — the contrast beat.
    for (const [ox, oz] of [[-11, 0], [11, 0], [0, -11]]) {
      const p = kit.aetherPool(D.x + ox, D.y, D.z + oz, 1.9);
      this.lights.push({ pos: p, colour: 0x3fa8ff, intensity: 4.2, range: 18 });
    }

    for (let i = 0; i < 8; i++) {
      kit.crate(D.x + rng.spread(13), D.y, D.z + rng.spread(13), rng.range(0.7, 1.0));
    }
    kit.coverBlock(D.x - 5, D.y, D.z + 5, 1.8, 1.1, 0.9, 0.4);
    kit.coverBlock(D.x + 5, D.y, D.z - 4, 1.8, 1.1, 0.9, -0.4);

    this.spawns.vaults = [
      new THREE.Vector3(D.x - 9, D.y, D.z - 6),
      new THREE.Vector3(D.x + 9, D.y, D.z - 2),
      new THREE.Vector3(D.x, D.y, D.z - 12),
      new THREE.Vector3(D.x + 6, D.y, D.z + 8)
    ];
  }

  // ── Ruined District ───────────────────────────────────────────────────
  _buildRuins(kit, b, rng) {
    const D = DISTRICTS.ruins;
    kit.island(D.x, D.y, D.z, D.w, D.d, { top: 'rubble', rockSteps: 5, lip: false });

    // Remains of a peristyle: some columns standing, some snapped, some down.
    const cols = [];
    for (let i = -3; i <= 3; i++) {
      for (const sz of [-1, 1]) {
        cols.push([D.x + i * 7.5, D.z + sz * 15]);
      }
    }
    for (const [cx, cz] of cols) {
      const roll = rng.next();
      if (roll < 0.4) {
        kit.column(cx, D.y, cz, rng.range(6.5, 8.5), 0.5);
      } else if (roll < 0.72) {
        // Snapped: a stump with a jagged top.
        const hh = rng.range(1.4, 3.6);
        kit.column(cx, D.y, cz, hh, 0.5, { flutes: false });
        kit.rubblePile(cx + rng.spread(1.5), D.y, cz + rng.spread(1.5), 1.4, 7);
      } else {
        kit.brokenColumn(cx, D.y, cz, rng.range(5, 9), 0.5, rng.range(0, Math.PI * 2));
      }
    }

    // Partial temple shell — two standing walls and a collapsed corner.
    const shellMat = kit.mat('sandstone');
    const sh = 7.5;
    const wallSpecs = [
      [D.x - 16, D.z - 8, 18, 0.9, Math.PI / 2, sh],
      [D.x - 7, D.z - 17, 18, 0.9, 0, sh * 0.72]
    ];
    for (const [wx, wz, wlen, wt, wrot, wh] of wallSpecs) {
      const g = boxGeo(wlen, wh, wt, kit.mats.tileOf('sandstone'));
      g.translate(0, wh / 2, 0);
      b.add(g, shellMat, makeMatrix([wx, D.y, wz], [0, wrot, 0]));
      g.dispose();
      const c = Math.abs(Math.cos(wrot)), s = Math.abs(Math.sin(wrot));
      b.box([wx, D.y + wh / 2, wz], [c * wlen + s * wt, wh, s * wlen + c * wt], 'stone');
      // Broken crenellation along the top so it does not read as cut with a saw.
      const n = Math.floor(wlen / 1.3);
      for (let i = 0; i < n; i++) {
        if (rng.bool(0.45)) continue;
        const g2 = boxGeo(1.1, rng.range(0.3, 1.1), wt, 2);
        g2.translate((i / n - 0.5) * wlen, wh + 0.3, 0);
        b.add(g2, shellMat, makeMatrix([wx, D.y, wz], [0, wrot, 0]));
        g2.dispose();
      }
    }

    // Rubble fields and cover.
    for (let i = 0; i < Math.round(16 * this.ctx.quality.propDensity); i++) {
      kit.rubblePile(
        D.x + rng.spread(D.w / 2 - 5), D.y, D.z + rng.spread(D.d / 2 - 5),
        rng.range(1.3, 3.2), rng.int(8, 18)
      );
    }
    const ruinCover = [
      [-18, 6, 0.3], [-9, 10, -0.5], [2, 4, 1.1], [12, 9, 0.6],
      [19, -2, -0.9], [8, -12, 0.2], [-4, -14, 1.4], [-16, -6, 0.7],
      [16, 14, 0.1], [-20, 16, -0.3]
    ];
    for (const [ox, oz, rot] of ruinCover) {
      kit.coverBlock(D.x + ox, D.y, D.z + oz, rng.range(1.6, 2.4), 1.2, 0.9, rot, 'rubble');
    }

    // Three beacons: objective 3. Kept out of the merged batch so they can be
    // destroyed and animated individually.
    const beaconSpots = [
      [D.x - 20, D.z + 14], [D.x + 18, D.z - 12], [D.x + 4, D.z + 18]
    ];
    for (let i = 0; i < beaconSpots.length; i++) {
      this._beacon(kit, b, beaconSpots[i][0], D.y, beaconSpots[i][1], i);
    }

    this.spawns.ruins = [
      new THREE.Vector3(D.x - 14, D.y, D.z + 8),
      new THREE.Vector3(D.x + 12, D.y, D.z + 6),
      new THREE.Vector3(D.x - 6, D.y, D.z - 10),
      new THREE.Vector3(D.x + 16, D.y, D.z - 6),
      new THREE.Vector3(D.x + 2, D.y, D.z + 16),
      new THREE.Vector3(D.x - 20, D.y, D.z - 4),
      new THREE.Vector3(D.x + 22, D.y, D.z + 12),
      new THREE.Vector3(D.x - 2, D.y, D.z - 18)
    ];
  }

  _beacon(kit, b, x, y, z, index) {
    // Static plinth goes in the batch; the emissive head is a live object.
    const plinth = boxGeo(1.8, 1.0, 1.8, 2);
    plinth.translate(0, 0.5, 0);
    b.add(plinth, kit.mat('sandstone'), makeMatrix([x, y, z]));
    plinth.dispose();
    b.box([x, y + 0.5, z], [1.8, 1.0, 1.8], 'stone');

    const group = new THREE.Group();
    group.position.set(x, y + 1.0, z);

    const pillar = new THREE.Mesh(
      cylGeo(0.32, 0.42, 2.2, 12, 1.5),
      kit.mat('darkMetal')
    );
    pillar.position.y = 1.1;
    pillar.castShadow = true;
    group.add(pillar);

    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.55, 1),
      kit.mats.get('beacon').clone()
    );
    core.position.y = 2.6;
    group.add(core);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.95, 0.06, 8, 26),
      kit.mat('bronze')
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 2.6;
    group.add(ring);

    const light = new THREE.PointLight(0xff5522, 3.0, 20, 1.8);
    light.position.y = 2.6;
    group.add(light);

    this.props.add(group);
    b.cylinder([x, y + 2.0, z], 0.5, 4.0, 'metal');

    this.beacons.push({
      id: index, group, core, ring, light,
      pos: new THREE.Vector3(x, y + 2.6, z),
      hp: 120, maxHp: 120, alive: true,
      hitbox: { centre: new THREE.Vector3(x, y + 2.4, z), radius: 1.0 }
    });
  }

  // ── Temple Plateau ────────────────────────────────────────────────────
  _buildTemple(kit, b, rng) {
    const D = DISTRICTS.temple;
    const A = TEMPLE_APRON;
    kit.island(A.x, A.y, A.z, A.w, A.d, { top: 'marbleFloor', rockSteps: 3 });
    kit.island(D.x, D.y, D.z, D.w, D.d, { top: 'marbleFloor', rockSteps: 6 });

    // The grand stair spans the void between the two islands: 24 treads
    // climbing 12m over 13m, landing exactly on the plateau's north edge.
    // Free-floating over the drop, which is the most dramatic approach in the
    // level and the reason the apron sits where it does.
    const stairStartZ = A.z - A.d / 2;              // -45
    const steps = 24;
    const rise = (D.y - A.y) / steps;               // 0.5
    const run = (Math.abs(D.z + D.d / 2 - stairStartZ)) / steps;
    kit.stairs(D.x - 5, A.y, stairStartZ, 10, rise, run, steps, 0, -1);
    // Flanking balustrades so the climb reads as architecture, not a ramp.
    for (const s of [-1, 1]) {
      kit.balustrade(D.x + s * 5.4, A.y + 6, stairStartZ - steps * run / 2, steps * run, Math.PI / 2);
    }

    // Peristyle: tall columns all the way round.
    const inset = 4.5;
    const perW = D.w / 2 - inset;
    const perD = D.d / 2 - inset;
    // Eight across the front, so the processional axis runs clear between the
    // two central columns and straight into the cella.
    for (const i of [-3.5, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3.5]) {
      kit.column(D.x + i * (perW / 3.8), D.y, D.z - perD, 8.5, 0.62);
      kit.column(D.x + i * (perW / 3.8), D.y, D.z + perD, 8.5, 0.62);
    }
    for (let j = -2; j <= 2; j++) {
      if (j === 0) continue;
      kit.column(D.x - perW, D.y, D.z + j * (perD / 2.4), 8.5, 0.62);
      kit.column(D.x + perW, D.y, D.z + j * (perD / 2.4), 8.5, 0.62);
    }

    // Entablature.
    for (const [ox, oz, ww, dd] of [
      [0, -perD, perW * 2 + 3, 1.6], [0, perD, perW * 2 + 3, 1.6],
      [-perW, 0, 1.6, perD * 2], [perW, 0, 1.6, perD * 2]
    ]) {
      const g = boxGeo(ww, 1.4, dd, 3);
      g.translate(ox, 9.5, oz);
      b.add(g, kit.mat('marble'), makeMatrix([D.x, D.y, D.z]));
      g.dispose();
      b.box([D.x + ox, D.y + 9.5, D.z + oz], [ww, 1.4, dd], 'stone');
    }

    // Cella: the inner sanctum, walls with a single opening facing the stair.
    const cw = 20, cd = 18, ch = 7.5;
    const cellaMat = kit.mat('marble');
    for (const [ox, oz, ww, dd] of [
      [0, -cd / 2, cw, 0.8], [-cw / 2, 0, 0.8, cd], [cw / 2, 0, 0.8, cd]
    ]) {
      const g = boxGeo(ww, ch, dd, 3);
      g.translate(ox, ch / 2, oz);
      b.add(g, cellaMat, makeMatrix([D.x, D.y, D.z]));
      g.dispose();
      b.box([D.x + ox, D.y + ch / 2, D.z + oz], [ww, ch, dd], 'stone');
    }
    for (const s of [-1, 1]) {
      const seg = (cw - 5) / 2;
      const g = boxGeo(seg, ch, 0.8, 3);
      g.translate(s * (2.5 + seg / 2), ch / 2, cd / 2);
      b.add(g, cellaMat, makeMatrix([D.x, D.y, D.z]));
      g.dispose();
      b.box([D.x + s * (2.5 + seg / 2), D.y + ch / 2, D.z + cd / 2], [seg, ch, 0.8], 'stone');
    }

    // Drum and dome in gold, now with an env map to actually reflect.
    const drum = cylGeo(9.2, 9.6, 2.4, 32, 2.5);
    drum.translate(0, ch + 1.2, 0);
    b.add(drum, kit.mat('gold'), makeMatrix([D.x, D.y, D.z]));
    drum.dispose();
    b.cylinder([D.x, D.y + ch + 1.2, D.z], 9.6, 2.4, 'metal');

    const dome = sphereGeo(9.2, 40, 24, 2.5, 0, Math.PI * 2, 0, Math.PI / 2);
    dome.translate(0, ch + 2.4, 0);
    b.add(dome, kit.mat('gold'), makeMatrix([D.x, D.y, D.z]));
    dome.dispose();

    // Ribbing so the dome is not a bare hemisphere.
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      const g = torusGeo(9.28, 0.11, 6, 20, Math.PI / 2, 2);
      g.rotateX(Math.PI / 2);
      g.rotateY(-a);
      g.translate(0, ch + 2.4, 0);
      b.add(g, kit.mat('bronze'), makeMatrix([D.x, D.y, D.z]));
      g.dispose();
    }

    const lantern = cylGeo(1.5, 1.9, 2.0, 16, 2);
    lantern.translate(0, ch + 11.4, 0);
    b.add(lantern, kit.mat('gold'), makeMatrix([D.x, D.y, D.z]));
    lantern.dispose();
    const finial = coneGeo(1.0, 3.0, 10, 2);
    finial.translate(0, ch + 13.9, 0);
    b.add(finial, kit.mat('gold'), makeMatrix([D.x, D.y, D.z]));
    finial.dispose();

    // Sanctum floor inlay and the objective marker.
    const inlay = cylGeo(6.5, 6.5, 0.05, 40, 3);
    b.add(inlay, kit.mats.variant('marbleFloor', { color: new THREE.Color(0xd8b45c) }),
      makeMatrix([D.x, D.y + 0.04, D.z]));
    inlay.dispose();

    const sanctum = kit.aetherPool(D.x, D.y, D.z - 3, 2.4);
    this.lights.push({ pos: sanctum, colour: 0x7fd0ff, intensity: 5.0, range: 26 });
    this.lights.push({
      pos: new THREE.Vector3(D.x, D.y + ch + 4, D.z),
      colour: 0xffcf80, intensity: 4.0, range: 30
    });

    kit.statue(D.x - 7, D.y, D.z - 6, 1.25, 0.5);
    kit.statue(D.x + 7, D.y, D.z - 6, 1.25, -0.5);

    for (const [ox, oz, rot] of [
      [-11, 9, 0.2], [11, 9, -0.2], [-15, 0, 1.5], [15, 0, 1.5], [0, 14, 0]
    ]) {
      kit.coverBlock(D.x + ox, D.y, D.z + oz, 2.0, 1.2, 0.9, rot, 'marble');
    }

    kit.balustrade(D.x, D.y, D.z - D.d / 2 + 0.5, D.w - 3, 0);
    kit.balustrade(D.x - D.w / 2 + 0.5, D.y, D.z, D.d - 3, Math.PI / 2);
    kit.balustrade(D.x + D.w / 2 - 0.5, D.y, D.z, D.d - 3, Math.PI / 2);

    this.spawns.temple = [
      new THREE.Vector3(D.x - 12, D.y, D.z + 12),
      new THREE.Vector3(D.x + 12, D.y, D.z + 12),
      new THREE.Vector3(D.x - 16, D.y, D.z - 2),
      new THREE.Vector3(D.x + 16, D.y, D.z - 2),
      new THREE.Vector3(D.x - 6, D.y, D.z + 18),
      new THREE.Vector3(D.x + 6, D.y, D.z + 18),
      new THREE.Vector3(D.x, D.y, D.z - 10),
      new THREE.Vector3(D.x - 20, D.y, D.z + 6),
      new THREE.Vector3(D.x + 20, D.y, D.z + 6)
    ];
    this.objectives = this.objectives || {};
    this.objectives.sanctum = new THREE.Vector3(D.x, D.y + 1.7, D.z - 3);
    this.objectives.templeApron = new THREE.Vector3(A.x, A.y + 1.7, A.z);
  }

  // ── Connections ───────────────────────────────────────────────────────
  _buildConnections(kit, b, rng) {
    const L = DISTRICTS.landing;
    const M = DISTRICTS.market;
    const V = DISTRICTS.vaults;
    const R = DISTRICTS.ruins;
    const T = DISTRICTS.temple;

    // Landing -> Market: a broad ceremonial stair.
    kit.stairs(L.x - 4, L.y, L.z - L.d / 2, 8, -0.4, 0.95, 20, 0, -1);
    // Landing platform where it meets the market deck.
    kit.island(L.x, M.y, M.z + M.d / 2 + 6, 12, 12, { top: 'marbleFloor', rockSteps: 3 });

    // Market -> Vaults: a long descending flight out over the void.
    kit.stairs(M.x - M.w / 2, M.y, V.z - 2.5, 5, -0.5, 0.8, 28, -1, 0, 'sandstone');

    // Market -> Ruins: an arched bridge.
    this._bridge(kit, b, M.x + M.w / 2 - 1, M.y, M.z - 6, R.x - R.w / 2 + 1, R.y, R.z + 14, 6);

    // Ruins -> Temple: the great span, in three parts. The middle section is
    // retracted at the start of the game and deploys when the beacons fall.
    const pier = { x: 41, y: 12, z: -55 };
    kit.island(pier.x, pier.y, pier.z, 11, 11, { top: 'marbleFloor', rockSteps: 4 });
    kit.column(pier.x - 3, pier.y, pier.z - 3, 4.5, 0.42);
    kit.column(pier.x + 3, pier.y, pier.z + 3, 4.5, 0.42);

    this._bridge(kit, b, R.x - R.w / 2 + 2, R.y, R.z - 18, pier.x + 4, pier.y, pier.z + 2, 5);
    // Lands on the temple apron, which is where the grand stair begins.
    this._retractableSpan(kit, pier.x - 4, pier.y, pier.z + 1,
      TEMPLE_APRON.x + 8, TEMPLE_APRON.y, TEMPLE_APRON.z - 2, 5);
  }

  // Deck + parapet + underside ribs spanning two points, with a slight arch.
  //
  // The visible deck is still built from segments so it can follow the camber,
  // but collision is a SINGLE ramp across the whole span. The previous version
  // emitted one axis-aligned box per segment: on a diagonal bridge each 2.5m
  // plank became a 5.3m square that overlapped its neighbours, and since every
  // segment then sat inside the next one's volume, the step onto it was
  // refused. That is what forced you to jump from piece to piece.
  _bridge(kit, b, x0, y0, z0, x1, y1, z1, width) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const ang = Math.atan2(dz, dx);
    const segs = Math.max(4, Math.ceil(len / 2.5));
    const deckMat = kit.mat('sandstone');
    const arch = Math.min(1.6, len * 0.06);

    // One collider for the whole deck. Walk-on, never a wall.
    b.ramp([x0, y0, z0], [x1, y1, z1], width - 0.6, 'stone', { arch, blocksSight: false });

    // Parapets as oriented boxes, split into a few pieces so each one hugs the
    // camber instead of being one long box through the middle of the arch.
    const pieces = Math.max(2, Math.ceil(len / 5));
    for (let p = 0; p < pieces; p++) {
      const t = (p + 0.5) / pieces;
      const px = x0 + dx * t;
      const pz = z0 + dz * t;
      const py = y0 + (y1 - y0) * t + Math.sin(t * Math.PI) * arch;
      for (const s of [-1, 1]) {
        b.obox(
          [px + Math.sin(ang) * s * (width / 2 - 0.15), py + 0.42,
            pz - Math.cos(ang) * s * (width / 2 - 0.15)],
          [len / pieces + 0.1, 0.85, 0.3], -ang,
          'stone', { blocksSight: false, climbable: false }
        );
      }
    }

    // Visual geometry only from here down — collision is the ramp and the
    // oriented parapets above.
    for (let i = 0; i < segs; i++) {
      const t = (i + 0.5) / segs;
      const x = x0 + dx * t;
      const z = z0 + dz * t;
      // Rise in the middle so it reads as an arch, not a plank.
      const camber = Math.sin(t * Math.PI) * arch;
      const y = y0 + (y1 - y0) * t + camber;
      const segLen = len / segs + 0.12;

      const g = boxGeo(segLen, 0.5, width, 2.5);
      b.add(g, deckMat, makeMatrix([x, y - 0.25, z], [0, -ang, 0]));
      g.dispose();

      for (const s of [-1, 1]) {
        const px = x + Math.sin(ang) * s * (width / 2 - 0.15);
        const pz = z - Math.cos(ang) * s * (width / 2 - 0.15);
        const p = boxGeo(segLen, 0.85, 0.3, 2);
        b.add(p, kit.mat('marble'), makeMatrix([px, y + 0.42, pz], [0, -ang, 0]));
        p.dispose();
      }

      // Underside ribs every other segment.
      if (i % 2 === 0) {
        const rib = boxGeo(0.5, 1.2 + camber, width * 0.8, 2);
        b.add(rib, deckMat, makeMatrix([x, y - 1.1 - camber / 2, z], [0, -ang, 0]));
        rib.dispose();
      }
    }
  }

  // The middle of the great span. Starts folded down against the pier; when the
  // beacons are destroyed it swings up into place and its collider goes live.
  _retractableSpan(kit, x0, y0, z0, x1, y1, z1, width) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const ang = Math.atan2(dz, dx);

    const group = new THREE.Group();
    group.position.set(x0, y0, z0);
    group.rotation.y = -ang;

    const deck = new THREE.Mesh(boxGeo(len, 0.5, width, 2.5), kit.mat('sandstone'));
    deck.position.set(len / 2, -0.25, 0);
    deck.castShadow = true;
    deck.receiveShadow = true;
    group.add(deck);

    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(boxGeo(len, 0.85, 0.3, 2), kit.mat('marble'));
      p.position.set(len / 2, 0.42, s * (width / 2 - 0.15));
      p.castShadow = true;
      group.add(p);
    }
    for (let i = 0; i < Math.floor(len / 4); i++) {
      const rib = new THREE.Mesh(boxGeo(0.5, 1.4, width * 0.8, 2), kit.mat('sandstone'));
      rib.position.set(2 + i * 4, -1.2, 0);
      group.add(rib);
    }

    // Stowed: rotated down about the pier end.
    group.rotation.z = -1.15;
    this.props.add(group);

    // One ramp for the deployed position, registered up front but inactive so
    // the broadphase skips it until the span swings into place. Same reasoning
    // as `_bridge`: a diagonal span split into boxes is impassable.
    const ramp = this.builder.ramp(
      [x0, y0, z0], [x1, y1, z1], width - 0.6, 'stone',
      { blocksSight: false, active: false }
    );
    const colliders = ramp ? [ramp] : [];

    this.span = {
      group, colliders, deployed: false, t: 0,
      from: { x: x0, y: y0, z: z0 }, to: { x: x1, y: y1, z: z1 },
      targetRotZ: (y1 - y0) / len
    };
  }

  deploySpan() {
    if (!this.span || this.span.deployed) return;
    this.span.deployed = true;
  }

  _placeLights() {
    // Point lights are a shader permutation key in three: changing how many are
    // visible recompiles every lit material in the scene. So we allocate a
    // fixed pool up front and move the pool members around, keeping the count
    // constant for the whole session.
    const ctx = this.ctx;
    const max = ctx.quality.maxLights;
    this.lightPool = [];
    for (let i = 0; i < max; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 20, 1.8);
      l.castShadow = false;
      ctx.scene.add(l);
      this.lightPool.push(l);
    }
    this._sortedLights = this.lights.slice();
  }

  // Assign the light pool to the nearest authored light sources each frame.
  // Intensity is driven to zero rather than toggling visibility, which is what
  // keeps the permutation count stable.
  update(dt) {
    const cam = this.ctx.camera;
    const pool = this.lightPool;
    if (!pool) return;

    if (this.ctx.time.frame % 12 === 0) {
      this._sortedLights.sort((a, bb) =>
        a.pos.distanceToSquared(cam.position) - bb.pos.distanceToSquared(cam.position));
    }

    for (let i = 0; i < pool.length; i++) {
      const src = this._sortedLights[i];
      const l = pool[i];
      if (!src) { l.intensity = 0; continue; }
      const d = src.pos.distanceTo(cam.position);
      l.position.copy(src.pos);
      l.color.setHex(src.colour);
      l.distance = src.range;
      // Fade out with distance so a light swapping out of the pool does not pop.
      const fade = 1 - Math.min(1, Math.max(0, (d - src.range * 1.2) / (src.range * 0.6)));
      l.intensity = src.intensity * fade * (src.on === false ? 0 : 1);
    }

    // Beacon idle animation and span deployment.
    const t = this.ctx.time.elapsed;
    for (const bc of this.beacons) {
      if (!bc.alive) continue;
      bc.core.rotation.y += dt * 0.9;
      bc.core.rotation.x += dt * 0.35;
      bc.ring.rotation.z += dt * 1.4;
      const pulse = 2.0 + Math.sin(t * 3.1 + bc.id) * 0.7;
      bc.core.material.emissiveIntensity = pulse;
      bc.light.intensity = 2.4 + Math.sin(t * 3.1 + bc.id) * 0.8;
    }

    if (this.span && this.span.deployed && this.span.t < 1) {
      this.span.t = Math.min(1, this.span.t + dt * 0.42);
      // Ease out so it settles rather than slamming.
      const e = 1 - Math.pow(1 - this.span.t, 3);
      this.span.group.rotation.z = -1.15 + (this.span.targetRotZ + 1.15) * e;
      if (this.span.t >= 1) {
        for (const c of this.span.colliders) c.active = true;
        this.ctx.bus.emit('span:deployed', {});
      }
    }
  }

  killBeacon(beacon) {
    if (!beacon.alive) return;
    beacon.alive = false;
    beacon.group.visible = false;
    beacon.light.intensity = 0;
    const idx = this.builder.colliders.findIndex(
      (c) => c.type === 'cyl' && Math.abs(c.x - beacon.pos.x) < 0.1 && Math.abs(c.z - beacon.pos.z) < 0.1
    );
    if (idx >= 0) this.builder.colliders[idx].active = false;
  }

  get aliveBeacons() {
    return this.beacons.filter((b) => b.alive).length;
  }
}

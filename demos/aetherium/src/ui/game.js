import * as THREE from 'three';
import { scratch } from '../core/loop.js';
import { clamp } from '../core/rng.js';
import { DISTRICTS } from '../world/world.js';

// Campaign director.
//
// Four gated stages that walk the player across the whole archipelago, each
// with its own objective type: clear, traverse, destroy, then clear-and-reach.
// The director owns spawning, objective state, waypoints and the win/lose
// flow — subsystems below it stay ignorant of what the mission is.

const STAGES = [
  {
    id: 'landing',
    title: 'Secure the Landing',
    sub: 'Neutralise the Void patrol',
    stage: 'STAGE 1 / 4',
    type: 'clear',
    district: 'landing'
  },
  {
    id: 'market',
    title: 'Cross the Market Tier',
    sub: 'Reach the southern gate',
    stage: 'STAGE 2 / 4',
    type: 'reach',
    district: 'market'
  },
  {
    id: 'span',
    title: 'Restore the Great Span',
    sub: 'Destroy the three Void Anchors',
    stage: 'STAGE 3 / 4',
    type: 'beacons',
    district: 'ruins'
  },
  {
    id: 'temple',
    title: 'Take the Temple',
    sub: 'Clear the plateau and reach the sanctum',
    stage: 'STAGE 4 / 4',
    type: 'clear_reach',
    district: 'temple'
  }
];

export class GameSystem {
  constructor() {
    this.stageIndex = -1;
    this.stage = null;
    this.markers = [];
    this.pickups = [];
    this.startTime = 0;
    this.won = false;
    this.reachTarget = null;
    this._deaths = 0;
    this._respawnT = 0;
    this._stageT = 0;
    this._pendingAdvance = 0;
  }

  async init() {
    this.waypointEl = document.getElementById('waypoint');
  }

  async ready() {
    const bus = this.ctx.bus;
    bus.on('player:death', () => this._onPlayerDeath());
    bus.on('beacon:destroyed', () => this._onBeaconDestroyed());
    bus.on('span:deployed', () => {
      this.ctx.bus.emit('toast', { text: 'The great span is restored', duration: 3 });
    });
    this._spawnPickups();
  }

  begin() {
    this.startTime = this.ctx.time.elapsed;
    this.stageIndex = -1;
    this.won = false;
    this.ctx.gameOver = false;
    this._advance();
  }

  restart() {
    const ai = this.ctx.get('ai');
    const player = this.ctx.get('player');
    const weapons = this.ctx.get('weapons');
    const world = this.ctx.get('world');

    ai.clearActors();
    this.ctx.get('physics').reset();
    this.ctx.get('fx').reset();
    weapons.reset();
    player.stats = {
      shotsFired: 0, shotsHit: 0, kills: 0, headshots: 0, damageTaken: 0
    };
    player.respawn(world.spawns.player);

    // Beacons and the span go back to their opening state.
    for (const b of world.beacons) {
      b.alive = true;
      b.hp = b.maxHp;
      b.group.visible = true;
    }
    if (world.span) {
      world.span.deployed = false;
      world.span.t = 0;
      world.span.group.rotation.z = -1.15;
      for (const c of world.span.colliders) c.active = false;
    }
    for (const p of this.pickups) {
      p.taken = false;
      p.mesh.visible = true;
    }
    this._deaths = 0;
    this.begin();
  }

  // ── Stage flow ────────────────────────────────────────────────────────

  _advance() {
    this.stageIndex++;
    if (this.stageIndex >= STAGES.length) return this._win();

    this.stage = STAGES[this.stageIndex];
    this._stageT = 0;
    this._cleared = false;
    this.markers.length = 0;

    const world = this.ctx.get('world');
    const ai = this.ctx.get('ai');

    switch (this.stage.id) {
      case 'landing':
        ai.spawnSquad({
          district: 'landing', count: 3, types: ['skirmisher', 'skirmisher', 'sentry'],
          points: world.spawns.landing, state: 'patrol',
          patrol: this._patrolRing(DISTRICTS.landing, 12)
        });
        break;

      case 'market':
        ai.spawnSquad({
          district: 'market', count: 8,
          types: ['skirmisher', 'sentry', 'skirmisher', 'heavy', 'skirmisher', 'sentry', 'skirmisher', 'skirmisher'],
          points: world.spawns.market, state: 'patrol',
          patrol: this._patrolRing(DISTRICTS.market, 22)
        });
        this.reachTarget = world.objectives.marketExit.clone();
        this.markers.push({ position: this.reachTarget, label: 'Southern Gate' });
        break;

      case 'span':
        ai.spawnSquad({
          district: 'ruins', count: 8,
          types: ['sentry', 'skirmisher', 'heavy', 'skirmisher', 'sentry', 'skirmisher', 'skirmisher', 'heavy'],
          points: world.spawns.ruins, state: 'patrol',
          patrol: this._patrolRing(DISTRICTS.ruins, 18)
        });
        for (const b of world.beacons) {
          if (b.alive) this.markers.push({ position: b.pos, label: 'Void Anchor', colour: 'rgba(190,80,255,0.95)' });
        }
        break;

      case 'temple':
        ai.spawnSquad({
          district: 'temple', count: 9,
          types: ['heavy', 'sentry', 'skirmisher', 'sentry', 'skirmisher', 'heavy', 'skirmisher', 'sentry', 'skirmisher'],
          points: world.spawns.temple, state: 'patrol',
          patrol: this._patrolRing(DISTRICTS.temple, 18)
        });
        this.reachTarget = world.objectives.sanctum.clone();
        break;
    }

    this.ctx.bus.emit('objective:advance', {
      title: this.stage.title, sub: this.stage.sub, stage: this.stage.stage,
      id: this.stage.id
    });
  }

  _patrolRing(D, radius) {
    const rng = this.ctx.rng;
    const pts = [];
    const n = 5;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.range(0, 0.6);
      pts.push(new THREE.Vector3(
        D.x + Math.cos(a) * radius * rng.range(0.6, 1),
        D.y + 1.35,
        D.z + Math.sin(a) * radius * rng.range(0.6, 1)
      ));
    }
    return pts;
  }

  _onBeaconDestroyed() {
    const world = this.ctx.get('world');
    const left = world.aliveBeacons;
    this.markers = this.markers.filter((m) => {
      if (m.label !== 'Void Anchor') return true;
      return world.beacons.some((b) => b.alive && b.pos.equals(m.position));
    });
    if (left > 0) {
      this.ctx.bus.emit('toast', {
        text: `Void Anchor down — ${left} remaining`, duration: 2.2
      });
    } else {
      world.deploySpan();
      this.ctx.bus.emit('toast', { text: 'All Void Anchors down', duration: 2.5 });
      this._pendingAdvance = 2.4;
    }
  }

  _onPlayerDeath() {
    this._deaths++;
    this._respawnT = 2.6;
    this.ctx.bus.emit('toast', { text: 'Augment failure — Sentinel reinitialising', duration: 2.4 });
  }

  _win() {
    this.won = true;
    this.ctx.gameOver = true;
    const stats = this.ctx.get('player').stats;
    const time = this.ctx.time.elapsed - this.startTime;
    this.ctx.get('ui').showDebrief(true, stats, time);
    document.exitPointerLock();
  }

  // ── Pickups ───────────────────────────────────────────────────────────

  _spawnPickups() {
    const world = this.ctx.get('world');
    const mats = this.ctx.get('materials');
    const geo = new THREE.IcosahedronGeometry(0.3, 1);
    const mat = mats.get('aether').clone();
    mat.emissiveIntensity = 3.2;

    // Placed at the natural rest points of each district, so restocking is a
    // reason to explore rather than a scavenger hunt.
    const spots = [
      [DISTRICTS.landing.x - 12, DISTRICTS.landing.y, DISTRICTS.landing.z + 2],
      [DISTRICTS.landing.x + 12, DISTRICTS.landing.y, DISTRICTS.landing.z + 2],
      [DISTRICTS.market.x - 20, DISTRICTS.market.y, DISTRICTS.market.z + 14],
      [DISTRICTS.market.x + 20, DISTRICTS.market.y, DISTRICTS.market.z + 14],
      [DISTRICTS.market.x, DISTRICTS.market.y, DISTRICTS.market.z - 22],
      [DISTRICTS.market.x - 21, DISTRICTS.market.y, DISTRICTS.market.z - 12],
      [DISTRICTS.vaults.x, DISTRICTS.vaults.y, DISTRICTS.vaults.z],
      [DISTRICTS.vaults.x - 11, DISTRICTS.vaults.y, DISTRICTS.vaults.z + 8],
      [DISTRICTS.ruins.x - 18, DISTRICTS.ruins.y, DISTRICTS.ruins.z + 6],
      [DISTRICTS.ruins.x + 16, DISTRICTS.ruins.y, DISTRICTS.ruins.z - 8],
      [DISTRICTS.ruins.x + 2, DISTRICTS.ruins.y, DISTRICTS.ruins.z + 16],
      [DISTRICTS.temple.x - 14, DISTRICTS.temple.y, DISTRICTS.temple.z + 14],
      [DISTRICTS.temple.x + 14, DISTRICTS.temple.y, DISTRICTS.temple.z + 14],
      [41, 12, -55]
    ];

    for (const [x, y, z] of spots) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y + 1.0, z);
      this.ctx.scene.add(mesh);
      this.pickups.push({
        mesh, taken: false, baseY: y + 1.0, ammo: 45,
        phase: this.ctx.rng.range(0, Math.PI * 2)
      });
    }
  }

  _updatePickups(dt) {
    const player = this.ctx.get('player');
    const weapons = this.ctx.get('weapons');
    const t = this.ctx.time.elapsed;

    for (const p of this.pickups) {
      if (p.taken) continue;
      p.mesh.rotation.y += dt * 1.8;
      p.mesh.rotation.x += dt * 0.7;
      p.mesh.position.y = p.baseY + Math.sin(t * 1.9 + p.phase) * 0.14;

      if (p.mesh.position.distanceToSquared(player.position) < 2.2 * 2.2) {
        const gained = weapons.addAmmo(p.ammo);
        if (gained <= 0) continue;
        p.taken = true;
        p.mesh.visible = false;
        this.ctx.bus.emit('pickup:taken', { ammo: gained });
        this.ctx.bus.emit('toast', { text: `+${gained} plasma cells`, duration: 1.4 });
      }
    }
  }

  // ── Per-frame ─────────────────────────────────────────────────────────

  update(dt) {
    if (this.stageIndex < 0) return;
    const player = this.ctx.get('player');
    const ai = this.ctx.get('ai');
    const world = this.ctx.get('world');
    this._stageT += dt;

    this._updatePickups(dt);
    this._updateWaypoint(player);

    if (this._respawnT > 0) {
      this._respawnT -= dt;
      if (this._respawnT <= 0) this._respawn();
      return;
    }
    if (this.ctx.gameOver) return;

    if (this._pendingAdvance > 0) {
      this._pendingAdvance -= dt;
      if (this._pendingAdvance <= 0) this._advance();
      return;
    }

    // Objective completion checks.
    switch (this.stage.type) {
      case 'clear':
        if (ai.aliveInDistrict(this.stage.district) === 0 && this._stageT > 1) {
          this._pendingAdvance = 1.4;
        }
        break;

      case 'reach': {
        if (!this.reachTarget) break;
        const d = player.position.distanceTo(this.reachTarget);
        if (d < 6) this._pendingAdvance = 0.8;
        break;
      }

      case 'beacons':
        // Handled by the beacon event; nothing to poll.
        break;

      case 'clear_reach': {
        // Two beats in one stage: clear the plateau, then walk into the
        // sanctum. The waypoint only appears once the fighting is done, so it
        // never pulls the player past a live squad.
        const left = ai.aliveInDistrict(this.stage.district);
        if (left > 0) break;

        if (!this._cleared) {
          this._cleared = true;
          this.markers.push({ position: this.reachTarget, label: 'Sanctum' });
          this.ctx.bus.emit('objective:advance', {
            title: 'Enter the Sanctum',
            sub: 'The plateau is clear',
            stage: this.stage.stage,
            id: 'sanctum'
          });
        }
        if (player.position.distanceTo(this.reachTarget) < 5) this._pendingAdvance = 0.6;
        break;
      }
    }
  }

  // Screen-space waypoint: the single most valuable navigation aid once the
  // playable area is ten times larger than it was.
  _updateWaypoint(player) {
    const el = this.waypointEl;
    if (!el) return;
    if (!this.markers.length || this.ctx.paused || this.ctx.gameOver || player.dead) {
      el.style.display = 'none';
      return;
    }

    // Track the nearest marker.
    let target = this.markers[0];
    let bestD = Infinity;
    for (const m of this.markers) {
      const d = m.position.distanceToSquared(player.position);
      if (d < bestD) { bestD = d; target = m; }
    }

    const cam = this.ctx.camera;
    const v = scratch.v0.copy(target.position);
    v.y += 1.6;
    v.project(cam);

    const dist = Math.sqrt(bestD);
    const behind = v.z > 1;
    const w = window.innerWidth, h = window.innerHeight;
    let x = (v.x * 0.5 + 0.5) * w;
    let y = (-v.y * 0.5 + 0.5) * h;

    if (behind) {
      // Mirror it to the correct edge so an off-screen objective still reads.
      x = w - x;
      y = h * 0.5 + (y - h * 0.5) * 0.2 + h * 0.3;
    }

    const margin = 60;
    const clamped = x < margin || x > w - margin || y < margin || y > h - margin || behind;
    x = clamp(x, margin, w - margin);
    y = clamp(y, margin, h - margin);

    el.style.display = 'block';
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    el.classList.toggle('offscreen', clamped);
    el.querySelector('.wp-label').textContent = target.label || 'Objective';
    el.querySelector('.wp-dist').textContent = `${Math.round(dist)}m`;
  }

  _respawn() {
    const player = this.ctx.get('player');
    const world = this.ctx.get('world');
    const weapons = this.ctx.get('weapons');
    const ai = this.ctx.get('ai');

    // Respawn at the start of the current stage rather than the map origin, so
    // a death costs the stage, not the run.
    const districtKey = this.stage ? this.stage.district : 'landing';
    const D = DISTRICTS[districtKey];
    const spawn = districtKey === 'landing'
      ? world.spawns.player.clone()
      : new THREE.Vector3(D.x, D.y + 1.8, D.z + D.d / 2 - 4);

    player.respawn(spawn);
    weapons.reset();

    // Reset the squad's awareness so you are not spawned into an active
    // firefight you cannot see.
    for (const a of ai.actors) {
      a.awareness = 0;
      a.state = a.patrolRoute ? 'patrol' : 'idle';
      a.path = null;
      a.burstLeft = 0;
      a.telegraphing = false;
    }
  }
}

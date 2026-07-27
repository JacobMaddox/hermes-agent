import * as THREE from 'three';
import { scratch } from '../core/loop.js';
import { clamp, lerp, damp, smoothstep } from '../core/rng.js';
import { NavGrid } from './navgrid.js';
import { buildDrone, ARCHETYPES } from './drone.js';
import { raySphere } from '../weapons/weapons.js';

// Enemy AI.
//
// Round 1's drones checked `distance < 17` and fired every 1.15s with perfect
// aim, through walls, with no warning. These have a real perception model — a
// forward vision cone, a raycast line-of-sight test, hearing that responds to
// gunfire — and an alert state machine with a visible telegraph before every
// burst, so incoming fire is always something you had a chance to react to.
//
// Pathing is A* over the baked navigation grid, re-planned on a stagger so the
// whole squad never re-plans on the same frame.

const STATE = {
  IDLE: 'idle',
  PATROL: 'patrol',
  SUSPICIOUS: 'suspicious',
  COMBAT: 'combat',
  COVER: 'cover',
  SEARCH: 'search',
  DEAD: 'dead'
};

const FOV_COS = Math.cos(THREE.MathUtils.degToRad(62));
const PERIPHERAL_COS = Math.cos(THREE.MathUtils.degToRad(105));
const AWARE_RATE = 2.3;
const FORGET_RATE = 0.42;
const HEAR_RADIUS = 46;
const REPLAN_INTERVAL = 0.55;
const HOVER_HEIGHT = 1.35;

export class AiSystem {
  constructor() {
    this.actors = [];
    this.nav = null;
    this._replanCursor = 0;
    this._alertLevel = 0;
    this._sharedTargetT = 0;
    this._lastKnownPlayer = new THREE.Vector3();
    this._hasLastKnown = false;
  }

  async init() {
    this.group = new THREE.Group();
    this.group.name = 'actors';
    this.ctx.scene.add(this.group);
  }

  async ready() {
    const phys = this.ctx.get('physics');
    this.nav = new NavGrid(phys);
    const walkable = this.nav.bake((p) => {
      if (this.ctx.onProgress) this.ctx.onProgress(p, 'Charting patrol routes');
    });
    console.info(`[ai] navigation grid baked: ${walkable} walkable cells ` +
      `(${this.nav.cols}x${this.nav.rows} @ ${1.25}m)`);

    this.ctx.bus.on('weapon:fire', (e) => this.onNoise(e.position || e.origin, 1.0));
    this.ctx.bus.on('explosion', (e) => this.onNoise(e.point, 1.6));
    this.ctx.bus.on('player:land', (e) => {
      if (e.impactSpeed > 9) this.onNoise(this.ctx.get('player').position, 0.45);
    });
  }

  // ── Spawning ──────────────────────────────────────────────────────────

  spawnSquad(spec) {
    const mats = this.ctx.get('materials');
    const rng = this.ctx.rng;
    const spawned = [];

    for (let i = 0; i < spec.points.length && i < spec.count; i++) {
      const type = spec.types[i % spec.types.length];
      const A = ARCHETYPES[type];
      const rig = buildDrone(type, mats);
      const p = spec.points[i];

      const ground = this.ctx.get('physics').groundAt(p.x, p.z, p.y + 4, 8);
      const baseY = ground ? ground.y : p.y;

      rig.group.position.set(p.x, baseY + HOVER_HEIGHT, p.z);
      this.group.add(rig.group);

      const actor = {
        id: this.actors.length,
        type, rig, archetype: A,
        mesh: rig.group,
        position: rig.group.position,
        velocity: new THREE.Vector3(),
        hp: A.hp, maxHp: A.hp,
        alive: true,
        state: spec.state || STATE.PATROL,
        district: spec.district,

        awareness: 0,
        canSee: false,
        lastSeen: -99,
        target: new THREE.Vector3(),
        facing: rng.range(0, Math.PI * 2),
        desiredFacing: 0,

        path: null, pathIndex: 0, replanT: rng.range(0, REPLAN_INTERVAL),
        destination: null,
        patrolRoute: spec.patrol ? spec.patrol.map((v) => v.clone()) : null,
        patrolIndex: 0,
        homePos: new THREE.Vector3(p.x, baseY + HOVER_HEIGHT, p.z),

        fireT: rng.range(0, 1.5),
        burstLeft: 0,
        telegraphT: 0,
        telegraphing: false,
        coverPoint: null,
        strafeDir: rng.bool() ? 1 : -1,
        strafeT: 0,
        bobPhase: rng.range(0, Math.PI * 2),
        hitFlash: 0,
        deathT: 0,
        rng: rng.fork(0x100 + this.actors.length)
      };

      this.actors.push(actor);
      spawned.push(actor);
    }
    return spawned;
  }

  clearActors() {
    for (const a of this.actors) this.group.remove(a.mesh);
    this.actors.length = 0;
    this._alertLevel = 0;
    this._hasLastKnown = false;
  }

  get aliveCount() {
    let n = 0;
    for (const a of this.actors) if (a.alive) n++;
    return n;
  }

  aliveInDistrict(district) {
    let n = 0;
    for (const a of this.actors) if (a.alive && a.district === district) n++;
    return n;
  }

  // ── Perception ────────────────────────────────────────────────────────

  onNoise(position, strength) {
    if (!position) return;
    for (const a of this.actors) {
      if (!a.alive) continue;
      const d = a.position.distanceTo(position);
      if (d > HEAR_RADIUS * strength) continue;
      // Hearing raises awareness and points them at the sound, but does not by
      // itself grant a target — they have to look and confirm.
      const gain = (1 - d / (HEAR_RADIUS * strength)) * 0.55 * strength;
      a.awareness = Math.min(1, a.awareness + gain);
      if (a.state === STATE.IDLE || a.state === STATE.PATROL) {
        a.state = STATE.SUSPICIOUS;
        a.target.copy(position);
        a.destination = null;
      }
    }
  }

  _updatePerception(actor, dt, player) {
    const eye = scratch.v0.copy(actor.position);
    const toPlayer = scratch.v1.copy(player.eyePosition).sub(eye);
    const dist = toPlayer.length();
    const A = actor.archetype;

    actor.canSee = false;
    if (player.dead || dist > A.range * 1.35) {
      actor.awareness = Math.max(0, actor.awareness - FORGET_RATE * dt);
      return dist;
    }

    toPlayer.multiplyScalar(1 / dist);
    const fwd = scratch.v2.set(Math.sin(actor.facing), 0, Math.cos(actor.facing));
    const dot = fwd.x * toPlayer.x + fwd.z * toPlayer.z;

    // Full vision inside the cone; degraded but real awareness in the
    // periphery; nothing behind. Very close range is always noticed.
    let coneFactor = 0;
    if (dot > FOV_COS) coneFactor = 1;
    else if (dot > PERIPHERAL_COS) coneFactor = 0.35;
    if (dist < 6) coneFactor = Math.max(coneFactor, 0.8);
    if (coneFactor <= 0) {
      actor.awareness = Math.max(0, actor.awareness - FORGET_RATE * dt);
      return dist;
    }

    if (!this.ctx.get('physics').lineOfSight(eye, player.eyePosition, 0.3)) {
      actor.awareness = Math.max(0, actor.awareness - FORGET_RATE * dt * 0.7);
      return dist;
    }

    actor.canSee = true;
    actor.lastSeen = this.ctx.time.elapsed;
    this._lastKnownPlayer.copy(player.position);
    this._hasLastKnown = true;

    // Spotting is faster up close and slower against a crouched target.
    const distFactor = clamp(1.4 - dist / A.range, 0.25, 1.4);
    const stealth = player.isCrouched ? 0.62 : 1;
    const speedBonus = clamp(player.speed / 9, 0, 1) * 0.5 + 0.75;
    actor.awareness = Math.min(1,
      actor.awareness + AWARE_RATE * dt * coneFactor * distFactor * stealth * speedBonus);
    actor.target.copy(player.eyePosition);
    return dist;
  }

  // Squad awareness: once one drone is certain, its neighbours get pulled up
  // toward suspicion. This is what makes a group read as a group.
  _shareAwareness(dt) {
    this._sharedTargetT -= dt;
    if (this._sharedTargetT > 0) return;
    this._sharedTargetT = 0.4;

    let maxAware = 0;
    let source = null;
    for (const a of this.actors) {
      if (a.alive && a.awareness > maxAware) { maxAware = a.awareness; source = a; }
    }
    this._alertLevel = maxAware;
    if (!source || maxAware < 0.98) return;

    for (const a of this.actors) {
      if (!a.alive || a === source) continue;
      if (a.position.distanceTo(source.position) > 38) continue;
      if (a.awareness < 0.7) {
        a.awareness = Math.min(0.85, a.awareness + 0.3);
        if (a.state === STATE.IDLE || a.state === STATE.PATROL) {
          a.state = STATE.SUSPICIOUS;
          a.target.copy(source.target);
          a.destination = null;
        }
      }
    }
  }

  // ── Behaviour ─────────────────────────────────────────────────────────

  fixedUpdate(step) {
    const player = this.ctx.get('player');
    if (this.ctx.gameOver) return;

    this._shareAwareness(step);

    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      if (!a.alive) continue;
      const dist = this._updatePerception(a, step, player);
      this._think(a, step, player, dist);
      this._move(a, step);
      this._shoot(a, step, player, dist);
    }
  }

  _think(a, dt, player, dist) {
    const A = a.archetype;

    switch (a.state) {
      case STATE.IDLE:
      case STATE.PATROL:
        if (a.awareness >= 1) this._enterCombat(a);
        else if (a.awareness > 0.35) a.state = STATE.SUSPICIOUS;
        else this._patrol(a);
        break;

      case STATE.SUSPICIOUS:
        if (a.awareness >= 1) { this._enterCombat(a); break; }
        if (a.awareness <= 0.05) {
          a.state = a.patrolRoute ? STATE.PATROL : STATE.IDLE;
          a.destination = null;
          break;
        }
        // Move toward whatever drew their attention, looking as they go.
        if (!a.destination || a.destination.distanceTo(a.target) > 4) {
          a.destination = a.target.clone();
          a.path = null;
        }
        break;

      case STATE.COMBAT:
        if (a.canSee) {
          a.searchT = 0;
          this._combatPositioning(a, player, dist);
          // Hurt or exposed drones break for cover, weighted by aggression.
          const hurt = 1 - a.hp / a.maxHp;
          if (a.rng.next() < (hurt * 0.9 + 0.05) * (1 - A.aggression) * dt * 3) {
            const cover = this._findCover(a, player);
            if (cover) { a.coverPoint = cover; a.state = STATE.COVER; a.path = null; }
          }
        } else if (this.ctx.time.elapsed - a.lastSeen > 2.2) {
          a.state = STATE.SEARCH;
          a.searchT = 6.5;
          a.destination = this._hasLastKnown ? this._lastKnownPlayer.clone() : a.target.clone();
          a.path = null;
        }
        break;

      case STATE.COVER: {
        if (!a.coverPoint) { a.state = STATE.COMBAT; break; }
        a.destination = a.coverPoint;
        const atCover = a.position.distanceTo(a.coverPoint) < 1.6;
        if (atCover) {
          a.coverT = (a.coverT || 0) + dt;
          // Pop out once healed enough or after a beat — camping forever is
          // the least interesting thing an AI can do.
          if (a.coverT > 1.6 + a.rng.range(0, 1.4)) {
            a.coverT = 0;
            a.coverPoint = null;
            a.state = STATE.COMBAT;
          }
        }
        if (a.awareness <= 0.1) { a.state = STATE.SEARCH; a.searchT = 4; }
        break;
      }

      case STATE.SEARCH:
        a.searchT -= dt;
        if (a.awareness >= 1) { this._enterCombat(a); break; }
        if (a.searchT <= 0) {
          a.state = a.patrolRoute ? STATE.PATROL : STATE.IDLE;
          a.destination = a.patrolRoute ? null : a.homePos.clone();
          a.path = null;
          break;
        }
        // Sweep outward from the last known position.
        if (!a.destination || a.position.distanceTo(a.destination) < 2) {
          const ang = a.rng.range(0, Math.PI * 2);
          const r = a.rng.range(4, 12);
          const base = this._hasLastKnown ? this._lastKnownPlayer : a.homePos;
          a.destination = new THREE.Vector3(
            base.x + Math.cos(ang) * r, base.y, base.z + Math.sin(ang) * r
          );
          a.path = null;
        }
        break;
    }
  }

  _enterCombat(a) {
    if (a.state !== STATE.COMBAT) {
      a.state = STATE.COMBAT;
      a.path = null;
      a.coverT = 0;
      // A short hesitation on first contact, so you are not shot the instant
      // you round a corner.
      a.fireT = Math.max(a.fireT, a.archetype.telegraph * 1.4);
      this.ctx.bus.emit('ai:alerted', { actor: a });
    }
  }

  _patrol(a) {
    if (!a.patrolRoute || a.patrolRoute.length === 0) {
      a.destination = a.homePos;
      return;
    }
    const wp = a.patrolRoute[a.patrolIndex];
    if (a.position.distanceTo(wp) < 2.2) {
      a.patrolIndex = (a.patrolIndex + 1) % a.patrolRoute.length;
      a.path = null;
    }
    a.destination = a.patrolRoute[a.patrolIndex];
  }

  // Hold the archetype's preferred range and strafe, rather than walking into
  // the player's face like round 1's waypoint chasers.
  _combatPositioning(a, player, dist) {
    const A = a.archetype;
    a.strafeT -= 1 / 60;
    if (a.strafeT <= 0) {
      a.strafeT = a.rng.range(1.1, 2.6);
      if (a.rng.bool(0.45)) a.strafeDir *= -1;
    }

    const toPlayer = scratch.v3.subVectors(player.position, a.position).setY(0);
    const d = toPlayer.length() || 1;
    toPlayer.multiplyScalar(1 / d);
    const right = scratch.v4.set(-toPlayer.z, 0, toPlayer.x);

    // Sentries barely reposition; skirmishers and heavies close and circle.
    const rangeError = dist - A.preferredRange;
    const advance = clamp(rangeError / 12, -1, 1) * A.aggression;
    const strafe = a.strafeDir * (0.7 + A.aggression * 0.5);

    const dest = scratch.v5.copy(a.position)
      .addScaledVector(toPlayer, advance * 7)
      .addScaledVector(right, strafe * 6);

    if (!a.destination) a.destination = new THREE.Vector3();
    // Only re-target when the desired spot has moved meaningfully, so the path
    // is not thrown away every frame.
    if (a.destination.distanceToSquared(dest) > 9) {
      a.destination.copy(dest);
      a.path = null;
    }
  }

  // Score nearby cover cells: close to us, breaking line of sight to the
  // player, and not directly behind them.
  _findCover(a, player) {
    const nav = this.nav;
    const phys = this.ctx.get('physics');
    const world = this.ctx.get('world');
    let best = null;
    let bestScore = -Infinity;

    const cx = Math.floor((a.position.x - nav.minX) / 1.25);
    const cz = Math.floor((a.position.z - nav.minZ) / 1.25);
    const R = 10;

    for (let dz = -R; dz <= R; dz += 2) {
      for (let dx = -R; dx <= R; dx += 2) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= nav.cols || nz >= nav.rows) continue;
        const i = nav.index(nx, nz);
        if (!nav.walkable[i]) continue;

        const px = nav.worldX(i);
        const pz = nav.worldZ(i);
        const py = nav.height[i] + HOVER_HEIGHT;
        const test = scratch.v0.set(px, py - 0.55, pz);
        // Cover only counts if the player cannot see the crouched position.
        if (phys.lineOfSight(test, player.eyePosition, 0.25)) continue;

        const distToMe = Math.hypot(px - a.position.x, pz - a.position.z);
        const distToPlayer = Math.hypot(px - player.position.x, pz - player.position.z);
        const score = -distToMe * 1.4
          + clamp(distToPlayer, 0, a.archetype.preferredRange) * 0.8
          - Math.max(0, 8 - distToPlayer) * 3;
        if (score > bestScore) {
          bestScore = score;
          best = new THREE.Vector3(px, py, pz);
        }
      }
    }
    return best;
  }

  // ── Movement ──────────────────────────────────────────────────────────

  _move(a, dt) {
    const A = a.archetype;
    a.replanT -= dt;

    if (a.destination && (!a.path || a.replanT <= 0)) {
      // Stagger re-planning across the squad so a dozen A* queries never land
      // on the same frame.
      a.replanT = REPLAN_INTERVAL + a.rng.range(0, 0.35);
      const path = this.nav.findPath(
        a.position.x, a.position.z, a.destination.x, a.destination.z
      );
      if (path && path.length) {
        a.path = path;
        a.pathIndex = 0;
      } else {
        a.path = null;
      }
    }

    let moveDir = null;
    if (a.path && a.pathIndex < a.path.length) {
      const wp = a.path[a.pathIndex];
      const dx = wp.x - a.position.x;
      const dz = wp.z - a.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.1) {
        a.pathIndex++;
      } else {
        moveDir = scratch.v0.set(dx / d, 0, dz / d);
      }
      if (a.pathIndex >= a.path.length) a.path = null;
    }

    const speed = a.state === STATE.SUSPICIOUS ? A.speed * 0.55 : A.speed;
    if (moveDir) {
      a.velocity.x = damp(a.velocity.x, moveDir.x * speed, 4.5, dt);
      a.velocity.z = damp(a.velocity.z, moveDir.z * speed, 4.5, dt);
    } else {
      a.velocity.x = damp(a.velocity.x, 0, 6, dt);
      a.velocity.z = damp(a.velocity.z, 0, 6, dt);
    }

    a.position.x += a.velocity.x * dt;
    a.position.z += a.velocity.z * dt;

    // Hover: settle toward a fixed height above whatever is below, so they
    // follow stairs and ramps smoothly instead of clipping through them.
    const ground = this.ctx.get('physics').groundAt(
      a.position.x, a.position.z, a.position.y + 3, 12
    );
    const targetY = (ground ? ground.y : a.position.y - HOVER_HEIGHT) + HOVER_HEIGHT;
    a.position.y = damp(a.position.y, targetY, 5.5, dt);

    // Facing: look where you are going, unless you have a target.
    if (a.state === STATE.COMBAT || a.state === STATE.COVER) {
      a.desiredFacing = Math.atan2(a.target.x - a.position.x, a.target.z - a.position.z);
    } else if (a.state === STATE.SUSPICIOUS || a.state === STATE.SEARCH) {
      a.desiredFacing = Math.atan2(a.target.x - a.position.x, a.target.z - a.position.z);
    } else if (moveDir) {
      a.desiredFacing = Math.atan2(moveDir.x, moveDir.z);
    }
    // Shortest-arc turn.
    let diff = a.desiredFacing - a.facing;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    a.facing += diff * (1 - Math.exp(-(a.state === STATE.COMBAT ? 7 : 3.4) * dt));
  }

  // ── Combat ────────────────────────────────────────────────────────────

  _shoot(a, dt, player, dist) {
    const A = a.archetype;
    if (a.state !== STATE.COMBAT && a.state !== STATE.COVER) {
      a.telegraphing = false;
      a.burstLeft = 0;
      return;
    }
    if (!a.canSee || player.dead || dist > A.range) {
      a.telegraphing = false;
      return;
    }

    a.fireT -= dt;

    // Telegraph: the drone's emissives spool up before a burst. This is the
    // single biggest fairness fix over round 1, where fire arrived with no
    // warning at all.
    if (!a.telegraphing && a.burstLeft <= 0 && a.fireT <= A.telegraph) {
      a.telegraphing = true;
      a.telegraphT = 0;
      this.ctx.bus.emit('ai:telegraph', { actor: a });
    }
    if (a.telegraphing) a.telegraphT += dt;

    if (a.fireT > 0) return;

    if (a.burstLeft <= 0) {
      a.burstLeft = A.burst;
      a.telegraphing = false;
    }

    this._fireShot(a, player, dist);
    a.burstLeft--;
    a.fireT = a.burstLeft > 0 ? A.fireRate : A.burstGap + a.rng.range(0, 0.5);
  }

  _fireShot(a, player, dist) {
    const A = a.archetype;
    const rng = a.rng;
    const muzzleLocal = a.rig.muzzles[a._muzzleIdx = ((a._muzzleIdx || 0) + 1) % a.rig.muzzles.length];
    const origin = scratch.v0.copy(muzzleLocal).applyQuaternion(a.mesh.quaternion).add(a.position);

    const aimAt = scratch.v1.copy(player.eyePosition);
    // Lead the target a little, and aim at centre mass rather than the head.
    aimAt.y -= 0.28;
    aimAt.addScaledVector(player.velocity, 0.06 * A.accuracy);

    const dir = scratch.v2.subVectors(aimAt, origin).normalize();

    // Inaccuracy grows with range and with how much the target is moving.
    const moveFactor = 1 + clamp(player.speed / 9, 0, 1) * 0.85;
    const distFactor = 0.5 + dist / A.range;
    const spread = (1 - A.accuracy) * 0.075 * moveFactor * distFactor;
    dir.x += rng.gaussian() * spread;
    dir.y += rng.gaussian() * spread;
    dir.z += rng.gaussian() * spread;
    dir.normalize();

    const phys = this.ctx.get('physics');
    const worldHit = phys.raycast(origin, dir, A.range);
    const worldDist = worldHit.hit ? worldHit.distance : A.range;

    // Did the shot actually pass through the player capsule?
    const playerCentre = scratch.v3.copy(player.position);
    playerCentre.y += player.height * 0.55;
    const pHit = raySphere(origin, dir, playerCentre, 0.55, worldDist);

    const fx = this.ctx.get('fx');
    const end = scratch.v4;
    if (pHit !== null) {
      end.copy(origin).addScaledVector(dir, pHit);
      player.damage(A.damage, a.position, 'hit');
      fx.impact(end, scratch.v5.copy(dir).negate(), 'flesh', false);
    } else if (worldHit.hit) {
      end.copy(worldHit.point);
      this.ctx.bus.emit('bullet:impact', {
        point: worldHit.point.clone(), normal: worldHit.normal.clone(),
        surface: worldHit.surface, damage: 0, fromPlayer: false
      });
    } else {
      end.copy(origin).addScaledVector(dir, A.range);
    }

    fx.addTracer(origin, end, 260, 1.5);
    // Hostile tracers are red so you can read incoming fire at a glance.
    this.ctx.bus.emit('ai:fire', { actor: a, origin: origin.clone(), position: origin.clone() });
    a._flashT = 0.06;
  }

  // ── Damage ────────────────────────────────────────────────────────────

  // Hitbox ray test used by the weapon system. Returns the nearest actor hit.
  raycastActors(origin, dir, maxDist) {
    let best = null;
    for (const a of this.actors) {
      if (!a.alive) continue;
      // Cheap reject before testing individual hitboxes.
      const rough = raySphere(origin, dir, a.position, 1.6 * a.archetype.scale, maxDist);
      if (rough === null) continue;

      for (const hb of a.rig.hitboxes) {
        const centre = scratch.v0.copy(hb.offset).applyQuaternion(a.mesh.quaternion).add(a.position);
        const t = raySphere(origin, dir, centre, hb.radius, maxDist);
        if (t === null) continue;
        if (!best || t < best.distance) {
          best = {
            actor: a, distance: t, headshot: hb.headshot, box: hb.name,
            point: new THREE.Vector3().copy(origin).addScaledVector(dir, t)
          };
        }
      }
    }
    return best;
  }

  damageActor(actor, amount, point, headshot, dir) {
    if (!actor.alive) return;
    actor.hp -= amount;
    actor.hitFlash = 1;

    // Being shot at is information: an unaware drone snaps to alert and looks
    // back along the incoming round.
    actor.awareness = 1;
    if (dir) {
      actor.target.copy(point).addScaledVector(dir, -12);
    }
    if (actor.state !== STATE.COMBAT && actor.state !== STATE.COVER) this._enterCombat(actor);

    this.ctx.bus.emit('damage:dealt', {
      target: actor, amount, point: point.clone(), headshot, fromPlayer: true
    });

    if (actor.hp <= 0) this._kill(actor, point, headshot);
  }

  _kill(actor, point, headshot) {
    actor.alive = false;
    actor.state = STATE.DEAD;
    actor.hp = 0;
    const player = this.ctx.get('player');
    player.stats.kills++;

    this.ctx.bus.emit('actor:death', {
      actor, point: point ? point.clone() : actor.position.clone(),
      headshot, fromPlayer: true, label: actor.archetype.label
    });

    // The chassis falls out of the sky rather than vanishing. Its emissives go
    // dark; the materials are already per-drone clones, so this cannot affect
    // anything still alive.
    this.group.remove(actor.mesh);
    const phys = this.ctx.get('physics');
    actor.rig.eyeMat.emissiveIntensity = 0;
    actor.rig.jetMat.emissiveIntensity = 0;
    phys.spawnDebris(
      actor.mesh, actor.position,
      new THREE.Vector3(this.ctx.rng.spread(3), 1.5, this.ctx.rng.spread(3)),
      { life: 7, radius: 0.6 * actor.archetype.scale, bounce: 0.18, friction: 0.5 }
    );
  }

  // ── Presentation ──────────────────────────────────────────────────────

  update(dt) {
    const t = this.ctx.time.elapsed;
    for (const a of this.actors) {
      if (!a.alive) continue;

      a.mesh.position.copy(a.position);
      // Hover bob, plus bank into lateral velocity — the two cues that make a
      // floating chassis look like it is actually flying.
      a.bobPhase += dt * 2.4;
      a.mesh.position.y += Math.sin(a.bobPhase) * 0.06;
      a.mesh.rotation.y = a.facing;

      const speed = Math.hypot(a.velocity.x, a.velocity.z);
      const fwd = scratch.v0.set(Math.sin(a.facing), 0, Math.cos(a.facing));
      const right = scratch.v1.set(fwd.z, 0, -fwd.x);
      const lateral = a.velocity.x * right.x + a.velocity.z * right.z;
      const forward = a.velocity.x * fwd.x + a.velocity.z * fwd.z;
      a.rig.chassis.rotation.z = damp(a.rig.chassis.rotation.z,
        clamp(lateral / a.archetype.speed, -1, 1) * 0.3, 5, dt);
      a.rig.chassis.rotation.x = damp(a.rig.chassis.rotation.x,
        clamp(-forward / a.archetype.speed, -1, 1) * 0.16, 5, dt);

      // Thruster glow tracks throttle. One merged mesh per drone, so this is a
      // single material write rather than one per nozzle.
      const throttle = 0.4 + clamp(speed / a.archetype.speed, 0, 1) * 0.9;
      a.rig.jetMat.emissiveIntensity = throttle * 2.4;

      // Eye emissive: dim while idle, bright in combat, pulsing hard through a
      // firing telegraph.
      let eyeIntensity = 1.2;
      if (a.state === STATE.SUSPICIOUS || a.state === STATE.SEARCH) eyeIntensity = 2.4;
      if (a.state === STATE.COMBAT || a.state === STATE.COVER) eyeIntensity = 3.4;
      if (a.telegraphing) {
        const k = clamp(a.telegraphT / Math.max(0.01, a.archetype.telegraph), 0, 1);
        eyeIntensity = 3.4 + k * 9 + Math.sin(t * 42) * k * 4;
      }
      if (a._flashT > 0) {
        a._flashT -= dt;
        eyeIntensity += 6;
      }
      if (a.hitFlash > 0) {
        a.hitFlash = Math.max(0, a.hitFlash - dt * 4);
        eyeIntensity += a.hitFlash * 5;
      }
      a.rig.eyeMat.emissiveIntensity = eyeIntensity;
    }
  }

  get alertLevel() {
    return this._alertLevel;
  }

  reset() {
    this.clearActors();
  }
}

export { STATE as AI_STATE };

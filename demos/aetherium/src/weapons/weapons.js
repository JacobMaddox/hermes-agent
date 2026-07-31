import * as THREE from 'three';
import { scratch } from '../core/loop.js';
import { clamp, lerp, damp, smoothstep } from '../core/rng.js';
import { buildRifle } from './rifle.js';
import { VIEWMODEL_FOV_HIP, VIEWMODEL_FOV_ADS } from '../render/render.js';

// Weapons and ballistics.
//
// Round 1 fired 58 m/s glowing spheres and checked each one against a single
// point per enemy. That is why it felt imprecise and laggy. This is hitscan
// with real hitboxes and headshot multipliers, a deterministic recoil pattern,
// separate hip and aimed spread, a full reload cycle, and a viewmodel rig that
// animates all of it.

export const WEAPON = {
  name: 'Kestrel Carbine',
  damage: 26,
  headshotMult: 2.3,
  rpm: 620,
  magSize: 30,
  reserveMax: 210,
  reloadTime: 2.15,
  reloadEmptyTime: 2.75,
  range: 220,
  // Damage falls off past this distance, down to falloffMin at max range.
  falloffStart: 45,
  falloffMin: 0.55,

  hipSpread: 0.032,
  adsSpread: 0.0035,
  moveSpreadScale: 1.9,
  airSpreadScale: 2.6,

  recoilPitch: 0.0125,
  recoilYaw: 0.0042,
  recoilKick: 0.055,
  recoilRoll: 0.03,

  adsTime: 0.14,
  swapTime: 0.5,
  // Time to bring the weapon back on target after sprinting. Without it you
  // can fire accurately out of a full sprint, which removes any cost from
  // running everywhere.
  sprintRaiseTime: 0.22
};

// Deterministic recoil pattern: a repeatable climb with a horizontal S-curve,
// so a skilled player can learn to pull down through it. Random spray is what
// makes a shooter feel arbitrary.
const RECOIL_PATTERN = [
  [0.0, 1.0], [0.08, 1.0], [-0.05, 0.98], [0.14, 0.94], [0.22, 0.9],
  [0.1, 0.86], [-0.16, 0.82], [-0.28, 0.8], [-0.22, 0.78], [-0.05, 0.76],
  [0.18, 0.74], [0.32, 0.72], [0.28, 0.7], [0.1, 0.68], [-0.14, 0.66],
  [-0.3, 0.64], [-0.36, 0.62], [-0.24, 0.6], [-0.06, 0.6], [0.16, 0.58]
];

const HIP = new THREE.Vector3(0.135, -0.115, -0.19);
const SPRINT_POS = new THREE.Vector3(0.19, -0.16, -0.12);

export class WeaponSystem {
  constructor() {
    this.ammo = WEAPON.magSize;
    this.reserve = 120;
    this.reloading = false;
    this._reloadT = 0;
    this._reloadWasEmpty = false;
    this._cooldown = 0;
    this._shotIndex = 0;
    this._triggerHeld = false;
    this._adsT = 0;
    this._swayPos = new THREE.Vector2();
    this._swayTarget = new THREE.Vector2();
    this._kick = 0;
    this._kickRot = 0;
    this._bobPhase = 0;
    this._lastYaw = 0;
    this._lastPitch = 0;
    this._hitMarkerT = 0;
    this._lastHitWasKill = false;
    this._shells = [];
    this._raiseT = 0;
    this._wasSprinting = false;
  }

  async init() {
    const mats = this.ctx.get('materials');
    const rig = buildRifle(mats);
    this.rig = rig;
    this.group = new THREE.Group();
    this.group.add(rig.group);
    this.ctx.camera.add(this.group);
    this.group.position.copy(HIP);

    // Where the aim point must land in camera space when fully aimed.
    //
    // Dead centre, and that is not a style choice: shots leave from the camera
    // axis, so if the optic sits anywhere else the reticle lies about where
    // the round goes. The previous -0.028 put it 6.7 degrees low. Pushed a
    // little further out than before so the receiver covers less of the frame.
    this._adsTarget = new THREE.Vector3(0, 0, -0.30);

    this._buildShellPool();
  }

  async ready() {
    document.addEventListener('mousedown', (e) => {
      if (!this._active()) return;
      if (e.button === 0) this._triggerHeld = true;
      if (e.button === 2) this.ctx.get('player').setAds(true);
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this._triggerHeld = false;
      if (e.button === 2) this.ctx.get('player').setAds(false);
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('keydown', (e) => {
      if (!this._active()) return;
      if (e.code === 'KeyR') this.startReload();
    });
    // Never leave the trigger latched when focus leaves the window.
    window.addEventListener('blur', () => {
      this._triggerHeld = false;
      const p = this.ctx.tryGet('player');
      if (p) p.setAds(false);
    });
  }

  _active() {
    const p = this.ctx.get('player');
    return p.locked && !this.ctx.paused && !p.dead && !this.ctx.gameOver;
  }

  _buildShellPool() {
    const geo = new THREE.CylinderGeometry(0.008, 0.0085, 0.032, 6);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xd8b26a, metalness: 0.95, roughness: 0.3
    });
    this._shellGeo = geo;
    this._shellMat = mat;
  }

  // ── Firing ────────────────────────────────────────────────────────────

  fire() {
    const player = this.ctx.get('player');
    if (this.reloading || this._cooldown > 0) return;
    // The weapon is stowed across the body while sprinting; it has to come up
    // before it can fire.
    if (this._raiseT > 0) return;
    if (this.ammo <= 0) {
      this.ctx.bus.emit('weapon:dryfire', {});
      this._cooldown = 0.22;
      if (this.reserve > 0) this.startReload();
      return;
    }

    this.ammo--;
    this._cooldown = 60 / WEAPON.rpm;
    player.stats.shotsFired++;

    const cam = this.ctx.camera;
    const origin = scratch.v0.copy(cam.position);
    const dir = cam.getWorldDirection(scratch.v1).clone();

    // Spread: tight when aimed and still, wide when hip-firing on the move or
    // in the air.
    let spread = player.ads ? WEAPON.adsSpread : WEAPON.hipSpread;
    const speedFactor = clamp(player.speed / 9, 0, 1);
    spread *= 1 + speedFactor * (WEAPON.moveSpreadScale - 1);
    if (!player.grounded) spread *= WEAPON.airSpreadScale;
    if (player.isCrouched) spread *= 0.7;

    if (spread > 0.0001) {
      const rng = this.ctx.rng;
      const right = scratch.v2.set(1, 0, 0).applyQuaternion(cam.quaternion);
      const up = scratch.v3.set(0, 1, 0).applyQuaternion(cam.quaternion);
      dir.addScaledVector(right, rng.gaussian() * spread)
        .addScaledVector(up, rng.gaussian() * spread)
        .normalize();
    }

    this._resolveShot(origin, dir);
    this._applyRecoil(player);
    this._ejectShell();

    // The flash quad parents to the muzzle so it tracks the barrel exactly;
    // the flash light needs a world position.
    const muzzleWorld = this.rig.muzzleTip.getWorldPosition(scratch.v4);
    this.ctx.get('fx').muzzleFlash(muzzleWorld, this.rig.muzzleTip, player.ads ? 0.55 : 0.85);

    this.ctx.bus.emit('weapon:fire', {
      origin: origin.clone(), dir: dir.clone(), position: muzzleWorld.clone(), ads: player.ads
    });

    this._shotIndex++;
    if (this.ammo === 0) this.ctx.bus.emit('weapon:empty', {});
  }

  _resolveShot(origin, dir) {
    const phys = this.ctx.get('physics');
    const ai = this.ctx.get('ai');
    const world = this.ctx.get('world');
    const player = this.ctx.get('player');

    const worldHit = phys.raycast(origin, dir, WEAPON.range);
    const worldDist = worldHit.hit ? worldHit.distance : WEAPON.range;

    const actorHit = ai.raycastActors(origin, dir, worldDist);
    const beaconHit = this._raycastBeacons(world, origin, dir, worldDist);

    // Nearest of the three wins.
    let end = scratch.v2;
    if (actorHit && (!beaconHit || actorHit.distance <= beaconHit.distance)) {
      end.copy(actorHit.point);
      const falloff = this._falloff(actorHit.distance);
      const dmg = WEAPON.damage * falloff * (actorHit.headshot ? WEAPON.headshotMult : 1);
      player.stats.shotsHit++;
      if (actorHit.headshot) player.stats.headshots++;
      ai.damageActor(actorHit.actor, dmg, end, actorHit.headshot, dir);
      this.ctx.bus.emit('bullet:impact', {
        point: end.clone(), normal: dir.clone().negate(), surface: 'flesh',
        damage: dmg, fromPlayer: true
      });
      this._hitMarkerT = 0.3;
      this._lastHitWasKill = !actorHit.actor.alive;
      this.ctx.bus.emit('weapon:hitmarker', {
        headshot: actorHit.headshot, kill: !actorHit.actor.alive
      });
    } else if (beaconHit) {
      end.copy(beaconHit.point);
      const dmg = WEAPON.damage * this._falloff(beaconHit.distance);
      player.stats.shotsHit++;
      this._damageBeacon(beaconHit.beacon, dmg, end);
      this.ctx.bus.emit('bullet:impact', {
        point: end.clone(), normal: dir.clone().negate(), surface: 'metal',
        damage: dmg, fromPlayer: true
      });
      this._hitMarkerT = 0.3;
      this.ctx.bus.emit('weapon:hitmarker', { headshot: false, kill: !beaconHit.beacon.alive });
    } else if (worldHit.hit) {
      end.copy(worldHit.point);
      this.ctx.bus.emit('bullet:impact', {
        point: worldHit.point.clone(), normal: worldHit.normal.clone(),
        surface: worldHit.surface, damage: 0, fromPlayer: true
      });
    } else {
      end.copy(origin).addScaledVector(dir, WEAPON.range);
    }

    const muzzle = this.rig.muzzleTip.getWorldPosition(scratch.v3);
    this.ctx.get('fx').addTracer(muzzle, end, 420, 1);
  }

  _falloff(dist) {
    if (dist <= WEAPON.falloffStart) return 1;
    const t = clamp((dist - WEAPON.falloffStart) / (WEAPON.range - WEAPON.falloffStart), 0, 1);
    return lerp(1, WEAPON.falloffMin, t);
  }

  _raycastBeacons(world, origin, dir, maxDist) {
    let best = null;
    for (const b of world.beacons) {
      if (!b.alive) continue;
      const hit = raySphere(origin, dir, b.hitbox.centre, b.hitbox.radius, maxDist);
      if (hit !== null && (!best || hit < best.distance)) {
        best = {
          beacon: b, distance: hit,
          point: new THREE.Vector3().copy(origin).addScaledVector(dir, hit)
        };
      }
    }
    return best;
  }

  _damageBeacon(beacon, dmg, point) {
    beacon.hp -= dmg;
    this.ctx.get('fx').impact(point, scratch.v5.set(0, 1, 0), 'metal', true);
    if (beacon.hp <= 0 && beacon.alive) {
      this.ctx.get('world').killBeacon(beacon);
      this.ctx.bus.emit('explosion', { point: beacon.pos.clone(), radius: 3.2, damage: 0 });
      this.ctx.bus.emit('beacon:destroyed', { beacon });
    }
  }

  _applyRecoil(player) {
    const idx = Math.min(this._shotIndex, RECOIL_PATTERN.length - 1);
    const [hx, vy] = RECOIL_PATTERN[idx];
    const rng = this.ctx.rng;
    const adsScale = player.ads ? 0.62 : 1;
    // Pattern plus a small random jitter, so it is learnable but not robotic.
    const pitch = WEAPON.recoilPitch * vy * adsScale * (1 + rng.spread(0.12));
    const yaw = WEAPON.recoilYaw * hx * adsScale + rng.spread(WEAPON.recoilYaw * 0.35) * adsScale;
    player.addRecoil(pitch, yaw);
    this._kick = Math.min(1.4, this._kick + WEAPON.recoilKick * (player.ads ? 0.6 : 1) * 14);
    this._kickRot += WEAPON.recoilRoll * (rng.next() > 0.5 ? 1 : -1);
    player.addShake(player.ads ? 0.03 : 0.06);
  }

  _ejectShell() {
    const rng = this.ctx.rng;
    const mesh = new THREE.Mesh(this._shellGeo, this._shellMat);
    mesh.castShadow = true;
    const port = scratch.v0.set(0.05, 0.02, -0.03);
    this.group.localToWorld(port);
    const cam = this.ctx.camera;
    const right = scratch.v1.set(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = scratch.v2.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const player = this.ctx.get('player');
    const vel = scratch.v3
      .copy(right).multiplyScalar(rng.range(1.8, 3.2))
      .addScaledVector(up, rng.range(1.2, 2.4))
      .add(player.velocity);
    this.ctx.get('physics').spawnDebris(mesh, port, vel, {
      life: 4, radius: 0.014, bounce: 0.42, friction: 0.6
    });
  }

  // ── Reload ────────────────────────────────────────────────────────────

  startReload() {
    if (this.reloading || this.ammo >= WEAPON.magSize || this.reserve <= 0) return;
    this.reloading = true;
    this._reloadWasEmpty = this.ammo === 0;
    this._reloadT = 0;
    this.ctx.get('player').setAds(false);
    this.ctx.bus.emit('weapon:reload', { phase: 'start', empty: this._reloadWasEmpty });
  }

  _updateReload(dt) {
    if (!this.reloading) return;
    const total = this._reloadWasEmpty ? WEAPON.reloadEmptyTime : WEAPON.reloadTime;
    const prev = this._reloadT;
    this._reloadT += dt;
    const t = this._reloadT / total;

    // Phase events drive the audio and the cell animation.
    if (prev / total < 0.22 && t >= 0.22) this.ctx.bus.emit('weapon:reload', { phase: 'magout' });
    if (prev / total < 0.62 && t >= 0.62) this.ctx.bus.emit('weapon:reload', { phase: 'magin' });
    if (this._reloadWasEmpty && prev / total < 0.86 && t >= 0.86) {
      this.ctx.bus.emit('weapon:reload', { phase: 'charge' });
    }

    if (this._reloadT >= total) {
      const need = WEAPON.magSize - this.ammo;
      const take = Math.min(need, this.reserve);
      this.ammo += take;
      this.reserve -= take;
      this.reloading = false;
      this._shotIndex = 0;
      this.ctx.bus.emit('weapon:reload', { phase: 'end' });
    }
  }

  addAmmo(n) {
    const before = this.reserve;
    this.reserve = Math.min(WEAPON.reserveMax, this.reserve + n);
    return this.reserve - before;
  }

  // ── Viewmodel animation ───────────────────────────────────────────────

  update(dt) {
    const player = this.ctx.get('player');
    this._cooldown = Math.max(0, this._cooldown - dt);
    this._updateReload(dt);

    // Sprinting stows the weapon; dropping out of a sprint starts the raise.
    if (player.sprinting) {
      this._raiseT = WEAPON.sprintRaiseTime;
    } else if (this._raiseT > 0) {
      this._raiseT = Math.max(0, this._raiseT - dt);
    }

    if (this._triggerHeld && this._active()) this.fire();
    // Recoil pattern resets once you stop shooting for a beat.
    if (!this._triggerHeld && this._cooldown <= 0) {
      this._shotIndex = Math.max(0, this._shotIndex - dt * 22);
    }

    const ads = player.ads && !this.reloading && !player.sprinting;
    this._adsT = clamp(this._adsT + (ads ? dt / WEAPON.adsTime : -dt / WEAPON.adsTime), 0, 1);
    const adsE = smoothstep(0, 1, this._adsT);

    // The viewmodel zooms with the world so aiming reads as magnification.
    this.ctx.get('render').setViewmodelFov(
      lerp(VIEWMODEL_FOV_HIP, VIEWMODEL_FOV_ADS, adsE)
    );

    // Sway: the weapon lags behind fast look changes and settles back.
    const dYaw = player.yaw - this._lastYaw;
    const dPitch = player.pitch - this._lastPitch;
    this._lastYaw = player.yaw;
    this._lastPitch = player.pitch;
    this._swayTarget.x = clamp(-dYaw * 3.2, -0.06, 0.06);
    this._swayTarget.y = clamp(dPitch * 3.0, -0.05, 0.05);
    this._swayPos.x = damp(this._swayPos.x, this._swayTarget.x, 9, dt);
    this._swayPos.y = damp(this._swayPos.y, this._swayTarget.y, 9, dt);

    // Walk bob on the weapon, distinct from the camera bob so they do not
    // cancel out into stillness.
    const speedN = clamp(player.speed / 9, 0, 1);
    this._bobPhase += dt * (5.6 + player.speed * 0.7);
    const bobAmp = speedN * (1 - adsE * 0.85) * (player.grounded ? 1 : 0.25);
    const bobX = Math.sin(this._bobPhase) * 0.016 * bobAmp;
    const bobY = Math.abs(Math.cos(this._bobPhase)) * 0.012 * bobAmp;

    // Recoil kick recovers with a spring rather than a linear ramp.
    this._kick = damp(this._kick, 0, 12, dt);
    this._kickRot = damp(this._kickRot, 0, 10, dt);

    // Reload animation: dip and roll the weapon out of the sight line.
    let reloadDip = 0, reloadRoll = 0, reloadYaw = 0;
    if (this.reloading) {
      const total = this._reloadWasEmpty ? WEAPON.reloadEmptyTime : WEAPON.reloadTime;
      const t = clamp(this._reloadT / total, 0, 1);
      const arc = Math.sin(t * Math.PI);
      reloadDip = arc * 0.13;
      reloadRoll = arc * 0.55;
      reloadYaw = arc * 0.22;
      // The cell drops out and a fresh one seats.
      const cellPhase = clamp((t - 0.22) / 0.4, 0, 1);
      const seat = clamp((t - 0.62) / 0.25, 0, 1);
      this.rig.cell.position.y = -0.115 - cellPhase * 0.16 * (1 - seat);
      this.rig.cellGlow.position.y = -0.108 - cellPhase * 0.16 * (1 - seat);
      this.rig.cellGlow.visible = seat > 0.5 || cellPhase < 0.1;
    } else {
      this.rig.cell.position.y = -0.115;
      this.rig.cellGlow.position.y = -0.108;
      this.rig.cellGlow.visible = true;
    }

    // Sprint stows the weapon across the body.
    const sprintE = player.sprinting && !ads ? 1 : 0;
    this._sprintT = damp(this._sprintT || 0, sprintE, 8, dt);

    // Compose the final viewmodel transform.
    const base = scratch.v0.copy(HIP);
    if (this._sprintT > 0.001) base.lerp(SPRINT_POS, this._sprintT);

    // Aim: place the rig so the optic's aim point lands on screen centre.
    if (adsE > 0.001) {
      const aimLocal = scratch.v1.copy(this.rig.aimPoint.position);
      const adsPos = scratch.v2.copy(this._adsTarget).sub(aimLocal);
      base.lerp(adsPos, adsE);
    }

    this.group.position.set(
      base.x + (this._swayPos.x + bobX) * (1 - adsE * 0.8),
      base.y + (this._swayPos.y + bobY) * (1 - adsE * 0.8) - reloadDip,
      base.z + this._kick * 0.006
    );
    this.group.rotation.set(
      -this._kick * 0.02 + this._swayPos.y * 0.9 + reloadDip * 1.6,
      this._swayPos.x * 1.4 + this._sprintT * -0.5 + reloadYaw,
      this._kickRot + this._sprintT * 0.35 + reloadRoll + this._swayPos.x * 0.6
    );

    // Trigger finger pulls on fire.
    this.rig.trigger.rotation.x = 0.55 + clamp(this._kick, 0, 1) * 0.35;

    // Charge bar tracks remaining ammo; reticle only visible while aiming.
    const ammoFrac = this.ammo / WEAPON.magSize;
    this.rig.chargeBar.scale.z = Math.max(0.02, ammoFrac);
    this.rig.chargeBar.position.z = -0.12 - (1 - ammoFrac) * 0.08;
    this.rig.chargeBar.material = this.rig.chargeBar.material;
    this.rig.reticle.visible = adsE > 0.5;
    this.rig.reticle.material.opacity = smoothstep(0.5, 1, adsE);

    this._hitMarkerT = Math.max(0, this._hitMarkerT - dt);
  }

  get adsProgress() {
    return this._adsT;
  }

  // Current spread in radians, so the HUD crosshair can open and close with it.
  get currentSpread() {
    const player = this.ctx.get('player');
    let spread = player.ads ? WEAPON.adsSpread : WEAPON.hipSpread;
    spread *= 1 + clamp(player.speed / 9, 0, 1) * (WEAPON.moveSpreadScale - 1);
    if (!player.grounded) spread *= WEAPON.airSpreadScale;
    if (player.isCrouched) spread *= 0.7;
    return spread;
  }

  reset() {
    this.ammo = WEAPON.magSize;
    this.reserve = 120;
    this.reloading = false;
    this._reloadT = 0;
    this._shotIndex = 0;
    this._triggerHeld = false;
    this._kick = 0;
    this._adsT = 0;
    this._raiseT = 0;
  }
}

// Ray/sphere used for beacon and actor hitboxes. Returns the near distance or
// null. Kept here rather than in physics because it operates on gameplay
// volumes, not world colliders.
export function raySphere(origin, dir, centre, radius, maxDist) {
  const ox = origin.x - centre.x;
  const oy = origin.y - centre.y;
  const oz = origin.z - centre.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c > 0 && b > 0) return null;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  if (t < 0 || t > maxDist) return null;
  return t;
}

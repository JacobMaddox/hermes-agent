import * as THREE from 'three';
import { scratch } from '../core/loop.js';
import { clamp, lerp, damp, smoothstep } from '../core/rng.js';
import { VOID_Y } from '../world/world.js';

// Player controller.
//
// Round 1 added a normalised direction straight to the camera position: no
// acceleration, no friction, no air control, no bob, no landing weight. It was
// technically movement and it felt like nothing. This is a state machine with
// real momentum, plus the camera dynamics that sell it.
//
// Mouse look is hand-rolled rather than using PointerLockControls, because
// recoil, aim-down-sights sensitivity scaling and leaning all need to compose
// on top of the look angles, which that helper does not expose.

const STATE = {
  GROUND: 'ground',
  AIR: 'air',
  CROUCH: 'crouch',
  SLIDE: 'slide',
  MANTLE: 'mantle'
};

export const CFG = {
  radius: 0.34,
  standHeight: 1.78,
  crouchHeight: 1.05,
  eyeOffset: -0.16,      // eye sits just below the capsule top
  stepHeight: 0.55,

  walkSpeed: 5.4,
  sprintSpeed: 9.0,
  crouchSpeed: 2.7,
  airSpeed: 4.2,

  groundAccel: 62,
  airAccel: 18,
  groundFriction: 11.5,
  airFriction: 0.25,

  gravity: 26,
  jumpVelocity: 8.4,
  coyoteTime: 0.12,
  jumpBuffer: 0.14,

  slideBoost: 1.32,
  slideFriction: 2.6,
  slideMinSpeed: 3.4,
  slideMaxTime: 1.15,

  mantleReach: 1.05,
  mantleMaxHeight: 1.95,
  mantleTime: 0.42,

  maxHp: 100,
  regenDelay: 6.0,
  regenRate: 9.0,

  fallSafeSpeed: 13,
  fallDamageScale: 6.2,

  baseFov: 76,
  sprintFovAdd: 7,
  adsFov: 48,

  lookSensitivity: 0.0022,
  adsSensitivityScale: 0.55,
  maxPitch: Math.PI / 2 - 0.02
};

export class PlayerSystem {
  constructor() {
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.state = STATE.GROUND;
    this.height = CFG.standHeight;

    this.hp = CFG.maxHp;
    this.alive = true;
    this.dead = false;

    this.grounded = false;
    this.sprinting = false;
    this.ads = false;

    this.keys = Object.create(null);
    this.moveState = {
      grounded: false, hitWall: false, hitCeiling: false, steppedUp: 0,
      groundSurface: 'stone', stepHeight: CFG.stepHeight, wallNormal: new THREE.Vector3()
    };

    // Camera dynamics, all additive on top of the look angles.
    this._bobPhase = 0;
    this._bob = new THREE.Vector2();
    this._landDip = 0;
    this._shake = 0;
    this._shakeSeed = 0;
    this._recoilPitch = 0;
    this._recoilYaw = 0;
    this._lean = 0;
    this._leanTarget = 0;
    this._roll = 0;
    this._fov = CFG.baseFov;

    this._coyote = 0;
    this._jumpBuffered = 0;
    this._slideTime = 0;
    this._mantle = null;
    this._lastDamage = -99;
    this._damageDirs = [];
    this._airTime = 0;
    this._peakFallSpeed = 0;
    this._footAccum = 0;
    this._lastGroundSurface = 'stone';

    this.stats = { shotsFired: 0, shotsHit: 0, kills: 0, headshots: 0, damageTaken: 0 };
  }

  async init() {
    this._bindInput();
  }

  async ready() {
    const world = this.ctx.get('world');
    this.spawnPoint = world.spawns.player.clone();
    this.respawn();

    this.ctx.bus.on('weapon:recoil', (e) => this.addRecoil(e.pitch, e.yaw));
    this.ctx.bus.on('explosion', (e) => {
      const d = this.position.distanceTo(e.point);
      if (d < e.radius * 2.2) this.addShake(clamp(1 - d / (e.radius * 2.2), 0, 1) * 0.9);
    });
  }

  _bindInput() {
    const canvas = this.ctx.renderer.domElement;

    document.addEventListener('keydown', (e) => {
      // Only swallow keys we actually use, so browser shortcuts still work.
      if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
      this.keys[e.code] = true;
      if (e.code === 'Space') this._jumpBuffered = CFG.jumpBuffer;
    });
    document.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    window.addEventListener('blur', () => { for (const k in this.keys) this.keys[k] = false; });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked || this.ctx.paused) return;
      const scale = this.ads ? CFG.adsSensitivityScale : 1;
      const sens = this.ctx.settings.sensitivity * CFG.lookSensitivity * scale;
      this.yaw -= e.movementX * sens;
      this.pitch -= e.movementY * sens * (this.ctx.settings.invertY ? -1 : 1);
      this.pitch = clamp(this.pitch, -CFG.maxPitch, CFG.maxPitch);
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas ||
        document.pointerLockElement === document.body;
      this.ctx.bus.emit('pointerlock:change', { locked: this.locked });
    });
    document.addEventListener('pointerlockerror', () => {
      console.warn('[player] pointer lock was refused');
      this.ctx.bus.emit('pointerlock:error', {});
    });
  }

  requestLock() {
    const canvas = this.ctx.renderer.domElement;
    const p = canvas.requestPointerLock({ unadjustedMovement: true });
    // Chrome returns a promise for unadjustedMovement; older browsers do not.
    if (p && p.catch) p.catch(() => canvas.requestPointerLock());
  }

  respawn(at) {
    const p = at || this.spawnPoint;
    this.position.copy(p);
    this.velocity.set(0, 0, 0);
    this.hp = CFG.maxHp;
    this.alive = true;
    this.dead = false;
    this.state = STATE.GROUND;
    this.height = CFG.standHeight;
    this._mantle = null;
    this._landDip = 0;
    this._shake = 0;
    this._damageDirs.length = 0;
    this._lastDamage = -99;
    this.yaw = 0;
    this.pitch = 0;
    this.ctx.bus.emit('player:respawn', { position: this.position });
  }

  // ── Simulation ────────────────────────────────────────────────────────

  fixedUpdate(step) {
    if (this.dead) {
      // Keep gravity running on the corpse so a death mid-air still falls.
      this.velocity.y -= CFG.gravity * step;
      const d = scratch.v0.set(0, this.velocity.y * step, 0);
      this.ctx.get('physics').moveCapsule(this.position, CFG.radius, 0.6, d, this.moveState);
      if (this.moveState.grounded) this.velocity.y = 0;
      return;
    }

    this._coyote = Math.max(0, this._coyote - step);
    this._jumpBuffered = Math.max(0, this._jumpBuffered - step);

    if (this.state === STATE.MANTLE) {
      this._stepMantle(step);
      return;
    }

    const wish = this._wishDirection();
    this._updateStance(step, wish);

    const speed = this._targetSpeed();
    const accel = this.grounded ? CFG.groundAccel : CFG.airAccel;

    // Accelerate toward the wish velocity rather than snapping to it. The gap
    // between input and velocity is what movement weight actually is.
    if (wish.lengthSq() > 0) {
      const target = scratch.v1.copy(wish).multiplyScalar(speed);
      const dvx = target.x - this.velocity.x;
      const dvz = target.z - this.velocity.z;
      const maxDelta = accel * step;
      const mag = Math.hypot(dvx, dvz);
      if (mag > 1e-5) {
        const k = Math.min(1, maxDelta / mag);
        this.velocity.x += dvx * k;
        this.velocity.z += dvz * k;
      }
    }

    // Friction.
    if (this.state === STATE.SLIDE) {
      this._applyFriction(CFG.slideFriction, step);
    } else if (this.grounded) {
      if (wish.lengthSq() === 0) this._applyFriction(CFG.groundFriction, step);
      else this._applyFriction(CFG.groundFriction * 0.28, step);
    } else {
      this._applyFriction(CFG.airFriction, step);
    }

    // Jump, honouring both coyote time and the input buffer so the control
    // forgives a frame either side of the edge.
    if (this._jumpBuffered > 0 && (this.grounded || this._coyote > 0) && this.state !== STATE.MANTLE) {
      this.velocity.y = CFG.jumpVelocity;
      this._jumpBuffered = 0;
      this._coyote = 0;
      this.grounded = false;
      if (this.state === STATE.SLIDE) this._endSlide();
      this.state = STATE.AIR;
      this.ctx.bus.emit('player:jump', {});
    }

    this.velocity.y -= CFG.gravity * step;
    if (this.velocity.y < -60) this.velocity.y = -60;

    const delta = scratch.v2.copy(this.velocity).multiplyScalar(step);
    this.moveState.stepHeight = this.state === STATE.SLIDE ? 0.25 : CFG.stepHeight;
    const phys = this.ctx.get('physics');
    phys.moveCapsule(this.position, CFG.radius, this.height, delta, this.moveState);

    if (this.moveState.hitWall) {
      // Slide along the wall instead of stopping dead: cancel only the
      // component of velocity going into the surface.
      const n = this.moveState.wallNormal;
      const into = this.velocity.x * n.x + this.velocity.z * n.z;
      if (into < 0) {
        this.velocity.x -= n.x * into;
        this.velocity.z -= n.z * into;
      }
      this._tryMantle();
    }
    if (this.moveState.hitCeiling && this.velocity.y > 0) this.velocity.y = 0;

    this._handleLanding(step);
    this._updateFootsteps(step);
    this._updateHealth(step);

    if (this.position.y < VOID_Y) this._die('void');
  }

  _applyFriction(coef, step) {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed < 1e-4) { this.velocity.x = 0; this.velocity.z = 0; return; }
    const drop = speed * coef * step;
    const k = Math.max(0, speed - drop) / speed;
    this.velocity.x *= k;
    this.velocity.z *= k;
  }

  _wishDirection() {
    const out = scratch.v0.set(0, 0, 0);
    const k = this.keys;
    const f = (k['KeyW'] ? 1 : 0) - (k['KeyS'] ? 1 : 0);
    const r = (k['KeyD'] ? 1 : 0) - (k['KeyA'] ? 1 : 0);
    if (f === 0 && r === 0) return out;
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    // Forward is -Z in camera space.
    out.x = -sy * f + cy * r;
    out.z = -cy * f - sy * r;
    return out.normalize();
  }

  _targetSpeed() {
    switch (this.state) {
      case STATE.CROUCH: return CFG.crouchSpeed;
      case STATE.SLIDE: return 0;
      case STATE.AIR: return CFG.airSpeed;
      default: return this.sprinting ? CFG.sprintSpeed : CFG.walkSpeed;
    }
  }

  _updateStance(step, wish) {
    const k = this.keys;
    const wantCrouch = k['ControlLeft'] || k['ControlRight'] || k['KeyC'];
    const wantSprint = (k['ShiftLeft'] || k['ShiftRight']) && !this.ads;
    const movingForward = wish.lengthSq() > 0;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);

    this.sprinting = wantSprint && movingForward && this.grounded && !wantCrouch;

    if (this.state === STATE.SLIDE) {
      this._slideTime += step;
      if (!wantCrouch || this._slideTime > CFG.slideMaxTime || speed < CFG.slideMinSpeed || !this.grounded) {
        this._endSlide();
      }
    } else if (wantCrouch && this.grounded) {
      // Crouching at speed converts into a slide — the movement flourish that
      // makes traversal feel good.
      if (speed > CFG.sprintSpeed * 0.72 && this.state !== STATE.CROUCH) {
        this._beginSlide(speed);
      } else {
        this.state = STATE.CROUCH;
      }
    } else if (this.grounded) {
      if (this.state === STATE.CROUCH) {
        // Only stand up if there is room.
        if (this.ctx.get('physics')._hasHeadroom(this.position, CFG.radius, CFG.standHeight, this.position.y)) {
          this.state = STATE.GROUND;
        }
      } else {
        this.state = STATE.GROUND;
      }
    } else {
      this.state = STATE.AIR;
    }

    const targetH = (this.state === STATE.CROUCH || this.state === STATE.SLIDE)
      ? CFG.crouchHeight : CFG.standHeight;
    this.height = damp(this.height, targetH, 16, step);
  }

  _beginSlide(speed) {
    this.state = STATE.SLIDE;
    this._slideTime = 0;
    const mag = Math.hypot(this.velocity.x, this.velocity.z);
    if (mag > 1e-4) {
      const k = (mag * CFG.slideBoost) / mag;
      this.velocity.x *= k;
      this.velocity.z *= k;
    }
    this.ctx.bus.emit('player:slide', { speed });
  }

  _endSlide() {
    this._slideTime = 0;
    this.state = this.keys['ControlLeft'] || this.keys['KeyC'] ? STATE.CROUCH : STATE.GROUND;
  }

  // Ledge grab: if we are pressed against a wall whose top is within reach and
  // there is space to stand on it, pull up.
  _tryMantle() {
    if (this.state === STATE.MANTLE || this.grounded) return;
    if (this.velocity.y < -9) return;
    const wish = this._wishDirection();
    if (wish.lengthSq() === 0) return;

    const phys = this.ctx.get('physics');
    const ahead = scratch.v3.copy(this.position)
      .addScaledVector(wish, CFG.radius + CFG.mantleReach * 0.55);
    const ledge = phys.groundAt(ahead.x, ahead.z, this.position.y + CFG.mantleMaxHeight, CFG.mantleMaxHeight + 0.5);
    if (!ledge) return;
    const rise = ledge.y - this.position.y;
    if (rise < 0.5 || rise > CFG.mantleMaxHeight) return;
    if (!phys._hasHeadroom(ahead, CFG.radius, CFG.standHeight, ledge.y + 0.05)) return;

    this.state = STATE.MANTLE;
    this._mantle = {
      t: 0,
      from: this.position.clone(),
      to: new THREE.Vector3(ahead.x, ledge.y + 0.02, ahead.z)
    };
    this.velocity.set(0, 0, 0);
    this.ctx.bus.emit('player:mantle', { rise });
  }

  _stepMantle(step) {
    const m = this._mantle;
    m.t = Math.min(1, m.t + step / CFG.mantleTime);
    // Up first, then forward — the shape of an actual pull-up.
    const up = smoothstep(0, 0.6, m.t);
    const fwd = smoothstep(0.35, 1, m.t);
    this.position.x = lerp(m.from.x, m.to.x, fwd);
    this.position.z = lerp(m.from.z, m.to.z, fwd);
    this.position.y = lerp(m.from.y, m.to.y, up);
    if (m.t >= 1) {
      this._mantle = null;
      this.state = STATE.GROUND;
      this.grounded = true;
      this._coyote = CFG.coyoteTime;
    }
  }

  _handleLanding(step) {
    const wasGrounded = this.grounded;
    this.grounded = this.moveState.grounded;

    if (this.grounded) {
      this._coyote = CFG.coyoteTime;
      this._lastGroundSurface = this.moveState.groundSurface;
      if (!wasGrounded) {
        const impact = Math.abs(this._peakFallSpeed);
        // Landing dip scales with impact, so a hop reads differently from a drop.
        this._landDip = clamp(impact / 26, 0, 1) * 0.28;
        if (impact > 6) {
          this.ctx.bus.emit('player:land', {
            surface: this._lastGroundSurface, impactSpeed: impact
          });
        }
        if (impact > CFG.fallSafeSpeed) {
          const dmg = (impact - CFG.fallSafeSpeed) * CFG.fallDamageScale;
          this.damage(dmg, null, 'fall');
          this.addShake(clamp(dmg / 40, 0.2, 1));
        }
        this._airTime = 0;
        this._peakFallSpeed = 0;
      }
      if (this.velocity.y < 0) this.velocity.y = 0;
    } else {
      this._airTime += step;
      this._peakFallSpeed = Math.max(this._peakFallSpeed, -this.velocity.y);
    }
  }

  _updateFootsteps(step) {
    if (!this.grounded || this.state === STATE.SLIDE) return;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed < 0.6) return;
    // Distance-based rather than time-based, so cadence tracks actual speed.
    this._footAccum += speed * step;
    const stride = this.sprinting ? 2.15 : this.state === STATE.CROUCH ? 1.5 : 1.75;
    if (this._footAccum >= stride) {
      this._footAccum = 0;
      this.ctx.bus.emit('player:footstep', {
        surface: this._lastGroundSurface,
        running: this.sprinting,
        position: this.position
      });
    }
  }

  _updateHealth(step) {
    if (this.hp <= 0) return;
    const since = this.ctx.time.elapsed - this._lastDamage;
    if (since > CFG.regenDelay && this.hp < CFG.maxHp) {
      this.hp = Math.min(CFG.maxHp, this.hp + CFG.regenRate * step);
    }
  }

  // ── Damage and death ──────────────────────────────────────────────────

  damage(amount, fromPosition, cause = 'hit') {
    if (this.dead || !this.alive) return;
    this.hp -= amount;
    this.stats.damageTaken += amount;
    this._lastDamage = this.ctx.time.elapsed;
    this.addShake(clamp(amount / 30, 0.08, 0.5));

    if (fromPosition) {
      const d = scratch.v4.subVectors(fromPosition, this.position);
      this._damageDirs.push({
        angle: Math.atan2(d.x, d.z),
        t: 1.6,
        amount
      });
      if (this._damageDirs.length > 6) this._damageDirs.shift();
    }

    this.ctx.bus.emit('damage:taken', { amount, cause, fromPosition });

    if (this.hp <= 0) {
      this.hp = 0;
      this._die(cause);
    }
  }

  // Guarded so a fall and a bullet arriving on the same step cannot queue two
  // death sequences — the round-1 bug where onDeath() stacked setTimeouts.
  _die(cause) {
    if (this.dead) return;
    this.dead = true;
    this.alive = false;
    this.hp = 0;
    this.ctx.bus.emit('player:death', { cause });
  }

  addShake(amount) {
    this._shake = Math.min(1.4, this._shake + amount);
    this._shakeSeed = this.ctx.rng.next() * 1000;
  }

  addRecoil(pitch, yaw) {
    this._recoilPitch += pitch;
    this._recoilYaw += yaw;
  }

  setAds(on) {
    this.ads = on;
  }

  // ── Camera ────────────────────────────────────────────────────────────

  update(dt) {
    const cam = this.ctx.camera;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);

    // Head bob: figure-of-eight, amplitude and rate scaling with speed. Only
    // on the ground, and killed while aiming so the sights stay usable.
    const bobTarget = this.grounded && !this.ads && this.state !== STATE.SLIDE
      ? clamp(speed / CFG.sprintSpeed, 0, 1) : 0;
    this._bobPhase += dt * (6.2 + speed * 0.62);
    const amp = bobTarget * (this.sprinting ? 0.055 : 0.038);
    this._bob.x = damp(this._bob.x, Math.sin(this._bobPhase) * amp, 10, dt);
    this._bob.y = damp(this._bob.y, Math.abs(Math.cos(this._bobPhase)) * amp * 0.85, 10, dt);

    // Landing dip recovers with a slight overshoot.
    this._landDip = damp(this._landDip, 0, 7.5, dt);

    // Trauma-style shake: squared falloff, rapid noise, decays fast.
    this._shake = Math.max(0, this._shake - dt * 1.9);
    const trauma = this._shake * this._shake;
    const st = this.ctx.time.elapsed * 34 + this._shakeSeed;
    const shakeX = Math.sin(st * 1.7) * Math.sin(st * 0.53) * trauma * 0.045;
    const shakeY = Math.cos(st * 1.31) * Math.sin(st * 0.79) * trauma * 0.045;
    const shakeR = Math.sin(st * 0.97) * trauma * 0.035;

    // Recoil decays back toward centre; the residual is what makes a burst
    // climb and then settle.
    this._recoilPitch = damp(this._recoilPitch, 0, 7, dt);
    this._recoilYaw = damp(this._recoilYaw, 0, 7, dt);

    // Lean (Q/E) shifts the camera sideways and rolls it.
    this._leanTarget = (this.keys['KeyQ'] ? 1 : 0) - (this.keys['KeyE'] ? 1 : 0);
    if (!this.grounded) this._leanTarget = 0;
    this._lean = damp(this._lean, this._leanTarget, 9, dt);

    // Strafe roll: a few degrees of bank into lateral movement.
    const right = scratch.v0.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const lateral = this.velocity.x * right.x + this.velocity.z * right.z;
    const rollTarget = -lateral / CFG.sprintSpeed * 0.028 - this._lean * 0.14;
    this._roll = damp(this._roll, rollTarget, 7, dt);

    // Compose the camera transform.
    const eyeY = this.position.y + this.height + CFG.eyeOffset;
    cam.position.set(
      this.position.x + right.x * this._lean * 0.42 + this._bob.x * right.x,
      eyeY - this._landDip + this._bob.y + shakeY,
      this.position.z + right.z * this._lean * 0.42 + this._bob.x * right.z
    );
    cam.rotation.set(0, 0, 0);
    cam.rotation.order = 'YXZ';
    cam.rotation.y = this.yaw + this._recoilYaw + shakeX;
    cam.rotation.x = this.pitch + this._recoilPitch;
    cam.rotation.z = this._roll + shakeR;

    // FOV: widens with sprint, narrows hard for ADS.
    let targetFov = this.ctx.settings.fov;
    if (this.ads) targetFov = CFG.adsFov;
    else if (this.sprinting) targetFov = this.ctx.settings.fov + CFG.sprintFovAdd;
    // Sliding punches it a little wider still.
    if (this.state === STATE.SLIDE) targetFov += 6;
    this._fov = damp(this._fov, targetFov, this.ads ? 14 : 8, dt);
    if (Math.abs(cam.fov - this._fov) > 0.01) {
      cam.fov = this._fov;
      cam.updateProjectionMatrix();
    }

    // Damage haze in the grade pass, driven by how hurt we are.
    const render = this.ctx.get('render');
    const hurt = 1 - this.hp / CFG.maxHp;
    render.setDamageHaze(this.dead ? 1 : smoothstep(0.45, 1, hurt) * 0.9);

    // Age the damage-direction markers for the HUD.
    for (let i = this._damageDirs.length - 1; i >= 0; i--) {
      this._damageDirs[i].t -= dt;
      if (this._damageDirs[i].t <= 0) this._damageDirs.splice(i, 1);
    }
  }

  get damageIndicators() {
    return this._damageDirs;
  }

  get speed() {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  get eyePosition() {
    return this.ctx.camera.position;
  }

  get isCrouched() {
    return this.state === STATE.CROUCH || this.state === STATE.SLIDE;
  }
}

export { STATE as PLAYER_STATE };

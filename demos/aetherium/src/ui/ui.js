import * as THREE from 'three';
import { clamp } from '../core/rng.js';
import { CFG as PLAYER_CFG } from '../player/player.js';
import { DISTRICTS } from '../world/world.js';

// HUD and menus.
//
// Round 1 had health, ammo and one line of objective text, and on winning it
// left the HUD up with no end screen and no way to restart. This is the rest
// of it: a crosshair that opens with actual weapon spread, hit markers, a
// compass minimap, directional damage arcs, a kill feed, a pause menu with
// live settings, and a real debrief.
//
// The crosshair and the damage arcs are drawn to a canvas rather than built
// from DOM nodes — they change every frame, and thrashing layout sixty times a
// second to move four divs is a waste.

export class UiSystem {
  constructor() {
    this.el = {};
    this._killFeed = [];
    this._hitMarker = 0;
    this._hitKill = false;
    this._hitHead = false;
    this._toast = null;
    this._toastT = 0;
    this._objective = '';
    this._lowHpPulse = 0;
  }

  async init() {
    const q = (id) => document.getElementById(id);
    this.el = {
      hud: q('hud'),
      hpFill: q('hpFill'),
      hpValue: q('hpValue'),
      ammoMag: q('ammoMag'),
      ammoReserve: q('ammoReserve'),
      ammoBlock: q('ammoBlock'),
      objective: q('objective'),
      objectiveSub: q('objectiveSub'),
      stage: q('stageLabel'),
      killFeed: q('killFeed'),
      toast: q('toast'),
      overlay: q('overlay'),
      loading: q('loading'),
      loadBar: q('loadBar'),
      loadLabel: q('loadLabel'),
      pause: q('pauseMenu'),
      debrief: q('debrief'),
      debriefBody: q('debriefBody'),
      debriefTitle: q('debriefTitle'),
      reticleCanvas: q('reticleCanvas'),
      minimap: q('minimap'),
      alertBar: q('alertBar'),
      perf: q('perf')
    };

    this.rCtx = this.el.reticleCanvas.getContext('2d');
    this.mCtx = this.el.minimap.getContext('2d');
    this.onResize(window.innerWidth, window.innerHeight);
    this._bindMenus();
  }

  async ready() {
    const bus = this.ctx.bus;
    bus.on('weapon:hitmarker', (e) => {
      this._hitMarker = 0.32;
      this._hitKill = e.kill;
      this._hitHead = e.headshot;
    });
    bus.on('actor:death', (e) => this.addKill(e.label || 'Drone', e.headshot));
    bus.on('beacon:destroyed', () => this.addKill('Aether Beacon', false, true));
    bus.on('objective:advance', (e) => this.setObjective(e.title, e.sub, e.stage));
    bus.on('toast', (e) => this.toast(e.text, e.duration));
    bus.on('pointerlock:error', () =>
      this.toast('Pointer lock refused — click the canvas again', 4));
  }

  onResize(w, h) {
    const c = this.el.reticleCanvas;
    const dpr = Math.min(window.devicePixelRatio, 2);
    c.width = Math.floor(w * dpr);
    c.height = Math.floor(h * dpr);
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    this.rCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = w;
    this._h = h;

    const m = this.el.minimap;
    m.width = 200 * dpr;
    m.height = 200 * dpr;
    this.mCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ── Screens ───────────────────────────────────────────────────────────

  setProgress(p, label) {
    if (!this.el.loadBar) return;
    this.el.loadBar.style.width = clamp(p, 0, 1) * 100 + '%';
    if (label) this.el.loadLabel.textContent = label;
  }

  showLoading(on) {
    this.el.loading.classList.toggle('hidden', !on);
  }

  showOverlay(on) {
    this.el.overlay.classList.toggle('hidden', !on);
  }

  showHud(on) {
    this.el.hud.classList.toggle('hidden', !on);
  }

  showPause(on) {
    this.el.pause.classList.toggle('hidden', !on);
  }

  showDebrief(won, stats, timeSec) {
    const acc = stats.shotsFired > 0
      ? Math.round((stats.shotsHit / stats.shotsFired) * 100) : 0;
    const mm = Math.floor(timeSec / 60);
    const ss = Math.floor(timeSec % 60).toString().padStart(2, '0');

    this.el.debriefTitle.textContent = won ? 'ELYSIUM PRIME SECURED' : 'MISSION FAILED';
    this.el.debriefTitle.className = won ? 'win' : 'lose';
    this.el.debriefBody.innerHTML = `
      <div class="stat-grid">
        <div><span>Time</span><strong>${mm}:${ss}</strong></div>
        <div><span>Drones destroyed</span><strong>${stats.kills}</strong></div>
        <div><span>Headshots</span><strong>${stats.headshots}</strong></div>
        <div><span>Accuracy</span><strong>${acc}%</strong></div>
        <div><span>Shots fired</span><strong>${stats.shotsFired}</strong></div>
        <div><span>Damage taken</span><strong>${Math.round(stats.damageTaken)}</strong></div>
      </div>`;
    this.el.debrief.classList.remove('hidden');
  }

  hideDebrief() {
    this.el.debrief.classList.add('hidden');
  }

  // ── HUD elements ──────────────────────────────────────────────────────

  setObjective(title, sub, stage) {
    this._objective = title;
    this.el.objective.textContent = title;
    this.el.objectiveSub.textContent = sub || '';
    if (stage) this.el.stage.textContent = stage;
    this.el.objective.classList.remove('flash');
    // Force a reflow so the animation restarts on a repeat objective.
    void this.el.objective.offsetWidth;
    this.el.objective.classList.add('flash');
  }

  toast(text, duration = 2.2) {
    this.el.toast.textContent = text;
    this.el.toast.classList.add('show');
    this._toastT = duration;
  }

  addKill(label, headshot, isObject = false) {
    const row = document.createElement('div');
    row.className = 'kill-row';
    row.innerHTML = `<span class="k-src">You</span>` +
      `<span class="k-icon">${headshot ? '⌖' : isObject ? '◈' : '✕'}</span>` +
      `<span class="k-tgt">${label}</span>`;
    this.el.killFeed.appendChild(row);
    this._killFeed.push({ el: row, t: 5 });
    if (this._killFeed.length > 5) {
      const old = this._killFeed.shift();
      old.el.remove();
    }
  }

  // ── Per-frame ─────────────────────────────────────────────────────────

  update(dt) {
    const player = this.ctx.tryGet('player');
    const weapons = this.ctx.tryGet('weapons');
    if (!player || !weapons) return;

    // Health.
    const hpPct = clamp(player.hp / PLAYER_CFG.maxHp, 0, 1);
    this.el.hpFill.style.width = hpPct * 100 + '%';
    this.el.hpValue.textContent = Math.ceil(player.hp);
    this.el.hpFill.classList.toggle('critical', hpPct < 0.3);
    this.el.hpValue.classList.toggle('critical', hpPct < 0.3);

    // Ammo. Round 1 hardcoded the starting value in the markup and never
    // refreshed it on init, so it showed the wrong number until the first shot.
    this.el.ammoMag.textContent = weapons.ammo;
    this.el.ammoReserve.textContent = weapons.reserve;
    this.el.ammoBlock.classList.toggle('low', weapons.ammo <= 6);
    this.el.ammoBlock.classList.toggle('reloading', weapons.reloading);

    // Toast and kill feed ageing.
    if (this._toastT > 0) {
      this._toastT -= dt;
      if (this._toastT <= 0) this.el.toast.classList.remove('show');
    }
    for (let i = this._killFeed.length - 1; i >= 0; i--) {
      const k = this._killFeed[i];
      k.t -= dt;
      if (k.t < 1) k.el.style.opacity = k.t;
      if (k.t <= 0) { k.el.remove(); this._killFeed.splice(i, 1); }
    }

    this._hitMarker = Math.max(0, this._hitMarker - dt);
    this._lowHpPulse += dt * (hpPct < 0.3 ? 5 : 0);

    // Alert bar shows how close the squad is to spotting you.
    const ai = this.ctx.tryGet('ai');
    if (ai && this.el.alertBar) {
      const a = ai.alertLevel;
      this.el.alertBar.style.opacity = a > 0.04 ? String(clamp(a * 1.4, 0, 1)) : '0';
      this.el.alertBar.style.setProperty('--alert', String(a));
      this.el.alertBar.classList.toggle('engaged', a >= 0.99);
    }

    this._drawReticle(player, weapons);
    if (this.ctx.time.frame % 2 === 0) this._drawMinimap(player);
    if (this.ctx.settings.showPerf) this._drawPerf();
  }

  _drawReticle(player, weapons) {
    const c = this.rCtx;
    const w = this._w, h = this._h;
    c.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;

    const adsE = weapons.adsProgress;
    const hidden = player.dead || this.ctx.paused || this.ctx.gameOver;
    if (hidden) return;

    // Crosshair gap is derived from the real spread cone projected to screen
    // space, so what you see is genuinely what the weapon will do.
    if (adsE < 0.85) {
      const fov = THREE.MathUtils.degToRad(this.ctx.camera.fov);
      const pxPerRad = (h * 0.5) / Math.tan(fov * 0.5);
      const gap = clamp(weapons.currentSpread * pxPerRad, 4, 90);
      const len = 7;
      const alpha = (1 - adsE / 0.85) * 0.95;

      c.strokeStyle = `rgba(214,236,255,${alpha})`;
      c.lineWidth = 2;
      c.lineCap = 'round';
      c.beginPath();
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        c.moveTo(cx + dx * gap, cy + dy * gap);
        c.lineTo(cx + dx * (gap + len), cy + dy * (gap + len));
      }
      c.stroke();

      c.fillStyle = `rgba(126,200,255,${alpha * 0.9})`;
      c.beginPath();
      c.arc(cx, cy, 1.6, 0, Math.PI * 2);
      c.fill();
    }

    // Hit marker.
    if (this._hitMarker > 0) {
      const t = this._hitMarker / 0.32;
      const s = 9 + (1 - t) * 5;
      c.strokeStyle = this._hitKill
        ? `rgba(255,110,70,${t})`
        : this._hitHead ? `rgba(255,214,120,${t})` : `rgba(255,255,255,${t})`;
      c.lineWidth = this._hitKill ? 3 : 2.2;
      c.beginPath();
      for (const [dx, dy] of [[-1, -1], [1, 1], [-1, 1], [1, -1]]) {
        c.moveTo(cx + dx * s * 0.45, cy + dy * s * 0.45);
        c.lineTo(cx + dx * s, cy + dy * s);
      }
      c.stroke();
    }

    // Directional damage arcs.
    const inds = player.damageIndicators;
    if (inds.length) {
      const yaw = player.yaw;
      const radius = Math.min(w, h) * 0.19;
      for (const d of inds) {
        // Angle relative to where we are facing.
        const rel = d.angle - yaw + Math.PI;
        const alpha = clamp(d.t / 1.6, 0, 1) * 0.85;
        c.save();
        c.translate(cx, cy);
        c.rotate(rel);
        const grad = c.createLinearGradient(0, -radius - 18, 0, -radius + 8);
        grad.addColorStop(0, `rgba(255,60,40,0)`);
        grad.addColorStop(1, `rgba(255,70,45,${alpha})`);
        c.fillStyle = grad;
        c.beginPath();
        c.arc(0, 0, radius + 18, -Math.PI / 2 - 0.36, -Math.PI / 2 + 0.36);
        c.arc(0, 0, radius, -Math.PI / 2 + 0.36, -Math.PI / 2 - 0.36, true);
        c.closePath();
        c.fill();
        c.restore();
      }
    }

    // Low-health pulse at the screen edge.
    const hpPct = player.hp / PLAYER_CFG.maxHp;
    if (hpPct < 0.32 && !player.dead) {
      const pulse = 0.25 + Math.sin(this._lowHpPulse) * 0.12;
      const a = (1 - hpPct / 0.32) * pulse;
      const g = c.createRadialGradient(cx, cy, Math.min(w, h) * 0.28, cx, cy, Math.max(w, h) * 0.62);
      g.addColorStop(0, 'rgba(180,20,20,0)');
      g.addColorStop(1, `rgba(190,24,24,${a})`);
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    }
  }

  _drawMinimap(player) {
    const c = this.mCtx;
    const S = 200;
    const RANGE = 62;
    c.clearRect(0, 0, S, S);

    const px = player.position.x;
    const pz = player.position.z;
    const scale = (S * 0.5) / RANGE;

    c.save();
    c.beginPath();
    c.arc(S / 2, S / 2, S / 2 - 3, 0, Math.PI * 2);
    c.clip();

    c.fillStyle = 'rgba(8,13,24,0.72)';
    c.fillRect(0, 0, S, S);

    // District footprints, rotated so the map is always player-forward.
    const rot = -player.yaw;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const project = (x, z) => {
      const dx = (x - px) * scale;
      const dz = (z - pz) * scale;
      return [S / 2 + (dx * cos - dz * sin), S / 2 + (dx * sin + dz * cos)];
    };

    c.strokeStyle = 'rgba(120,170,230,0.35)';
    c.fillStyle = 'rgba(90,140,200,0.14)';
    c.lineWidth = 1.4;
    for (const key of Object.keys(DISTRICTS)) {
      const D = DISTRICTS[key];
      const pts = [
        project(D.x - D.w / 2, D.z - D.d / 2),
        project(D.x + D.w / 2, D.z - D.d / 2),
        project(D.x + D.w / 2, D.z + D.d / 2),
        project(D.x - D.w / 2, D.z + D.d / 2)
      ];
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < 4; i++) c.lineTo(pts[i][0], pts[i][1]);
      c.closePath();
      c.fill();
      c.stroke();
    }

    // Objective markers.
    const game = this.ctx.tryGet('game');
    if (game && game.markers) {
      for (const m of game.markers) {
        const [mx, my] = project(m.position.x, m.position.z);
        c.fillStyle = m.colour || 'rgba(255,210,90,0.95)';
        c.beginPath();
        c.moveTo(mx, my - 5);
        c.lineTo(mx + 4.5, my + 3.5);
        c.lineTo(mx - 4.5, my + 3.5);
        c.closePath();
        c.fill();
      }
    }

    // Only show drones the player is actually aware of — a minimap that shows
    // every enemy through every wall removes the point of the stealth window.
    const ai = this.ctx.tryGet('ai');
    if (ai) {
      for (const a of ai.actors) {
        if (!a.alive) continue;
        const known = a.canSee || a.awareness > 0.6;
        if (!known) continue;
        const [ax, ay] = project(a.position.x, a.position.z);
        const dy = a.position.y - player.position.y;
        c.fillStyle = a.state === 'combat' ? 'rgba(255,70,50,0.95)' : 'rgba(255,150,60,0.8)';
        c.beginPath();
        c.arc(ax, ay, 3.4, 0, Math.PI * 2);
        c.fill();
        // A small tick above or below when they are on another level.
        if (Math.abs(dy) > 3) {
          c.fillRect(ax - 1, ay + (dy > 0 ? -8 : 5), 2, 3);
        }
      }
    }

    c.restore();

    // Player arrow, always centre, always up.
    c.fillStyle = '#cfe6ff';
    c.beginPath();
    c.moveTo(S / 2, S / 2 - 7);
    c.lineTo(S / 2 + 5, S / 2 + 5);
    c.lineTo(S / 2, S / 2 + 2);
    c.lineTo(S / 2 - 5, S / 2 + 5);
    c.closePath();
    c.fill();

    // Bezel and cardinal N.
    c.strokeStyle = 'rgba(140,190,250,0.4)';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(S / 2, S / 2, S / 2 - 3, 0, Math.PI * 2);
    c.stroke();

    const nAngle = rot - Math.PI / 2;
    c.fillStyle = 'rgba(180,215,255,0.8)';
    c.font = '600 11px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('N',
      S / 2 + Math.cos(nAngle) * (S / 2 - 13),
      S / 2 + Math.sin(nAngle) * (S / 2 - 13));
  }

  _drawPerf() {
    const loop = this.ctx.loopRef;
    const render = this.ctx.tryGet('render');
    if (!loop || !this.el.perf) return;
    if (this.ctx.time.frame % 15 !== 0) return;
    const ai = this.ctx.tryGet('ai');
    this.el.perf.textContent =
      `${loop.fps.toFixed(0)} fps  ${loop.avgFrameMs.toFixed(1)}ms  ` +
      `p95 ${loop.percentile(0.95).toFixed(1)}ms\n` +
      `draws ${render ? render.drawCalls : 0}  ` +
      `scale ${(render ? render._renderScale : 1).toFixed(2)}  ` +
      `${this.ctx.quality.label}\n` +
      `drones ${ai ? ai.aliveCount : 0}  ` +
      `debris ${this.ctx.get('physics').debris.length}`;
  }

  // ── Menus ─────────────────────────────────────────────────────────────

  _bindMenus() {
    const s = this.ctx.settings;

    const bind = (id, key, fmt, apply) => {
      const input = document.getElementById(id);
      const out = document.getElementById(id + 'Val');
      if (!input) return;
      input.value = s[key];
      if (out) out.textContent = fmt(s[key]);
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        s[key] = v;
        if (out) out.textContent = fmt(v);
        if (apply) apply(v);
        this.ctx.saveSettings();
      });
    };

    bind('setSensitivity', 'sensitivity', (v) => v.toFixed(2));
    bind('setFov', 'fov', (v) => Math.round(v) + '°');
    bind('setVolume', 'volume', (v) => Math.round(v * 100) + '%', (v) => {
      const a = this.ctx.tryGet('audio');
      if (a) a.setVolume(v);
    });

    const invert = document.getElementById('setInvert');
    if (invert) {
      invert.checked = s.invertY;
      invert.addEventListener('change', () => {
        s.invertY = invert.checked;
        this.ctx.saveSettings();
      });
    }
    const perf = document.getElementById('setPerf');
    if (perf) {
      perf.checked = s.showPerf;
      perf.addEventListener('change', () => {
        s.showPerf = perf.checked;
        this.el.perf.classList.toggle('hidden', !perf.checked);
        this.ctx.saveSettings();
      });
      this.el.perf.classList.toggle('hidden', !s.showPerf);
    }

    const quality = document.getElementById('setQuality');
    if (quality) {
      quality.value = this.ctx.quality.name;
      quality.addEventListener('change', () => {
        // A preset change alters texture sizes and shadow maps, which means a
        // rebuild. Reloading with the choice in the URL is honest and instant
        // rather than half-applying it.
        const url = new URL(location.href);
        url.searchParams.set('q', quality.value);
        location.href = url.toString();
      });
    }
  }
}

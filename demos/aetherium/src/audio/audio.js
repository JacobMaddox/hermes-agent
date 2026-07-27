import * as THREE from 'three';
import { scratch } from '../core/loop.js';
import { clamp } from '../core/rng.js';

// Audio.
//
// Round 1's Web Audio synthesis was genuinely good and it is kept here — the
// oscillator-plus-noise-burst approach to a plasma discharge still sounds
// right. What it lacked was a graph: everything went straight to a master
// gain, so a drone firing behind a wall sixty metres away was as loud and as
// centred as your own rifle.
//
// This routes every world sound through a PannerNode, adds a synthesised
// impulse-response reverb per district, and low-passes sources whose path to
// the listener is blocked by geometry.

const IR_PRESETS = {
  open: { time: 1.1, decay: 3.4, wet: 0.16, damp: 0.55 },
  street: { time: 1.6, decay: 2.6, wet: 0.24, damp: 0.42 },
  vault: { time: 2.8, decay: 1.7, wet: 0.42, damp: 0.28 },
  temple: { time: 3.4, decay: 1.5, wet: 0.38, damp: 0.22 }
};

export class AudioSystem {
  constructor() {
    this.ctxA = null;
    this.enabled = false;
    this._occlusionCache = new Map();
    this._occlusionT = 0;
    this._activeIr = 'open';
  }

  async init() {
    // Nothing until a user gesture: browsers refuse to start an AudioContext
    // before one, and starting it early just produces a suspended context.
  }

  start() {
    if (this.ctxA) {
      if (this.ctxA.state === 'suspended') this.ctxA.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      console.warn('[audio] Web Audio unavailable; running silent');
      return;
    }
    const a = new AC();
    this.ctxA = a;

    this.master = a.createGain();
    this.master.gain.value = this.ctx.settings.volume;
    this.master.connect(a.destination);

    // A gentle limiter so a grenade next to your face does not clip.
    this.limiter = a.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 9;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.16;
    this.limiter.connect(this.master);

    this.dry = a.createGain();
    this.dry.gain.value = 1;
    this.dry.connect(this.limiter);

    this.convolver = a.createConvolver();
    this.wet = a.createGain();
    this.wet.gain.value = IR_PRESETS.open.wet;
    this.convolver.connect(this.wet);
    this.wet.connect(this.limiter);

    this._irCache = {};
    this.setSpace('open');

    this.listener = a.listener;
    this.enabled = true;

    this._startAmbience();
    this._bind();
  }

  setVolume(v) {
    if (this.master) this.master.gain.value = v;
  }

  // ── Impulse responses ─────────────────────────────────────────────────

  // Exponentially-decaying noise with a lowpass sweep. Not a measured space,
  // but it gives each district a distinct tail — the vaults boom, the terrace
  // is nearly dry — which is most of what reverb is for here.
  _makeIr(preset) {
    const a = this.ctxA;
    const len = Math.floor(a.sampleRate * preset.time);
    const buf = a.createBuffer(2, len, a.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.pow(1 - t, preset.decay);
        const n = (Math.random() * 2 - 1) * env;
        // One-pole lowpass, brighter early and darker in the tail.
        const cutoff = 1 - preset.damp * t;
        lp += (n - lp) * cutoff;
        data[i] = lp;
      }
    }
    return buf;
  }

  setSpace(name) {
    if (!this.ctxA || this._activeIr === name) return;
    const preset = IR_PRESETS[name] || IR_PRESETS.open;
    if (!this._irCache[name]) this._irCache[name] = this._makeIr(preset);
    this.convolver.buffer = this._irCache[name];
    this.wet.gain.setTargetAtTime(preset.wet, this.ctxA.currentTime, 0.4);
    this._activeIr = name;
  }

  // ── Graph helpers ─────────────────────────────────────────────────────

  // A positioned voice: source -> occlusion lowpass -> gain -> panner, split
  // into the dry bus and the reverb send.
  _voice(position, opts = {}) {
    const a = this.ctxA;
    const panner = a.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = opts.refDistance || 4;
    panner.maxDistance = opts.maxDistance || 220;
    panner.rolloffFactor = opts.rolloff || 1.1;
    panner.positionX.value = position.x;
    panner.positionY.value = position.y;
    panner.positionZ.value = position.z;

    const filter = a.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = opts.cutoff || 20000;
    filter.Q.value = 0.7;

    const gain = a.createGain();
    gain.gain.value = opts.gain !== undefined ? opts.gain : 1;

    filter.connect(gain);
    gain.connect(panner);
    panner.connect(this.dry);
    // Reverb send is pre-panner so the tail is not hard-panned with the source.
    const send = a.createGain();
    send.gain.value = opts.send !== undefined ? opts.send : 0.5;
    gain.connect(send);
    send.connect(this.convolver);

    return { input: filter, gain, panner, filter };
  }

  _tone(voice, freq, type, duration, volume, slideTo) {
    const a = this.ctxA;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, a.currentTime);
    if (slideTo) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(1, slideTo), a.currentTime + duration
      );
    }
    g.gain.setValueAtTime(volume, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + duration);
    osc.connect(g);
    g.connect(voice.input);
    osc.start();
    osc.stop(a.currentTime + duration + 0.04);
  }

  _noise(voice, duration, volume, curve = 0.3, filterFreq = null) {
    const a = this.ctxA;
    const n = Math.max(1, Math.floor(a.sampleRate * duration));
    const buf = a.createBuffer(1, n, a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (n * curve));
    }
    const src = a.createBufferSource();
    src.buffer = buf;
    const g = a.createGain();
    g.gain.value = volume;
    if (filterFreq) {
      const f = a.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = filterFreq;
      src.connect(f); f.connect(g);
    } else {
      src.connect(g);
    }
    g.connect(voice.input);
    src.start();
  }

  // Occlusion: if the straight path from source to listener is blocked, roll
  // off the highs. Cached and rate-limited — a raycast per sound per frame
  // would cost more than the audio.
  _occlusion(position) {
    const phys = this.ctx.tryGet('physics');
    if (!phys) return 20000;
    const listener = this.ctx.camera.position;
    const key = `${Math.round(position.x / 3)}:${Math.round(position.y / 3)}:${Math.round(position.z / 3)}`;
    const now = this.ctx.time.elapsed;
    const cached = this._occlusionCache.get(key);
    if (cached && now - cached.t < 0.25) return cached.v;

    const clear = phys.lineOfSight(position, listener, 0.2);
    const v = clear ? 20000 : 900;
    this._occlusionCache.set(key, { v, t: now });
    if (this._occlusionCache.size > 256) this._occlusionCache.clear();
    return v;
  }

  // ── Sounds ────────────────────────────────────────────────────────────

  playerShot(position) {
    if (!this.enabled) return;
    // The player's own weapon is deliberately close-mic'd: low rolloff, wide
    // reference distance, so it stays present and centred.
    const v = this._voice(position, { refDistance: 20, rolloff: 0.2, send: 0.35, gain: 0.9 });
    this._tone(v, 940, 'sawtooth', 0.085, 0.2, 210);
    this._tone(v, 1560, 'square', 0.045, 0.1, 380);
    this._tone(v, 168, 'triangle', 0.12, 0.16, 62);
    this._noise(v, 0.09, 0.2, 0.28);
    // Mechanical tail.
    this._tone(v, 2400, 'square', 0.02, 0.03, 1400);
  }

  enemyShot(position) {
    if (!this.enabled) return;
    const v = this._voice(position, {
      refDistance: 6, rolloff: 1.4, send: 0.7, gain: 0.7,
      cutoff: this._occlusion(position)
    });
    this._tone(v, 210, 'sawtooth', 0.13, 0.2, 74);
    this._tone(v, 96, 'square', 0.16, 0.13);
    this._noise(v, 0.1, 0.12, 0.35, 2600);
  }

  impact(position, surface) {
    if (!this.enabled) return;
    const v = this._voice(position, {
      refDistance: 4, rolloff: 1.6, send: 0.5, gain: 0.55,
      cutoff: this._occlusion(position)
    });
    if (surface === 'metal') {
      this._tone(v, 2100, 'square', 0.055, 0.09, 900);
      this._noise(v, 0.07, 0.1, 0.2, 7000);
    } else if (surface === 'flesh') {
      this._tone(v, 150, 'triangle', 0.1, 0.15, 60);
      this._noise(v, 0.08, 0.1, 0.25, 1400);
    } else if (surface === 'wood') {
      this._tone(v, 340, 'triangle', 0.07, 0.1, 150);
      this._noise(v, 0.06, 0.08, 0.25, 2200);
    } else {
      this._noise(v, 0.08, 0.13, 0.22, 4200);
      this._tone(v, 420, 'triangle', 0.05, 0.06, 200);
    }
  }

  explosion(position) {
    if (!this.enabled) return;
    const v = this._voice(position, { refDistance: 12, rolloff: 0.8, send: 1.0, gain: 1.0 });
    this._tone(v, 130, 'sawtooth', 0.45, 0.3, 28);
    this._tone(v, 62, 'square', 0.6, 0.24, 18);
    this._noise(v, 0.5, 0.3, 0.36, 3800);
    // Debris rattle after the blast.
    setTimeout(() => {
      if (!this.enabled) return;
      const v2 = this._voice(position, { refDistance: 8, rolloff: 1.4, send: 0.8, gain: 0.4 });
      this._noise(v2, 0.5, 0.09, 0.7, 5200);
    }, 160);
  }

  footstep(position, surface, running) {
    if (!this.enabled) return;
    const v = this._voice(position, { refDistance: 2, rolloff: 2.4, send: 0.3, gain: running ? 0.5 : 0.32 });
    const base = surface === 'wood' ? 150 : surface === 'metal' ? 260 : 105;
    this._tone(v, base + Math.random() * 40, 'triangle', 0.055, 0.09);
    this._noise(v, 0.05, surface === 'rubble' ? 0.09 : 0.05, 0.2,
      surface === 'metal' ? 6000 : 1800);
  }

  land(position, impactSpeed) {
    if (!this.enabled) return;
    const v = this._voice(position, { refDistance: 3, rolloff: 2, send: 0.4, gain: 1 });
    const k = clamp(impactSpeed / 20, 0.2, 1);
    this._tone(v, 88, 'triangle', 0.14, 0.18 * k, 42);
    this._noise(v, 0.1, 0.1 * k, 0.25, 1600);
  }

  reload(phase) {
    if (!this.enabled) return;
    const pos = this.ctx.camera.position;
    const v = this._voice(pos, { refDistance: 30, rolloff: 0.1, send: 0.15, gain: 0.6 });
    switch (phase) {
      case 'magout':
        this._tone(v, 620, 'square', 0.05, 0.08, 380);
        this._noise(v, 0.06, 0.05, 0.3, 5000);
        break;
      case 'magin':
        this._tone(v, 340, 'square', 0.07, 0.11, 520);
        this._noise(v, 0.05, 0.06, 0.25, 3500);
        break;
      case 'charge':
        this._tone(v, 480, 'sawtooth', 0.12, 0.09, 900);
        this._tone(v, 1200, 'square', 0.04, 0.05, 700);
        break;
      case 'end':
        this._tone(v, 880, 'sine', 0.09, 0.06, 1320);
        break;
      default:
        this._tone(v, 260, 'square', 0.04, 0.05, 200);
    }
  }

  dryFire() {
    if (!this.enabled) return;
    const v = this._voice(this.ctx.camera.position, { refDistance: 30, rolloff: 0.1, gain: 0.5 });
    this._tone(v, 1400, 'square', 0.025, 0.05, 700);
  }

  hitmarker(headshot, kill) {
    if (!this.enabled) return;
    // Non-positional feedback: this is a UI sound, not a world sound.
    const a = this.ctxA;
    const g = a.createGain();
    g.gain.value = 0.28;
    g.connect(this.limiter);
    const v = { input: g };
    if (kill) {
      this._tone(v, 900, 'sine', 0.07, 0.22, 1400);
      this._tone(v, 1350, 'sine', 0.11, 0.16, 1800);
    } else if (headshot) {
      this._tone(v, 1500, 'square', 0.04, 0.14, 1900);
      this._tone(v, 1000, 'sine', 0.06, 0.1, 1300);
    } else {
      this._tone(v, 1150, 'square', 0.03, 0.1, 1400);
    }
  }

  pickup() {
    if (!this.enabled) return;
    const a = this.ctxA;
    const g = a.createGain();
    g.gain.value = 0.3;
    g.connect(this.limiter);
    const v = { input: g };
    this._tone(v, 660, 'sine', 0.11, 0.2, 990);
    this._tone(v, 990, 'sine', 0.15, 0.14, 1320);
  }

  objective(success = true) {
    if (!this.enabled) return;
    const a = this.ctxA;
    const g = a.createGain();
    g.gain.value = 0.34;
    g.connect(this.limiter);
    const v = { input: g };
    if (success) {
      this._tone(v, 392, 'sine', 0.4, 0.18);
      setTimeout(() => this.enabled && this._tone(v, 523, 'sine', 0.4, 0.18), 140);
      setTimeout(() => this.enabled && this._tone(v, 784, 'sine', 0.7, 0.16), 300);
    } else {
      this._tone(v, 220, 'sawtooth', 0.5, 0.2, 90);
      this._tone(v, 110, 'square', 0.7, 0.14, 50);
    }
  }

  alert() {
    if (!this.enabled) return;
    const a = this.ctxA;
    const g = a.createGain();
    g.gain.value = 0.22;
    g.connect(this.limiter);
    const v = { input: g };
    this._tone(v, 180, 'sawtooth', 0.22, 0.18, 320);
    this._tone(v, 90, 'square', 0.3, 0.12, 160);
  }

  telegraph(position) {
    if (!this.enabled) return;
    const v = this._voice(position, {
      refDistance: 8, rolloff: 1.5, send: 0.4, gain: 0.5,
      cutoff: this._occlusion(position)
    });
    // Rising whine: the audible half of the fire warning.
    this._tone(v, 320, 'sawtooth', 0.3, 0.1, 1100);
  }

  // ── Ambience ──────────────────────────────────────────────────────────

  _startAmbience() {
    const a = this.ctxA;
    // Wind: filtered noise loop with a slowly wandering cutoff. Cheap, and it
    // fills the silence that made round 1 feel like a tech demo between shots.
    const len = a.sampleRate * 4;
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const n = Math.random() * 2 - 1;
      lp += (n - lp) * 0.02;
      // Crossfade the last 0.25s into the start so the loop has no seam.
      d[i] = lp * 3.2;
    }
    const fade = Math.floor(a.sampleRate * 0.25);
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      d[i] = d[i] * k + d[len - fade + i] * (1 - k);
    }

    const src = a.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = a.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.6;
    const gain = a.createGain();
    gain.gain.value = 0.05;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.limiter);
    src.start();
    this._windFilter = filter;
    this._windGain = gain;

    // A low drone under everything, tuned to the aether fiction.
    const osc = a.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 55;
    const og = a.createGain();
    og.gain.value = 0.025;
    osc.connect(og);
    og.connect(this.limiter);
    osc.start();
    this._droneGain = og;
  }

  _bind() {
    const bus = this.ctx.bus;
    bus.on('weapon:fire', (e) => this.playerShot(e.position || this.ctx.camera.position));
    bus.on('weapon:dryfire', () => this.dryFire());
    bus.on('weapon:reload', (e) => this.reload(e.phase));
    bus.on('weapon:hitmarker', (e) => this.hitmarker(e.headshot, e.kill));
    bus.on('ai:fire', (e) => this.enemyShot(e.position));
    bus.on('ai:telegraph', (e) => this.telegraph(e.actor.position));
    bus.on('ai:alerted', () => this.alert());
    bus.on('bullet:impact', (e) => this.impact(e.point, e.surface));
    bus.on('explosion', (e) => this.explosion(e.point));
    bus.on('player:footstep', (e) => this.footstep(e.position, e.surface, e.running));
    bus.on('player:land', (e) => this.land(this.ctx.get('player').position, e.impactSpeed));
    bus.on('pickup:taken', () => this.pickup());
    bus.on('objective:advance', () => this.objective(true));
    bus.on('player:death', () => this.objective(false));
  }

  // ── Per-frame ─────────────────────────────────────────────────────────

  update(dt) {
    if (!this.enabled) return;
    const a = this.ctxA;
    const cam = this.ctx.camera;
    const L = a.listener;

    const fwd = cam.getWorldDirection(scratch.v0);
    const up = scratch.v1.set(0, 1, 0).applyQuaternion(cam.quaternion);

    // Newer browsers expose AudioParams on the listener; older ones only have
    // the deprecated setters.
    if (L.positionX) {
      const t = a.currentTime;
      L.positionX.setValueAtTime(cam.position.x, t);
      L.positionY.setValueAtTime(cam.position.y, t);
      L.positionZ.setValueAtTime(cam.position.z, t);
      L.forwardX.setValueAtTime(fwd.x, t);
      L.forwardY.setValueAtTime(fwd.y, t);
      L.forwardZ.setValueAtTime(fwd.z, t);
      L.upX.setValueAtTime(up.x, t);
      L.upY.setValueAtTime(up.y, t);
      L.upZ.setValueAtTime(up.z, t);
    } else if (L.setPosition) {
      L.setPosition(cam.position.x, cam.position.y, cam.position.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }

    // Wind rises with altitude and drops when you go underground.
    const player = this.ctx.tryGet('player');
    if (this._windFilter && player) {
      const alt = clamp((player.position.y + 20) / 60, 0, 1);
      const indoors = this._activeIr === 'vault';
      this._windGain.gain.setTargetAtTime(
        indoors ? 0.012 : 0.03 + alt * 0.05, a.currentTime, 0.6
      );
      this._windFilter.frequency.setTargetAtTime(
        320 + alt * 400 + Math.sin(this.ctx.time.elapsed * 0.21) * 90, a.currentTime, 0.8
      );
    }
  }

  suspend() {
    if (this.ctxA && this.ctxA.state === 'running') this.ctxA.suspend();
  }

  resume() {
    if (this.ctxA && this.ctxA.state === 'suspended') this.ctxA.resume();
  }
}

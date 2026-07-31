import * as THREE from 'three';
import { damp, clamp } from '../core/rng.js';
import { DISTRICTS, TEMPLE_APRON } from './world.js';

// District atmosphere.
//
// The archipelago is one contiguous scene and always has been — there is no
// loading between districts and never was. What was missing is that crossing
// from the open terrace into the sunken vaults felt like nothing, because every
// district shared one fog colour, one exposure and one reverb.
//
// Each district declares its own air: fog density and tint, an exposure offset,
// grade contrast and saturation, and an audio space. The player's position
// blends between them continuously, so a crossing is a gradient rather than a
// switch, and nothing ever stops to load.

export const ZONES = {
  landing: {
    label: 'Landing Terrace',
    fogColour: 0xa8c6e4, fogDensity: 0.0020,
    exposure: 0.62, contrast: 1.13, saturation: 1.14,
    space: 'open', hemi: 0.22
  },
  market: {
    label: 'Market Tier',
    // Warmer and slightly hazier — awnings, dust, bodies, cooking smoke.
    fogColour: 0xb8c2d0, fogDensity: 0.0030,
    exposure: 0.60, contrast: 1.15, saturation: 1.20,
    space: 'street', hemi: 0.24
  },
  vaults: {
    label: 'Sunken Vaults',
    // Cold, close and dark. The aether pools are the only light down here, so
    // the exposure drops and the fog thickens to shorten sightlines.
    fogColour: 0x2a3850, fogDensity: 0.0140,
    exposure: 0.50, contrast: 1.24, saturation: 0.92,
    space: 'vault', hemi: 0.10
  },
  ruins: {
    label: 'Ruined District',
    // Dust hanging in the air over broken stone.
    fogColour: 0xc0bbae, fogDensity: 0.0044,
    exposure: 0.63, contrast: 1.10, saturation: 1.04,
    space: 'open', hemi: 0.26
  },
  temple: {
    label: 'Temple Plateau',
    // High, open and gilded. Thin air, long views, warm bounce off the dome.
    fogColour: 0xbcd2ea, fogDensity: 0.0016,
    exposure: 0.66, contrast: 1.12, saturation: 1.18,
    space: 'temple', hemi: 0.26
  }
};

// Falloff beyond a district's footprint over which its influence decays. Wide
// enough that bridges are a genuine blend of the two ends they connect.
const FALLOFF = 26;

export class ZoneSystem {
  constructor() {
    this.current = 'landing';
    this._weights = {};
    this._blend = {
      fogColour: new THREE.Color(0xa8c6e4),
      fogDensity: 0.0020,
      exposure: 0.62,
      contrast: 1.13,
      saturation: 1.14,
      hemi: 0.22
    };
    this._seen = new Set();
    this._cardT = 0;
  }

  async init() {
    this.cardEl = document.getElementById('districtCard');
  }

  async ready() {
    // The apron belongs to the temple's air even though it is a separate
    // island — you are already in the temple's world by the time you land on it.
    this._regions = Object.keys(ZONES).map((key) => ({
      key,
      zone: ZONES[key],
      boxes: key === 'temple'
        ? [DISTRICTS.temple, TEMPLE_APRON]
        : [DISTRICTS[key]]
    }));
    for (const k of Object.keys(ZONES)) this._weights[k] = 0;
    this._weights.landing = 1;
    this._apply(1);
  }

  // Influence of a district at a point: 1 inside its footprint, falling to 0
  // over FALLOFF metres outside it. Height matters too — standing on the
  // temple plateau should not pick up the market's air from 20m below.
  _influence(region, p) {
    let best = 0;
    for (const b of region.boxes) {
      const dx = Math.max(0, Math.abs(p.x - b.x) - b.w / 2);
      const dz = Math.max(0, Math.abs(p.z - b.z) - b.d / 2);
      const dy = Math.max(0, Math.abs(p.y - b.y) - 12);
      const d = Math.hypot(dx, dz) + dy * 1.5;
      best = Math.max(best, 1 - clamp(d / FALLOFF, 0, 1));
    }
    return best * best;   // squared, so the nearest district dominates
  }

  update(dt) {
    const player = this.ctx.tryGet('player');
    if (!player || !this._regions) return;

    // Re-weight on a slow cadence; the blend below runs every frame regardless,
    // so this costs nothing visually.
    if (this.ctx.time.frame % 6 === 0) {
      let total = 0;
      let top = 0;
      let topKey = this.current;
      for (const r of this._regions) {
        const w = this._influence(r, player.position);
        this._weights[r.key] = w;
        total += w;
        if (w > top) { top = w; topKey = r.key; }
      }
      if (total > 0.001) {
        for (const r of this._regions) this._weights[r.key] /= total;
      } else {
        // Out over the void between islands — hold the last air.
        this._weights[this.current] = 1;
      }
      if (topKey !== this.current && top > 0.45) {
        this.current = topKey;
        this._onEnter(topKey);
      }
    }

    this._blendTargets(dt);
    this._apply(dt);
    this._updateCard(dt);
  }

  _blendTargets(dt) {
    let fogR = 0, fogG = 0, fogB = 0;
    let density = 0, exposure = 0, contrast = 0, saturation = 0, hemi = 0;
    const c = new THREE.Color();

    for (const r of this._regions) {
      const w = this._weights[r.key];
      if (w <= 0.0001) continue;
      const z = r.zone;
      c.setHex(z.fogColour);
      fogR += c.r * w; fogG += c.g * w; fogB += c.b * w;
      density += z.fogDensity * w;
      exposure += z.exposure * w;
      contrast += z.contrast * w;
      saturation += z.saturation * w;
      hemi += z.hemi * w;
    }

    // Damped toward the weighted target rather than snapped, so even a fast
    // crossing reads as the air changing around you.
    const b = this._blend;
    const rate = 1.6;
    b.fogColour.setRGB(
      damp(b.fogColour.r, fogR, rate, dt),
      damp(b.fogColour.g, fogG, rate, dt),
      damp(b.fogColour.b, fogB, rate, dt)
    );
    b.fogDensity = damp(b.fogDensity, density, rate, dt);
    b.exposure = damp(b.exposure, exposure, rate, dt);
    b.contrast = damp(b.contrast, contrast, rate, dt);
    b.saturation = damp(b.saturation, saturation, rate, dt);
    b.hemi = damp(b.hemi, hemi, rate, dt);
  }

  _apply() {
    const ctx = this.ctx;
    const b = this._blend;

    if (ctx.scene.fog) {
      ctx.scene.fog.color.copy(b.fogColour);
      ctx.scene.fog.density = b.fogDensity;
    }
    const render = ctx.tryGet('render');
    if (render) {
      render.setExposure(b.exposure);
      if (render.grade) {
        render.grade.uniforms.uContrast.value = b.contrast;
        render.grade.uniforms.uSaturation.value = b.saturation;
      }
      if (render.hemi) render.hemi.intensity = b.hemi;
    }
  }

  _onEnter(key) {
    const zone = ZONES[key];
    const audio = this.ctx.tryGet('audio');
    if (audio && audio.enabled) audio.setSpace(zone.space);

    this.ctx.bus.emit('district:enter', { key, label: zone.label });

    // The card is a first-visit thing. Announcing "MARKET TIER" every time you
    // step back across a bridge would be noise.
    if (this._seen.has(key)) return;
    this._seen.add(key);
    if (this.cardEl) {
      this.cardEl.textContent = zone.label;
      this.cardEl.classList.add('show');
      this._cardT = 3.4;
    }
  }

  _updateCard(dt) {
    if (this._cardT <= 0) return;
    this._cardT -= dt;
    if (this._cardT <= 0 && this.cardEl) this.cardEl.classList.remove('show');
  }

  reset() {
    this._seen.clear();
    this.current = 'landing';
  }
}

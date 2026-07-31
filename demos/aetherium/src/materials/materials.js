import * as THREE from 'three';
import { Noise2D, clamp } from '../core/rng.js';
import { SURFACES } from './surfaces.js';

// Procedural PBR material bakery.
//
// Nothing here loads a file. For each surface we evaluate its sampler over a
// grid to get albedo + a height field + roughness, then derive a tangent-space
// normal map from the height with a Sobel filter and a cavity AO term from the
// difference between the height and its local average.
//
// Maps are packed ORM-style — AO in red, roughness in green — so one texture
// serves both slots and we upload two textures per surface instead of four.
// Metalness stays a scalar per material (metals are 0 or 1; a metalness map
// with intermediate values is almost always a mistake).

const OUT = new Float32Array(5);

export class MaterialSystem {
  constructor() {
    this.materials = new Map();
    this.textures = new Map();
    this._noise = null;
    this._simple = new Map();
  }

  async init() {
    const ctx = this.ctx;
    const size = ctx.quality.textureSize;
    this._noise = new Noise2D(ctx.rng.fork(0x5eed).seed);

    this._buildMacroVariation(ctx.quality.textureSize >= 512 ? 256 : 128);

    const names = Object.keys(SURFACES);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      this._bakeSurface(name, SURFACES[name], size);
      if (ctx.onProgress) {
        ctx.onProgress((i + 1) / names.length, `Synthesising ${name}`);
      }
      // Yield so the loading bar actually paints between surfaces instead of
      // the whole bake landing as one frozen block.
      await new Promise((r) => setTimeout(r, 0));
    }

    this._buildSpecials();
  }

  // Macro variation.
  //
  // A tiling texture repeated across a 68-metre market floor reads as a tiling
  // texture, however good the tile is — the eye locks onto the period long
  // before it notices the detail. The standard fix is to modulate albedo with a
  // second, much lower-frequency field sampled at a different scale, so the
  // repeat never lines up with itself. It costs one extra texture fetch and it
  // is the single most effective thing available here.
  //
  // Injected through onBeforeCompile rather than baked, precisely because it
  // has to vary at a scale *larger* than the tile: baking it in would make it
  // repeat along with everything else and achieve nothing.
  _buildMacroVariation(size = 256) {
    const noise = new Noise2D(this.ctx.rng.fork(0xac0f).seed);
    const data = new Uint8Array(size * size * 4);
    const inv = 1 / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const n = noise.tiling(x * inv * 3, y * inv * 3, 3, 4, 2.0, 0.6);
        const v = clamp(0.5 + n * 0.5, 0, 1);
        const o = (y * size + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = v * 255;
        data[o + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    this._macroTex = tex;
    return tex;
  }

  _applyMacroVariation(mat, strength, scale) {
    const tex = this._macroTex;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uMacro = { value: tex };
      shader.uniforms.uMacroScale = { value: scale };
      shader.uniforms.uMacroStrength = { value: strength };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>',
          '#include <common>\n' +
          'uniform sampler2D uMacro;\n' +
          'uniform float uMacroScale;\n' +
          'uniform float uMacroStrength;')
        .replace('#include <map_fragment>',
          '#include <map_fragment>\n' +
          '#ifdef USE_MAP\n' +
          '  {\n' +
          '    float macro = texture2D(uMacro, vMapUv * uMacroScale).r;\n' +
          '    diffuseColor.rgb *= 1.0 + (macro - 0.5) * 2.0 * uMacroStrength;\n' +
          '  }\n' +
          '#endif');
    };
    // Materials with different injected code must not share a compiled
    // program, and Three keys its cache on this string.
    mat.customProgramCacheKey = () => `macro:${strength.toFixed(2)}:${scale}`;
  }

  _bakeSurface(name, def, size) {
    const n = size * size;
    const albedo = new Uint8Array(n * 4);
    const height = new Float32Array(n);
    const rough = new Float32Array(n);
    const noise = this._noise;
    const inv = 1 / size;

    for (let y = 0; y < size; y++) {
      const v = y * inv;
      const row = y * size;
      for (let x = 0; x < size; x++) {
        def.sample(x * inv, v, noise, OUT);
        const i = row + x;
        const o = i * 4;
        albedo[o] = OUT[0] * 255;
        albedo[o + 1] = OUT[1] * 255;
        albedo[o + 2] = OUT[2] * 255;
        albedo[o + 3] = 255;
        height[i] = OUT[3];
        rough[i] = OUT[4];
      }
    }

    const bump = def.bump !== undefined ? def.bump : 1.0;
    const normal = this._heightToNormal(height, size, bump);
    const orm = this._packOrm(height, rough, size);

    const albedoTex = this._makeTexture(albedo, size, THREE.SRGBColorSpace);
    const normalTex = this._makeTexture(normal, size, THREE.NoColorSpace);
    const ormTex = this._makeTexture(orm, size, THREE.NoColorSpace);

    const mat = new THREE.MeshStandardMaterial({
      map: albedoTex,
      normalMap: normalTex,
      aoMap: ormTex,
      roughnessMap: ormTex,
      metalness: def.metalness,
      roughness: 1.0,
      aoMapIntensity: 0.85,
      envMapIntensity: 1.0,
      normalScale: new THREE.Vector2(def.normalScale || 1.0, def.normalScale || 1.0)
    });
    mat.name = name;
    // aoMap defaults to the second UV set in some pipelines; every mesh here
    // carries a single UV channel, so pin it explicitly.
    ormTex.channel = 0;

    // Large flat surfaces need the most help; a column or a crate never shows
    // enough of itself at once for the repeat to register.
    const macro = def.macro !== undefined ? def.macro : 0.18;
    if (macro > 0) this._applyMacroVariation(mat, macro, def.macroScale || 0.07);

    this.textures.set(name, { albedo: albedoTex, normal: normalTex, orm: ormTex });
    this.materials.set(name, mat);
  }

  // Sobel over the height field, wrapping at the edges so the normal map tiles
  // as seamlessly as the albedo it came from.
  _heightToNormal(height, size, strength) {
    const out = new Uint8Array(size * size * 4);
    const w = size;
    // Sobel output is a difference between neighbouring texels, so this scale
    // is the whole character of the surface. Too high and every material turns
    // into molten wax with no readable silhouette — which is exactly what it
    // did at the first attempt. Keep it modest and let per-surface `bump`
    // do the tuning.
    const scale = strength * 2.2;
    for (let y = 0; y < size; y++) {
      const ym = ((y - 1 + size) % size) * w;
      const y0 = y * w;
      const yp = ((y + 1) % size) * w;
      for (let x = 0; x < size; x++) {
        const xm = (x - 1 + size) % size;
        const xp = (x + 1) % size;

        const tl = height[ym + xm], t = height[ym + x], tr = height[ym + xp];
        const l = height[y0 + xm], r = height[y0 + xp];
        const bl = height[yp + xm], b = height[yp + x], br = height[yp + xp];

        const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);

        let nx = -dx * scale;
        let ny = -dy * scale;
        let nz = 1;
        const len = Math.hypot(nx, ny, nz);
        nx /= len; ny /= len; nz /= len;

        const o = (y0 + x) * 4;
        out[o] = (nx * 0.5 + 0.5) * 255;
        out[o + 1] = (ny * 0.5 + 0.5) * 255;
        out[o + 2] = (nz * 0.5 + 0.5) * 255;
        out[o + 3] = 255;
      }
    }
    return out;
  }

  // Cavity AO: blur the height, then darken wherever a texel sits below its
  // neighbourhood. Cheap, and it is what makes mortar joints and panel seams
  // read as recessed rather than merely painted darker.
  _packOrm(height, rough, size) {
    const n = size * size;
    const blur = new Float32Array(n);
    const tmp = new Float32Array(n);
    const radius = Math.max(2, Math.floor(size / 48));

    // Separable box blur, wrapping.
    const invW = 1 / (radius * 2 + 1);
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++) s += height[row + ((x + k + size) % size)];
        tmp[row + x] = s * invW;
      }
    }
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++) s += tmp[((y + k + size) % size) * size + x];
        blur[y * size + x] = s * invW;
      }
    }

    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const cavity = clamp(1 - (blur[i] - height[i]) * 2.4, 0.15, 1);
      const o = i * 4;
      out[o] = cavity * 255;
      out[o + 1] = clamp(rough[i], 0, 1) * 255;
      out[o + 2] = 0;
      out[o + 3] = 255;
    }
    return out;
  }

  _makeTexture(data, size, colorSpace) {
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.colorSpace = colorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = this.ctx.get('render').maxAnisotropy;
    tex.needsUpdate = true;
    return tex;
  }

  // Materials that are not surface-textured: glass, emissives, the cloud sea.
  _buildSpecials() {
    const add = (name, mat) => {
      mat.name = name;
      this._simple.set(name, mat);
    };

    add('glass', new THREE.MeshPhysicalMaterial({
      color: 0xbfe4ff,
      metalness: 0,
      roughness: 0.06,
      transmission: 0.92,
      thickness: 0.35,
      ior: 1.45,
      transparent: true,
      opacity: 0.5,
      envMapIntensity: 1.4,
      side: THREE.DoubleSide
    }));

    add('aether', new THREE.MeshStandardMaterial({
      color: 0x2f8fd6,
      emissive: 0x2fa8ff,
      emissiveIntensity: 2.6,
      roughness: 0.25,
      metalness: 0.1,
      transparent: true,
      opacity: 0.88
    }));

    // Void Syndicate dark energy. Violet against a warm marble-and-gold world
    // is both the faction's visual language and the reason you can pick a
    // hostile out of the scene at range.
    add('hostile', new THREE.MeshStandardMaterial({
      color: 0x2e0a50,
      emissive: 0xc040ff,
      emissiveIntensity: 3.2,
      roughness: 0.3,
      metalness: 0.0
    }));

    add('beacon', new THREE.MeshStandardMaterial({
      color: 0x2a0c40,
      emissive: 0xb040ff,
      emissiveIntensity: 2.4,
      roughness: 0.35,
      metalness: 0.2
    }));

    add('lamp', new THREE.MeshStandardMaterial({
      color: 0xffe6b0,
      emissive: 0xffcf80,
      emissiveIntensity: 3.0,
      roughness: 0.4,
      metalness: 0.0
    }));

    add('void', new THREE.MeshBasicMaterial({ color: 0x0a0d18 }));
  }

  get(name) {
    const m = this.materials.get(name) || this._simple.get(name);
    if (!m) throw new Error(`unknown material: ${name}`);
    return m;
  }

  // Metres per texture repeat for a surface. The geometry kit needs this to
  // scale UVs to world scale rather than stretching one copy over a whole wall.
  tileOf(name) {
    const def = SURFACES[name];
    return def ? def.tile : 2;
  }

  // A one-off variant sharing the baked maps. Used sparingly — for anything
  // that needs a different tint or emissive on the same surface, so we do not
  // pay for a second bake.
  variant(name, overrides) {
    const base = this.get(name);
    const m = base.clone();
    Object.assign(m, overrides);
    m.name = `${name}:variant`;
    return m;
  }

  // Assigns the baked environment map to every material once the sky has
  // produced it. Without this, metals have nothing to reflect and gold renders
  // as a flat dull brown — the single biggest reason round 1's dome looked
  // lifeless despite being metalness 0.95.
  applyEnvironment(envMap, intensity = 1.0) {
    // Metals get a much stronger environment weight than dielectrics. A metal
    // has no diffuse term at all — everything you see on it is reflection — so
    // at parity with stone the gold dome reflected a blue-white sky through a
    // gold F0 and came out olive. Boosting the metal term restores the warm
    // multiple-bounce look real gilding has.
    const apply = (m) => {
      m.envMap = envMap;
      m.envMapIntensity = intensity * (m.metalness > 0.5 ? 3.2 : 0.9);
      m.needsUpdate = true;
    };
    this.materials.forEach(apply);
    this._simple.forEach((m) => {
      if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) apply(m);
    });

    // A whisper of warm self-illumination on the gilding. Not physical, but the
    // temple dome is the landmark the entire level points at, and it has to
    // read as gold from 150 metres away in fog, not merely be gold up close.
    const gold = this.materials.get('gold');
    if (gold) {
      gold.emissive = new THREE.Color(0x3a2408);
      gold.emissiveIntensity = 0.5;
      gold.needsUpdate = true;
    }
  }

  dispose() {
    this.materials.forEach((m) => m.dispose());
    this.textures.forEach((set) => {
      set.albedo.dispose();
      set.normal.dispose();
      set.orm.dispose();
    });
  }
}

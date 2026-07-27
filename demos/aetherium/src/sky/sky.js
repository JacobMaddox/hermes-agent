import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Noise2D, clamp, smoothstep } from '../core/rng.js';

// Sky, cloud sea and image-based lighting.
//
// Round 1 set scene.background to a flat blue and called it done, which left
// every metal in the scene with nothing to reflect. Here a physically-based
// Rayleigh/Mie sky is rendered once into a PMREM probe and handed to every
// material as an environment map, so gold behaves like gold and marble picks
// up sky bounce on its upward faces.
//
// The cloud sea below the islands is several alpha-blended discs at different
// altitudes scrolling at different rates. Cheap, and the parallax between the
// layers is what sells the sense of height when you look over an edge.

const SUN_ELEVATION_DEG = 17.5;
const SUN_AZIMUTH_DEG = 148;

export class SkySystem {
  constructor() {
    this.sky = null;
    this.sunDirection = new THREE.Vector3();
    this.cloudLayers = [];
    this.envRT = null;
    this._pmrem = null;
    this._time = 0;
  }

  async init() {
    const ctx = this.ctx;
    const scene = ctx.scene;

    const sky = new Sky();
    sky.scale.setScalar(20000);
    sky.name = 'sky';
    const u = sky.material.uniforms;
    // Late-afternoon air. Turbidity and rayleigh both drive overall sky
    // radiance, which feeds the environment probe and therefore the whole
    // scene's ambient level — pushed too far they wash the world out long
    // before the sky itself looks wrong.
    u.turbidity.value = 4.5;
    u.rayleigh.value = 1.35;
    u.mieCoefficient.value = 0.0042;
    u.mieDirectionalG.value = 0.8;
    this.sky = sky;

    const phi = THREE.MathUtils.degToRad(90 - SUN_ELEVATION_DEG);
    const theta = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG);
    this.sunDirection.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDirection);

    scene.add(sky);

    this._buildCloudSea();
    this._buildSpires();
  }

  // Runs after every subsystem has initialised, so the probe captures the sky
  // and the distant skyline together.
  async ready() {
    this._bakeEnvironment();
    this._applyFog();
    this.ctx.get('render').setSunDirection(this.sunDirection);
  }

  _bakeEnvironment() {
    const ctx = this.ctx;
    const renderer = ctx.renderer;

    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    this._pmrem = pmrem;

    // Capture the sky alone. Including world geometry would bake the temple
    // into every reflection and pin the lighting to one spot on the map.
    const envScene = new THREE.Scene();
    const skyClone = this.sky;
    const parent = skyClone.parent;
    envScene.add(skyClone);

    this.envRT = pmrem.fromScene(envScene, 0.04);
    if (parent) parent.add(skyClone);

    ctx.scene.environment = this.envRT.texture;
    ctx.scene.environmentIntensity = 0.55;
    ctx.get('materials').applyEnvironment(this.envRT.texture, 0.55);

    pmrem.dispose();
  }

  // Fog colour is read out of the baked probe rather than hand-picked, so the
  // horizon can never seam against the sky the way round 1's mismatched
  // background and fog colours did.
  _applyFog() {
    const ctx = this.ctx;
    const horizon = this._sampleHorizonColour();
    // Nudge toward the sky's blue so distant geometry recedes rather than
    // simply fading to grey, and keep the density low: the archipelago is 200m
    // across and the far islands have to stay legible.
    horizon.lerp(new THREE.Color(0x9dbfe0), 0.35);
    ctx.scene.fog = new THREE.FogExp2(horizon.getHex(), 0.0022);
    this.horizonColour = horizon;
  }

  _sampleHorizonColour() {
    const renderer = this.ctx.renderer;
    // Render the sky shader into a 1x1 target aimed at the horizon opposite
    // the sun; that is the colour distant geometry should fade toward.
    const rt = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType });
    const cam = new THREE.PerspectiveCamera(30, 1, 1, 100000);
    cam.position.set(0, 0, 0);
    cam.lookAt(-this.sunDirection.x, 0.06, -this.sunDirection.z);

    const s = new THREE.Scene();
    const parent = this.sky.parent;
    s.add(this.sky);
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(s, cam);
    renderer.setRenderTarget(prevTarget);
    if (parent) parent.add(this.sky);

    const buf = new Uint16Array(16 * 16 * 4);
    let colour = new THREE.Color(0xa8c4e0);
    try {
      renderer.readRenderTargetPixels(rt, 0, 0, 16, 16, buf);
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < 16 * 16; i++) {
        r += fromHalf(buf[i * 4]);
        g += fromHalf(buf[i * 4 + 1]);
        b += fromHalf(buf[i * 4 + 2]);
      }
      const n = 16 * 16;
      // The probe is linear HDR; tone it down and convert roughly to sRGB so
      // the fog sits where the tone-mapped sky lands on screen.
      // Match the renderer's exposure before the gamma step, or the fog reads
      // far brighter than the sky it is supposed to blend into.
      const exposure = renderer.toneMappingExposure;
      colour = new THREE.Color(
        clamp(Math.pow(clamp(r / n * exposure, 0, 1), 1 / 2.2), 0, 1),
        clamp(Math.pow(clamp(g / n * exposure, 0, 1), 1 / 2.2), 0, 1),
        clamp(Math.pow(clamp(b / n * exposure, 0, 1), 1 / 2.2), 0, 1)
      );
    } catch (err) {
      console.warn('[sky] horizon readback failed, using fallback fog:', err.message);
    }
    rt.dispose();
    return colour;
  }

  _cloudTexture(size, seed, coverage, softness) {
    const noise = new Noise2D(seed);
    const data = new Uint8Array(size * size * 4);
    const inv = 1 / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x * inv;
        const v = y * inv;
        // Two octave sets: billows for the mass, wisps for the fringe.
        const billow = Math.abs(noise.tiling(u * 3, v * 3, 3, 5, 2.2, 0.55));
        const wisp = noise.tiling(u * 9, v * 9, 9, 3);
        const d = billow * 0.75 + wisp * 0.25 + 0.15;
        const a = smoothstep(coverage, coverage + softness, d);

        // No radial falloff here. The first version faded each disc toward its
        // rim in texture space and then scrolled the texture across the plane,
        // which slid the fade off the geometry and left hard rectangular edges
        // hanging in the sky. The noise tiles seamlessly, so the plane simply
        // repeats and its actual rim sits far outside the fog.
        //
        // Bright, because these are sunlit cloud tops against a bright sky:
        // mid-grey clouds read as dark slabs once the sky is exposed properly.
        const shade = 1.05 + clamp(wisp, -1, 1) * 0.16 + billow * 0.2;
        const o = (y * size + x) * 4;
        data[o] = clamp(shade * 1.0, 0, 1) * 255;
        data[o + 1] = clamp(shade * 0.99, 0, 1) * 255;
        data[o + 2] = clamp(shade * 1.0, 0, 1) * 255;
        data[o + 3] = clamp(a, 0, 1) * 255;
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  _buildCloudSea() {
    const ctx = this.ctx;
    const q = ctx.quality;
    const count = q.cloudLayers;
    const size = q.textureSize >= 512 ? 512 : 256;

    // Altitudes descend into haze; the lowest layers are the "sea floor" you
    // see when you look over the edge of an island.
    // Layers above the player are deliberately sparse and faint: seen from
    // underneath they are the one thing that can read as a solid ceiling.
    const specs = [
      { y: -34, scale: 900, opacity: 0.95, speed: 0.0016, coverage: 0.30, soft: 0.34, repeat: 3 },
      { y: -58, scale: 1500, opacity: 0.85, speed: 0.0011, coverage: 0.22, soft: 0.40, repeat: 4 },
      { y: 96, scale: 2400, opacity: 0.30, speed: 0.0022, coverage: 0.62, soft: 0.30, repeat: 5 },
      { y: -96, scale: 2400, opacity: 0.70, speed: 0.0007, coverage: 0.18, soft: 0.45, repeat: 5 },
      { y: 150, scale: 3200, opacity: 0.20, speed: 0.0030, coverage: 0.70, soft: 0.24, repeat: 6 }
    ];

    for (let i = 0; i < count && i < specs.length; i++) {
      const s = specs[i];
      const tex = this._cloudTexture(size, 0xc10d5 + i * 7919, s.coverage, s.soft);
      // Tile the noise rather than stretching one copy over a 900-3000 unit
      // plane, which would smear it into featureless haze.
      tex.repeat.set(s.repeat, s.repeat);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: s.opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
        toneMapped: true
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(s.scale, s.scale, 1, 1), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = s.y;
      mesh.renderOrder = -10 + i;
      mesh.frustumCulled = false;
      ctx.scene.add(mesh);
      this.cloudLayers.push({ mesh, speed: s.speed, tex });
    }
  }

  // Distant floating spires. Pure silhouette — they exist to give the horizon
  // scale and to tell the player the archipelago continues past the playable
  // islands. Never collided against, never lit interestingly.
  _buildSpires() {
    const ctx = this.ctx;
    const rng = ctx.rng.fork(0x5217e);
    const group = new THREE.Group();
    group.name = 'skyline';

    const geo = new THREE.CylinderGeometry(0.6, 1, 1, 7, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x9fb4cc,
      roughness: 0.95,
      metalness: 0,
      fog: true
    });

    const count = 46;
    const inst = new THREE.InstancedMesh(geo, mat, count);
    inst.castShadow = false;
    inst.receiveShadow = false;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
      const ang = rng.range(0, Math.PI * 2);
      const dist = rng.range(320, 900);
      const h = rng.range(30, 130);
      pos.set(Math.cos(ang) * dist, rng.range(-70, 20), Math.sin(ang) * dist);
      scl.set(rng.range(8, 26), h, rng.range(8, 26));
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI * 2));
      m.compose(pos, q, scl);
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = false;
    group.add(inst);
    ctx.scene.add(group);
    this.spires = group;
  }

  update(dt) {
    this._time += dt;
    // Scroll the cloud maps rather than moving the meshes, so the discs stay
    // centred on the player and never run out.
    const cam = this.ctx.camera;
    for (let i = 0; i < this.cloudLayers.length; i++) {
      const l = this.cloudLayers[i];
      l.tex.offset.x = this._time * l.speed;
      l.tex.offset.y = this._time * l.speed * 0.35;
      l.mesh.position.x = cam.position.x;
      l.mesh.position.z = cam.position.z;
    }
    this.sky.position.set(cam.position.x, 0, cam.position.z);
  }

  dispose() {
    if (this.envRT) this.envRT.dispose();
    this.cloudLayers.forEach((l) => {
      l.tex.dispose();
      l.mesh.geometry.dispose();
      l.mesh.material.dispose();
    });
  }
}

// IEEE 754 half float -> float. readRenderTargetPixels on a HalfFloat target
// hands back raw uint16s.
function fromHalf(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -1 : 1) * Infinity;
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

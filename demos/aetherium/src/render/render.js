import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GradeShader } from './grade.js';
import { scratch } from '../core/loop.js';

// Objects on LAYER_VIEWMODEL are drawn by a second camera in a second render
// pass with the depth buffer cleared, so the first-person weapon can never
// clip into world geometry no matter how hard you push into a wall. Both
// passes write into the same composer target, so the viewmodel still receives
// bloom, grade and anti-aliasing — unlike the common trick of drawing it after
// post, which leaves the weapon looking pasted on.
export const LAYER_WORLD = 0;
export const LAYER_VIEWMODEL = 1;

export class RenderSystem {
  constructor(canvas) {
    this.canvas = canvas;
    this.composer = null;
    this.sun = null;
    this.viewCamera = null;
    this._renderScale = 1;
    this._targetScale = 1;
    this._scaleCheck = 0;
    this._shadowBasis = null;
    this._gtaoPass = null;
    this._size = new THREE.Vector2();
  }

  async init() {
    const ctx = this.ctx;
    const q = ctx.quality;

    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      // Deliberately off: every frame goes through the composer, whose own
      // render target carries the MSAA. Leaving this true would allocate a
      // multisampled default framebuffer that is never drawn to.
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Exposure-driven, not multiplier-driven. The sky, the sun and the
    // environment probe are all at physically sensible relative intensities;
    // this is the one knob that sets overall brightness, and at 1.0 the whole
    // scene clipped to white.
    renderer.toneMappingExposure = 0.62;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.info.autoReset = false;
    ctx.renderer = renderer;
    this.renderer = renderer;

    this.maxAnisotropy = Math.min(q.anisotropy, renderer.capabilities.getMaxAnisotropy());

    const scene = new THREE.Scene();
    ctx.scene = scene;

    // Far plane sized for a 200m archipelago plus its distant spire skyline.
    const camera = new THREE.PerspectiveCamera(
      75, window.innerWidth / window.innerHeight, 0.06, 3000
    );
    camera.layers.set(LAYER_WORLD);
    ctx.camera = camera;
    this.camera = camera;
    scene.add(camera);

    // Viewmodel camera rides the main camera at identity but keeps its own,
    // narrower FOV — the standard trick that stops the weapon fish-eyeing when
    // the world FOV is wide.
    const viewCamera = new THREE.PerspectiveCamera(
      58, window.innerWidth / window.innerHeight, 0.01, 8
    );
    viewCamera.layers.set(LAYER_VIEWMODEL);
    camera.add(viewCamera);
    this.viewCamera = viewCamera;

    this._setupLights();
    // Awaited: the composer's GTAO pass is a dynamic import, and rendering a
    // frame before the chain is assembled would throw.
    await this._buildComposer();

    window.addEventListener('resize', () => this.resize());
  }

  _setupLights() {
    const ctx = this.ctx;
    const q = ctx.quality;
    const scene = ctx.scene;

    // Sky/ground hemisphere fill. The environment probe (sky subsystem) does
    // most of the ambient work; this keeps shadowed faces from going flat.
    // The environment probe does the ambient work; this only keeps shadowed
    // faces from going flat, so it stays low.
    this.hemi = new THREE.HemisphereLight(0xbcd8ff, 0x4a3a28, 0.22);
    scene.add(this.hemi);

    const sun = new THREE.DirectionalLight(0xfff2dc, 2.1);
    sun.position.set(58, 96, 42);
    sun.castShadow = true;
    sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 400;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.035;
    // Blur radius is in texels, so it has to track the map size or shadows go
    // hard-edged on Ultra and mushy on Low.
    sun.shadow.radius = Math.max(1, q.shadowMapSize / 1024);
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;

    // Fixed orthonormal basis for the light, used to snap the shadow frustum to
    // whole texels each frame. Without snapping, a moving shadow camera makes
    // every shadow edge crawl and shimmer as you walk.
    const dir = sun.position.clone().normalize();
    const up = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, dir).normalize();
    const trueUp = new THREE.Vector3().crossVectors(dir, right).normalize();
    this._shadowBasis = { dir, right, up: trueUp };

    this._applyShadowExtent(q.shadowExtent);
  }

  // The sky subsystem owns the sun angle; the shadow basis has to be rebuilt
  // to match or the texel snapping snaps along the wrong axes.
  setSunDirection(dir) {
    const d = dir.clone().normalize();
    const up = Math.abs(d.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, d).normalize();
    const trueUp = new THREE.Vector3().crossVectors(d, right).normalize();
    this._shadowBasis = { dir: d, right, up: trueUp };
    this.sun.position.copy(d).multiplyScalar(150);
    this._updateShadows();
  }

  _applyShadowExtent(extent) {
    const cam = this.sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.updateProjectionMatrix();
    this._shadowExtent = extent;
  }

  async _buildComposer() {
    const ctx = this.ctx;
    const q = ctx.quality;
    const renderer = this.renderer;
    const size = renderer.getDrawingBufferSize(this._size);

    // HalfFloat so bloom has real HDR headroom above 1.0, and `samples` for
    // hardware MSAA inside the composer — the fix for round 1's aliasing,
    // where renderer antialias was silently bypassed by the composer target.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: q.msaa,
      depthBuffer: true,
      stencilBuffer: false
    });
    target.texture.name = 'composer.main';

    const composer = new EffectComposer(renderer, target);
    composer.setPixelRatio(renderer.getPixelRatio());
    this.composer = composer;

    const worldPass = new RenderPass(ctx.scene, ctx.camera);
    composer.addPass(worldPass);
    this.worldPass = worldPass;

    if (q.gtao) await this._addGtao(size);

    // Second pass, same target, depth cleared: the viewmodel composites over
    // the finished world image and can never intersect it.
    const viewPass = new RenderPass(ctx.scene, this.viewCamera);
    viewPass.clear = false;
    viewPass.clearDepth = true;
    composer.addPass(viewPass);
    this.viewPass = viewPass;

    if (q.bloom) {
      // Threshold matters more than strength here: at 0.78 almost every lit
      // marble surface qualified and the entire frame hazed over. Only genuine
      // highlights — emissives, the gold dome, the sun — should bloom.
      // Radius matters as much as threshold: the sky's sun disc is genuinely
      // very bright HDR, and a wide radius smeared it across a third of the
      // frame. Tight and bright reads as glare; wide and bright reads as fog.
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(size.x, size.y), q.bloomStrength, 0.28, 0.94
      );
      composer.addPass(bloom);
      this.bloom = bloom;
    }

    composer.addPass(new OutputPass());

    const grade = new ShaderPass(GradeShader);
    grade.uniforms.uGrain.value = q.grain ? 0.035 : 0;
    composer.addPass(grade);
    this.grade = grade;

    if (q.smaa) {
      const smaa = new SMAAPass(size.x, size.y);
      composer.addPass(smaa);
      this.smaa = smaa;
    }
  }

  // GTAO is loaded dynamically: it is the most version-fragile pass in the
  // addons set, and a demo that hard-fails to boot because one optional
  // ambient-occlusion pass moved namespace is a bad trade. If it will not
  // load, we fall back to the baked AO maps the material bakery produces.
  async _addGtao(size) {
    try {
      const mod = await import('three/addons/postprocessing/GTAOPass.js');
      const GTAOPass = mod.GTAOPass;
      const pass = new GTAOPass(this.ctx.scene, this.ctx.camera, size.x, size.y);
      pass.output = GTAOPass.OUTPUT.Default;
      if (pass.updateGtaoMaterial) {
        pass.updateGtaoMaterial({
          radius: 0.4,
          distanceExponent: 1.4,
          thickness: 1.0,
          scale: 1.0,
          samples: this.ctx.quality.name === 'ultra' ? 16 : 8,
          screenSpaceRadius: false
        });
      }
      this.composer.addPass(pass);
      this._gtaoPass = pass;
    } catch (err) {
      console.warn('[render] GTAO unavailable, falling back to baked AO:', err.message);
      this._gtaoPass = null;
    }
  }

  // Recentre the shadow frustum on the player each frame, biased slightly
  // forward so more of the map is in front of you than behind. Snapped to
  // texel boundaries so edges stay stable while you move.
  _updateShadows() {
    const ctx = this.ctx;
    const sun = this.sun;
    const basis = this._shadowBasis;
    const cam = ctx.camera;

    const centre = scratch.v0.copy(cam.position);
    const fwd = cam.getWorldDirection(scratch.v1);
    fwd.y = 0;
    if (fwd.lengthSq() > 1e-6) {
      fwd.normalize().multiplyScalar(this._shadowExtent * 0.35);
      centre.add(fwd);
    }

    const texel = (this._shadowExtent * 2) / ctx.quality.shadowMapSize;
    let lx = centre.dot(basis.right);
    let ly = centre.dot(basis.up);
    const lz = centre.dot(basis.dir);
    lx = Math.round(lx / texel) * texel;
    ly = Math.round(ly / texel) * texel;

    const snapped = scratch.v2
      .copy(basis.right).multiplyScalar(lx)
      .addScaledVector(basis.up, ly)
      .addScaledVector(basis.dir, lz);

    sun.target.position.copy(snapped);
    sun.position.copy(snapped).addScaledVector(basis.dir, 150);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
  }

  // Dynamic resolution. Checked on a slow cadence and moved in small steps so
  // the image never visibly pumps; only the internal buffer scales, the canvas
  // and UI stay at native size.
  _updateDynamicResolution() {
    const loop = this.ctx.loopRef;
    if (!loop) return;
    if (this.ctx.time.frame - this._scaleCheck < 45) return;
    this._scaleCheck = this.ctx.time.frame;

    const ms = loop.avgFrameMs;
    const max = this.ctx.quality.renderScale;
    if (ms > 21 && this._targetScale > 0.62) this._targetScale -= 0.06;
    else if (ms < 13.5 && this._targetScale < max) this._targetScale += 0.04;
    this._targetScale = Math.min(max, Math.max(0.62, this._targetScale));

    if (Math.abs(this._targetScale - this._renderScale) > 0.015) {
      this._renderScale = this._targetScale;
      this._resizeBuffers();
    }
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this._resizeBuffers();
    const ui = this.ctx.tryGet('ui');
    if (ui && ui.onResize) ui.onResize(w, h);
  }

  _resizeBuffers() {
    const w = Math.max(2, Math.floor(window.innerWidth * this._renderScale));
    const h = Math.max(2, Math.floor(window.innerHeight * this._renderScale));
    if (this.composer) this.composer.setSize(w, h);
    if (this.bloom) this.bloom.setSize(w, h);
    if (this._gtaoPass && this._gtaoPass.setSize) this._gtaoPass.setSize(w, h);
    if (this.smaa && this.smaa.setSize) this.smaa.setSize(w, h);
  }

  setExposure(v) {
    this.renderer.toneMappingExposure = v;
  }

  // Driven by the player subsystem: damage haze intensity and screen flash.
  setDamageHaze(v) {
    if (this.grade) this.grade.uniforms.uDamage.value = v;
  }

  setFlash(v) {
    if (this.grade) this.grade.uniforms.uFlash.value = v;
  }

  update(dt) {
    this._updateShadows();
    this._updateDynamicResolution();
    if (this.grade) {
      this.grade.uniforms.uTime.value = this.ctx.time.elapsed;
      // Flash decays fast — it is an impact accent, not a fade.
      const f = this.grade.uniforms.uFlash.value;
      if (f > 0.001) this.grade.uniforms.uFlash.value = Math.max(0, f - dt * 3.2);
    }
  }

  render() {
    this.renderer.info.reset();
    this.composer.render();
  }

  get drawCalls() {
    return this.renderer.info.render.calls;
  }
}

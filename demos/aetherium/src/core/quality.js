// Quality presets.
//
// Every expensive feature is gated here rather than being decided at its call
// site, so a preset change is a single source of truth. Subsystems read their
// budgets from ctx.quality and must never exceed them.

export const PRESETS = {
  low: {
    label: 'Low',
    pixelRatio: 1.0,
    renderScale: 0.75,
    shadowMapSize: 1024,
    shadowExtent: 26,
    shadowDistance: 90,
    msaa: 0,
    smaa: true,
    gtao: false,
    bloom: true,
    bloomStrength: 0.32,
    volumetrics: false,
    grain: false,
    particleBudget: 400,
    decalBudget: 48,
    debrisBudget: 40,
    textureSize: 256,
    detailTextures: false,
    cloudLayers: 2,
    propDensity: 0.55,
    envProbeSize: 128,
    anisotropy: 2,
    maxLights: 4
  },
  medium: {
    label: 'Medium',
    pixelRatio: 1.25,
    renderScale: 0.9,
    shadowMapSize: 1536,
    shadowExtent: 34,
    shadowDistance: 130,
    msaa: 2,
    smaa: true,
    gtao: true,
    bloom: true,
    bloomStrength: 0.36,
    volumetrics: false,
    grain: true,
    particleBudget: 1200,
    decalBudget: 96,
    debrisBudget: 80,
    textureSize: 512,
    detailTextures: true,
    cloudLayers: 3,
    propDensity: 0.8,
    envProbeSize: 256,
    anisotropy: 4,
    maxLights: 6
  },
  high: {
    label: 'High',
    pixelRatio: 1.5,
    renderScale: 1.0,
    shadowMapSize: 2048,
    shadowExtent: 42,
    shadowDistance: 170,
    msaa: 4,
    smaa: true,
    gtao: true,
    bloom: true,
    bloomStrength: 0.40,
    volumetrics: true,
    grain: true,
    particleBudget: 2400,
    decalBudget: 160,
    debrisBudget: 140,
    textureSize: 1024,
    detailTextures: true,
    cloudLayers: 4,
    propDensity: 1.0,
    envProbeSize: 256,
    anisotropy: 8,
    maxLights: 8
  },
  ultra: {
    label: 'Ultra',
    pixelRatio: 2.0,
    renderScale: 1.0,
    shadowMapSize: 3072,
    shadowExtent: 50,
    shadowDistance: 220,
    msaa: 8,
    smaa: true,
    gtao: true,
    bloom: true,
    bloomStrength: 0.44,
    volumetrics: true,
    grain: true,
    particleBudget: 4000,
    decalBudget: 256,
    debrisBudget: 220,
    textureSize: 1024,
    detailTextures: true,
    cloudLayers: 5,
    propDensity: 1.0,
    envProbeSize: 512,
    anisotropy: 16,
    maxLights: 10
  }
};

export const PRESET_ORDER = ['low', 'medium', 'high', 'ultra'];

// First-load hardware probe. We can't benchmark before we have a scene, so we
// classify from the GL context: renderer string, texture limits and extension
// support. Deliberately conservative — a wrong guess downward costs some
// fidelity, a wrong guess upward costs a stuttering first impression.
export function detectPreset() {
  const override = new URLSearchParams(location.search).get('q');
  if (override && PRESETS[override]) return override;

  let canvas, gl;
  try {
    canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl2');
  } catch (_) {
    return 'low';
  }
  if (!gl) return 'low';

  let renderer = '';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
  const r = renderer.toLowerCase();

  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  const mobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);

  // Lose the probe context immediately; some drivers cap live contexts at ~8.
  const lose = gl.getExtension('WEBGL_lose_context');
  if (lose) lose.loseContext();

  if (mobile) return 'low';
  if (maxTex < 8192 || cores <= 2 || mem <= 2) return 'low';

  // Known-slow integrated parts. Intel Arc is genuinely capable, so it is
  // excluded from the integrated downgrade.
  const weakIntegrated = /(intel).*(uhd|hd graphics|iris)/.test(r) && !/arc/.test(r);
  const softwareRaster = /(swiftshader|llvmpipe|software|basic render)/.test(r);
  if (softwareRaster) return 'low';
  if (weakIntegrated) return 'medium';

  const strongDiscrete = /(rtx|radeon rx|geforce gtx 1[6-9]|geforce rtx|arc a|apple m[1-9])/.test(r);
  if (strongDiscrete && cores >= 8 && mem >= 8) return 'ultra';
  if (/(nvidia|geforce|radeon|apple)/.test(r) && cores >= 6) return 'high';

  return 'medium';
}

export function makeQuality(name) {
  const key = PRESETS[name] ? name : 'medium';
  // Copy so runtime tweaks (dynamic resolution) never mutate the preset table.
  return { ...PRESETS[key], name: key };
}

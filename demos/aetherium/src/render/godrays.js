// Volumetric light shafts.
//
// A radial blur of the frame's brightest pixels, streaked away from the sun's
// screen position. It is not real volumetrics — there is no participating
// medium and no shadow-map sampling along the ray — but it is the effect people
// mean by "god rays through the colonnade", it costs one pass, and it is
// entirely self-contained rather than depending on an addon that may move.
//
// The pass is a no-op when the sun is behind the camera or off screen, which is
// most of the time in a level where you spend a lot of it looking away from it.

export const GodRayShader = {
  name: 'GodRayShader',

  uniforms: {
    tDiffuse: { value: null },
    uSunScreen: { value: null },     // sun position in [0,1] screen space
    uIntensity: { value: 0.0 },      // driven by sun visibility; 0 disables
    uDecay: { value: 0.94 },
    uDensity: { value: 0.86 },
    uWeight: { value: 0.26 },
    uThreshold: { value: 0.80 },
    uTint: { value: null },
    uAspect: { value: 1.0 }
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSunScreen;
    uniform float uIntensity;
    uniform float uDecay;
    uniform float uDensity;
    uniform float uWeight;
    uniform float uThreshold;
    uniform vec3 uTint;
    uniform float uAspect;
    varying vec2 vUv;

    const int SAMPLES = 24;

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);

      if (uIntensity <= 0.001) {
        gl_FragColor = base;
        return;
      }

      // March from the fragment toward the sun, accumulating only the parts of
      // the image bright enough to plausibly be a light source.
      vec2 delta = (vUv - uSunScreen) * (uDensity / float(SAMPLES));
      vec2 uv = vUv;
      float illumination = 1.0;
      vec3 accum = vec3(0.0);

      for (int i = 0; i < SAMPLES; i++) {
        uv -= delta;
        vec3 s = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb;
        // Threshold in luma, so a bright sky streaks and a bright white wall
        // does not.
        float luma = dot(s, vec3(0.2126, 0.7152, 0.0722));
        s *= smoothstep(uThreshold, 1.0, luma);
        accum += s * illumination * uWeight;
        illumination *= uDecay;
      }

      accum /= float(SAMPLES);

      // Fade out toward the screen edge nearest the sun so the streaks do not
      // terminate in a hard line at the frame boundary.
      vec2 d = (vUv - uSunScreen) * vec2(uAspect, 1.0);
      float falloff = 1.0 - smoothstep(0.15, 1.25, length(d));

      gl_FragColor = vec4(base.rgb + accum * uTint * uIntensity * falloff, base.a);
    }
  `
};

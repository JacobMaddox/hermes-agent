// Final colour grade, applied after tone mapping in LDR.
//
// Round 1 went straight from bloom to output, so the image had no filmic
// character at all. This pass adds the cheap things that read as "shot with a
// lens": vignette, subtle chromatic aberration at the edges, film grain, a
// contrast S-curve, and a warm/cool split-tone that separates the golden temple
// light from the blue sky bounce.

export const GradeShader = {
  name: 'GradeShader',

  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.42 },
    uGrain: { value: 0.035 },
    uAberration: { value: 0.0016 },
    uContrast: { value: 1.13 },
    uSaturation: { value: 1.14 },
    uLift: { value: 0.002 },
    uDamage: { value: 0.0 },
    uFlash: { value: 0.0 }
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
    uniform float uTime;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uAberration;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uLift;
    uniform float uDamage;
    uniform float uFlash;
    varying vec2 vUv;

    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centred = uv - 0.5;
      float r2 = dot(centred, centred);

      // Chromatic aberration scales with radius, so the centre stays clean.
      vec2 offset = centred * uAberration * r2 * 4.0;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + offset).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - offset).b;

      // Contrast around mid grey, then saturation around luma.
      col = (col - 0.5) * uContrast + 0.5;
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);

      // Split tone: warm the highlights, cool the shadows.
      vec3 warm = vec3(1.03, 1.005, 0.96);
      vec3 cool = vec3(0.96, 0.99, 1.05);
      col *= mix(cool, warm, smoothstep(0.25, 0.8, luma));

      // Lift crushes pure black slightly so shadow detail survives the grade.
      col += uLift;

      // Vignette.
      float vig = 1.0 - uVignette * smoothstep(0.15, 0.85, r2 * 2.0);
      col *= vig;

      // Low-health / damage haze: red at the edges, desaturation overall.
      if (uDamage > 0.001) {
        float edge = smoothstep(0.05, 0.5, r2);
        float dl = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(col, vec3(dl), uDamage * 0.45);
        col = mix(col, vec3(0.55, 0.045, 0.045), edge * uDamage * 0.7);
      }

      // Animated grain, weighted toward the shadows where it reads as film.
      if (uGrain > 0.0001) {
        float n = hash(uv * 900.0 + fract(uTime) * 137.0) - 0.5;
        col += n * uGrain * (1.25 - luma * 0.75);
      }

      // Full-screen flash (explosions, stage transitions).
      col += uFlash;

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `
};

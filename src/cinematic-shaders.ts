// GLSL / SkSL-compatible functions: the demo and Owlbear share the same cloud.
export const EXPLOSION_SECONDS = 4.4;

export const VOLUME_NOISE = `
float hash3(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x),
        mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x),
        mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
}

float fbm(vec3 p) {
  return noise3(p) * 0.57 + noise3(p * 2.03 + 13.1) * 0.28 +
         noise3(p * 4.09 + 27.7) * 0.15;
}

vec3 fireColor(float heat) {
  vec3 color = mix(vec3(0.18, 0.008, 0.002), vec3(1.1, 0.095, 0.008),
                   smoothstep(0.0, 0.38, heat));
  color = mix(color, vec3(1.65, 0.31, 0.018), smoothstep(0.28, 0.72, heat));
  return mix(color, vec3(2.8, 1.8, 0.70), smoothstep(0.72, 1.0, heat));
}
`;

export const EXPLOSION_VOLUME = `
${VOLUME_NOISE}

float cloudDensity(vec3 p, float time) {
  float turn = time * 0.24 + p.z * 0.8;
  float cs = cos(turn);
  float sn = sin(turn);
  p.xy = mat2(cs, -sn, sn, cs) * p.xy;
  float angle = atan(p.y, p.x);
  float rise = 1.0 - exp(-time * 1.7);
  float crownHeight = 0.22 + 0.28 * rise;
  float lobes = sin(angle * 7.0 + 0.7) * 0.035 + sin(angle * 11.0) * 0.016;
  float crown = length(vec2(length(p.xy) - (0.28 + 0.14 * rise),
                           (p.z - crownHeight) * 1.3)) - 0.255 - lobes;
  float stem = length(vec3(p.xy * 1.23, (p.z - 0.08) * 0.60)) - 0.29;
  float initial = length(vec3(p.xy * 0.92, (p.z - 0.18) * 1.05)) - 0.52;
  float shape = mix(initial, min(crown, stem), smoothstep(0.15, 1.1, time));
  // Advect the density upward while the crown rolls outward around its torus.
  vec3 flow = p * 7.3 + vec3(0.0, 0.0, -time * 1.65);
  flow.xy += p.xy * sin(p.z * 5.0 - time * 2.2) * 0.55;
  float turbulence = fbm(flow);
  return clamp(-shape * 8.0 + (turbulence - 0.48) * 2.7, 0.0, 1.6);
}

vec4 explosionVolume(vec2 uv, float time) {
  if (time <= 0.0 || time >= 4.4) return vec4(0.0);
  float growth = 0.10 + 0.90 * (1.0 - exp(-time * 8.0));
  vec2 xy = (uv - 0.5) * 2.2 / growth;
  if (length(xy) > 0.95) return vec4(0.0);
  float fade = 1.0 - smoothstep(2.65, 4.35, time);
  float cooling = exp(-max(0.0, time - 0.28) * 1.8);
  float transmission = 1.0;
  vec3 radiance = vec3(0.0);
  // Front-to-back volume integration, with a fixed budget for both renderers.
  for (int i = 0; i < 22; i++) {
    vec3 p = vec3(xy, 1.25 - (float(i) + 0.5) * 0.09);
    float density = cloudDensity(p, time) * fade;
    if (density > 0.01) {
      float shadow = cloudDensity(p + vec3(-0.085, 0.095, 0.13), time);
      float light = clamp(0.48 + (density / max(fade, 0.01) - shadow) * 0.72, 0.12, 1.0);
      vec3 smoke = mix(vec3(0.023, 0.025, 0.029), vec3(0.23, 0.215, 0.195), light * light);
      float burning = fbm(p * 5.8 + vec3(time * 0.24, 0.0, -time * 2.0));
      float heat = clamp((burning * 1.4 - 0.10 - length(p.xy) * 0.12) * cooling, 0.0, 1.0);
      vec3 emission = fireColor(heat) * (0.60 + cooling * 0.90);
      vec3 color = mix(smoke, emission, smoothstep(0.14, 0.46, heat));
      float alpha = 1.0 - exp(-density * 0.48);
      radiance += transmission * alpha * color;
      transmission *= 1.0 - alpha;
      if (transmission < 0.025) break;
    }
  }
  float alpha = 1.0 - transmission;
  return vec4(radiance / max(alpha, 0.001), alpha);
}
`;

export const fireVertexShader = `
uniform float uTime;
varying vec3 vPosition;
varying vec3 vNormal;
${VOLUME_NOISE}
void main() {
  vPosition = position / 19.0;
  float turbulence = fbm(vPosition * 3.2 - vec3(uTime * 3.1, 0.0, 0.0));
  vec3 displaced = position * (0.86 + turbulence * 0.31);
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
`;

export const fireFragmentShader = `
uniform float uTime;
varying vec3 vPosition;
varying vec3 vNormal;
${VOLUME_NOISE}
void main() {
  float flames = fbm(vPosition * 4.4 - vec3(uTime * 4.1, 0.0, 0.0));
  float facing = clamp(vNormal.z, 0.0, 1.0);
  float heat = clamp(flames * 0.95 + facing * 0.27, 0.0, 1.0);
  vec3 color = fireColor(heat);
  color *= 0.72 + 0.28 * max(0.0, dot(vNormal, normalize(vec3(-0.4, 0.7, 1.0))));
  gl_FragColor = vec4(color, 0.96);
}
`;

import { EXPLOSION_SECONDS, EXPLOSION_VOLUME, VOLUME_NOISE } from "./cinematic-shaders";

export const PROJECTILE_SHADER = `
uniform vec2 size;
uniform float progress;
${VOLUME_NOISE}
half4 main(float2 coord) {
  vec2 uv = coord / size;
  vec2 p = uv - vec2(0.66, 0.5);
  p.x *= size.x / size.y;
  float time = progress * 5.0;
  float turbulence = fbm(vec3(p * 12.0, -time * 3.0));
  float r = length(p);
  float head = 1.0 - smoothstep(0.17, 0.24, r + (turbulence - 0.5) * 0.05);
  float behind = clamp((0.66 - uv.x) / 0.66, 0.0, 1.0);
  float width = mix(0.07, 0.15, behind);
  float flame = fbm(vec3(uv * vec2(12.0, 21.0) - vec2(time * 4.0, 0.0), time));
  float tail = (1.0 - smoothstep(width * 0.2, width, abs(p.y + (flame - 0.5) * behind * 0.13)));
  tail *= (1.0 - behind) * step(uv.x, 0.66) * smoothstep(0.0, 0.09, uv.x);
  float halo = exp(-r * r * 14.0) * 0.24;
  float heat = clamp(turbulence * 0.85 + (1.0 - smoothstep(0.0, 0.22, r)) * 0.3, 0.0, 1.0);
  vec3 color = fireColor(heat);
  color = mix(color, fireColor(flame * 0.6 + 0.12), (1.0 - head) * tail);
  color = color / (vec3(1.0) + color * 0.45);
  float alpha = clamp(head * 0.96 + tail * 0.68 + halo, 0.0, 1.0);
  return half4(clamp(color, vec3(0.0), vec3(1.0)) * alpha, alpha);
}
`;

export const EXPLOSION_SHADER = `
uniform vec2 size;
uniform float progress;
${EXPLOSION_VOLUME}
half4 main(float2 coord) {
  vec2 uv = coord / size;
  float time = clamp(progress, 0.0, 1.0) * ${EXPLOSION_SECONDS.toFixed(1)};
  vec4 cloud = explosionVolume(uv, time);
  vec2 p = (uv - 0.5) * 2.0;
  float radius = length(p);
  float angle = atan(p.y, p.x);
  float front = 0.04 + 0.81 * (1.0 - exp(-time * 5.5));
  float ring = exp(-pow((radius - front - sin(angle * 13.0) * 0.007) / 0.014, 2.0));
  ring *= (1.0 - smoothstep(0.08, 0.78, time)) * smoothstep(0.0, 0.035, time);
  // Each angular lane emits a separate slowing ember; no per-frame scene items.
  float lane = floor((angle + 3.141593) * 19.0);
  float seed = hash3(vec3(lane, 7.0, 2.0));
  float age = max(0.0, time - seed * 0.16);
  float travel = (0.25 + seed * 0.57) * (1.0 - exp(-age * 3.0));
  float crossLane = abs(fract((angle + 3.141593) * 19.0) - 0.5);
  float spark = exp(-pow((radius - travel) / 0.018, 2.0)) *
                (1.0 - smoothstep(0.025, 0.14, crossLane));
  spark *= step(seed * 0.16, time) * (1.0 - smoothstep(0.3, 0.8 + seed, age));
  float glow = exp(-radius * radius * 9.0) * exp(-time * 5.0) * 0.30;
  float flash = exp(-radius * radius * 85.0) * exp(-time * 22.0) * 0.65;
  float extraAlpha = clamp(ring * 0.30 + spark * 0.60 + glow + flash, 0.0, 1.0);
  vec3 light = vec3(1.0, 0.56, 0.16) * (ring * 0.30 + glow) +
               vec3(1.0, 0.72, 0.30) * spark * 0.60 + vec3(1.0, 0.92, 0.73) * flash;
  vec3 mapped = cloud.rgb / (vec3(1.0) + cloud.rgb * 0.45);
  vec3 color = mapped * cloud.a + light * (1.0 - cloud.a * 0.72);
  float alpha = cloud.a + extraAlpha * (1.0 - cloud.a);
  float endFade = 1.0 - smoothstep(0.92, 1.0, progress);
  return half4(min(color, vec3(alpha)) * endFade, alpha * endFade);
}
`;

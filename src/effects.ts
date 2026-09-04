import OBR, { buildEffect, type Effect, type Vector2 } from "@owlbear-rodeo/sdk";
import { distance, easeInCubic, lerpVector, originForRotatedAnchor } from "./geometry";
import type { FireballCastMessage } from "./types";

const PROJECTILE_SHADER = `
uniform vec2 size;
uniform float progress;

half4 main(float2 coord) {
  vec2 uv = coord / size;
  vec2 p = uv - vec2(0.66, 0.5);
  p.x *= size.x / size.y;

  float head = length(p);
  float core = 1.0 - smoothstep(0.02, 0.20, head);
  float halo = 1.0 - smoothstep(0.08, 0.48, head);

  float tailGate = 1.0 - smoothstep(0.14, 0.72, abs(uv.y - 0.5));
  float tail = (1.0 - smoothstep(0.06, 0.68, uv.x)) * tailGate;
  float hotTail = (1.0 - smoothstep(0.24, 0.66, uv.x)) *
                  (1.0 - smoothstep(0.03, 0.25, abs(uv.y - 0.5)));

  float flicker = 0.88 + 0.12 * sin((uv.x * 23.0 + uv.y * 31.0 + progress * 19.0));
  float alpha = clamp(core + halo * 0.55 + tail * 0.5 + hotTail * 0.72, 0.0, 1.0) * flicker;

  vec3 ember = vec3(1.0, 0.12, 0.01);
  vec3 orange = vec3(1.0, 0.42, 0.02);
  vec3 whiteHot = vec3(1.0, 0.96, 0.56);
  vec3 color = mix(ember, orange, clamp(halo + tail * 0.45, 0.0, 1.0));
  color = mix(color, whiteHot, clamp(core + hotTail * 0.35, 0.0, 1.0));
  return half4(color, alpha);
}
`;

const EXPLOSION_SHADER = `
uniform vec2 size;
uniform float progress;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

half4 main(float2 coord) {
  vec2 p = (coord - size * 0.5) / (min(size.x, size.y) * 0.5);
  float radius = length(p);
  float angle = atan(p.y, p.x);
  float t = clamp(progress, 0.0, 1.0);

  float front = 0.12 + t * 0.82;
  float irregular = sin(angle * 9.0 + t * 13.0) * 0.035 +
                    sin(angle * 17.0 - t * 9.0) * 0.018;
  float edgeDistance = abs(radius - front - irregular);
  float shock = 1.0 - smoothstep(0.025, 0.11, edgeDistance);

  float cloudMask = 1.0 - smoothstep(front * 0.25, front, radius);
  float cells = hash(floor((p + vec2(t * 0.6, -t * 0.35)) * 12.0));
  float fireCloud = cloudMask * smoothstep(0.08, 0.76, cells + (1.0 - radius) * 0.52);

  float rays = pow(max(0.0, sin(angle * 13.0 + cells * 3.0)), 10.0);
  rays *= 1.0 - smoothstep(0.08, front + 0.18, radius);

  float fade = 1.0 - smoothstep(0.62, 1.0, t);
  float alpha = clamp(shock * 0.92 + fireCloud * 0.86 + rays * 0.45, 0.0, 1.0) * fade;

  vec3 deepRed = vec3(0.72, 0.035, 0.005);
  vec3 orange = vec3(1.0, 0.25, 0.005);
  vec3 yellow = vec3(1.0, 0.82, 0.12);
  vec3 whiteHot = vec3(1.0, 0.98, 0.68);
  vec3 color = mix(deepRed, orange, clamp(1.0 - radius, 0.0, 1.0));
  color = mix(color, yellow, clamp(shock + rays, 0.0, 1.0));
  color = mix(color, whiteHot, clamp((1.0 - radius / max(front, 0.01)) * (1.0 - t), 0.0, 1.0));
  return half4(color, alpha);
}
`;

export async function playFireball(message: FireballCastMessage): Promise<void> {
  if (!(await OBR.scene.isReady())) return;

  const travelDistance = distance(message.from, message.to);
  const angle =
    (Math.atan2(message.to.y - message.from.y, message.to.x - message.from.x) * 180) /
    Math.PI;
  const duration = Math.min(
    1050,
    Math.max(380, 320 + (travelDistance / Math.max(message.radius, 1)) * 110),
  );
  const projectileWidth = message.projectileSize * 4.8;
  const projectileHeight = message.projectileSize * 1.9;
  const projectileAnchor = { x: projectileWidth * 0.66, y: projectileHeight * 0.5 };

  const projectile = buildEffect()
    .effectType("STANDALONE")
    .width(projectileWidth)
    .height(projectileHeight)
    .sksl(PROJECTILE_SHADER)
    .uniforms([{ name: "progress", value: 0 }])
    .position(originForRotatedAnchor(message.from, projectileAnchor, angle))
    .rotation(angle)
    .locked(true)
    .disableHit(true)
    .disableAutoZIndex(true)
    .zIndex(1_000_000)
    .layer("POPOVER")
    .blendMode("SCREEN")
    .metadata({ "com.codex.owlbear-fireball/castId": message.castId })
    .build();

  await OBR.scene.local.addItems([projectile]);
  await animateProjectile(
    projectile.id,
    message.from,
    message.to,
    projectileAnchor,
    angle,
    duration,
  );
  await OBR.scene.local.deleteItems([projectile.id]);
  await playExplosion(message.to, message.radius, message.castId);
}

async function animateProjectile(
  id: string,
  from: Vector2,
  to: Vector2,
  localAnchor: Vector2,
  rotation: number,
  duration: number,
): Promise<void> {
  const startedAt = performance.now();

  while (true) {
    const elapsed = performance.now() - startedAt;
    const progress = Math.min(1, elapsed / duration);
    const eased = easeInCubic(progress);
    const center = lerpVector(from, to, eased);
    const position = originForRotatedAnchor(center, localAnchor, rotation);

    await updateEffect(id, position, progress);
    if (progress >= 1) return;
    await nextFrame();
  }
}

async function playExplosion(position: Vector2, radius: number, castId: string): Promise<void> {
  const diameter = radius * 2.35;
  const effectOrigin = originForRotatedAnchor(
    position,
    { x: diameter / 2, y: diameter / 2 },
    0,
  );
  const explosion = buildEffect()
    .effectType("STANDALONE")
    .width(diameter)
    .height(diameter)
    .sksl(EXPLOSION_SHADER)
    .uniforms([{ name: "progress", value: 0 }])
    .position(effectOrigin)
    .locked(true)
    .disableHit(true)
    .disableAutoZIndex(true)
    .zIndex(1_000_001)
    .layer("POPOVER")
    .blendMode("SCREEN")
    .metadata({ "com.codex.owlbear-fireball/castId": castId })
    .build();

  await OBR.scene.local.addItems([explosion]);

  const duration = 1050;
  const startedAt = performance.now();
  while (true) {
    const progress = Math.min(1, (performance.now() - startedAt) / duration);
    await updateEffect(explosion.id, effectOrigin, progress);
    if (progress >= 1) break;
    await nextFrame();
  }

  await OBR.scene.local.deleteItems([explosion.id]);
}

async function updateEffect(id: string, position: Vector2, progress: number): Promise<void> {
  await OBR.scene.local.updateItems([id], (items) => {
    const effect = items[0] as Effect | undefined;
    if (!effect || effect.type !== "EFFECT") return;
    effect.position = position;
    effect.uniforms = [{ name: "progress", value: progress }];
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

import OBR, { buildEffect, type Effect, type Vector2 } from "@owlbear-rodeo/sdk";
import { distance, easeInCubic, lerpVector, originForRotatedAnchor } from "./geometry";
import type { FireballCastMessage } from "./types";

import { EXPLOSION_SECONDS } from "./cinematic-shaders";
import { EXPLOSION_SHADER, PROJECTILE_SHADER } from "./owlbear-shaders";

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
    .blendMode("SRC_OVER")
    .metadata({ "com.codex.owlbear-fireball/castId": message.castId })
    .build();

  await OBR.scene.local.addItems([projectile]);
  try {
    await animateProjectile(
      projectile.id,
      message.from,
      message.to,
      projectileAnchor,
      angle,
      duration,
    );
  } finally {
    if (await OBR.scene.isReady()) await OBR.scene.local.deleteItems([projectile.id]);
  }
  if (!(await OBR.scene.isReady())) return;
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
    if (!(await OBR.scene.isReady())) return;
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
    .blendMode("SRC_OVER")
    .metadata({ "com.codex.owlbear-fireball/castId": castId })
    .build();

  await OBR.scene.local.addItems([explosion]);

  const duration = EXPLOSION_SECONDS * 1000;
  const startedAt = performance.now();
  try {
    while (true) {
      if (!(await OBR.scene.isReady())) break;
      const progress = Math.min(1, (performance.now() - startedAt) / duration);
      await updateEffect(explosion.id, effectOrigin, progress);
      if (progress >= 1) break;
      await nextFrame();
    }
  } finally {
    if (await OBR.scene.isReady()) await OBR.scene.local.deleteItems([explosion.id]);
  }
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

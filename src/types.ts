import type { Vector2 } from "@owlbear-rodeo/sdk";

export interface FireballCastMessage {
  kind: "fireball-cast";
  castId: string;
  from: Vector2;
  to: Vector2;
  radius: number;
  projectileSize: number;
}

export function isFireballCastMessage(value: unknown): value is FireballCastMessage {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<FireballCastMessage>;
  return (
    candidate.kind === "fireball-cast" &&
    typeof candidate.castId === "string" &&
    isVector(candidate.from) &&
    isVector(candidate.to) &&
    isPositiveFinite(candidate.radius) &&
    isPositiveFinite(candidate.projectileSize)
  );
}

function isVector(value: unknown): value is Vector2 {
  if (!value || typeof value !== "object") return false;
  const vector = value as Partial<Vector2>;
  return Number.isFinite(vector.x) && Number.isFinite(vector.y);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}


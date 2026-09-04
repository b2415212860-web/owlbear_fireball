import type { Vector2 } from "@owlbear-rodeo/sdk";

const UNIT_ALIASES: Record<string, string> = {
  "'": "ft",
  foot: "ft",
  feet: "ft",
  inch: "in",
  inches: "in",
  yard: "yd",
  yards: "yd",
  meter: "m",
  meters: "m",
  metre: "m",
  metres: "m",
  centimeter: "cm",
  centimeters: "cm",
  centimetre: "cm",
  centimetres: "cm",
  kilometer: "km",
  kilometers: "km",
  kilometre: "km",
  kilometres: "km",
  mile: "mi",
  miles: "mi",
};

export function feetToSceneUnit(feet: number, rawUnit: string): number {
  const normalized = rawUnit.trim().toLowerCase().replaceAll(".", "");
  const unit = UNIT_ALIASES[normalized] ?? normalized;

  switch (unit) {
    case "in":
      return feet * 12;
    case "yd":
      return feet / 3;
    case "m":
      return feet * 0.3048;
    case "cm":
      return feet * 30.48;
    case "km":
      return feet * 0.0003048;
    case "mi":
      return feet / 5280;
    case "ft":
    default:
      return feet;
  }
}

export function worldRadiusForFeet(
  feet: number,
  gridDpi: number,
  gridMultiplier: number,
  gridUnit: string,
): number {
  const safeDpi = Number.isFinite(gridDpi) && gridDpi > 0 ? gridDpi : 150;
  const safeMultiplier =
    Number.isFinite(gridMultiplier) && gridMultiplier > 0 ? gridMultiplier : 5;
  return (feetToSceneUnit(feet, gridUnit) / safeMultiplier) * safeDpi;
}

export function centerOfBounds(bounds: {
  min: Vector2;
  max: Vector2;
}): Vector2 {
  return {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
  };
}

export function distance(from: Vector2, to: Vector2): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

export function lerpVector(from: Vector2, to: Vector2, progress: number): Vector2 {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  };
}

export function originForRotatedAnchor(
  worldAnchor: Vector2,
  localAnchor: Vector2,
  rotationDegrees: number,
): Vector2 {
  const radians = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const rotatedAnchor = {
    x: localAnchor.x * cos - localAnchor.y * sin,
    y: localAnchor.x * sin + localAnchor.y * cos,
  };

  return {
    x: worldAnchor.x - rotatedAnchor.x,
    y: worldAnchor.y - rotatedAnchor.y,
  };
}

export function easeInCubic(progress: number): number {
  return progress * progress * progress;
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  centerOfBounds,
  easeInCubic,
  feetToSceneUnit,
  lerpVector,
  originForRotatedAnchor,
  worldRadiusForFeet,
} from "./geometry.ts";

describe("fireball geometry", () => {
  it("converts 20 feet to a four-cell radius on a 5 ft grid", () => {
    assert.equal(worldRadiusForFeet(20, 150, 5, "ft"), 600);
  });

  it("supports metric scenes while retaining a true 20 ft radius", () => {
    assert.ok(Math.abs(feetToSceneUnit(20, "m") - 6.096) < 0.000001);
    assert.ok(Math.abs(worldRadiusForFeet(20, 100, 1.5, "m") - 406.4) < 0.000001);
  });

  it("finds bounds centers and interpolates flight positions", () => {
    assert.deepEqual(centerOfBounds({ min: { x: 10, y: 30 }, max: { x: 30, y: 70 } }), {
      x: 20,
      y: 50,
    });
    assert.deepEqual(lerpVector({ x: 0, y: 0 }, { x: 100, y: 40 }, 0.25), {
      x: 25,
      y: 10,
    });
    assert.equal(easeInCubic(0.5), 0.125);
  });

  it("keeps an effect anchor fixed while rotating its local rectangle", () => {
    assert.deepEqual(originForRotatedAnchor({ x: 100, y: 100 }, { x: 30, y: 10 }, 0), {
      x: 70,
      y: 90,
    });
    const rotated = originForRotatedAnchor({ x: 100, y: 100 }, { x: 30, y: 10 }, 90);
    assert.ok(Math.abs(rotated.x - 110) < 0.000001);
    assert.ok(Math.abs(rotated.y - 70) < 0.000001);
  });
});

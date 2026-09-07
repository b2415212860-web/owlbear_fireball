import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import ts from "typescript";

// Real production scene/materials/uniforms, but a stub WebGL driver. Shader compilation and
// visual quality are checked separately in tests/render-fixture.html in an actual browser.
const compiled = new Map();
function fixture(t, quality = "standard") {
  const context = { createRadialGradient: () => ({ addColorStop() {} }), beginPath() {}, arc() {}, fill() {}, fillRect() {} };
  const canvas = () => ({ style: {}, setAttribute() {}, remove() {}, addEventListener() {}, removeEventListener() {}, getContext: () => context });
  class Driver {
    domElement = canvas();
    debug = {};
    setClearColor() {} setPixelRatio() {} clear() {} dispose() {} forceContextLoss() {}
    setSize(width, height) { Object.assign(this.domElement, { width, height }); }
    render() {} initTexture() {} async compileAsync() {}
    getContext() { return { isContextLost: () => false }; }
  }
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    if (!compiled.has(name)) compiled.set(name, ts.transpileModule(
      readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText);
    const module = { exports: {} };
    new Function("require", "exports", "module", "window", "document", "navigator", "cancelAnimationFrame", compiled.get(name))(
      (id) => id === "three" ? { ...THREE, WebGLRenderer: Driver } : load(id.slice(2)),
      module.exports, module,
      { innerWidth: 1920, innerHeight: 1080, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout },
      { createElement: canvas, addEventListener() {}, removeEventListener() {} }, { hardwareConcurrency: 8, deviceMemory: 8 }, () => {},
    );
    modules.set(name, module.exports);
    return module.exports;
  }
  const api = load("performance-fx");
  const renderer = new api.ThreeFireballPrototype({ append() {} }, quality);
  t.after(() => renderer.dispose());
  const cast = { from: { x: 100, y: 200 }, to: { x: 500, y: 400 }, radius: 160, seed: 1234 };
  return { renderer, cast, load, draw(age) { renderer.draw(cast, api.FLIGHT_SECONDS + age); } };
}

test("cast variation is repeatable, seed zero is valid, and lobe sizes and speeds are not uniform", (t) => {
  const { load } = fixture(t);
  const { createExplosionProfile, normalizeEffectSeed } = load("explosion-profile");
  assert.deepEqual(createExplosionProfile(1234), createExplosionProfile(1234));
  assert.notDeepEqual(createExplosionProfile(1234), createExplosionProfile(5678));
  assert.notDeepEqual(createExplosionProfile(0), createExplosionProfile(0xf1b411));
  assert.equal(normalizeEffectSeed(-1), 0xffffffff);
  assert.equal(normalizeEffectSeed(Infinity), 0xf1b411);
  for (let seed = 0; seed < 128; seed++) {
    const { lobes } = createExplosionProfile(seed);
    assert.equal(lobes.length, 7);
    assert.ok(new Set(lobes.map((lobe) => lobe.width)).size > 5);
    assert.ok(new Set(lobes.map((lobe) => lobe.speed)).size > 5);
    assert.ok(lobes.every((lobe) => lobe.distance <= .61 && lobe.width <= .52 && lobe.height <= 1.03));
  }
});

test("impact overlaps the old tail with the burst, then introduces dust and retires each layer", (t) => {
  const f = fixture(t);
  f.draw(-.10);
  assert.equal(f.renderer.fireball.visible, true);
  assert.equal(f.renderer.explosion.visible, false);
  f.draw(0);
  assert.equal(f.renderer.fireball.visible, false);
  assert.equal(f.renderer.trail.visible, true);
  assert.equal(f.renderer.burst.visible, true);
  assert.equal(f.renderer.shock.visible, false);
  f.draw(.14);
  assert.equal(f.renderer.trail.material.uniforms.uProgress.value, 1, "Never emit beyond the target");
  assert.ok(Math.abs(f.renderer.trail.material.uniforms.uAfterImpact.value - .14) < 1e-6);
  assert.equal(f.renderer.shock.visible, true);
  f.draw(.33);
  assert.equal(f.renderer.trail.visible, false);
  f.draw(.73);
  assert.equal(f.renderer.burst.visible, false);
  assert.equal(f.renderer.shock.visible, true);
  f.draw(1.13);
  assert.equal(f.renderer.shock.visible, false);
  assert.equal(f.renderer.sparks.visible, true);
  f.draw(2.21);
  assert.equal(f.renderer.sparks.visible, false);
  assert.equal(f.renderer.smoke.visible, true);
  f.draw(3.8);
  assert.equal(f.renderer.smoke.visible, false);
});

test("seed and quality changes reuse GPU resources and retain bounded particles, texture and buffers", (t) => {
  const f = fixture(t);
  const r = f.renderer;
  f.draw(.4);
  const profile = r.smoke.profile;
  const geometry = r.sparks.geometry;
  const noise = r.smoke.noiseTexture;
  const before = r.smoke.material.uniforms.uLobes.value.map((v) => v.toArray());
  const phases = r.burst.material.uniforms.uSeed.value.toArray();
  f.draw(.4);
  assert.strictEqual(r.smoke.profile, profile, "Do not allocate a new profile every frame");
  assert.deepEqual(r.smoke.material.uniforms.uLobes.value.map((v) => v.toArray()), before);
  f.cast.seed = 5678;
  f.draw(.4);
  assert.notDeepEqual(r.smoke.material.uniforms.uLobes.value.map((v) => v.toArray()), before);
  assert.notDeepEqual(r.burst.material.uniforms.uSeed.value.toArray(), phases);
  assert.deepEqual(r.trail.material.uniforms.uSeed.value.toArray(), r.smoke.material.uniforms.uSeed.value.toArray());
  assert.deepEqual(r.shock.material.uniforms.uSeed.value.toArray(), r.smoke.material.uniforms.uSeed.value.toArray());
  assert.strictEqual(r.sparks.geometry, geometry);
  assert.strictEqual(r.smoke.noiseTexture, noise);
  assert.equal(noise.image.data.byteLength, 32768);
  assert.equal(r.particleCount, 352);
  assert.equal(r.trail.geometry.instanceCount, 32);
  assert.equal(r.sparks.geometry.drawRange.count, 320);
  assert.deepEqual([r.renderer.domElement.width, r.renderer.domElement.height], [1280, 720]);
  r.setQuality("low");
  f.draw(.4);
  assert.equal(r.particleCount, 136);
  assert.equal(r.trail.geometry.instanceCount, 16);
  assert.equal(r.sparks.geometry.drawRange.count, 120);
  assert.equal(r.smoke.material.uniforms.uLow.value, 1);
  assert.deepEqual([r.renderer.domElement.width, r.renderer.domElement.height], [960, 540]);
  const kinds = r.sparks.geometry.attributes.aKind.array;
  assert.equal([...kinds.slice(0, 120)].filter((kind) => kind === 1).length, 30);
  assert.equal([...kinds].filter((kind) => kind === 1).length, 80);
});

test("cloud remains overhead and compact across seeded rise and breakup phases", (t) => {
  const f = fixture(t);
  for (const seed of [0, 1, 1234, 5678, 0xffffffff]) {
    f.cast.seed = seed;
    for (const age of [.01, .2, .6, 1.2, 2.5, 3.7]) {
      f.draw(age);
      const uniforms = f.renderer.smoke.material.uniforms;
      const shape = uniforms.uShape.value;
      assert.ok(shape.x < .79 && shape.y < .67 && shape.z < .35);
      uniforms.uLobes.value.forEach((lobe, i) => {
        assert.ok(Math.hypot(lobe.x, lobe.y) + uniforms.uLobeWidths.value[i] < .82);
        assert.ok(shape.x + lobe.z + lobe.w < 1.45, "Stay inside the volume ray depth");
      });
    }
  }
});

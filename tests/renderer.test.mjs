import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as THREE from "three";
import ts from "typescript";

// The real Canvas renderer exercises the shared production lifecycle. Three is
// imported normally, but these tests do not construct a WebGL context or claim GPU coverage.
const compiled = new Map();
function compileModule(name) {
  if (!compiled.has(name)) {
    compiled.set(name, ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText);
  }
  return compiled.get(name);
}
async function settle() { await setImmediate(); }

function createFixture(t, options = {}) {
  let now = 100;
  let nextId = 1;
  const frames = new Map();
  const timers = new Map();
  const surfaces = [];
  const children = [];
  const listeners = { window: new Map(), document: new Map() };

  function subscribe(surface, name, callback) {
    const callbacks = listeners[surface].get(name) ?? new Set();
    callbacks.add(callback);
    listeners[surface].set(name, callbacks);
  }
  function emit(surface, name) {
    for (const callback of [...(listeners[surface].get(name) ?? [])]) callback({ type: name });
  }
  function makeCanvas() {
    const calls = [];
    let failMethod;
    const context = {
      calls,
      failNext(method) { failMethod = method; },
      createRadialGradient() { return { addColorStop() {} }; },
    };
    for (const method of ["setTransform", "clearRect", "beginPath", "arc", "fill", "stroke", "fillRect", "drawImage"]) {
      context[method] = (...args) => {
        if (failMethod === method) { failMethod = undefined; throw new Error(`Canvas ${method} failed`); }
        calls.push({ method, args });
      };
    }
    const canvas = {
      width: 0, height: 0, style: {}, attributes: {}, context,
      getContext(kind) { assert.equal(kind, "2d"); return context; },
      setAttribute(name, value) { this.attributes[name] = value; },
      remove() {
        const index = children.indexOf(this);
        if (index >= 0) children.splice(index, 1);
      },
    };
    surfaces.push(canvas);
    return canvas;
  }

  const document = {
    hidden: false,
    createElement(tag) { assert.equal(tag, "canvas"); return makeCanvas(); },
    addEventListener: (name, callback) => subscribe("document", name, callback),
    removeEventListener: (name, callback) => listeners.document.get(name)?.delete(callback),
  };
  const window = {
    innerWidth: options.width ?? 1920,
    innerHeight: options.height ?? 1080,
    devicePixelRatio: 3,
    matchMedia: () => ({ matches: options.reducedMotion ?? false }),
    addEventListener: (name, callback) => subscribe("window", name, callback),
    removeEventListener: (name, callback) => listeners.window.get(name)?.delete(callback),
    setTimeout: (callback, ms) => { const id = nextId++; timers.set(id, { callback, at: now + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const module = { exports: {} };
    new Function("require", "module", "exports", "document", "window", "navigator", "performance",
      "requestAnimationFrame", "cancelAnimationFrame", compileModule(name))(
      (id) => {
        if (id === "three") return THREE;
        if (id === "./cinematic-visuals" || id === "./volumetric-cloud") return load(id.slice(2));
        throw new Error(`Unexpected renderer dependency: ${id}`);
      }, module, module.exports,
      document, window, { hardwareConcurrency: options.cores ?? 8, deviceMemory: options.memory ?? 8 },
      { now: () => now },
      (callback) => { const id = nextId++; frames.set(id, callback); return id; },
      (id) => frames.delete(id),
    );
    modules.set(name, module.exports);
    return module.exports;
  }
  const api = load("performance-fx");
  const timing = { flight: api.FLIGHT_SECONDS * 1000, explosion: api.EXPLOSION_SECONDS * 1000, total: api.TOTAL_SECONDS * 1000 };
  assert.ok(Object.values(timing).every((value) => Number.isFinite(value) && value > 0), "production timing constants must be exported");
  assert.ok(Math.abs(timing.flight + timing.explosion - timing.total) < 0.001);
  const renderer = new api.CanvasFireballFallback({ append: (canvas) => children.push(canvas) }, options.quality ?? "auto");
  const canvas = children[0];
  const events = [];
  const play = (onStarted, onImpact) => renderer.play({ x: 100, y: 200 }, { x: 500, y: 400 },
    () => { events.push({ kind: "impact", at: now }); onImpact?.(); }, 160,
    () => { events.push({ kind: "started", at: now, drawn: canvas.context.calls.some(({ method }) => method === "arc") }); onStarted?.(); });

  function runTimers() {
    for (const [id, timer] of [...timers]) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.callback();
    }
  }
  const fixture = {
    renderer, canvas, surfaces, children, frames, timers, events, play, timing,
    get now() { return now; },
    get listenerCount() { return [...listeners.window.values(), ...listeners.document.values()].reduce((sum, entries) => sum + entries.size, 0); },
    frame(delta = 16) {
      now += delta;
      const scheduled = [...frames.values()];
      frames.clear();
      for (const callback of scheduled) callback(now);
      runTimers();
    },
    advanceWithoutFrames(ms) { now += ms; runTimers(); },
    advanceFrames(ms) {
      let remaining = ms;
      while (frames.size && remaining > 0) {
        const step = Math.min(16, remaining);
        this.frame(step);
        remaining -= step;
      }
    },
    finishFrames() {
      // Include the longest permitted initial scheduling delay, without an idle loop.
      const maximumFrames = Math.ceil((timing.total + 750) / 16) + 2;
      for (let i = 0; frames.size && i < maximumFrames; i++) this.frame();
      assert.equal(frames.size, 0, "playback must terminate without an endless render loop");
    },
    hide() { document.hidden = true; emit("document", "visibilitychange"); },
    show() { document.hidden = false; emit("document", "visibilitychange"); },
    resize(width, height) { window.innerWidth = width; window.innerHeight = height; emit("window", "resize"); },
  };
  t.after(() => renderer.dispose());
  return fixture;
}

test("ready keeps the idle renderer transparent, pointer-transparent, and free of scheduled work", async (t) => {
  const f = createFixture(t);
  await Promise.all([f.renderer.ready(), f.renderer.ready()]);
  assert.equal(f.renderer.kind, "canvas");
  assert.equal(f.children.length, 1);
  assert.equal(f.canvas.style.pointerEvents, "none");
  assert.equal(f.canvas.attributes["aria-hidden"], "true");
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.canvas.context.calls.length, 0);
  assert.equal(f.listenerCount, 2);
});

test("Owlbear playback reserves 0.9 seconds of flight and 3.8 seconds of explosion and smoke", (t) => {
  const f = createFixture(t);
  assert.deepEqual(Object.fromEntries(Object.entries(f.timing).map(([key, value]) => [key, Math.round(value)])), {
    flight: 900, explosion: 3800, total: 4700,
  });
});

test("play acknowledges a successful first drawing, then impacts once and completes with no idle RAF", async (t) => {
  const f = createFixture(t);
  const playing = f.play();
  assert.deepEqual(f.events, []);
  await settle();
  assert.equal(f.frames.size, 1);
  assert.equal(f.timers.size, 1);
  f.frame();
  assert.equal(f.events[0].kind, "started");
  assert.equal(f.events[0].drawn, true);
  f.finishFrames();
  await playing;
  assert.deepEqual(f.events.map(({ kind }) => kind), ["started", "impact"]);
  assert.ok(f.events[1].at - f.events[0].at >= f.timing.flight);
  assert.ok(f.events[1].at - f.events[0].at < f.timing.flight + 16);
  assert.ok(f.now - f.events[0].at >= f.timing.total);
  assert.ok(f.now - f.events[0].at < f.timing.total + 16);
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.canvas.context.calls.at(-1).method, "clearRect");
  assert.ok(f.renderer.lastAverageFps >= 50 && f.renderer.lastAverageFps <= 65);
});

test("a first frame delayed up to the suspension threshold still starts at the caster", async (t) => {
  for (const delay of [450, 700, 750]) {
    await t.test(`${delay}ms`, async (t) => {
      const f = createFixture(t);
      const playing = f.play();
      await settle();
      f.frame(delay);
      assert.deepEqual(f.events.map(({ kind }) => kind), ["started"]);
      const orb = f.canvas.context.calls.filter(({ method }) => method === "arc").at(-1);
      assert.equal(orb.args[0], 100, "the first visible frame is at the casting origin");
      assert.equal(orb.args[1], 200);
      f.finishFrames();
      await playing;
      assert.deepEqual(f.events.map(({ kind }) => kind), ["started", "impact"]);
      assert.ok(f.events[1].at - f.events[0].at >= f.timing.flight);
      assert.ok(f.events[1].at - f.events[0].at < f.timing.flight + 16);
    });
  }
});

test("a suspended initial or later frame cancels without a stale impact or stuck Promise", async (t) => {
  for (const hadFirstFrame of [false, true]) {
    await t.test(hadFirstFrame ? "during flight" : "before first frame", async (t) => {
      const f = createFixture(t);
      const playing = f.play();
      await settle();
      if (hadFirstFrame) f.frame();
      f.frame(800);
      await playing;
      assert.deepEqual(f.events.map(({ kind }) => kind), hadFirstFrame ? ["started"] : []);
      assert.equal(f.frames.size, 0);
      assert.equal(f.timers.size, 0);
      assert.equal(f.canvas.context.calls.at(-1).method, "clearRect");
    });
  }
});

test("duplicate play rejects during preparation and playback without replacing the active cast", async (t) => {
  const f = createFixture(t);
  const first = f.play();
  await assert.rejects(f.play(), /already playing/);
  await settle();
  f.frame();
  await assert.rejects(f.play(), /already playing/);
  assert.equal(f.frames.size, 1);
  f.renderer.cancel();
  await first;
  const next = f.play();
  await settle();
  f.finishFrames();
  await next;
  assert.deepEqual(f.events.map(({ kind }) => kind), ["started", "started", "impact"]);
});

test("cancel before the ready continuation resolves prevents late RAF and watchdog registration", async (t) => {
  const f = createFixture(t);
  const playing = f.play();
  f.renderer.cancel();
  await playing;
  await settle();
  assert.deepEqual(f.events, []);
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.canvas.context.calls.at(-1).method, "clearRect");
});

test("cancel while playing resolves promptly, clears the surface, and permits a new cast", async (t) => {
  const f = createFixture(t);
  const first = f.play();
  await settle();
  f.frame();
  f.renderer.cancel();
  f.renderer.cancel();
  await first;
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.canvas.context.calls.at(-1).method, "clearRect");
  const second = f.play();
  await settle();
  f.finishFrames();
  await second;
  assert.deepEqual(f.events.map(({ kind }) => kind), ["started", "started", "impact"]);
});

test("hiding cancels active work, rejects hidden casts and does not replay on return", async (t) => {
  const f = createFixture(t);
  const playing = f.play();
  await settle();
  f.frame();
  f.hide();
  await playing;
  assert.equal(f.frames.size, 0);
  await assert.rejects(f.play(), /not visible/);
  f.show();
  f.frame();
  assert.deepEqual(f.events.map(({ kind }) => kind), ["started"]);
  const next = f.play();
  await settle();
  f.finishFrames();
  await next;
  assert.deepEqual(f.events.map(({ kind }) => kind), ["started", "started", "impact"]);
});

test("the no-frame watchdog rejects and releases scheduling resources", async (t) => {
  const f = createFixture(t);
  const playing = f.play();
  const rejected = assert.rejects(playing, /timed out/);
  await settle();
  f.advanceWithoutFrames(6500);
  await rejected;
  assert.deepEqual(f.events, []);
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
});

test("drawing failure rejects without acknowledging a frame and restores a reusable renderer", async (t) => {
  const f = createFixture(t);
  const playing = f.play();
  const rejected = assert.rejects(playing, /Canvas arc failed/);
  await settle();
  f.canvas.context.failNext("arc");
  f.frame();
  await rejected;
  assert.deepEqual(f.events, []);
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
  const next = f.play();
  await settle();
  f.finishFrames();
  await next;
  assert.deepEqual(f.events.map(({ kind }) => kind), ["started", "impact"]);
});

test("callbacks may cancel playback without scheduling a stray frame", async (t) => {
  for (const phase of ["started", "impact"]) {
    await t.test(phase, async (t) => {
      const f = createFixture(t);
      const cancel = () => f.renderer.cancel();
      const playing = phase === "started" ? f.play(cancel) : f.play(undefined, cancel);
      await settle();
      f.finishFrames();
      await playing;
      assert.deepEqual(f.events.map(({ kind }) => kind), phase === "started" ? ["started"] : ["started", "impact"]);
      assert.equal(f.frames.size, 0);
      assert.equal(f.timers.size, 0);
    });
  }
});

test("projection replacement updates screen geometry without restarting the animation clock", async (t) => {
  const f = createFixture(t);
  const playing = f.play();
  f.renderer.setProjection({ x: 40, y: 50 }, { x: 240, y: 250 }, 80);
  await settle();
  f.frame();
  const firstOrb = f.canvas.context.calls.filter(({ method }) => method === "arc").at(-1);
  assert.deepEqual(firstOrb.args.slice(0, 2), [40, 50]);
  assert.ok(firstOrb.args[2] > 0 && firstOrb.args[2] < 80, "orb radius is a positive fraction of the projected blast radius");
  const beforeChange = f.timing.flight * 0.55;
  f.advanceFrames(beforeChange);
  f.renderer.setProjection({ x: 400, y: 500 }, { x: 1200, y: 900 }, 320);
  f.advanceFrames(f.timing.flight - beforeChange + 16);
  assert.equal(f.events.filter(({ kind }) => kind === "impact").length, 1, "projection updates do not restart flight");
  f.finishFrames();
  await playing;
});

test("standard and low caps apply to high-DPI landscape and portrait buffers without idle rendering", async (t) => {
  const f = createFixture(t, { quality: "standard", width: 3840, height: 2160 });
  assert.deepEqual([f.canvas.width, f.canvas.height], [1280, 720]);
  f.renderer.setQuality("low");
  assert.deepEqual([f.canvas.width, f.canvas.height], [960, 540]);
  f.resize(1080, 1920);
  assert.ok(f.canvas.width <= 960 && f.canvas.height <= 540);
  f.renderer.setQuality("standard");
  assert.ok(f.canvas.width <= 1280 && f.canvas.height <= 720);
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
});

test("auto chooses a low baseline on weaker devices or reduced motion and can lower quality on slow frames", async (t) => {
  for (const configuration of [{ cores: 4 }, { memory: 4 }, { reducedMotion: true, quality: "standard" }]) {
    await t.test(JSON.stringify(configuration), (t) => {
      const f = createFixture(t, configuration);
      assert.equal(f.renderer.currentQuality, "low");
    });
  }
  await t.test("five recent slow frames downgrade despite many cheap flight frames", async (t) => {
    const f = createFixture(t, { quality: "auto" });
    assert.equal(f.renderer.currentQuality, "standard");
    const playing = f.play();
    await settle();
    for (let i = 0; i < 60; i++) f.frame(16);
    assert.deepEqual(f.events.map(({ kind }) => kind), ["started", "impact"]);
    for (let i = 0; i < 4; i++) f.frame(40);
    assert.equal(f.renderer.currentQuality, "standard");
    f.frame(40);
    assert.equal(f.renderer.currentQuality, "low");
    assert.deepEqual([f.canvas.width, f.canvas.height], [960, 540]);
    f.renderer.cancel();
    await playing;
  });
});

test("fast frames reduce the recent-load score and exactly 34 ms is not a slow frame", async (t) => {
  const f = createFixture(t, { quality: "auto" });
  const playing = f.play();
  await settle();
  f.frame(16);
  for (let i = 0; i < 4; i++) f.frame(35);
  assert.equal(f.renderer.currentQuality, "standard");
  f.frame(34); // Four slow frames become three after a frame at the boundary.
  f.frame(35);
  assert.equal(f.renderer.currentQuality, "standard");
  f.frame(35);
  assert.equal(f.renderer.currentQuality, "low");
  f.renderer.cancel();
  await playing;
});

test("zoomed impacts keep volume pixel cost bounded without changing projected radius", async (t) => {
  const f = createFixture(t, { quality: "standard" });
  f.resize(1280,720);
  const playing = f.renderer.play({x:100,y:100},{x:500,y:400},()=>{},600);
  await settle();
  assert.ok(f.canvas.width <= 640 && f.canvas.height <= 360);
  f.frame();
  for(let radius=612;radius<=840;radius+=12) f.renderer.setProjection({x:100,y:100},{x:500,y:400},radius);
  assert.ok(f.canvas.width <= 510, "small zoom increments must accumulate past the resize hysteresis");
  f.renderer.setQuality("low");
  assert.ok(f.canvas.width <= 340);
  f.renderer.cancel(); await playing;
});

test("manually selected standard quality does not auto-downgrade during a slow burst", async (t) => {
  const f = createFixture(t, { quality: "standard" });
  const playing = f.play();
  await settle();
  for (let i = 0; i < 12; i++) f.frame(40);
  assert.equal(f.renderer.currentQuality, "standard");
  assert.deepEqual([f.canvas.width, f.canvas.height], [1280, 720]);
  f.renderer.cancel();
  await playing;
});

test("invalid projection inputs reject before creating a render loop", async (t) => {
  const f = createFixture(t);
  for (const [from, to, radius] of [
    [{ x: NaN, y: 0 }, { x: 0, y: 0 }, 10],
    [{ x: 0, y: 0 }, { x: Infinity, y: 0 }, 10],
    [{ x: 0, y: 0 }, { x: 1, y: 1 }, 0],
    [{ x: 0, y: 0 }, { x: 1, y: 1 }, 100001],
  ]) await assert.rejects(f.renderer.play(from, to, () => {}, radius), /projection/);
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
});

test("dispose is idempotent, resolves the cast, removes the canvas/listeners and rejects future use", async (t) => {
  const f = createFixture(t);
  const playing = f.play();
  await settle();
  f.frame();
  f.renderer.dispose();
  f.renderer.dispose();
  await playing;
  assert.equal(f.children.length, 0);
  assert.equal(f.listenerCount, 0);
  assert.deepEqual([f.canvas.width, f.canvas.height], [1, 1]);
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
  await assert.rejects(f.renderer.ready(), /disposed/);
  await assert.rejects(f.play(), /disposed/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";

// Execute the production adapter and protocol. Browser scheduling, SDK transport
// and GPU drawing are controlled substitutes; no adapter logic is copied here.
const compiled = new Map(["fx", "protocol"].map((name) => [name,
  ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText,
]));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { await setImmediate(); }

function createFixture(t, options = {}) {
  const instance = "overlay-1";
  const connection = "local-connection";
  const messages = [];
  const operations = [];
  const renderers = [];
  const gates = new Map();
  const allGates = [];
  const intervals = new Map();
  const frames = new Map();
  const listeners = { document: new Map(), window: new Map() };
  const logs = [];
  let nextTimer = 1;
  let readyCallback;
  let subscription;
  let unsubscribed = 0;
  let origin = { x: 20, y: 30 };
  let scale = 2;
  const root = {};
  const document = {
    hidden: false,
    querySelector: (selector) => selector === "#fx-root" ? root : null,
    addEventListener: (name, callback) => subscribe("document", name, callback),
    removeEventListener: (name, callback) => listeners.document.get(name)?.delete(callback),
  };
  const window = {
    addEventListener: (name, callback) => subscribe("window", name, callback),
    removeEventListener: (name, callback) => listeners.window.get(name)?.delete(callback),
  };

  function subscribe(surface, name, callback) {
    const entries = listeners[surface].get(name) ?? new Set();
    entries.add(callback);
    listeners[surface].set(name, entries);
  }
  function emit(surface, name) {
    for (const callback of [...(listeners[surface].get(name) ?? [])]) callback({ type: name });
  }
  async function operation(name) {
    operations.push(name);
    const queue = gates.get(name);
    const gate = queue?.shift();
    if (!gate) return;
    gate.entered.resolve();
    await gate.result.promise;
  }
  function deferNext(name) {
    const gate = { entered: deferred(), result: deferred() };
    const queue = gates.get(name) ?? [];
    queue.push(gate);
    gates.set(name, queue);
    allGates.push(gate);
    return { entered: gate.entered.promise, release: gate.result.resolve, reject: gate.result.reject };
  }

  const OBR = {
    isAvailable: options.available ?? true,
    onReady: (callback) => { readyCallback = callback; },
    player: { getConnectionId: async () => connection },
    broadcast: {
      onMessage: (channel, callback) => {
        subscription = { channel, callback };
        return () => { subscription = undefined; unsubscribed++; };
      },
      sendMessage: async (channel, data, destination) => {
        messages.push({ channel, data: structuredClone(data), destination,
          drawnFrames: renderers.reduce((total, renderer) => total + renderer.drawnFrames, 0) });
        await operation(`send.${data.kind}`);
      },
    },
    viewport: {
      transformPoint: async (point) => {
        assert.deepEqual(point, { x: 0, y: 0 }, "adapter should acquire one world origin, not transform every particle");
        await operation("viewport.transformPoint");
        return { ...origin };
      },
      getScale: async () => { await operation("viewport.getScale"); return scale; },
    },
  };

  class MockRenderer {
    constructor(container, quality, kind) {
      assert.equal(container, root);
      this.kind = kind;
      this.initialQuality = quality;
      this.currentQuality = quality === "low" ? "low" : "standard";
      this.qualityChanges = [];
      this.projections = [];
      this.plays = [];
      this.lastAverageFps = 58;
      this.drawnFrames = 0;
      this.cancelCount = 0;
      this.disposeCount = 0;
      this.disposed = false;
      this.pending = null;
      renderers.push(this);
      if (options[`${kind}ConstructorError`]) throw new Error(`${kind} constructor unavailable`);
    }
    async ready() {
      await operation(`${this.kind}.ready`);
      if (this.disposed) throw new Error("renderer disposed during preparation");
      if (options[`${this.kind}ReadyError`]) throw new Error(`${this.kind} preparation failed`);
    }
    setQuality(quality) {
      this.qualityChanges.push(quality);
      this.currentQuality = quality === "low" ? "low" : "standard";
    }
    setProjection(from, to, radius) { this.projections.push({ from, to, radius }); }
    play(from, to, onImpact, radius, onStarted) {
      const completion = deferred();
      const play = { from, to, radius, onImpact, onStarted, completion, firstFrame: false };
      this.plays.push(play);
      this.pending = play;
      return completion.promise;
    }
    firstFrame() {
      if (!this.pending || this.pending.firstFrame) return;
      this.pending.firstFrame = true;
      this.drawnFrames++;
      this.pending.onStarted?.();
    }
    impact() { this.pending?.onImpact(); }
    complete() {
      const pending = this.pending;
      this.pending = null;
      pending?.completion.resolve();
    }
    reject(error = new Error("WebGL context lost")) {
      const pending = this.pending;
      this.pending = null;
      pending?.completion.reject(error);
    }
    cancel() { this.cancelCount++; this.complete(); }
    dispose() { this.disposeCount++; this.disposed = true; this.complete(); }
  }
  class WebGLRenderer extends MockRenderer {
    constructor(container, quality) { super(container, quality, "webgl"); }
  }
  class CanvasRenderer extends MockRenderer {
    constructor(container, quality) { super(container, quality, "canvas"); }
  }

  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const module = { exports: {} };
    new Function("require", "module", "exports", "document", "window", "location", "console",
      "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", compiled.get(name))(
      (id) => {
        if (id === "@owlbear-rodeo/sdk") return { __esModule: true, default: OBR };
        if (id === "./performance-fx") return { ThreeFireballPrototype: WebGLRenderer, CanvasFireballFallback: CanvasRenderer };
        if (id === "./protocol") return load("protocol");
        throw new Error(`Unexpected production dependency: ${id}`);
      }, module, module.exports, document, window,
      { search: `?instance=${instance}&quality=standard` },
      Object.fromEntries(["warn", "error", "log"].map((method) => [method, (...args) => logs.push({ method, args })])),
      (callback, ms) => { const id = nextTimer++; intervals.set(id, { callback, ms }); return id; },
      (id) => intervals.delete(id),
      (callback) => { const id = nextTimer++; frames.set(id, callback); return id; },
      (id) => frames.delete(id),
    );
    modules.set(name, module.exports);
    return module.exports;
  }

  load("fx");
  const { LOCAL_CHANNEL } = load("protocol");
  t.after(async () => {
    emit("window", "pagehide");
    for (const gate of allGates) gate.result.resolve();
    await settle();
  });

  return {
    instance, connection, messages, operations, renderers, intervals, frames, logs,
    deferNext,
    async start() { readyCallback?.(); await settle(); },
    get subscribed() { return !!subscription; },
    get unsubscribed() { return unsubscribed; },
    count(name) { return operations.filter((entry) => entry === name).length; },
    events(kind) { return messages.filter(({ data }) => data.kind === kind).map(({ data }) => data); },
    stages(castId) { return messages.filter(({ data }) => data.kind === "fx-stage" && data.castId === castId).map(({ data }) => data.stage); },
    setProjection(nextOrigin, nextScale) { origin = nextOrigin; scale = nextScale; },
    deliver(data, sender = connection) {
      if (subscription) {
        assert.equal(subscription.channel, LOCAL_CHANNEL);
        subscription.callback({ connectionId: sender, data });
      }
    },
    play(castId = "cast-1", slot = "primary", overrides = {}, sender = connection) {
      this.deliver({ kind: "fx-play", instance, quality: "standard", slot,
        cast: { kind: "cast-v2", version: 2, castId, sceneKey: "scene-1", seed: 1234,
          from: { x: 100, y: 200 }, to: { x: 300, y: 400 }, radius: 600, projectileSize: 48 },
        ...overrides,
      }, sender);
    },
    tick() { for (const { callback } of [...intervals.values()]) callback(); },
    flushFrames() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(16);
    },
    hide() { document.hidden = true; emit("document", "visibilitychange"); },
    show() { document.hidden = false; emit("document", "visibilitychange"); },
    clear() { this.deliver({ kind: "fx-clear", instance }); },
    closePage() { emit("window", "pagehide"); },
  };
}

test("fx-ready is sent only after renderer prewarming, with no idle animation or projection polling", async (t) => {
  const f = createFixture(t);
  const gate = f.deferNext("webgl.ready");
  await f.start();
  await gate.entered;
  assert.equal(f.events("fx-ready").length, 0);
  assert.equal(f.renderers[0].initialQuality, "standard");
  gate.release();
  await settle();
  assert.deepEqual(f.events("fx-ready"), [{ kind: "fx-ready", instance: f.instance, engine: "webgl" }]);
  assert.ok(f.messages.every(({ destination }) => destination.destination === "LOCAL"));
  assert.equal(f.intervals.size, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.count("viewport.transformPoint"), 0);
});

test("failed WebGL preparation waits for Canvas preparation before advertising readiness", async (t) => {
  const f = createFixture(t, { webglReadyError: true });
  const gate = f.deferNext("canvas.ready");
  await f.start();
  await gate.entered;
  assert.equal(f.renderers[0].disposeCount, 1);
  assert.equal(f.events("fx-ready").length, 0);
  gate.release();
  await settle();
  assert.equal(f.events("fx-ready")[0].engine, "canvas");
  assert.equal(f.renderers[1].initialQuality, "low");
});

test("failure of both backends sends fx-failed and removes the listener", async (t) => {
  const f = createFixture(t, { webglReadyError: true, canvasReadyError: true });
  await f.start();
  assert.equal(f.events("fx-ready").length, 0);
  assert.equal(f.events("fx-failed").length, 1);
  assert.match(f.events("fx-failed")[0].detail, /canvas preparation failed/);
  assert.equal(f.subscribed, false);
  assert.ok(f.renderers.every((renderer) => renderer.disposed));
});

test("started acknowledges the renderer's first successful draw, then impact and finish preserve order", async (t) => {
  const f = createFixture(t);
  await f.start();
  f.play();
  await settle();
  const renderer = f.renderers[0];
  assert.equal(renderer.plays.length, 1);
  assert.deepEqual(renderer.plays[0].from, { x: 220, y: 430 });
  assert.deepEqual(renderer.plays[0].to, { x: 620, y: 830 });
  assert.equal(renderer.plays[0].radius, 1200);
  assert.deepEqual(f.stages("cast-1"), []);
  f.flushFrames();
  await settle();
  assert.deepEqual(f.stages("cast-1"), [], "an adapter rAF is not proof that the renderer drew");
  renderer.firstFrame();
  await settle();
  const start = f.messages.find(({ data }) => data.kind === "fx-stage" && data.stage === "started");
  assert.ok(start.drawnFrames >= 1);
  renderer.impact();
  renderer.complete();
  await settle();
  assert.deepEqual(f.stages("cast-1"), ["started", "impact", "finished"]);
  assert.equal(f.intervals.size, 0);
});

test("terminal stages report the renderer's actual quality after automatic degradation", async (t) => {
  for (const terminal of ["finished", "cancelled", "error"]) {
    await t.test(terminal, async (t) => {
      const f = createFixture(t);
      await f.start();
      f.play();
      await settle();
      const renderer = f.renderers[0];
      renderer.firstFrame();
      renderer.currentQuality = "low";
      if (terminal === "finished") renderer.complete();
      else if (terminal === "cancelled") f.hide();
      else renderer.reject();
      await settle();
      const event = f.events("fx-stage").find((message) => message.stage === terminal);
      assert.equal(event.actualQuality, "low");
      assert.equal(event.fps, renderer.lastAverageFps);
    });
  }
});

test("duplicate casts are ignored and two renderer slots enforce a bounded concurrency limit", async (t) => {
  const f = createFixture(t);
  await f.start();
  f.play("primary-1");
  f.play("primary-1");
  f.play("secondary-1", "secondary");
  f.play("overflow-primary");
  f.play("overflow-secondary", "secondary");
  await settle();
  assert.equal(f.renderers.length, 2);
  assert.equal(f.renderers[0].plays.length, 1);
  assert.equal(f.renderers[1].plays.length, 1);
  assert.deepEqual(f.renderers[1].qualityChanges, ["low"]);
  assert.deepEqual(f.stages("overflow-primary"), ["error"]);
  assert.deepEqual(f.stages("overflow-secondary"), ["error"]);
  f.renderers.forEach((renderer) => renderer.complete());
  await settle();
  f.play("primary-1");
  f.play("overflow-primary");
  await settle();
  assert.equal(f.renderers[0].plays.length, 1, "completed and rejected casts are not queued or replayed");
  f.play("primary-2");
  await settle();
  assert.equal(f.renderers[0].plays.length, 2, "a fresh cast can use the released slot");
});

test("control messages from other connections, other overlay instances, or invalid payloads are ignored", async (t) => {
  const f = createFixture(t);
  await f.start();
  f.play("foreign", "primary", {}, "another-player");
  f.play("old-overlay", "primary", { instance: "expired-overlay" });
  f.play("invalid", "primary", { cast: { castId: "invalid" } });
  f.deliver({ kind: "fx-clear", instance: f.instance }, "another-player");
  await settle();
  assert.equal(f.renderers[0].plays.length, 0);
  assert.equal(f.subscribed, true);
});

test("10 Hz projection updates are serialized while an SDK snapshot remains in flight", async (t) => {
  const f = createFixture(t);
  await f.start();
  f.play();
  await settle();
  assert.deepEqual([...f.intervals.values()].map(({ ms }) => ms), [100]);
  const before = f.count("viewport.transformPoint");
  const gate = f.deferNext("viewport.transformPoint");
  f.setProjection({ x: -40, y: 90 }, 0.5);
  f.tick();
  await gate.entered;
  for (let i = 0; i < 20; i++) f.tick();
  assert.equal(f.count("viewport.transformPoint"), before + 1);
  assert.equal(f.renderers[0].projections.length, 0);
  gate.release();
  await settle();
  assert.deepEqual(f.renderers[0].projections, [{ from: { x: 10, y: 190 }, to: { x: 110, y: 290 }, radius: 300 }]);
  f.tick();
  await settle();
  assert.equal(f.count("viewport.transformPoint"), before + 2);
  f.renderers[0].complete();
  await settle();
  assert.equal(f.intervals.size, 0);
});

test("projection failure emits one error terminal, cancels rendering, and never retries the cast", async (t) => {
  const f = createFixture(t);
  await f.start();
  f.play();
  await settle();
  const renderer = f.renderers[0];
  renderer.firstFrame();
  const gate = f.deferNext("viewport.transformPoint");
  f.tick();
  await gate.entered;
  gate.reject(new Error("viewport disconnected"));
  await settle();
  assert.equal(renderer.cancelCount, 1);
  assert.deepEqual(f.stages("cast-1"), ["started", "error"]);
  assert.equal(f.intervals.size, 0);
  f.play();
  await settle();
  assert.equal(renderer.plays.length, 1);
});

test("renderer failure emits error without automatic fallback replay, then releases its slot", async (t) => {
  const f = createFixture(t);
  await f.start();
  f.play();
  await settle();
  const renderer = f.renderers[0];
  renderer.firstFrame();
  renderer.reject();
  await settle();
  assert.deepEqual(f.stages("cast-1"), ["started", "error"]);
  assert.equal(f.renderers.length, 1);
  f.play();
  f.play("next-cast");
  await settle();
  assert.equal(renderer.plays.length, 2);
});

test("hiding during playback cancels once and showing the iframe does not replay", async (t) => {
  const f = createFixture(t);
  await f.start();
  f.play();
  await settle();
  f.hide();
  await settle();
  f.flushFrames();
  assert.deepEqual(f.stages("cast-1"), ["cancelled"]);
  assert.equal(f.intervals.size, 0);
  f.show();
  f.play();
  await settle();
  assert.equal(f.renderers[0].plays.length, 1);
});

test("hiding during renderer readiness or initial projection still settles the cast as cancelled", async (t) => {
  for (const operation of ["webgl.ready", "viewport.transformPoint"]) {
    await t.test(operation, async (t) => {
      const f = createFixture(t);
      await f.start();
      const gate = f.deferNext(operation);
      f.play();
      await gate.entered;
      f.hide();
      gate.release();
      await settle();
      assert.equal(f.renderers[0].plays.length, 0);
      assert.deepEqual(f.stages("cast-1"), ["cancelled"]);
      assert.equal(f.intervals.size, 0);
      f.show();
      f.play();
      await settle();
      assert.equal(f.renderers[0].plays.length, 0);
    });
  }
});

test("clear during a pending projection ignores its late result, disposes both slots and removes transport", async (t) => {
  const f = createFixture(t);
  await f.start();
  f.play("primary");
  f.play("secondary", "secondary");
  await settle();
  const gate = f.deferNext("viewport.transformPoint");
  f.tick();
  await gate.entered;
  f.clear();
  gate.release();
  await settle();
  assert.equal(f.subscribed, false);
  assert.equal(f.intervals.size, 0);
  assert.deepEqual(f.stages("primary"), ["cancelled"]);
  assert.deepEqual(f.stages("secondary"), ["cancelled"]);
  assert.ok(f.renderers.every((renderer) => renderer.disposed && renderer.projections.length === 0));
  f.flushFrames();
  f.show();
  f.play("late");
  await settle();
  assert.equal(f.events("fx-stage").length, 2);
});

test("page close during prewarming does not advertise a late ready or create fallback", async (t) => {
  const f = createFixture(t);
  const gate = f.deferNext("webgl.ready");
  await f.start();
  await gate.entered;
  f.closePage();
  gate.release();
  await settle();
  assert.equal(f.events("fx-ready").length, 0);
  assert.equal(f.events("fx-failed").length, 0);
  assert.equal(f.renderers.length, 1);
  assert.equal(f.subscribed, false);
});

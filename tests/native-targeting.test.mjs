import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";

// Compile the actual source into an isolated module. Only SDK calls, Vite's base
// URL and interval scheduling are substituted; no production loader is changed.
const compiled = new Map();
for (const name of ["native-targeting", "constants", "geometry"]) {
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8")
    .replaceAll("import.meta.env.BASE_URL", JSON.stringify("/fireball/"));
  compiled.set(name, ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  // Native event handlers return void and then finish through Promise callbacks.
  await setImmediate();
}

function createFixture(t, options = {}) {
  const local = new Map();
  const tokens = new Map([["token", {
    id: "token", type: "IMAGE", layer: "CHARACTER", center: { x: 100, y: 200 },
  }]]);
  const listeners = { scene: new Set(), tool: new Set(), grid: new Set() };
  const intervals = new Map();
  const gates = new Map();
  const allGates = [];
  const operations = [];
  const confirmed = [];
  const confirmationState = [];
  const errors = [];
  let selection = ["token"];
  let activeTool = "move";
  let activeMode = "move/default";
  const rememberedModes = new Map([[activeTool, activeMode]]);
  let mode;
  let tool;
  let ready = true;
  let cancelled = 0;
  let nextIntervalId = 1;

  async function operation(name) {
    operations.push(name);
    const gate = gates.get(name);
    if (!gate) return;
    gates.delete(name);
    gate.entered.resolve();
    await gate.result.promise;
  }

  function subscribe(type, callback) {
    listeners[type].add(callback);
    return () => listeners[type].delete(callback);
  }

  function bounds(center, width = 150, height = 150) {
    return { center: { ...center }, width, height,
      min: { x: center.x - width / 2, y: center.y - height / 2 },
      max: { x: center.x + width / 2, y: center.y + height / 2 } };
  }

  function buildShape() {
    const item = { type: "SHAPE" };
    const builder = new Proxy({}, {
      get(_, key) {
        if (key === "build") return () => item;
        return (value) => { item[key] = value; return builder; };
      },
    });
    return builder;
  }

  const dpi = options.dpi ?? 150;
  const scale = options.scale ?? { raw: "5ft", parsed: { multiplier: 5, unit: "ft" } };
  const OBR = {
    player: { getSelection: async () => selection },
    tool: {
      createMode: async (value) => { await operation("tool.createMode"); mode = value; },
      create: async (value) => { await operation("tool.create"); tool = value; },
      remove: async () => operation("tool.remove"),
      removeMode: async () => operation("tool.removeMode"),
      getActiveTool: async () => activeTool,
      getActiveToolMode: async () => activeMode,
      onToolChange: (callback) => subscribe("tool", callback),
      // Activating a mode configures that tool; it must not implicitly select the tool.
      activateTool: async (id) => {
        await operation("tool.activateTool");
        if (options.ignoreToolActivation) return;
        const previous = activeTool;
        activeTool = id;
        activeMode = rememberedModes.get(id) ?? (id === tool?.id ? options.initialFireballMode ?? tool.defaultMode : `${id}/default`);
        for (const callback of listeners.tool) callback(id);
        if (previous.endsWith("/native-targeting") && previous !== id) {
          // Both callbacks can arrive when restoration interrupts a pointer drag.
          mode.onToolDragCancel();
          mode.onDeactivate();
        }
      },
      activateMode: async (id, nextMode) => {
        await operation("tool.activateMode");
        if (options.ignoreModeActivation) return;
        rememberedModes.set(id, nextMode);
        if (activeTool === id) activeMode = nextMode;
      },
    },
    scene: {
      isReady: async () => ready,
      onReadyChange: (callback) => subscribe("scene", callback),
      grid: {
        getDpi: async () => dpi,
        getScale: async () => scale,
        onChange: (callback) => subscribe("grid", callback),
      },
      items: {
        getItems: async (ids) => {
          await operation("items.getItems");
          return ids.map((id) => tokens.get(id)).filter(Boolean);
        },
        getItemBounds: async (ids) => {
          await operation("items.getItemBounds");
          const token = tokens.get(ids[0]);
          if (!token) throw new Error("Item not found");
          return bounds(token.center);
        },
      },
      local: {
        addItems: async (items) => {
          await operation("local.addItems");
          for (const item of items) local.set(item.id, structuredClone(item));
        },
        deleteItems: async (ids) => {
          await operation("local.deleteItems");
          for (const id of ids) local.delete(id);
        },
        getItemBounds: async (ids) => {
          const item = local.get(ids[0]);
          if (!item) throw new Error("Local item not found");
          const offset = options.centeredShape ? 0 : 0.5;
          return bounds({
            x: item.position.x + item.width * offset,
            y: item.position.y + item.height * offset,
          }, item.width, item.height);
        },
        updateItems: async (ids, recipe) => {
          await operation("local.updateItems");
          recipe(ids.map((id) => local.get(id)).filter(Boolean));
        },
      },
    },
  };

  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const output = { exports: {} };
    new Function("require", "module", "exports", "setInterval", "clearInterval", compiled.get(name))(
      (id) => {
        if (id === "@owlbear-rodeo/sdk") return { __esModule: true, default: OBR, buildShape };
        if (id === "./constants" || id === "./geometry") return load(id.slice(2));
        throw new Error(`Unexpected production dependency: ${id}`);
      },
      output, output.exports,
      (callback, ms) => {
        const id = nextIntervalId++;
        intervals.set(id, { callback, ms });
        return id;
      },
      (id) => intervals.delete(id),
    );
    modules.set(name, output.exports);
    return output.exports;
  }

  const { NativeTargeting } = load("native-targeting");
  const targeting = new NativeTargeting({
    onRequest: options.onRequest,
    onConfirm: async (cast) => {
      confirmationState.push({ activeTool, previewCount: local.size });
      confirmed.push(cast);
    },
    onCancel: () => { cancelled += 1; },
    onError: (error) => errors.push(error),
  });

  t.after(async () => {
    for (const gate of allGates) gate.result.resolve();
    await targeting.dispose();
  });

  return {
    targeting, local, tokens, operations, confirmed, confirmationState, errors, intervals,
    get mode() { return mode; },
    get tool() { return tool; },
    get cancelled() { return cancelled; },
    get activeTool() { return activeTool; },
    get activeMode() { return activeMode; },
    get listenerCount() { return Object.values(listeners).reduce((sum, values) => sum + values.size, 0); },
    setSelection(value) { selection = value; },
    setReady(value) { ready = value; },
    count(name) { return operations.filter((operation) => operation === name).length; },
    tick() { for (const { callback } of [...intervals.values()]) callback(); },
    move(point) { if (activeTool === tool.id && activeMode === mode.id) mode.onToolMove({}, { pointerPosition: point }); },
    click(point) { if (activeTool === tool.id && activeMode === mode.id) return mode.onToolClick({}, { pointerPosition: point }); },
    escape() { if (activeTool === tool.id && activeMode === mode.id) mode.onKeyDown({}, { key: "Escape" }); },
    async switchTool(id = "measure") { await OBR.tool.activateTool(id); await OBR.tool.activateMode(id, `${id}/default`); },
    closeScene() {
      ready = false;
      for (const callback of listeners.scene) callback(false);
    },
    changeGrid(grid) { for (const callback of listeners.grid) callback(grid); },
    deferNext(name) {
      const gate = { entered: deferred(), result: deferred() };
      gates.set(name, gate);
      allGates.push(gate);
      return { entered: gate.entered.promise, release: gate.result.resolve, reject: gate.result.reject };
    },
  };
}

test("registration and disposal are idempotent and remove subscriptions", async (t) => {
  const f = createFixture(t);
  await Promise.all([f.targeting.init(), f.targeting.init()]);
  assert.equal(f.count("tool.createMode"), 1);
  assert.equal(f.count("tool.create"), 1);
  assert.equal(f.listenerCount, 3);
  await Promise.all([f.targeting.dispose(), f.targeting.dispose()]);
  assert.equal(f.count("tool.remove"), 1);
  assert.equal(f.count("tool.removeMode"), 1);
  assert.equal(f.listenerCount, 0);
  await assert.rejects(f.targeting.begin(), /已关闭/);
});

test("native toolbar delegates requests to the controller without bypassing its state", async (t) => {
  let requested = 0;
  const f = createFixture(t, { onRequest: () => { requested += 1; } });
  await f.targeting.init();
  assert.equal(f.tool.onClick(), false);
  await settle();
  assert.equal(requested, 1);
  assert.equal(f.local.size, 0);
  assert.equal(f.count("tool.activateMode"), 0);
  await f.targeting.begin();
  assert.equal(f.local.size, 1, "controller may explicitly begin after validating state");
});

test("native toolbar keeps standalone begin behavior when onRequest is omitted", async (t) => {
  const f = createFixture(t);
  await f.targeting.init();
  assert.equal(f.tool.onClick(), false);
  await settle();
  assert.equal(f.local.size, 1);
  assert.equal(f.errors.length, 0);
});

test("begin requires exactly one existing character image and a ready scene", async (t) => {
  const cases = [
    ["no selection", (f) => f.setSelection([])],
    ["multiple selection", (f) => f.setSelection(["token", "second"])],
    ["map image", (f) => { f.tokens.get("token").layer = "MAP"; }],
    ["non-image", (f) => { f.tokens.get("token").type = "SHAPE"; }],
    ["deleted item", (f) => f.tokens.delete("token")],
    ["closed scene", (f) => f.setReady(false)],
  ];
  for (const [name, arrange] of cases) {
    await t.test(name, async (t) => {
      const f = createFixture(t);
      arrange(f);
      await assert.rejects(f.targeting.begin());
      assert.equal(f.count("local.addItems"), 0);
      assert.equal(f.confirmed.length, 0);
    });
  }
});

test("20 ft preview uses actual grid units and centers either native shape anchor", async (t) => {
  for (const centeredShape of [false, true]) {
    await t.test(centeredShape ? "center origin" : "top-left origin", async (t) => {
      const f = createFixture(t, { centeredShape,
        scale: { raw: "1.524m", parsed: { multiplier: 1.524, unit: "m" } } });
      await f.targeting.begin();
      const circle = [...f.local.values()][0];
      assert.equal(circle.shapeType, "CIRCLE");
      assert.equal(circle.width, 1200);
      assert.equal(circle.height, 1200);
      assert.equal(circle.disableHit, true);
      assert.equal(circle.visible, true);
      assert.deepEqual(circle.position, centeredShape ? { x: 100, y: 200 } : { x: -500, y: -400 });
      assert.deepEqual([...f.intervals.values()].map(({ ms }) => ms), [50]);
    });
  }
});

test("aiming explicitly activates the tool and mode before exposing a movable, clickable preview", async (t) => {
  const f = createFixture(t, { centeredShape: true });
  await f.targeting.begin();
  assert.equal(f.activeTool, f.tool.id);
  assert.equal(f.activeMode, f.mode.id);
  assert.ok(f.operations.indexOf("tool.activateTool") < f.operations.indexOf("tool.activateMode"));
  assert.ok(f.operations.indexOf("tool.activateMode") < f.operations.indexOf("local.updateItems"));
  f.move({ x: 750, y: 850 });
  f.tick();
  await settle();
  assert.deepEqual([...f.local.values()][0].position, { x: 750, y: 850 });
  f.click({ x: 750, y: 850 });
  await settle();
  assert.equal(f.confirmed.length, 1);
  assert.deepEqual(f.confirmed[0].to, { x: 750, y: 850 });
  assert.equal(f.activeTool, "move");
  assert.equal(f.activeMode, "move/default");
  assert.equal(f.local.size, 0);
});

test("silently rejected activation fails visibly and leaves no fixed circle", async (t) => {
  for (const options of [
    { ignoreToolActivation: true },
    { ignoreModeActivation: true, initialFireballMode: "another-mode" },
  ]) {
    await t.test(JSON.stringify(options), async (t) => {
      const f = createFixture(t, options);
      await assert.rejects(f.targeting.begin(), /未能/);
      assert.equal(f.local.size, 0);
      assert.equal(f.intervals.size, 0);
      assert.equal(f.confirmed.length, 0);
      assert.equal(f.count("local.updateItems"), 0, "the preview must stay hidden until activation is verified");
      assert.equal(f.activeTool, "move");
    });
  }
});

test("cancelling an in-flight tool activation cleans its late result and restores the original tool", async (t) => {
  const f = createFixture(t);
  const pending = f.deferNext("tool.activateTool");
  const beginning = f.targeting.begin();
  await pending.entered;
  assert.equal([...f.local.values()][0].visible, false);
  const cancelling = f.targeting.cancel();
  pending.release();
  await Promise.all([beginning, cancelling]);
  assert.equal(f.local.size, 0);
  assert.equal(f.activeTool, "move");
  assert.equal(f.activeMode, "move/default");
  assert.equal(f.intervals.size, 0);
  assert.equal(f.cancelled, 1);
});

test("confirmation is single-shot, rereads the origin, and restores before calling onConfirm", async (t) => {
  const f = createFixture(t);
  await f.targeting.begin();
  f.tokens.get("token").center = { x: 300, y: 400 };
  assert.equal(f.click({ x: 700, y: 800 }), false);
  f.click({ x: 900, y: 900 });
  await settle();
  assert.equal(f.confirmed.length, 1);
  assert.deepEqual(f.confirmed[0], {
    from: { x: 300, y: 400 }, to: { x: 700, y: 800 }, radius: 600, projectileSize: 48,
  });
  assert.deepEqual(f.confirmationState, [{ activeTool: "move", previewCount: 0 }]);
  assert.equal(f.cancelled, 0, "restoration drag-cancel and deactivate must not cancel confirmation");
  assert.equal(f.errors.length, 0);
  assert.equal(f.intervals.size, 0);
});

test("pointer movement coalesces to the latest position with at most one RPC in flight", async (t) => {
  const f = createFixture(t);
  await f.targeting.begin();
  const baseline = f.count("local.updateItems");
  const gate = f.deferNext("local.updateItems");
  for (let i = 0; i < 100; i++) f.move({ x: i, y: i });
  f.tick();
  await gate.entered;
  for (let i = 100; i < 200; i++) { f.move({ x: i, y: i }); f.tick(); }
  assert.equal(f.count("local.updateItems"), baseline + 1);
  gate.release();
  await settle();
  f.tick();
  await settle();
  assert.equal(f.count("local.updateItems"), baseline + 2);
  assert.deepEqual([...f.local.values()][0].position, { x: -401, y: -401 });
  f.tick();
  await settle();
  assert.equal(f.count("local.updateItems"), baseline + 2, "idle targeting produces no update RPCs");
});

test("cancelling waits for an in-flight update before removing the preview", async (t) => {
  const f = createFixture(t);
  await f.targeting.begin();
  const gate = f.deferNext("local.updateItems");
  f.move({ x: 500, y: 700 });
  f.tick();
  await gate.entered;
  const cancelling = f.targeting.cancel();
  await settle();
  assert.equal(f.count("local.deleteItems"), 0);
  gate.release();
  await cancelling;
  assert.equal(f.local.size, 0);
  assert.equal(f.cancelled, 1);
  assert.equal(f.activeTool, "move");
  assert.equal(f.intervals.size, 0);
});

test("late addItems after cancellation is cleaned without activating targeting", async (t) => {
  const f = createFixture(t);
  const gate = f.deferNext("local.addItems");
  const beginning = f.targeting.begin();
  await gate.entered;
  const cancelling = f.targeting.cancel();
  gate.release();
  await Promise.all([beginning, cancelling]);
  assert.equal(f.local.size, 0);
  assert.equal(f.count("local.deleteItems"), 1);
  assert.equal(f.count("tool.activateMode"), 0);
  assert.equal(f.cancelled, 1);
});

test("cancel during initialization prevents late begin from starting a session", async (t) => {
  const f = createFixture(t);
  const gate = f.deferNext("tool.createMode");
  const beginning = f.targeting.begin();
  await gate.entered;
  await f.targeting.cancel();
  gate.release();
  await beginning;
  assert.equal(f.count("local.addItems"), 0);
  assert.equal(f.count("tool.activateMode"), 0);
  assert.equal(f.local.size, 0);
});

test("Escape cancels and restores; switching tools cancels without overwriting the new tool", async (t) => {
  const f = createFixture(t);
  await f.targeting.begin();
  f.escape();
  await settle();
  assert.equal(f.cancelled, 1);
  assert.equal(f.local.size, 0);
  assert.equal(f.activeTool, "move");
  await f.targeting.begin();
  await f.switchTool("measure");
  await settle();
  assert.equal(f.cancelled, 2);
  assert.equal(f.local.size, 0);
  assert.equal(f.activeTool, "measure");
});

test("grid scale changes and scene shutdown cancel targeting and its interval", async (t) => {
  const f = createFixture(t);
  await f.targeting.begin();
  f.changeGrid({ dpi: 150, scale: "10ft" });
  await settle();
  assert.equal(f.cancelled, 1);
  assert.equal(f.local.size, 0);
  await f.targeting.begin();
  f.closeScene();
  await settle();
  assert.equal(f.cancelled, 2);
  assert.equal(f.local.size, 0);
  assert.equal(f.intervals.size, 0);
});

test("scene shutdown invalidates a late confirmation response", async (t) => {
  const f = createFixture(t);
  await f.targeting.begin();
  const gate = f.deferNext("items.getItemBounds");
  f.click({ x: 700, y: 800 });
  await gate.entered;
  f.closeScene();
  gate.release();
  await settle();
  assert.equal(f.confirmed.length, 0);
  assert.equal(f.local.size, 0);
  assert.equal(f.cancelled, 1);
  assert.equal(f.errors.length, 0);
});

test("a removed origin cannot cast and failed pointer updates are surfaced and cleaned", async (t) => {
  const f = createFixture(t);
  await f.targeting.begin();
  f.tokens.delete("token");
  f.click({ x: 700, y: 800 });
  await settle();
  assert.equal(f.confirmed.length, 0);
  assert.equal(f.errors.length, 1);
  assert.equal(f.local.size, 0);

  f.tokens.set("token", { id: "token", type: "IMAGE", layer: "CHARACTER", center: { x: 0, y: 0 } });
  await f.targeting.begin();
  const gate = f.deferNext("local.updateItems");
  f.move({ x: 100, y: 100 });
  f.tick();
  await gate.entered;
  gate.reject(new Error("SDK update unavailable"));
  await settle();
  assert.equal(f.errors.length, 2);
  assert.match(f.errors[1].message, /SDK update unavailable/);
  assert.equal(f.local.size, 0);
  assert.equal(f.intervals.size, 0);
});

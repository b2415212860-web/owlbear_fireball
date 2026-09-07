import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";

const compiled = new Map();
for (const name of ["controller", "protocol", "constants", "residue"]) {
  compiled.set(name, ts.transpileModule(
    readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8")
      .replaceAll("import.meta.env.BASE_URL", JSON.stringify("/fireball/")),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const settle = () => setImmediate();
const castInput = { from: { x: 100, y: 200 }, to: { x: 800, y: 600 }, radius: 600, projectileSize: 48 };
const fireSphere = {
  name: "Fire Sphere", type: "PROP", image: { width: 640, height: 480, mime: "video/webm", url: "https://assets.example/fire.webm" },
  grid: { dpi: 160, offset: { x: 3, y: 4 } }, scale: { x: 1.5, y: -1 }, rotation: 30,
};

async function createFixture(t, options = {}) {
  const modules = new Map();
  const channels = new Map();
  const sceneListeners = new Set();
  const metadataListeners = new Set();
  const pagehide = new Set();
  const timers = new Map();
  const intervals = new Map();
  const gates = new Map();
  const allGates = [];
  const operations = [];
  const outbound = [];
  const modals = [];
  const popovers = [];
  const notifications = [];
  const items = new Map();
  const itemWrites = [];
  const storage = options.storage ?? new Map();
  const pickerCalls = [];
  let targeting;
  let nextTimer = 1;
  let ready = options.sceneReady ?? true;
  let metadata;
  let activeTargeting = false;
  let viewportWidth = 1440;
  let popoverVisible = false;
  let clock = 1000000;
  class FixtureDate extends Date { static now() { return clock; } }

  async function operation(name) {
    operations.push(name);
    if (name === options.failAt) throw options.failure ?? new Error(`Rejected ${name}`);
    const gate = gates.get(name);
    if (!gate) return;
    gates.delete(name);
    gate.entered.resolve();
    await gate.result.promise;
  }

  function receive(channel, data, connectionId = "self") {
    for (const callback of channels.get(channel) ?? []) callback({ connectionId, data });
  }

  function hidePage() {
    const callbacks = [...pagehide];
    pagehide.clear();
    for (const callback of callbacks) callback();
  }

  class NativeTargeting {
    constructor(options) { this.options = options; targeting = this; }
    async init() { await operation("targeting.init"); }
    async begin() { activeTargeting = true; await operation("targeting.begin"); }
    async cancel() {
      await operation("targeting.cancel");
      if (activeTargeting) { activeTargeting = false; this.options.onCancel(); }
    }
    async dispose() { await this.cancel(); }
  }

  const OBR = {
    room: { id: "room", getPermissions: async () => { await operation("room.getPermissions"); return options.permissions ?? ["PROP_CREATE"]; } },
    assets: { downloadImages: async (...args) => { pickerCalls.push(args); await operation("assets.downloadImages"); return structuredClone(options.assets ?? [fireSphere]); } },
    player: { getConnectionId: async () => { await operation("player.getConnectionId"); return "self"; }, getRole: async () => options.role ?? "GM" },
    broadcast: {
      onMessage(channel, callback) {
        if (!channels.has(channel)) channels.set(channel, new Set());
        channels.get(channel).add(callback);
        return () => channels.get(channel).delete(callback);
      },
      async sendMessage(channel, data, options) {
        await operation(options.destination === "REMOTE" ? "broadcast.remote" : "broadcast.local");
        outbound.push({ channel, data, destination: options.destination });
        if (options.destination === "LOCAL") receive(channel, data);
      },
    },
    modal: {
      async open(modal) { modals.push(modal); await operation("modal.open"); },
      async close() { await operation("modal.close"); },
    },
    notification: { async show(message, variant) { notifications.push({ message, variant }); } },
    scene: {
      items: {
        getItems: async (ids) => { await operation("items.getItems"); return ids.map((id) => items.get(id)).filter(Boolean); },
        addItems: async (added) => {
          await operation("items.addItems");
          for (const item of added) { itemWrites.push(structuredClone(item)); items.set(item.id, structuredClone(item)); }
        },
      },
      isReady: async () => {
        const snapshot = ready;
        await operation("scene.isReady");
        return snapshot;
      },
      getMetadata: async () => { await operation("scene.getMetadata"); return { ...metadata }; },
      setMetadata: async (value) => {
        await operation("scene.setMetadata");
        metadata = { ...metadata, ...value };
        for (const callback of metadataListeners) callback(metadata);
      },
      onReadyChange(callback) { sceneListeners.add(callback); return () => sceneListeners.delete(callback); },
      onMetadataChange(callback) { metadataListeners.add(callback); return () => metadataListeners.delete(callback); },
    },
    viewport: {
      getWidth: async () => {
        const snapshot = viewportWidth;
        await operation("viewport.getWidth");
        // Match the real host: SDK ready does not imply a scene viewport exists.
        if (!ready) throw { error: { name: "MissingDataError", message: "No scene found" } };
        return snapshot;
      },
    },
    popover: {
      open: async (popover) => { await operation("popover.open"); popovers.push(popover); popoverVisible = true; },
      close: async () => { await operation("popover.close"); popoverVisible = false; },
    },
  };

  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const output = { exports: {} };
    new Function("require", "module", "exports", "window", "localStorage", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "console", "Date", compiled.get(name))(
      (id) => {
        if (id === "@owlbear-rodeo/sdk") return { __esModule: true, default: OBR, buildImage: (image, grid) => {
          const item = { type: "IMAGE", image, grid };
          const builder = new Proxy({}, { get(_, key) {
            if (key === "build") return () => item;
            return (value) => { item[key] = value; return builder; };
          } });
          return builder;
        } };
        if (id === "./native-targeting") return { NativeTargeting };
        if (id === "./protocol" || id === "./constants" || id === "./residue") return load(id.slice(2));
        throw new Error(`Unexpected production dependency: ${id}`);
      }, output, output.exports,
      {
        addEventListener: (event, callback) => { if (event === "pagehide") pagehide.add(callback); },
        removeEventListener: (event, callback) => { if (event === "pagehide") pagehide.delete(callback); },
      },
      {
        getItem: (key) => { if (options.storageFailure) throw new Error("Storage blocked"); return storage.get(key) ?? null; },
        setItem: (key, value) => { if (options.storageFailure) throw new Error("Storage blocked"); storage.set(key, value); },
      },
      (callback, ms) => { const id = nextTimer++; timers.set(id, { callback, ms }); return id; },
      (id) => timers.delete(id),
      (callback, ms) => { const id = nextTimer++; intervals.set(id, { callback, ms }); return id; },
      (id) => intervals.delete(id),
      { error() {}, warn() {} },
      FixtureDate,
    );
    modules.set(name, output.exports);
    return output.exports;
  }

  const protocol = load("protocol");
  metadata = { [protocol.SCENE_KEY]: "scene-a" };
  let startupError;
  try { await load("controller").startController(); }
  catch (error) { if (!options.failAt) throw error; startupError = error; }
  await settle();
  t.after(async () => {
    for (const gate of allGates) gate.result.resolve();
    hidePage();
    await settle();
  });

  const instance = () => new URL(modals.at(-1).url, "https://test.invalid").searchParams.get("instance");
  return {
    protocol, outbound, operations, modals, popovers, notifications, timers, intervals, startupError,
    items, itemWrites, pickerCalls, storage, residueModule: load("residue"),
    get listenerCount() { return [...channels.values()].reduce((n, set) => n + set.size, 0) + sceneListeners.size + metadataListeners.size + pagehide.size; },
    get targeting() { return targeting; },
    get popoverVisible() { return popoverVisible; },
    get status() { return outbound.filter(({ data }) => data.kind === "status").at(-1)?.data.status; },
    get plays() { return outbound.filter(({ data }) => data.kind === "fx-play").map(({ data }) => data); },
    get roomCasts() { return outbound.filter(({ destination }) => destination === "REMOTE"); },
    instance,
    hidePage,
    clearFailure() { delete options.failAt; },
    advanceTime(ms) { clock += ms; },
    resize(width) { viewportWidth = width; },
    tickIntervals(ms) {
      for (const interval of [...intervals.values()]) if (interval.ms === ms) interval.callback();
    },
    count(name) { return operations.filter((value) => value === name).length; },
    confirm() { activeTargeting = false; return targeting.options.onConfirm(structuredClone(castInput)); },
    command(action, sender = "self") { receive(protocol.LOCAL_CHANNEL, { kind: "button-command", action }, sender); },
    local(message, sender = "self") { receive(protocol.LOCAL_CHANNEL, message, sender); },
    ready(instanceId = instance()) { receive(protocol.LOCAL_CHANNEL, { kind: "fx-ready", instance: instanceId, engine: "webgl" }); },
    stage(play, stage, detail, actualQuality) {
      receive(protocol.LOCAL_CHANNEL, { kind: "fx-stage", instance: play.instance, castId: play.cast.castId, stage, detail, actualQuality });
    },
    remote(id, sender = "peer", sceneKey = "room:scene-a") {
      receive(protocol.CHANNEL, { kind: "cast-v2", version: 2, castId: id, sceneKey, seed: 42, ...castInput }, sender);
    },
    changeScene(id, isReady = true) {
      metadata = { [protocol.SCENE_KEY]: id };
      ready = isReady;
      for (const callback of sceneListeners) callback(isReady);
    },
    fireTimeout(ms) {
      for (const [id, timer] of [...timers]) {
        if (timer.ms !== ms) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    deferNext(name) {
      const gate = { entered: deferred(), result: deferred() };
      gates.set(name, gate);
      allGates.push(gate);
      return { entered: gate.entered.promise, release: gate.result.resolve, reject: gate.result.reject };
    },
  };
}

async function startLocalCast(f) {
  const pending = f.confirm();
  await settle();
  f.ready();
  await settle();
  const play = f.plays.at(-1);
  f.stage(play, "started");
  await pending;
  return play;
}

async function chooseResidue(f) {
  f.local({ kind: "residue-command", action: "select" });
  await settle();
  assert.equal(f.status.residueName, "Fire Sphere");
}

test("selected Props media is saved per room and emitted once, only after successful local playback", async (t) => {
  const f = await createFixture(t);
  await chooseResidue(f);
  assert.deepEqual(f.pickerCalls, [[false, undefined, "PROP"]]);
  assert.equal(f.itemWrites.length, 0, "choosing media must not add it to the scene");
  const play = await startLocalCast(f);
  assert.equal(f.itemWrites.length, 0);
  f.stage(play, "impact");
  await settle();
  assert.equal(f.itemWrites.length, 0, "smoke must complete first");
  f.stage(play, "finished");
  f.stage(play, "finished");
  await settle();
  assert.equal(f.itemWrites.length, 1);
  const item = f.itemWrites[0];
  assert.equal(item.id, play.cast.castId);
  assert.equal(item.layer, "PROP");
  assert.equal(item.visible, true);
  assert.equal(item.locked, false);
  assert.deepEqual(item.image, fireSphere.image);
  assert.deepEqual(item.position, castInput.to);
  assert.deepEqual(item.scale, fireSphere.scale);
  assert.equal(item.rotation, fireSphere.rotation);
  assert.deepEqual(item.grid, { dpi: 160, offset: { x: 320, y: 240 } });
  assert.equal(item.metadata[f.residueModule.RESIDUE_KEY].castId, play.cast.castId);
  assert.equal(f.status.phase, "idle");
  assert.equal(f.roomCasts.length, 1, "residue creation has no extra room broadcast");
  const reloaded = await createFixture(t, { storage: f.storage });
  assert.equal(reloaded.status.residueName, "Fire Sphere");
});

test("remote viewers, cancelled casts, errors and missing playback stages never generate Props", async (t) => {
  for (const scenario of ["remote", "cancelled", "error", "no-impact", "no-start", "reset", "timeout"]) {
    await t.test(scenario, async (t) => {
      const f = await createFixture(t);
      await chooseResidue(f);
      let play;
      if (scenario === "remote") {
        f.remote("remote-cast"); await settle(); f.ready(); await settle();
        play = f.plays.at(-1); f.stage(play, "started"); await settle();
      } else if (scenario === "no-start") {
        const pending = f.confirm(); await settle(); f.ready(); await settle();
        play = f.plays.at(-1); f.stage(play, "impact"); f.stage(play, "finished"); await pending;
      } else play = await startLocalCast(f);
      if (scenario !== "no-impact") f.stage(play, "impact");
      if (scenario === "reset") { f.command("reset"); await settle(); }
      if (scenario === "timeout") { f.fireTimeout(6500); await settle(); }
      f.stage(play, ["cancelled", "error"].includes(scenario) ? scenario : "finished", "example failure");
      await settle();
      assert.equal(f.itemWrites.length, 0);
    });
  }
});

test("unconfigured or cleared residue leaves the old fireball behavior and does not delete existing Props", async (t) => {
  const f = await createFixture(t);
  const first = await startLocalCast(f);
  f.stage(first, "impact"); f.stage(first, "finished"); await settle();
  assert.equal(f.itemWrites.length, 0);
  await chooseResidue(f);
  const second = await startLocalCast(f);
  f.stage(second, "impact"); f.stage(second, "finished"); await settle();
  assert.equal(f.items.size, 1);
  f.local({ kind: "residue-command", action: "clear" }); await settle();
  assert.equal(f.status.residueName, undefined);
  assert.equal(f.items.size, 1);
  const third = await startLocalCast(f);
  f.stage(third, "impact"); f.stage(third, "finished"); await settle();
  assert.equal(f.itemWrites.length, 1);
  const reloaded = await createFixture(t, { storage: f.storage });
  assert.equal(reloaded.status.residueName, undefined);
});

test("picker cancellation retains the old choice and unsupported media never replaces it", async (t) => {
  const options = {};
  const f = await createFixture(t, options);
  await chooseResidue(f);
  options.assets = [];
  await chooseResidue(f);
  options.assets = [{ ...fireSphere, image: { ...fireSphere.image, url: "javascript:alert(1)" } }];
  await chooseResidue(f);
  assert.match(f.notifications.at(-1).message, /不受支持/);
  assert.equal(f.status.residueBusy, false);
});

test("picker work is serialized, blocks casting, and stale results after reset are discarded", async (t) => {
  const f = await createFixture(t);
  const picker = f.deferNext("assets.downloadImages");
  f.local({ kind: "residue-command", action: "select" }); await picker.entered;
  assert.equal(f.status.residueBusy, true);
  f.local({ kind: "residue-command", action: "select" });
  f.command("toggle"); await settle();
  assert.equal(f.pickerCalls.length, 1);
  assert.equal(f.count("targeting.begin"), 0);
  f.command("reset"); await settle();
  picker.release(); await settle();
  assert.equal(f.status.residueBusy, false);
  assert.equal(f.status.residueName, undefined);
  assert.equal(f.storage.size, 0);
});

test("other clients and active casts cannot change the local residual template", async (t) => {
  const f = await createFixture(t);
  f.local({ kind: "residue-command", action: "select" }, "peer"); await settle();
  assert.equal(f.pickerCalls.length, 0);
  await chooseResidue(f);
  const play = await startLocalCast(f);
  f.local({ kind: "residue-command", action: "clear" });
  f.local({ kind: "residue-command", action: "select" }); await settle();
  assert.equal(f.pickerCalls.length, 1);
  assert.equal(f.status.residueName, "Fire Sphere");
  f.stage(play, "impact"); f.stage(play, "finished"); await settle();
  assert.equal(f.itemWrites.length, 1);
});

test("residual creation respects Props permissions and reports failures without replaying the cast", async (t) => {
  for (const scenario of ["allowed", "denied", "write-failed"]) {
    await t.test(scenario, async (t) => {
      const options = { role: "PLAYER", permissions: scenario === "denied" ? [] : ["PROP_CREATE"] };
      const f = await createFixture(t, options);
      await chooseResidue(f);
      const play = await startLocalCast(f);
      if (scenario === "write-failed") options.failAt = "items.addItems";
      f.stage(play, "impact"); f.stage(play, "finished"); await settle();
      assert.equal(f.itemWrites.length, scenario === "allowed" ? 1 : 0);
      assert.equal(f.plays.length, 1);
      assert.equal(f.status.phase, "idle");
      if (scenario !== "allowed") assert.match(f.notifications.at(-1).message, /残留创建失败/);
    });
  }
});

test("scene changes and page close invalidate residual reads before the shared scene write", async (t) => {
  for (const boundary of ["scene.isReady", "items.getItems", "scene.getMetadata"]) {
    for (const cancel of ["scene", "pagehide"]) {
      await t.test(`${boundary}: ${cancel}`, async (t) => {
        const f = await createFixture(t);
        await chooseResidue(f);
        const play = await startLocalCast(f);
        const gate = f.deferNext(boundary);
        f.stage(play, "impact"); f.stage(play, "finished"); await gate.entered;
        if (cancel === "scene") f.changeScene("scene-b"); else f.hidePage();
        await settle(); gate.release(); await settle();
        assert.equal(f.itemWrites.length, 0);
      });
    }
  }
});

test("an existing cast item is not recreated or overwritten", async (t) => {
  const f = await createFixture(t);
  await chooseResidue(f);
  const play = await startLocalCast(f);
  f.items.set(play.cast.castId, { id: play.cast.castId, name: "Existing" });
  f.stage(play, "impact"); f.stage(play, "finished"); await settle();
  assert.equal(f.itemWrites.length, 0);
  assert.equal(f.items.get(play.cast.castId).name, "Existing");
});

test("blocked or corrupt browser storage cannot break fireball initialization", async (t) => {
  const f = await createFixture(t, { storageFailure: true });
  await chooseResidue(f);
  assert.match(f.notifications.at(-1).message, /刷新后需要重新选择/);
  const play = await startLocalCast(f);
  f.stage(play, "impact"); f.stage(play, "finished"); await settle();
  assert.equal(f.itemWrites.length, 1);
  const corrupted = await createFixture(t, { storage: new Map([[`${f.residueModule.RESIDUE_KEY}/v1/room`, "{bad json"]]) });
  assert.equal(corrupted.status.phase, "idle");
  assert.equal(corrupted.status.residueName, undefined);
});

test("residue templates reject malformed data and preserve only supported media fields", async (t) => {
  const f = await createFixture(t);
  const valid = { version: 1, name: fireSphere.name, image: fireSphere.image, dpi: fireSphere.grid.dpi, scale: fireSphere.scale, rotation: 30 };
  const read = f.residueModule.readTemplate;
  assert.deepEqual(read({ ...valid, metadata: { surprise: true } }), valid);
  for (const bad of [null, {}, { ...valid, version: 2 }, { ...valid, name: "x".repeat(121) },
    { ...valid, dpi: 0 }, { ...valid, rotation: Infinity }, { ...valid, scale: { x: 0, y: 1 } },
    { ...valid, image: { ...valid.image, url: "blob:https://example.com/id" } },
    { ...valid, image: { ...valid.image, mime: "text/html" } },
    { ...valid, image: { ...valid.image, width: NaN } }]) assert.equal(read(bad), undefined);
});

test("floating UI stays 100 pixels farther left without changing its top position after resize or scene reopen", async (t) => {
  const f = await createFixture(t);
  const checkPosition = (width) => {
    const popover = f.popovers.at(-1);
    assert.deepEqual(popover.anchorPosition, { left: width - 18 - 100, top: 18 });
    assert.deepEqual(popover.transformOrigin, { horizontal: "RIGHT", vertical: "TOP" });
    assert.equal(popover.width, 178);
    assert.equal(popover.height, 188);
  };
  checkPosition(1440);
  f.resize(1024);
  f.tickIntervals(1200);
  await settle();
  checkPosition(1024);
  assert.equal(f.popovers.length, 2);
  f.changeScene("scene-a", false);
  await settle();
  f.changeScene("scene-b", true);
  await settle();
  checkPosition(1024);
  assert.equal(f.popovers.length, 3);
});

test("startup failures include the failed stage and release partially registered runtime state", async (t) => {
  for (const [failAt, stage] of [
    ["player.getConnectionId", "读取玩家连接"],
    ["viewport.getWidth", "创建右上角按钮"],
    ["popover.open", "创建右上角按钮"],
    ["targeting.init", "注册瞄准工具"],
    ["scene.getMetadata", "读取场景"],
  ]) {
    await t.test(failAt, async (t) => {
      const failure = { message: `Host rejected ${failAt}` };
      const f = await createFixture(t, { failAt, failure });
      assert.equal(f.startupError.message, `${stage}：Host rejected ${failAt}`);
      assert.equal(f.startupError.cause, failure);
      assert.equal(f.intervals.size, 0);
      assert.equal(f.timers.size, 0);
      assert.equal(f.listenerCount, 0);
      assert.equal(f.popoverVisible, false);
      const count = f.modals.length;
      f.remote("after-failure");
      await settle();
      assert.equal(f.modals.length, count, "failed startup must not consume later room casts");
    });
  }
});

test("starting without a scene waits without viewport, tool, button or metadata calls, then mounts on ready", async (t) => {
  const f = await createFixture(t, { sceneReady: false });
  assert.equal(f.startupError, undefined);
  assert.equal(f.status.hint, "请先打开场景");
  assert.equal(f.notifications.filter((notice) => notice.variant === "ERROR").length, 0);
  f.tickIntervals(1200);
  await settle();
  for (const name of ["viewport.getWidth", "popover.open", "targeting.init", "scene.getMetadata"]) assert.equal(f.count(name), 0, name);
  assert.ok(f.listenerCount > 0, "scene listener must survive the empty room");
  f.changeScene("scene-a", true);
  await settle();
  assert.equal(f.popoverVisible, true);
  assert.equal(f.status.phase, "idle");
  assert.equal(f.status.hint, "选中棋子 · 点击瞄准");
  assert.equal(f.count("popover.open"), 1);
  f.command("toggle");
  await settle();
  assert.equal(f.status.phase, "aiming");
});

test("closing a scene hides its button and stops viewport access; reopening at the same width restores it", async (t) => {
  const f = await createFixture(t);
  f.changeScene("closed", false);
  await settle();
  assert.equal(f.popoverVisible, false);
  assert.equal(f.status.hint, "请先打开场景");
  const reads = f.count("viewport.getWidth");
  f.tickIntervals(1200);
  await settle();
  assert.equal(f.count("viewport.getWidth"), reads);
  f.remote("ignored-closed-scene");
  await settle();
  assert.equal(f.modals.length, 0);
  f.changeScene("scene-b", true);
  await settle();
  assert.equal(f.popoverVisible, true);
  assert.equal(f.count("popover.open"), 2);
  assert.equal(f.notifications.filter((notice) => notice.variant === "ERROR").length, 0);
});

test("No scene found racing after readiness does not kill the controller", async (t) => {
  for (const failAt of ["viewport.getWidth", "popover.open", "targeting.init", "scene.getMetadata"]) {
    await t.test(failAt, async (t) => {
      const f = await createFixture(t, { failAt, failure: { error: { name: "MissingDataError", message: "No scene found" } } });
      assert.equal(f.startupError, undefined);
      assert.equal(f.popoverVisible, false);
      assert.equal(f.status.hint, "请先打开场景");
      assert.ok(f.listenerCount > 0);
      assert.equal(f.notifications.filter((notice) => notice.variant === "ERROR").length, 0);
      f.clearFailure();
      f.changeScene("scene-ready", true);
      await settle();
      assert.equal(f.popoverVisible, true);
      assert.equal(f.status.hint, "选中棋子 · 点击瞄准");
    });
  }
});

test("scene close invalidates a pending viewport result without opening a stale button", async (t) => {
  const f = await createFixture(t);
  const pending = f.deferNext("viewport.getWidth");
  f.resize(1600);
  f.tickIntervals(1200);
  await pending.entered;
  f.changeScene("closed", false);
  pending.release();
  await settle();
  assert.equal(f.popoverVisible, false);
  assert.equal(f.count("popover.open"), 1);
  assert.equal(f.status.hint, "请先打开场景");
});

test("old in-flight button opening is cleaned before the next scene opens its button", async (t) => {
  const f = await createFixture(t);
  const pending = f.deferNext("popover.open");
  f.resize(1600);
  f.tickIntervals(1200);
  await pending.entered;
  f.changeScene("scene-b", true);
  await settle();
  assert.equal(f.count("popover.open"), 2, "new-scene UI must wait for the old UI operation");
  pending.release();
  await settle();
  assert.equal(f.popoverVisible, true);
  assert.equal(f.count("popover.open"), 3);
  assert.equal(f.status.hint, "选中棋子 · 点击瞄准");
  assert.ok(f.operations.lastIndexOf("popover.close") < f.operations.lastIndexOf("popover.open"));
});

test("first cast waits for ready and playback ACK before broadcasting to the room", async (t) => {
  const f = await createFixture(t);
  const pending = f.confirm();
  await settle();
  assert.equal(f.modals.length, 1);
  assert.equal(f.plays.length, 0);
  assert.equal(f.roomCasts.length, 0);
  f.ready("wrong-instance");
  await settle();
  assert.equal(f.plays.length, 0);
  f.ready();
  await settle();
  assert.equal(f.plays.length, 1);
  assert.equal(f.roomCasts.length, 0);
  f.stage(f.plays[0], "started");
  await pending;
  await settle();
  assert.equal(f.roomCasts.length, 1);
  assert.equal(f.status.phase, "flying");
  f.stage(f.plays[0], "impact");
  await settle();
  assert.equal(f.status.phase, "smoke");
  f.stage(f.plays[0], "finished");
  await settle();
  assert.equal(f.status.phase, "idle");
  assert.equal(f.count("modal.close"), 1);
});

test("early ready cannot bypass completion of modal.open", async (t) => {
  const f = await createFixture(t);
  const opening = f.deferNext("modal.open");
  const pending = f.confirm();
  await opening.entered;
  f.ready();
  await settle();
  assert.equal(f.plays.length, 0);
  opening.release();
  await settle();
  assert.equal(f.plays.length, 1);
  f.stage(f.plays[0], "started");
  await pending;
});

test("failed initialization and ready timeout never broadcast an unplayed cast", async (t) => {
  for (const failure of ["fx-failed", "timeout"]) {
    await t.test(failure, async (t) => {
      const f = await createFixture(t);
      const pending = f.confirm();
      await settle();
      if (failure === "timeout") f.fireTimeout(10000);
      else f.local({ kind: "fx-failed", instance: f.instance(), detail: "Renderer unavailable" });
      await pending;
      await settle();
      assert.equal(f.roomCasts.length, 0);
      assert.equal(f.status.phase, "error");
      assert.equal(f.count("modal.close"), 1);
    });
  }
});

test("scene reset invalidates the first handshake and ignores late old-frame messages", async (t) => {
  const f = await createFixture(t);
  const pending = f.confirm();
  await settle();
  const oldInstance = f.instance();
  f.changeScene("scene-b");
  await pending;
  await settle();
  f.ready(oldInstance);
  await settle();
  assert.equal(f.plays.length, 0);
  assert.equal(f.roomCasts.length, 0);
  assert.equal(f.status.phase, "idle");
  assert.equal(f.count("modal.close"), 1);
  f.remote("old-scene-event", "peer", "room:scene-a");
  await settle();
  assert.equal(f.modals.length, 1);
  f.remote("new-scene-event", "peer", "room:scene-b");
  await settle();
  assert.equal(f.modals.length, 2);
});

test("a new overlay cannot open until an in-flight old close completes", async (t) => {
  const f = await createFixture(t);
  const pending = f.confirm();
  await settle();
  f.ready();
  await settle();
  f.stage(f.plays[0], "started");
  await pending;
  const closing = f.deferNext("modal.close");
  f.stage(f.plays[0], "finished");
  await closing.entered;
  f.remote("next-overlay");
  await settle();
  assert.equal(f.modals.length, 1);
  closing.release();
  await settle();
  assert.equal(f.modals.length, 2);
  assert.ok(f.operations.lastIndexOf("modal.close") < f.operations.lastIndexOf("modal.open"));
});

test("remote casts are deduplicated, limited to two slots, and never rebroadcast", async (t) => {
  const f = await createFixture(t);
  f.remote("one");
  f.remote("one");
  f.remote("two");
  f.remote("three");
  await settle();
  assert.equal(f.modals.length, 1);
  f.ready();
  await settle();
  assert.equal(f.plays.length, 2);
  assert.deepEqual(f.plays.map(({ slot }) => slot).sort(), ["primary", "secondary"]);
  for (const play of f.plays) f.stage(play, "started");
  await settle();
  assert.equal(f.roomCasts.length, 0);
  assert.equal(f.status.phase, "idle", "remote jobs must not lock the local button");
  assert.equal(f.notifications.filter(({ message }) => message.includes("省略")).length, 1);
});

test("local cast rejected by occupied slots is not broadcast", async (t) => {
  const f = await createFixture(t);
  f.remote("one");
  f.remote("two");
  await settle();
  await f.confirm();
  await settle();
  assert.equal(f.roomCasts.length, 0);
  assert.equal(f.status.phase, "error");
});

test("commands from another connection cannot trigger the local targeting tool", async (t) => {
  const f = await createFixture(t);
  f.command("toggle", "peer");
  await settle();
  assert.equal(f.count("targeting.begin"), 0);
  f.command("toggle");
  await settle();
  assert.equal(f.count("targeting.begin"), 1);
  assert.equal(f.status.phase, "aiming");
});

test("cancelling during targeting preparation must not leave a phantom aiming status", async (t) => {
  const f = await createFixture(t);
  const beginning = f.deferNext("targeting.begin");
  f.command("toggle");
  await beginning.entered;
  await f.targeting.cancel();
  beginning.release();
  await settle();
  assert.equal(f.status.phase, "idle");
});

test("playback timeout restores the button and releases the overlay", async (t) => {
  const f = await createFixture(t);
  const pending = f.confirm();
  await settle();
  f.ready();
  await settle();
  f.stage(f.plays[0], "started");
  await pending;
  f.fireTimeout(6500);
  await settle();
  assert.equal(f.status.phase, "error");
  assert.equal(f.count("modal.close"), 1);
});

test("a late failure from an older scene load cannot overwrite the new scene status", async (t) => {
  const f = await createFixture(t);
  const oldMetadata = f.deferNext("scene.getMetadata");
  f.command("reset");
  await oldMetadata.entered;
  f.changeScene("scene-b");
  await settle();
  assert.equal(f.status.phase, "idle");
  oldMetadata.reject(new Error("Old scene metadata is no longer available"));
  await settle();
  assert.equal(f.status.phase, "idle");
});

test("targeting error remains visible after its preview cleanup calls onCancel", async (t) => {
  const f = await createFixture(t);
  f.command("toggle");
  await settle();
  assert.equal(f.status.phase, "aiming");
  f.targeting.options.onError(new Error("Preview update failed"));
  await f.targeting.cancel();
  await settle();
  assert.equal(f.status.phase, "error");
});

test("targeting error during preparation invalidates a late successful begin", async (t) => {
  const f = await createFixture(t);
  const beginning = f.deferNext("targeting.begin");
  f.command("toggle");
  await beginning.entered;
  f.targeting.options.onError(new Error("Preparation interrupted"));
  beginning.release();
  await settle();
  assert.equal(f.status.phase, "error");
});

test("a late isReady response from an older scene cannot disable the current scene", async (t) => {
  const f = await createFixture(t);
  const oldReady = f.deferNext("scene.isReady");
  f.changeScene("scene-off", false);
  await oldReady.entered;
  f.changeScene("scene-b", true);
  await settle();
  assert.equal(f.status.phase, "idle");
  oldReady.release();
  await settle();
  f.remote("current-scene-cast", "peer", "room:scene-b");
  await settle();
  assert.equal(f.modals.length, 1);
});

test("pagehide prevents a late anchor operation from recreating the floating button", async (t) => {
  for (const boundary of ["viewport.getWidth", "popover.close", "popover.open"]) {
    await t.test(`shutdown while awaiting ${boundary}`, async (t) => {
      const f = await createFixture(t);
      assert.equal(f.popoverVisible, true);
      const pending = f.deferNext(boundary);
      f.resize(1600);
      f.tickIntervals(1200);
      await pending.entered;
      f.hidePage();
      await settle();
      assert.equal(f.popoverVisible, false);
      pending.release();
      await settle();
      assert.equal(f.popoverVisible, false, "a late open must be followed by another close");
      assert.equal(f.count("popover.open"), boundary === "popover.open" ? 2 : 1);
      assert.equal(f.intervals.size, 0);
    });
  }
});

async function completeLocalCast(f, actualQuality = "standard") {
  const pending = f.confirm();
  await settle();
  f.ready();
  await settle();
  const play = f.plays.at(-1);
  f.stage(play, "started");
  await pending;
  f.stage(play, "finished", undefined, actualQuality);
  await settle();
  return play;
}

test("automatic low-quality memory applies to the next overlay and expires after 60 seconds", async (t) => {
  for (const [elapsed, expected] of [[59999, "low"], [60000, "auto"]]) {
    await t.test(`${elapsed} ms after the low-quality terminal`, async (t) => {
      const f = await createFixture(t);
      const first = await completeLocalCast(f, "low");
      assert.equal(first.quality, "auto");
      assert.equal(f.status.quality, "auto");
      f.advanceTime(elapsed);
      const next = await completeLocalCast(f, expected === "low" ? "low" : "standard");
      assert.equal(next.quality, expected);
      const url = new URL(f.modals.at(-1).url, "https://test.invalid");
      assert.equal(url.searchParams.get("quality"), expected);
      assert.equal(f.status.quality, "auto", "memory must not change the selector or saved preference");
      for (const { data } of f.roomCasts) {
        assert.equal("quality" in data, false);
        assert.equal("actualQuality" in data, false, "performance feedback is local to this client");
      }
    });
  }
});

test("manual standard or low quality overrides the automatic memory", async (t) => {
  const f = await createFixture(t);
  await completeLocalCast(f, "low");
  for (const quality of ["standard", "low"]) {
    f.local({ kind: "quality", quality });
    await settle();
    const play = await completeLocalCast(f, quality);
    assert.equal(play.quality, quality);
    assert.equal(new URL(f.modals.at(-1).url, "https://test.invalid").searchParams.get("quality"), quality);
    assert.equal(f.status.quality, quality);
  }
  f.local({ kind: "quality", quality: "auto" });
  await settle();
  const remembered = await completeLocalCast(f, "low");
  assert.equal(remembered.quality, "low", "returning to Auto honors the still-valid local memory");
});

test("manually selected low quality does not create an automatic downgrade memory", async (t) => {
  const f = await createFixture(t);
  f.local({ kind: "quality", quality: "low" });
  await settle();
  await completeLocalCast(f, "low");
  f.local({ kind: "quality", quality: "auto" });
  await settle();
  const next = await completeLocalCast(f);
  assert.equal(next.quality, "auto");
  assert.equal(new URL(f.modals.at(-1).url, "https://test.invalid").searchParams.get("quality"), "auto");
});

test("nonterminal quality feedback does not downgrade a later cast", async (t) => {
  const f = await createFixture(t);
  const pending = f.confirm();
  await settle();
  f.ready();
  await settle();
  const play = f.plays.at(-1);
  f.stage(play, "started", undefined, "low");
  await pending;
  f.stage(play, "impact", undefined, "low");
  f.stage(play, "finished", undefined, "standard");
  await settle();
  const next = await completeLocalCast(f);
  assert.equal(next.quality, "auto");
});

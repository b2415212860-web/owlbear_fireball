import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";

const compiled = new Map(["button", "protocol"].map((name) => [name, ts.transpileModule(
  readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText]));

async function fixture(t) {
  const elements = new Map();
  const outbound = [];
  const modules = new Map();
  const intervals = new Map();
  let ready;
  let receiver;
  let close;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      disabled: id.startsWith("residue-") && id !== "residue-name", value: "auto", textContent: "", events: {},
      addEventListener(event, callback) { this.events[event] = callback; },
      setAttribute(name, value) { this[name] = value; },
      set innerHTML(_) { throw new Error("User-chosen asset names must not become HTML"); },
    });
    return elements.get(id);
  }
  const OBR = {
    onReady(callback) { ready = callback; },
    player: { getConnectionId: async () => "self" },
    broadcast: {
      onMessage(channel, callback) { receiver = callback; return () => { receiver = undefined; }; },
      async sendMessage(channel, data, options) { outbound.push({ channel, data, options }); },
    },
  };
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const output = { exports: {} };
    new Function("require", "module", "exports", "document", "window", "setInterval", "clearInterval", compiled.get(name))(
      (id) => {
        if (id === "@owlbear-rodeo/sdk") return { __esModule: true, default: OBR };
        if (id === "./protocol") return load("protocol");
        if (id.endsWith(".css")) return {};
        throw new Error(id);
      }, output, output.exports,
      { querySelector: (selector) => element(selector.slice(1)) },
      { addEventListener: (_, callback) => { close = callback; } },
      (callback) => { const id = intervals.size + 1; intervals.set(id, callback); return id; },
      (id) => intervals.delete(id),
    );
    modules.set(name, output.exports);
    return output.exports;
  }
  const protocol = load("protocol");
  load("button"); ready(); await setImmediate();
  t.after(() => close?.());
  return {
    element, outbound,
    status(fields = {}, sender = "self") {
      receiver({ connectionId: sender, data: { kind: "status", status: {
        phase: "idle", hint: "选中棋子", quality: "auto", release: protocol.RELEASE, residueCanConfigure: true, ...fields,
      } } });
    },
    async click(id) { const target = element(id); if (!target.disabled) target.events.click(); await setImmediate(); },
  };
}

test("residue controls send only local select/clear commands and safely display the chosen asset", async (t) => {
  const f = await fixture(t);
  assert.equal(f.element("residue-select").disabled, true);
  f.status();
  assert.equal(f.element("residue-select").disabled, false);
  assert.equal(f.element("residue-clear").disabled, true);
  await f.click("residue-select");
  assert.deepEqual(f.outbound.at(-1).data, { kind: "residue-command", action: "select" });
  assert.equal(f.outbound.at(-1).options.destination, "LOCAL");
  f.status({ residueName: "<img src=x onerror=alert(1)>" });
  assert.equal(f.element("residue-name").textContent, "房间残留：<img src=x onerror=alert(1)>");
  assert.equal(f.element("residue-clear").disabled, false);
  await f.click("residue-clear");
  assert.deepEqual(f.outbound.at(-1).data, { kind: "residue-command", action: "clear" });
  f.status();
  assert.equal(f.element("residue-name").textContent, "未设置 · 无残留");
});

test("picker and playback states disable residue changes; picker keeps reset available", async (t) => {
  const f = await fixture(t);
  for (const phase of ["loading", "aiming", "preparing", "flying", "smoke"]) {
    f.status({ phase, residueName: "Fire Sphere" });
    assert.equal(f.element("residue-select").disabled, true);
    assert.equal(f.element("residue-clear").disabled, true);
  }
  f.status({ residueBusy: true, residueName: "Fire Sphere" });
  assert.equal(f.element("fireball-button").disabled, true);
  assert.equal(f.element("residue-select").textContent, "正在发布…");
  assert.equal(f.element("reset").disabled, false);
  f.status({ residueBusy: false, residueName: "Fire Sphere" });
  assert.equal(f.element("fireball-button").disabled, false);
  assert.equal(f.element("residue-select").disabled, false);
  f.status({ residueName: "Someone else's template" }, "peer");
  assert.equal(f.element("residue-name").textContent, "房间残留：Fire Sphere");
});

test("players can use the shared template but cannot publish or clear it", async (t) => {
  const f = await fixture(t);
  f.status({ residueName: "Fire Sphere", residueCanConfigure: false });
  assert.equal(f.element("residue-select").textContent, "由 GM 设置");
  assert.equal(f.element("residue-select").disabled, true);
  assert.equal(f.element("residue-clear").disabled, true);
  assert.equal(f.element("residue-name").textContent, "房间残留：Fire Sphere");
  const before = f.outbound.length;
  await f.click("residue-select");
  await f.click("residue-clear");
  assert.equal(f.outbound.length, before);
});

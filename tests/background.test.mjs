import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";

const compiled = new Map();
for (const name of ["background", "protocol"]) {
  compiled.set(name, ts.transpileModule(
    readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8")
      .replaceAll("import.meta.env.BASE_URL", JSON.stringify("/fireball/")),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText);
}

function createFixture(options = {}) {
  const modules = new Map();
  const notices = [];
  const errors = [];
  const warnings = [];
  let ready;
  let starts = 0;
  const OBR = {
    isAvailable: true,
    onReady(callback) { ready = callback; },
    notification: { async show(message, variant) {
      notices.push({ message, variant });
      if (options.notificationError) throw options.notificationError;
    } },
  };
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const output = { exports: {} };
    new Function("require", "module", "exports", "console", compiled.get(name))(
      (id) => {
        if (id === "@owlbear-rodeo/sdk") return { __esModule: true, default: OBR };
        if (id === "./protocol") return load("protocol");
        if (id === "./controller") {
          if (options.importError) throw options.importError;
          return { async startController() { starts++; if (options.startError) throw options.startError; } };
        }
        throw new Error(`Unexpected dependency ${id}`);
      }, output, output.exports,
      { error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) },
    );
    modules.set(name, output.exports);
    return output.exports;
  }
  load("background");
  return { notices, errors, warnings, release: load("protocol").RELEASE, get starts() { return starts; }, ready: () => ready() };
}

test("background waits for the SDK and ignores duplicate ready callbacks", async () => {
  const f = createFixture();
  assert.equal(f.starts, 0);
  f.ready(); f.ready();
  await setImmediate();
  assert.equal(f.starts, 1);
  assert.equal(f.notices.length, 0);
});

test("failed dynamic import exposes its stage and original reason", async () => {
  const f = createFixture({ importError: new Error("Failed to fetch dynamically imported module") });
  f.ready(); await setImmediate();
  assert.ok(f.notices[0].message.includes(f.release));
  assert.match(f.notices[0].message, /加载控制器.*Failed to fetch dynamically imported module/);
  assert.equal(f.notices[0].variant, "ERROR");
  assert.equal(f.starts, 0);
});

test("controller startup details reach the user instead of a generic re-enable message", async () => {
  const f = createFixture({ startError: { message: "注册瞄准工具：Tool already exists" } });
  f.ready(); await setImmediate();
  assert.match(f.notices[0].message, /启动控制器.*注册瞄准工具：Tool already exists/);
  assert.equal(f.errors.length, 1);
});

test("a notification failure is caught and long details are bounded", async () => {
  const f = createFixture({ startError: new Error("X".repeat(1000)), notificationError: new Error("SDK disconnected") });
  f.ready(); await setImmediate();
  assert.ok(f.notices[0].message.length < 320);
  assert.equal(f.warnings.length, 1);
});

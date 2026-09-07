import assert from "node:assert/strict";
import { test } from "node:test";
import { CastLedger, errorText, isCast, isLocalMessage, isNoSceneError, type Cast } from "./protocol.ts";

const cast = (castId = "cast-1"): Cast => ({ kind: "cast-v2", version: 2, castId, sceneKey: "room:scene", from: { x: -25, y: 0 }, to: { x: 100, y: 200 }, radius: 600, projectileSize: 16, seed: 27 });

test("SDK error details survive both Error instances and structured message payloads", () => {
  assert.equal(errorText(new Error("SDK timeout")), "SDK timeout");
  assert.equal(errorText({ message: "Tool rejected" }), "Tool rejected");
  assert.equal(errorText({ error: "Invalid popover" }), "Invalid popover");
  assert.equal(errorText("Connection unavailable"), "Connection unavailable");
});

test("nested host errors expose No scene found and wrapped causes remain recognizable", () => {
  const original = { error: { name: "MissingDataError", message: "No scene found" } };
  assert.equal(errorText(original), "No scene found");
  assert.ok(isNoSceneError(original));
  const wrapped = new Error("创建右上角按钮：No scene found", { cause: original });
  assert.ok(isNoSceneError(wrapped));
  assert.equal(errorText(wrapped), "创建右上角按钮：No scene found");
  assert.equal(isNoSceneError({ error: { name: "MissingDataError", message: "No item found" } }), false);
  const cycle: { error?: unknown } = {};
  cycle.error = cycle;
  assert.equal(isNoSceneError(cycle), false);
  assert.equal(errorText(cycle), "[object Object]");
});

test("cast validation rejects malformed, old-version, oversized and nonfinite events", () => {
  assert.ok(isCast(cast()));
  for (const value of [null, {}, { ...cast(), version: 1 }, { ...cast(), radius: Infinity }, { ...cast(), radius: 0 },
    { ...cast(), radius: 12001 }, { ...cast(), seed: -1 }, { ...cast(), seed: 2.3 }, { ...cast(), seed: 2 ** 32 },
    { ...cast(), from: { x: NaN, y: 0 } }, { ...cast(), to: { x: 1e9, y: 0 } }, { ...cast(), sceneKey: "" }]) assert.equal(isCast(value), false);
});

test("cast ledger isolates scenes, deduplicates, and allows a bounded burst per sender", () => {
  let now = 1000;
  const ledger = new CastLedger(() => now);
  assert.equal(ledger.accept(cast(), "different-scene", "one"), false);
  assert.equal(ledger.accept(cast(), "room:scene", "one"), true);
  assert.equal(ledger.accept(cast(), "room:scene", "two"), false);
  for (let i = 2; i <= 5; i++) assert.equal(ledger.accept(cast(`cast-${i}`), "room:scene", "one"), true);
  assert.equal(ledger.accept(cast("cast-6"), "room:scene", "one"), false);
  assert.equal(ledger.accept(cast("cast-6"), "room:scene", "two"), true);
  now += 5000;
  assert.equal(ledger.accept(cast("cast-7"), "room:scene", "one"), true);
  assert.equal(ledger.accept(cast(), "room:scene", "one"), false);
  now += 30001;
  assert.equal(ledger.accept(cast(), "room:scene", "one"), true);
  ledger.clear();
  assert.equal(ledger.accept(cast(), "room:scene", "one"), true);
});

test("local messages require current protocol fields", () => {
  assert.ok(isLocalMessage({ kind: "residue-command", action: "select" }));
  assert.ok(isLocalMessage({ kind: "residue-command", action: "clear" }));
  assert.equal(isLocalMessage({ kind: "residue-command", action: "delete-all" }), false);
  assert.equal(isLocalMessage({ kind: "status", status: { phase: "idle", hint: "", quality: "auto", release: "1", residueBusy: "yes" } }), false);
  assert.equal(isLocalMessage({ kind: "status", status: { phase: "idle", hint: "", quality: "auto", release: "1", residueName: "x".repeat(121) } }), false);
  assert.ok(isLocalMessage({ kind: "fx-play", instance: "nonce", slot: "primary", quality: "auto", cast: cast() }));
  assert.ok(isLocalMessage({ kind: "fx-stage", instance: "nonce", castId: "cast-1", stage: "finished", fps: 58 }));
  assert.ok(isLocalMessage({ kind: "fx-stage", instance: "nonce", castId: "cast-1", stage: "finished", actualQuality: "low" }));
  assert.ok(isLocalMessage({ kind: "fx-stage", instance: "nonce", castId: "cast-1", stage: "error", actualQuality: "standard" }));
  assert.equal(isLocalMessage({ kind: "fx-play", instance: "nonce", slot: "third", quality: "auto", cast: cast() }), false);
  assert.equal(isLocalMessage({ kind: "quality", quality: "ultra" }), false);
  assert.equal(isLocalMessage({ kind: "fx-stage", instance: "nonce", castId: "cast-1", stage: "started", fps: Infinity }), false);
  for (const actualQuality of ["auto", "ultra", null, 1]) {
    assert.equal(isLocalMessage({ kind: "fx-stage", instance: "nonce", castId: "cast-1", stage: "finished", actualQuality }), false);
  }
  assert.equal(isLocalMessage({ kind: "status", status: { phase: "unknown", hint: "", quality: "auto", release: "1" } }), false);
});

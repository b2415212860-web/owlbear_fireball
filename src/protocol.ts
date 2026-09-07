export const RELEASE = "1.3.0";
export const CHANNEL = "com.codex.owlbear-fireball/v2/cast";
export const LOCAL_CHANNEL = "com.codex.owlbear-fireball/v2/control";
export const SCENE_KEY = "com.codex.owlbear-fireball/scene-id";
export const FX_MODAL = "com.codex.owlbear-fireball/v2/overlay";

export type Quality = "auto" | "standard" | "low";
export type Phase = "loading" | "idle" | "aiming" | "preparing" | "flying" | "smoke" | "error";
export interface Point { x: number; y: number }
export interface CastInput { from: Point; to: Point; radius: number; projectileSize: number }
export interface Cast extends CastInput {
  kind: "cast-v2";
  version: 2;
  castId: string;
  sceneKey: string;
  seed: number;
}
export interface Status { phase: Phase; hint: string; quality: Quality; release: string; residueName?: string; residueBusy?: boolean }
export type LocalMessage =
  | { kind: "button-ready" }
  | { kind: "button-command"; action: "toggle" | "reset" }
  | { kind: "residue-command"; action: "select" | "clear" }
  | { kind: "quality"; quality: Quality }
  | { kind: "status"; status: Status }
  | { kind: "fx-ready"; instance: string; engine: "webgl" | "canvas" }
  | { kind: "fx-play"; instance: string; cast: Cast; slot: "primary" | "secondary"; quality: Quality }
  | { kind: "fx-stage"; instance: string; castId: string; stage: "started" | "impact" | "finished" | "cancelled" | "error"; detail?: string; fps?: number; actualQuality?: "standard" | "low" }
  | { kind: "fx-failed"; instance: string; detail: string }
  | { kind: "fx-clear"; instance: string };

const phases = ["loading", "idle", "aiming", "preparing", "flying", "smoke", "error"];
const stages = ["started", "impact", "finished", "cancelled", "error"];
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object"; }
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 180; }
function point(value: unknown): value is Point {
  return record(value) && typeof value.x === "number" && Number.isFinite(value.x) && Math.abs(value.x) <= 1e8
    && typeof value.y === "number" && Number.isFinite(value.y) && Math.abs(value.y) <= 1e8;
}
export function isQuality(value: unknown): value is Quality { return value === "auto" || value === "standard" || value === "low"; }
export function isCast(value: unknown): value is Cast {
  return record(value) && value.kind === "cast-v2" && value.version === 2 && id(value.castId) && id(value.sceneKey)
    && point(value.from) && point(value.to)
    && typeof value.radius === "number" && Number.isFinite(value.radius) && value.radius > 0 && value.radius <= 12000
    && typeof value.projectileSize === "number" && Number.isFinite(value.projectileSize) && value.projectileSize > 0 && value.projectileSize <= 3000
    && typeof value.seed === "number" && Number.isInteger(value.seed) && value.seed >= 0 && value.seed <= 0xffffffff;
}
export function isLocalMessage(value: unknown): value is LocalMessage {
  if (!record(value)) return false;
  switch (value.kind) {
    case "button-ready": return true;
    case "button-command": return value.action === "toggle" || value.action === "reset";
    case "residue-command": return value.action === "select" || value.action === "clear";
    case "quality": return isQuality(value.quality);
    case "status": return record(value.status) && phases.includes(String(value.status.phase))
      && typeof value.status.hint === "string" && value.status.hint.length <= 500 && isQuality(value.status.quality) && id(value.status.release)
      && (value.status.residueName === undefined || (typeof value.status.residueName === "string" && value.status.residueName.length <= 120))
      && (value.status.residueBusy === undefined || typeof value.status.residueBusy === "boolean");
    case "fx-ready": return id(value.instance) && (value.engine === "webgl" || value.engine === "canvas");
    case "fx-play": return id(value.instance) && isCast(value.cast) && isQuality(value.quality) && (value.slot === "primary" || value.slot === "secondary");
    case "fx-stage": return id(value.instance) && id(value.castId) && stages.includes(String(value.stage))
      && (value.detail === undefined || typeof value.detail === "string")
      && (value.fps === undefined || (typeof value.fps === "number" && Number.isFinite(value.fps)))
      && (value.actualQuality === undefined || value.actualQuality === "standard" || value.actualQuality === "low");
    case "fx-failed": return id(value.instance) && typeof value.detail === "string";
    case "fx-clear": return id(value.instance);
    default: return false;
  }
}

/** Ephemeral messages are not persisted or replayed when a player reconnects. */
export class CastLedger {
  private readonly seen = new Map<string, number>();
  private readonly rates = new Map<string, { at: number; count: number }>();
  private readonly clock: () => number;
  constructor(clock: () => number = Date.now) { this.clock = clock; }
  accept(value: unknown, sceneKey: string, sender: string): value is Cast {
    const now = this.clock();
    for (const [key, at] of this.seen) if (now - at > 30000) this.seen.delete(key);
    for (const [key, rate] of this.rates) if (now - rate.at >= 5000) this.rates.delete(key);
    if (!sceneKey || !id(sender) || !isCast(value) || value.sceneKey !== sceneKey || this.seen.has(value.castId)) return false;
    const rate = this.rates.get(sender) ?? { at: now, count: 0 };
    if (rate.count >= 5) return false;
    rate.count++;
    this.rates.set(sender, rate);
    this.seen.set(value.castId, now);
    if (this.seen.size > 256) this.seen.delete(this.seen.keys().next().value!);
    if (this.rates.size > 128) this.rates.delete(this.rates.keys().next().value!);
    return true;
  }
  clear(): void { this.seen.clear(); this.rates.clear(); }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Cancellation may arrive before the consumer has started awaiting this promise.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
export function errorText(error: unknown): string {
  // The host can reject with { error: { name, message } }, including inside a cause.
  for (const value of errorChain(error)) {
    if (typeof value === "string") return value;
    if (record(value) && typeof value.message === "string" && value.message) return value.message;
  }
  return String(error);
}

export function isNoSceneError(error: unknown): boolean {
  return errorChain(error).some((value) => {
    const message = typeof value === "string" ? value : record(value) ? value.message : undefined;
    return typeof message === "string" && /^No scene found[.!]?$/i.test(message.trim());
  });
}

function errorChain(error: unknown): unknown[] {
  const values: unknown[] = [];
  let current = error;
  // Bound traversal and guard cycles in arbitrary structured SDK errors.
  while (values.length < 8 && !values.includes(current)) {
    values.push(current);
    if (!record(current)) break;
    current = current.error ?? current.cause;
    if (current === undefined) break;
  }
  return values;
}

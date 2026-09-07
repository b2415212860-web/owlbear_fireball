import OBR from "@owlbear-rodeo/sdk";
import { ThreeFireballPrototype, CanvasFireballFallback, type FxRenderer } from "./performance-fx";
import { LOCAL_CHANNEL, errorText, isLocalMessage, isQuality, type Cast, type LocalMessage, type Point, type Quality } from "./protocol";

const params = new URLSearchParams(location.search);
const instance = params.get("instance") ?? "";
const qualityParam = params.get("quality");
const initialQuality: Quality = isQuality(qualityParam) ? qualityParam : "auto";
const root = document.querySelector<HTMLElement>("#fx-root")!;

interface Playback { cast: Cast; renderer: FxRenderer; cancelled: boolean; started: boolean; ended: boolean }
interface Projection { origin: Point; scale: number }

if (OBR.isAvailable && instance) OBR.onReady(() => { void run().catch(console.error); });

async function run(): Promise<void> {
  const connection = await OBR.player.getConnectionId();
  const active = new Map<string, Playback>();
  const seen = new Set<string>();
  let primary: FxRenderer | undefined;
  let secondary: FxRenderer | undefined;
  let closed = false;
  let projecting = false;
  let projectionTimer: ReturnType<typeof setInterval> | undefined;
  const send = (message: LocalMessage) => OBR.broadcast.sendMessage(LOCAL_CHANNEL, message, { destination: "LOCAL" });
  const stage = (castId: string, value: "started" | "impact" | "finished" | "cancelled" | "error", detail?: string, fps?: number, actualQuality?: "standard" | "low") =>
    send({ kind: "fx-stage", instance, castId, stage: value, detail, fps, actualQuality });
  function end(item: Playback, value: "finished" | "cancelled" | "error", detail?: string): Promise<void> {
    if (item.ended) return Promise.resolve();
    item.ended = true;
    return stage(item.cast.castId, value, detail, item.renderer.lastAverageFps, item.renderer.currentQuality);
  }

  async function getProjection(): Promise<Projection> {
    const [origin, scale] = await Promise.all([OBR.viewport.transformPoint({ x: 0, y: 0 }), OBR.viewport.getScale()]);
    if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) throw new Error("地图视口坐标无效");
    return { origin, scale };
  }
  function screen(point: Point, projection: Projection): Point {
    return { x: projection.origin.x + point.x * projection.scale, y: projection.origin.y + point.y * projection.scale };
  }
  async function updateProjection(): Promise<void> {
    if (projecting || closed || !active.size) return;
    projecting = true;
    try {
      const projection = await getProjection();
      if (closed) return;
      for (const item of active.values()) item.renderer.setProjection(screen(item.cast.from, projection), screen(item.cast.to, projection), item.cast.radius * projection.scale);
    } catch (error) {
      for (const item of active.values()) {
        item.cancelled = true;
        void end(item, "error", `地图坐标读取失败：${errorText(error)}`).catch(console.warn);
        item.renderer.cancel();
      }
    } finally { projecting = false; }
  }

  async function play(message: Extract<LocalMessage, { kind: "fx-play" }>): Promise<void> {
    if (closed || seen.has(message.cast.castId)) return;
    seen.add(message.cast.castId);
    if (seen.size > 256) seen.delete(seen.values().next().value!);
    let renderer = primary;
    let playback: Playback | undefined;
    try {
      if (message.slot === "secondary") renderer = secondary ??= new CanvasFireballFallback(root, "low");
      if (!renderer) throw new Error("特效渲染器尚未就绪");
      if ([...active.values()].some((item) => item.renderer === renderer)) throw new Error("特效通道忙碌");
      playback = { cast: message.cast, renderer, cancelled: false, started: false, ended: false };
      active.set(message.cast.castId, playback);
      renderer.setQuality(message.slot === "secondary" ? "low" : message.quality);
      await renderer.ready();
      const projection = await getProjection();
      if (closed || playback.cancelled) { await end(playback, "cancelled"); return; }
      const item = playback;
      const result = renderer.play(screen(item.cast.from, projection), screen(item.cast.to, projection), () => {
        if (!closed && !item.cancelled && !item.ended) void stage(item.cast.castId, "impact").catch(console.warn);
      }, item.cast.radius * projection.scale, () => {
        if (closed || item.cancelled || item.ended || !active.has(item.cast.castId)) return;
        item.started = true;
        void stage(item.cast.castId, "started").catch(console.warn);
      });
      projectionTimer ??= setInterval(() => { void updateProjection(); }, 100);
      await result;
      if (!closed) await end(item, item.cancelled ? "cancelled" : "finished");
    } catch (error) {
      if (!closed) await (playback ? end(playback, "error", errorText(error)) : stage(message.cast.castId, "error", errorText(error))).catch(console.warn);
    } finally {
      if (playback && active.get(message.cast.castId) === playback) active.delete(message.cast.castId);
      if (!active.size && projectionTimer) { clearInterval(projectionTimer); projectionTimer = undefined; }
    }
  }

  const unsubscribe = OBR.broadcast.onMessage(LOCAL_CHANNEL, (event) => {
    if (event.connectionId !== connection || !isLocalMessage(event.data) || !("instance" in event.data) || event.data.instance !== instance) return;
    if (event.data.kind === "fx-play") void play(event.data);
    else if (event.data.kind === "fx-clear") cleanup();
  });
  function cleanup(): void {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(projectionTimer);
    for (const item of active.values()) {
      item.cancelled = true;
      void end(item, "cancelled").catch(() => {});
    }
    primary?.dispose(); secondary?.dispose();
    active.clear();
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    for (const item of active.values()) {
      item.cancelled = true;
      void end(item, "cancelled").catch(console.warn);
      item.renderer.cancel();
    }
  });
  window.addEventListener("pagehide", cleanup, { once: true });
  try {
    try {
      primary = new ThreeFireballPrototype(root, initialQuality);
      await primary.ready();
    } catch (error) {
      console.warn("WebGL unavailable; using Canvas fireball", error);
      primary?.dispose();
      if (closed) return;
      primary = new CanvasFireballFallback(root, "low");
      await primary.ready();
    }
    if (!closed) await send({ kind: "fx-ready", instance, engine: primary.kind });
  } catch (error) {
    await send({ kind: "fx-failed", instance, detail: errorText(error) }).catch(console.warn);
    cleanup();
  }
}

import OBR from "@owlbear-rodeo/sdk";
import { BUTTON_LEFT_OFFSET, BUTTON_MARGIN, BUTTON_POPOVER_ID, BUTTON_WIDTH } from "./constants";
import { NativeTargeting, type NativeTargetingCast } from "./native-targeting";
import { ResidueManager, type ResidueTemplate } from "./residue";
import {
  CHANNEL, LOCAL_CHANNEL, FX_MODAL, RELEASE, SCENE_KEY, CastLedger, deferred, errorText,
  isCast, isLocalMessage, isNoSceneError, isQuality, type Cast, type LocalMessage, type Phase, type Status,
} from "./protocol";

interface Job {
  cast: Cast;
  local: boolean;
  slot: "primary" | "secondary";
  started: ReturnType<typeof deferred<void>>;
  timer: ReturnType<typeof setTimeout>;
  residue?: ResidueTemplate;
  hasStarted: boolean;
  impacted: boolean;
}

/** The hidden background controls SDK state only. All animation runs in fx.html. */
export async function startController(): Promise<void> {
  const connection = await startupStep("读取玩家连接", () => OBR.player.getConnectionId());
  const canConfigureResidue = await startupStep("读取玩家角色", async () => await OBR.player.getRole() === "GM");
  const ledger = new CastLedger();
  const jobs = new Map<string, Job>();
  const residue = new ResidueManager();
  let pickingResidue = false;
  let residueRequest = 0;
  let savedQuality: unknown;
  try { savedQuality = localStorage.getItem("fireball-quality"); } catch { /* Storage may be restricted in iframes. */ }
  let status: Status = { phase: "loading", hint: "正在连接场景…", quality: isQuality(savedQuality) ? savedQuality : "auto", release: RELEASE };
  let sceneKey = "";
  let epoch = 0;
  let sceneRequest = 0;
  let sceneAvailable = false;
  let stopped = false;
  let toggling = false;
  let targetingAttempt = 0;
  let targetingRequested = false;
  let instance = "";
  let overlayReady: ReturnType<typeof deferred<void>> | undefined;
  let overlayTransition: Promise<void> = Promise.resolve();
  let buttonTransition: Promise<void> = Promise.resolve();
  let buttonTasks = 0;
  let buttonWidth = 0;
  let waitingNoticeShown = false;
  let overflowNoticeAt = 0;
  let autoLowUntil = 0;

  // Keep the user's selector on Auto while remembering this client's recent load.
  const playbackQuality = (): Status["quality"] =>
    status.quality === "auto" && Date.now() < autoLowUntil ? "low" : status.quality;

  const local = (message: LocalMessage) => OBR.broadcast.sendMessage(LOCAL_CHANNEL, message, { destination: "LOCAL" });
  const notify = (message: string, variant: "INFO" | "ERROR" = "ERROR") => { void OBR.notification.show(message, variant).catch(console.warn); };
  const publish = (phase: Phase, hint: string) => {
    status = { ...status, phase, hint, residueName: residue.name, residueBusy: pickingResidue, residueCanConfigure: canConfigureResidue };
    void local({ kind: "status", status }).catch(console.warn);
  };
  const report = (error: unknown) => {
    console.error("Fireball", error);
    if (stopped) return;
    publish("error", "未完成 · 点击重试 / 恢复");
    notify(errorText(error));
  };

  try {
    const initialRoomMetadata = await OBR.room.getMetadata();
    const initialResidue = residue.syncRoomMetadata(initialRoomMetadata);
    if (initialResidue === "invalid") notify("房间中的残留素材配置无效；已暂时保留此浏览器之前保存的模板。", "INFO");
    else if (initialResidue === "volatile") notify("已取得 GM 的房间残留配置，但浏览器不允许持久保存。", "INFO");
  } catch (error) {
    // Residue sync is optional: a transient metadata failure must not disable casting.
    notify(`暂时无法读取 GM 的房间残留配置，已使用此浏览器缓存：${errorText(error)}`, "INFO");
  }

  const targeting = new NativeTargeting({
    onRequest: () => { void command("toggle").catch(report); },
    onConfirm: confirm,
    onCancel: () => {
      if (!targetingRequested) return;
      targetingRequested = false;
      targetingAttempt++;
      publish("idle", "选中棋子 · 点击瞄准");
    },
    onError: (error) => {
      targetingRequested = false;
      targetingAttempt++;
      report(error);
    },
  });

  async function confirm(input: NativeTargetingCast): Promise<void> {
    targetingRequested = false;
    targetingAttempt++;
    const generation = epoch;
    if (!sceneKey || !sceneAvailable || pickingResidue || [...jobs.values()].some((job) => job.local)) return;
    const cast: Cast = {
      ...input, kind: "cast-v2", version: 2, castId: crypto.randomUUID(), sceneKey,
      seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
    };
    if (!isCast(cast)) throw new Error("地图比例超出火球术支持的范围");
    ledger.accept(cast, sceneKey, connection);
    publish("preparing", "正在准备特效…");
    try {
      // No room event until this client's renderer has acknowledged playback.
      await schedule(cast, true);
      if (generation !== epoch || !jobs.has(cast.castId)) return;
      try { await OBR.broadcast.sendMessage(CHANNEL, cast, { destination: "REMOTE" }); }
      catch { notify("本地已释放，但房间广播失败；其他玩家可能未看到特效。"); }
    } catch (error) { if (generation === epoch) report(error); }
  }

  function ensureOverlay(generation: number): Promise<void> {
    const operation = overlayTransition.then(async () => {
      if (generation !== epoch || stopped) throw new Error("场景已改变");
      if (instance && overlayReady) { await overlayReady.promise; return; }
      const opening = crypto.randomUUID();
      const handshake = deferred<void>();
      instance = opening;
      overlayReady = handshake;
      const timer = setTimeout(() => handshake.reject(new Error("特效页启动超时，请点击恢复；检查 fx.html/CDN 缓存")), 10000);
      try {
        await OBR.modal.open({
          id: FX_MODAL,
          url: `${import.meta.env.BASE_URL}fx.html?instance=${opening}&quality=${playbackQuality()}`,
          fullScreen: true, hideBackdrop: true, hidePaper: true, disablePointerEvents: true,
        });
        await handshake.promise;
        if (generation !== epoch || opening !== instance) throw new Error("特效准备已取消");
      } finally { clearTimeout(timer); }
    });
    overlayTransition = operation.catch(() => {});
    return operation;
  }

  function closeOverlay(): Promise<void> {
    const operation = overlayTransition.then(async () => {
      if (jobs.size || !instance) return;
      const closing = instance;
      instance = "";
      overlayReady?.reject(new Error("特效页已关闭"));
      overlayReady = undefined;
      await local({ kind: "fx-clear", instance: closing }).catch(() => {});
      await OBR.modal.close(FX_MODAL);
    });
    overlayTransition = operation.catch(console.warn);
    return operation;
  }

  async function schedule(cast: Cast, own: boolean): Promise<void> {
    const generation = epoch;
    const slot = [...jobs.values()].some((job) => job.slot === "primary") ? "secondary" : "primary";
    if ([...jobs.values()].some((job) => job.slot === slot)) {
      if (own) throw new Error("当前特效较多，请稍后释放");
      if (Date.now() - overflowNoticeAt > 5000) {
        overflowNoticeAt = Date.now();
        notify("为保持流畅，已省略一条同时到达的火球视觉效果（不影响规则结算）。", "INFO");
      }
      return;
    }
    const started = deferred<void>();
    const job: Job = {
      cast, local: own, slot, started, hasStarted: false, impacted: false,
      residue: own ? residue.snapshot() : undefined,
      timer: setTimeout(() => finish(cast.castId, "播放准备超时"), 17000),
    };
    jobs.set(cast.castId, job);
    try {
      await ensureOverlay(generation);
      if (generation !== epoch || !jobs.has(cast.castId)) throw new Error("释放已取消");
      await local({ kind: "fx-play", instance, cast, slot, quality: playbackQuality() });
      await started.promise;
    } catch (error) { finish(cast.castId, errorText(error)); throw error; }
  }

  function finish(castId: string, failure?: string): void {
    const job = jobs.get(castId);
    if (!job) return;
    jobs.delete(castId);
    clearTimeout(job.timer);
    job.started.reject(new Error(failure ?? "释放已结束"));
    if (job.local) {
      publish(failure ? "error" : "idle", failure ? "播放中断 · 可重试 / 恢复" : "选中棋子 · 点击瞄准");
      if (failure) notify(failure);
    }
    if (!jobs.size) void closeOverlay().catch(console.warn);
  }

  async function cancelRuntime(): Promise<void> {
    epoch++;
    residueRequest++;
    pickingResidue = false;
    targetingRequested = false;
    targetingAttempt++;
    sceneKey = "";
    ledger.clear();
    overlayReady?.reject(new Error("释放已取消"));
    for (const job of jobs.values()) { clearTimeout(job.timer); job.started.reject(new Error("释放已取消")); }
    jobs.clear();
    await targeting.cancel();
    await closeOverlay();
  }

  async function loadScene(): Promise<void> {
    const request = ++sceneRequest;
    // Invalidate scene-dependent work immediately, before waiting on old cleanup.
    sceneAvailable = false;
    try {
      publish("loading", "正在连接场景…");
      await cancelRuntime();
      if (request !== sceneRequest || stopped) return;
      await closeButton();
      if (request !== sceneRequest || stopped) return;
      const ready = await startupStep("检查场景状态", () => OBR.scene.isReady());
      if (request !== sceneRequest || stopped) return;
      sceneAvailable = ready;
      if (!sceneAvailable) { waitForScene(); return; }
      // SDK ready only means postMessage is connected, not that a scene exists.
      await startupStep("注册瞄准工具", () => targeting.init());
      if (request !== sceneRequest || stopped) return;
      await startupStep("创建右上角按钮", () => anchorButton(request));
      if (request !== sceneRequest || stopped) return;
      let metadata = await startupStep("读取场景", () => OBR.scene.getMetadata());
      if (request !== sceneRequest || stopped) return;
      if (typeof metadata[SCENE_KEY] !== "string" && await OBR.player.getRole() === "GM") {
        if (request !== sceneRequest || stopped) return;
        await OBR.scene.setMetadata({ [SCENE_KEY]: crypto.randomUUID() });
        if (request !== sceneRequest || stopped) return;
        metadata = await OBR.scene.getMetadata();
      }
      if (request !== sceneRequest || stopped) return;
      const id = metadata[SCENE_KEY];
      if (typeof id !== "string" || !id || id.length > 100) {
        publish("error", "请 GM 启用本扩展后点恢复");
        return;
      }
      sceneKey = `${OBR.room.id}:${id}`;
      waitingNoticeShown = false;
      publish("idle", "选中棋子 · 点击瞄准");
    } catch (error) {
      if (request !== sceneRequest || stopped) return;
      if (!isNoSceneError(error)) throw error;
      // The scene can disappear between isReady and a later RPC. Keep the listener alive.
      sceneAvailable = false;
      sceneKey = "";
      await closeButton().catch(console.warn);
      if (request === sceneRequest && !stopped) waitForScene();
    }
  }

  function waitForScene(): void {
    publish("idle", "请先打开场景");
    if (!waitingNoticeShown) {
      waitingNoticeShown = true;
      notify("火球术已连接，请先在房间中打开一个场景。", "INFO");
    }
  }

  async function command(action: "toggle" | "reset"): Promise<void> {
    if (action === "reset") { await loadScene(); return; }
    if (pickingResidue || toggling || [...jobs.values()].some((job) => job.local)) return;
    if (!sceneAvailable || !sceneKey) { await loadScene(); return; }
    const generation = epoch;
    let attempt = targetingAttempt;
    toggling = true;
    try {
      if (status.phase === "aiming") await targeting.cancel();
      else {
        attempt = ++targetingAttempt;
        targetingRequested = true;
        publish("preparing", "检查施法棋子…");
        await targeting.begin();
        if (generation === epoch && attempt === targetingAttempt && targetingRequested) publish("aiming", "点地图释放 · Esc 取消");
      }
    } catch (error) {
      if (generation !== epoch || attempt !== targetingAttempt) return;
      targetingRequested = false;
      targetingAttempt++;
      throw error;
    } finally { toggling = false; }
  }

  async function configureResidue(action: "select" | "clear"): Promise<void> {
    if (stopped || !sceneAvailable || !sceneKey || pickingResidue || toggling || targetingRequested ||
        [...jobs.values()].some((job) => job.local)) return;
    if (!canConfigureResidue) { notify("只有 GM 可以设置或关闭全房间残留素材。", "INFO"); return; }
    const request = ++residueRequest;
    const generation = epoch;
    const current = () => !stopped && generation === epoch && request === residueRequest && sceneAvailable;
    pickingResidue = true;
    publish(status.phase, status.hint);
    try {
      const result = action === "select" ? await residue.select(current) : await residue.clear(current);
      if (current() && result === "volatile") notify("房间配置已更新，但此浏览器不允许持久保存本地缓存。", "INFO");
    } catch (error) {
      if (current()) notify(`全房间残留素材未更改：${errorText(error)}`);
    } finally {
      if (current()) { pickingResidue = false; publish(status.phase, status.hint); }
    }
  }

  const offLocal = OBR.broadcast.onMessage(LOCAL_CHANNEL, (event) => {
    if (event.connectionId !== connection || !isLocalMessage(event.data)) return;
    const message = event.data;
    if (message.kind === "button-ready") { void local({ kind: "status", status }).catch(console.warn); return; }
    if (message.kind === "residue-command") { void configureResidue(message.action).catch(report); return; }
    if (message.kind === "quality") {
      status = { ...status, quality: message.quality };
      try { localStorage.setItem("fireball-quality", message.quality); } catch { /* Optional persistence. */ }
      publish(status.phase, status.hint);
      return;
    }
    if (message.kind === "button-command") {
      void command(message.action).then(() => local({ kind: "status", status })).catch(report);
      return;
    }
    if (!("instance" in message) || message.instance !== instance) return;
    if (message.kind === "fx-ready") {
      overlayReady?.resolve();
      if (message.engine === "canvas") notify("WebGL 不可用，已使用轻量 2D 特效。", "INFO");
    } else if (message.kind === "fx-failed") {
      overlayReady?.reject(new Error(message.detail));
      for (const id of [...jobs.keys()]) finish(id, message.detail);
    } else if (message.kind === "fx-stage") {
      const job = jobs.get(message.castId);
      if (!job) return;
      if (message.stage === "started") {
        if (job.hasStarted) return;
        job.hasStarted = true;
        clearTimeout(job.timer);
        job.timer = setTimeout(() => finish(message.castId, "播放无响应，已恢复按钮"), 6500);
        job.started.resolve();
        if (job.local) publish("flying", "火球飞行中…");
      } else if (message.stage === "impact") {
        if (!job.hasStarted || job.impacted) return;
        job.impacted = true;
        if (job.local) publish("smoke", "爆炸与余烟…");
      } else {
        if (status.quality === "auto" && message.actualQuality === "low") autoLowUntil = Date.now() + 60000;
        finish(message.castId, message.stage === "error" ? message.detail ?? "特效播放失败" : undefined);
        // Consume the job synchronously first, so duplicate terminals cannot create another prop.
        if (message.stage === "finished" && job.hasStarted && job.impacted && job.local && job.residue) {
          const generation = epoch;
          const current = () => !stopped && sceneAvailable && generation === epoch && sceneKey === job.cast.sceneKey;
          void residue.create(job.cast, job.residue, current).catch((error: unknown) => {
            if (current()) notify(`火球已播放，但残留创建失败：${errorText(error)}。请检查 Props 创建权限或手动放置素材。`);
          });
        }
      }
    }
  });
  const offRoom = OBR.broadcast.onMessage(CHANNEL, (event) => {
    if (event.connectionId === connection || !sceneAvailable || !ledger.accept(event.data, sceneKey, event.connectionId)) return;
    void schedule(event.data, false).catch((error) => console.warn("Remote fireball", error));
  });
  const offResidueMetadata = OBR.room.onMetadataChange((metadata) => {
    if (stopped) return;
    const result = residue.syncRoomMetadata(metadata);
    if (result === "missing") return;
    if (result === "invalid") notify("收到无效的房间残留配置；已保留此浏览器当前模板。", "INFO");
    else if (result === "volatile") notify("已同步 GM 的房间残留配置，但此浏览器不允许持久保存。", "INFO");
    publish(status.phase, status.hint);
  });
  const offScene = OBR.scene.onReadyChange(() => { void loadScene().catch(report); });
  const offMetadata = OBR.scene.onMetadataChange((metadata) => {
    if (!sceneAvailable || status.phase === "loading") return;
    const id = metadata[SCENE_KEY];
    if (typeof id === "string" && `${OBR.room.id}:${id}` !== sceneKey) void loadScene().catch(report);
  });

  function queueButton(run: () => Promise<void>): Promise<void> {
    buttonTasks++;
    const operation = buttonTransition.then(run).finally(() => { buttonTasks--; });
    buttonTransition = operation.catch(() => {});
    return operation;
  }

  function closeButton(): Promise<void> {
    return queueButton(async () => {
      if (!buttonWidth) return;
      buttonWidth = 0;
      await OBR.popover.close(BUTTON_POPOVER_ID);
    });
  }

  function anchorButton(request = sceneRequest): Promise<void> {
    const current = () => !stopped && sceneAvailable && request === sceneRequest;
    if (!current()) return Promise.resolve();
    return queueButton(async () => {
      if (!current()) return;
      const width = await OBR.viewport.getWidth();
      if (!current() || Math.abs(width - buttonWidth) < 2) return;
      if (buttonWidth) {
        buttonWidth = 0;
        await OBR.popover.close(BUTTON_POPOVER_ID);
      }
      if (!current()) return;
      try {
        await OBR.popover.open({
          id: BUTTON_POPOVER_ID, url: `${import.meta.env.BASE_URL}button.html`, width: BUTTON_WIDTH, height: 188,
          anchorReference: "POSITION", anchorPosition: { left: width - BUTTON_MARGIN - BUTTON_LEFT_OFFSET, top: BUTTON_MARGIN },
          anchorOrigin: { horizontal: "RIGHT", vertical: "TOP" }, transformOrigin: { horizontal: "RIGHT", vertical: "TOP" },
          hidePaper: true, disableClickAway: true, marginThreshold: 0,
        });
      } finally {
        // A late old-scene open is closed before any new-scene UI can enter this lane.
        if (!current()) await OBR.popover.close(BUTTON_POPOVER_ID);
      }
      if (!current()) return;
      buttonWidth = width;
    });
  }

  let anchorTimer: ReturnType<typeof setInterval> | undefined;
  function shutdown(): void {
    if (stopped) return;
    stopped = true;
    sceneAvailable = false;
    sceneRequest++;
    if (anchorTimer !== undefined) clearInterval(anchorTimer);
    window.removeEventListener("pagehide", shutdown);
    offLocal(); offRoom(); offResidueMetadata(); offScene(); offMetadata();
    void cancelRuntime().catch(console.warn);
    void targeting.dispose().catch(console.warn);
    void OBR.popover.close(BUTTON_POPOVER_ID).catch(console.warn);
  }
  // Register cleanup before the first UI RPC, including failures during startup.
  window.addEventListener("pagehide", shutdown, { once: true });
  try {
    await loadScene();
    if (stopped) return;
    anchorTimer = setInterval(() => {
      if (!sceneAvailable || buttonTasks || stopped) return;
      const request = sceneRequest;
      void anchorButton(request).catch((error: unknown) => {
        if (request !== sceneRequest || stopped) return;
        if (isNoSceneError(error)) void loadScene().catch(report);
        else console.warn("Fireball button", error);
      });
    }, 1200);
  } catch (error) {
    shutdown();
    throw error;
  }
}

async function startupStep<T>(step: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) { throw new Error(`${step}：${errorText(error)}`, { cause: error }); }
}

import OBR, { buildShape, type Vector2 } from "@owlbear-rodeo/sdk";
import { EXTENSION_ID, FIREBALL_RADIUS_FEET } from "./constants";
import { worldRadiusForFeet } from "./geometry";

const TOOL_ID = `${EXTENSION_ID}/native-targeting`;
const MODE_ID = `${TOOL_ID}/aim`;
const UPDATE_INTERVAL_MS = 50;

export interface NativeTargetingCast {
  from: Vector2;
  to: Vector2;
  radius: number;
  projectileSize: number;
}

interface NativeTargetingOptions {
  onRequest?: () => void;
  onConfirm: (cast: NativeTargetingCast) => Promise<void>;
  onCancel: () => void;
  onError: (error: unknown) => void;
}

interface TargetSession {
  phase: "preparing" | "aiming" | "confirming" | "finished";
  sceneEpoch: number;
  aborted: boolean;
  circleId: string;
  added: boolean;
  activationStarted: boolean;
  tokenId?: string;
  originalTool?: string;
  originalMode?: string;
  gridDpi?: number;
  gridScale?: string;
  radius: number;
  projectileSize: number;
  anchorOffset: Vector2;
  pendingPointer?: Vector2;
  notifyCancel?: boolean;
  timer?: ReturnType<typeof setInterval>;
  setup?: Promise<void>;
  update?: Promise<void>;
  cleanup?: Promise<void>;
}

/** Native map targeting; only the local preview is updated while the pointer moves. */
export class NativeTargeting {
  private readonly options: NativeTargetingOptions;
  private initialization?: Promise<void>;
  private disposal?: Promise<void>;
  private disposed = false;
  private modeRegistered = false;
  private toolRegistered = false;
  private sceneEpoch = 0;
  private requestEpoch = 0;
  private session?: TargetSession;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(options: NativeTargetingOptions) {
    this.options = options;
  }

  async init(): Promise<void> {
    if (this.disposed) throw new Error("火球术瞄准工具已关闭");
    if (!this.initialization) {
      this.initialization = this.register().catch(async (error: unknown) => {
        await this.unregister();
        this.initialization = undefined;
        throw error;
      });
    }
    await this.initialization;
  }

  /** Setup failures reject; failures from native event handlers use onError. */
  async begin(): Promise<void> {
    if (this.session) throw new Error("请先完成或取消当前的火球术瞄准");
    const requestEpoch = ++this.requestEpoch;
    await this.init();
    if (this.disposed || requestEpoch !== this.requestEpoch) return;
    if (this.session) throw new Error("请先完成或取消当前的火球术瞄准");

    const session: TargetSession = {
      phase: "preparing",
      sceneEpoch: this.sceneEpoch,
      aborted: false,
      circleId: crypto.randomUUID(),
      added: false,
      activationStarted: false,
      radius: 0,
      projectileSize: 0,
      anchorOffset: { x: 0, y: 0 },
    };
    this.session = session;
    session.setup = this.prepare(session);
    try {
      await session.setup;
    } catch (error) {
      if (session.aborted) {
        await session.cleanup;
        return;
      }
      await this.finish(session, false, true);
      throw error;
    }
  }

  async cancel(): Promise<void> {
    this.requestEpoch += 1;
    const session = this.session;
    if (!session) return;
    session.aborted = true;
    await this.finish(session, true, true);
  }

  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = (async () => {
      try {
        await this.cancel();
      } finally {
        await this.initialization?.catch(() => undefined);
        await this.unregister();
      }
    })();
    return this.disposal;
  }

  private async register(): Promise<void> {
    const icon = `${import.meta.env.BASE_URL}icon.svg`;
    await OBR.tool.createMode({
      id: MODE_ID,
      icons: [{ icon, label: "火球术 · 20 英尺范围", filter: { activeTools: [TOOL_ID] } }],
      cursors: [{ cursor: "crosshair" }],
      onToolMove: (_, event) => this.move(event.pointerPosition),
      onToolDragMove: (_, event) => this.move(event.pointerPosition),
      onToolClick: (_, event) => {
        void this.confirm(event.pointerPosition).catch(this.report);
        return false;
      },
      onToolDoubleClick: () => false,
      onKeyDown: (_, event) => {
        if (event.key === "Escape") void this.cancel().catch(this.report);
      },
      onToolDragCancel: () => {
        if (this.session?.phase === "aiming") void this.cancel().catch(this.report);
      },
      onDeactivate: () => this.toolWasChanged(),
    });
    this.modeRegistered = true;
    if (this.disposed) return;
    await OBR.tool.create({
      id: TOOL_ID,
      icons: [{ icon, label: "释放火球术" }],
      defaultMode: MODE_ID,
      onClick: () => {
        if (this.options.onRequest) this.options.onRequest();
        else void this.begin().catch(this.report);
        return false;
      },
    });
    this.toolRegistered = true;
    if (this.disposed) return;
    this.unsubscribe.push(
      OBR.scene.onReadyChange((ready) => {
        if (ready) return;
        this.sceneEpoch += 1;
        this.requestEpoch += 1;
        const session = this.session;
        if (session) {
          session.aborted = true;
          void this.finish(session, true, false).catch(this.report);
        }
      }),
      OBR.tool.onToolChange((id) => {
        const session = this.session;
        if (session && id !== TOOL_ID &&
            (session.activationStarted || (session.originalTool && id !== session.originalTool))) {
          this.toolWasChanged();
        }
      }),
      OBR.scene.grid.onChange((grid) => {
        const session = this.session;
        if (session?.gridDpi !== undefined &&
            (grid.dpi !== session.gridDpi || grid.scale !== session.gridScale)) {
          void this.cancel().catch(this.report);
        }
      }),
    );
  }

  private async unregister(): Promise<void> {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    if (this.toolRegistered) {
      await OBR.tool.remove(TOOL_ID);
      this.toolRegistered = false;
    }
    if (this.modeRegistered) {
      await OBR.tool.removeMode(MODE_ID);
      this.modeRegistered = false;
    }
  }

  private async prepare(session: TargetSession): Promise<void> {
    if (!(await OBR.scene.isReady())) throw new Error("请先打开一个 Owlbear 场景");
    if (!this.isCurrent(session)) return;
    const selection = await OBR.player.getSelection();
    if (!this.isCurrent(session)) return;
    if (!selection || selection.length !== 1) throw new Error("请先选中一个角色棋子作为施法起点");
    const tokenId = selection[0]!;
    const [items, bounds, dpi, scale, tool, mode] = await Promise.all([
      OBR.scene.items.getItems([tokenId]),
      OBR.scene.items.getItemBounds([tokenId]),
      OBR.scene.grid.getDpi(),
      OBR.scene.grid.getScale(),
      OBR.tool.getActiveTool(),
      OBR.tool.getActiveToolMode(),
    ]);
    if (!this.isCurrent(session)) return;
    if (items.length !== 1 || items[0]?.type !== "IMAGE" || items[0].layer !== "CHARACTER") {
      throw new Error("施法起点必须是场景中一个真实存在的角色棋子");
    }
    if (!finitePoint(bounds.center) || !Number.isFinite(dpi) || dpi <= 0 ||
        !Number.isFinite(scale.parsed.multiplier) || scale.parsed.multiplier <= 0) {
      throw new Error("场景网格或棋子坐标无效，无法计算 20 英尺范围");
    }
    session.tokenId = tokenId;
    session.originalTool = tool === TOOL_ID ? undefined : tool;
    session.originalMode = mode;
    session.gridDpi = dpi;
    session.gridScale = scale.raw;
    session.radius = worldRadiusForFeet(FIREBALL_RADIUS_FEET, dpi, scale.parsed.multiplier, scale.parsed.unit);
    session.projectileSize = Math.max(dpi * 0.22, session.radius * 0.08);

    const circle = buildShape()
      .id(session.circleId)
      .name("火球术瞄准 · 半径 20 英尺")
      .shapeType("CIRCLE")
      .width(session.radius * 2)
      .height(session.radius * 2)
      .position(bounds.center)
      .fillColor("#ff702c").fillOpacity(0.12)
      .strokeColor("#ffb85c").strokeOpacity(0.95).strokeWidth(Math.max(2, dpi / 40))
      .layer("POINTER").locked(true).disableHit(true).visible(false)
      .build();
    await OBR.scene.local.addItems([circle]);
    session.added = true;
    if (!this.isCurrent(session)) return;
    // Measure once so the preview is centered regardless of the shape's native anchor.
    const circleBounds = await OBR.scene.local.getItemBounds([session.circleId]);
    if (!this.isCurrent(session)) return;
    if (!finitePoint(circleBounds.center)) throw new Error("无法定位火球术范围圆");
    session.anchorOffset = {
      x: circleBounds.center.x - bounds.center.x,
      y: circleBounds.center.y - bounds.center.y,
    };
    // A tool's selected mode and the currently active map tool are separate SDK state.
    // Explicitly activate both; a successful mode RPC alone is not a pointer-event handshake.
    session.activationStarted = true;
    await OBR.tool.activateTool(TOOL_ID);
    if (!this.isCurrent(session)) return;
    await OBR.tool.activateMode(TOOL_ID, MODE_ID);
    if (!this.isCurrent(session)) return;
    const [activeTool, activeMode] = await Promise.all([
      OBR.tool.getActiveTool(), OBR.tool.getActiveToolMode(),
    ]);
    if (!this.isCurrent(session)) return;
    if (activeTool !== TOOL_ID) throw new Error("未能激活火球瞄准工具，请点恢复后重试");
    if (activeMode !== MODE_ID) throw new Error("未能切换到火球瞄准模式，请点恢复后重试");
    // Do not show a fixed preview if tool activation failed or was interrupted.
    await OBR.scene.local.updateItems([session.circleId], (draft) => {
      if (!this.isCurrent(session)) return;
      for (const item of draft) {
        item.position = this.circlePosition(session, bounds.center);
        item.visible = true;
      }
    });
    if (!this.isCurrent(session)) return;
    session.phase = "aiming";
    session.timer = setInterval(() => this.flushPointer(session), UPDATE_INTERVAL_MS);
  }

  private isCurrent(session: TargetSession): boolean {
    return !this.disposed && this.session === session && !session.aborted &&
      session.phase !== "finished" && session.sceneEpoch === this.sceneEpoch;
  }

  private move(point: Vector2): void {
    const session = this.session;
    if (session?.phase === "aiming" && finitePoint(point)) {
      session.pendingPointer = { ...point };
    }
  }

  private circlePosition(session: TargetSession, point: Vector2): Vector2 {
    return { x: point.x - session.anchorOffset.x, y: point.y - session.anchorOffset.y };
  }

  private flushPointer(session: TargetSession): void {
    if (!this.isCurrent(session) || session.phase !== "aiming" || session.update || !session.pendingPointer) return;
    const point = session.pendingPointer;
    session.pendingPointer = undefined;
    session.update = OBR.scene.local.updateItems([session.circleId], (draft) => {
      if (!this.isCurrent(session) || session.phase !== "aiming") return;
      for (const item of draft) item.position = this.circlePosition(session, point);
    }, true).catch((error: unknown) => {
      if (this.isCurrent(session)) {
        this.report(error);
        session.aborted = true;
        void this.finish(session, true, true).catch(this.report);
      }
    }).finally(() => { session.update = undefined; });
  }

  private toolWasChanged(): void {
    const session = this.session;
    if (!session || (session.phase !== "preparing" && session.phase !== "aiming")) return;
    session.aborted = true;
    // A user's newly chosen tool must not be overwritten by restoring the old one.
    void this.finish(session, true, false).catch(this.report);
  }

  private async confirm(point: Vector2): Promise<void> {
    const session = this.session;
    if (!session || session.phase !== "aiming" || !finitePoint(point) || !session.tokenId) return;
    session.phase = "confirming";
    clearInterval(session.timer);
    try {
      const [items, bounds, ready] = await Promise.all([
        OBR.scene.items.getItems([session.tokenId]),
        OBR.scene.items.getItemBounds([session.tokenId]),
        OBR.scene.isReady(),
      ]);
      if (!this.isCurrent(session)) return;
      if (!ready || items.length !== 1 || items[0]?.type !== "IMAGE" ||
          items[0].layer !== "CHARACTER" || !finitePoint(bounds.center)) {
        throw new Error("施法起点已被移除或场景已关闭，请重新瞄准");
      }
      const cast: NativeTargetingCast = {
        from: { ...bounds.center }, to: { ...point },
        radius: session.radius, projectileSize: session.projectileSize,
      };
      await this.finish(session, false, true);
      if (!session.aborted && !this.disposed && session.sceneEpoch === this.sceneEpoch) {
        await this.options.onConfirm(cast);
      }
    } catch (error) {
      await this.finish(session, false, true);
      if (!session.aborted) throw error;
    }
  }

  private finish(session: TargetSession, notifyCancel: boolean, restoreTool: boolean): Promise<void> {
    session.notifyCancel ||= notifyCancel;
    if (session.cleanup) return session.cleanup;
    session.phase = "finished";
    clearInterval(session.timer);
    session.pendingPointer = undefined;
    session.cleanup = (async () => {
      // Wait for late scene writes before deleting the unique preview item.
      await session.setup?.catch(() => undefined);
      await session.update?.catch(() => undefined);
      try {
        if (session.added) {
          try {
            await OBR.scene.local.deleteItems([session.circleId]);
          } catch (error) {
            if (session.sceneEpoch === this.sceneEpoch && await OBR.scene.isReady()) throw error;
          }
        }
        if (restoreTool && session.activationStarted && session.originalTool &&
            session.sceneEpoch === this.sceneEpoch && await OBR.tool.getActiveTool() === TOOL_ID) {
          await OBR.tool.activateTool(session.originalTool);
          if (session.originalMode && session.sceneEpoch === this.sceneEpoch &&
              await OBR.tool.getActiveTool() === session.originalTool) {
            await OBR.tool.activateMode(session.originalTool, session.originalMode);
          }
        }
      } finally {
        if (this.session === session) this.session = undefined;
        if (session.notifyCancel) this.options.onCancel();
      }
    })();
    return session.cleanup;
  }

  private readonly report = (error: unknown): void => { this.options.onError(error); };
}

function finitePoint(point: Vector2): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

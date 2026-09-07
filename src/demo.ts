import "./styles.css";
import "./demo-controls.css";
import { CanvasFireballFallback, ThreeFireballPrototype, type FxQuality, type FxRenderer } from "./performance-fx";

export function mountDemo(): void {
  document.title = "Owlbear 火球术 · 交互演示";
  document.body.className = "demo-page";
  document.body.innerHTML = `
    <main id="demo-stage" class="demo-stage">
      <div class="demo-grid" aria-hidden="true"></div>
      <div class="demo-vignette" aria-hidden="true"></div>

      <header class="demo-header">
        <span class="demo-mark" aria-hidden="true">O</span>
        <span><strong>Owlbear Fireball</strong><small>性能友好 · 交互演示</small></span>
      </header>

      <aside class="demo-quality-controls" id="demo-quality-controls" aria-label="画质设置">
        <label for="demo-quality">画质</label>
        <select id="demo-quality" aria-describedby="demo-quality-active">
          <option value="auto">自动</option>
          <option value="standard">标准</option>
          <option value="low">轻量</option>
        </select>
        <small id="demo-quality-active" role="status">正在准备…</small>
      </aside>

      <div class="demo-token demo-token--caster" id="demo-caster">
        <span>🧙</span><small>施法者</small>
      </div>
      <div class="demo-token demo-token--enemy demo-token--enemy-one"><span>👹</span><small>敌人</small></div>
      <div class="demo-token demo-token--enemy demo-token--enemy-two"><span>🧟</span><small>敌人</small></div>

      <section class="demo-welcome" id="demo-welcome">
        <span class="demo-welcome__eyebrow">D&amp;D 5E · EVOCATION</span>
        <h1>火球术</h1>
        <p>点击右上角按钮，移动半径 20 英尺的范围圈，再点击战场释放。</p>
        <div><span>20 ft 半径</span><span>完整释放流程</span><span>性能优先</span></div>
      </section>

      <div id="demo-ring" class="target-ring demo-target-ring" aria-hidden="true">
        <span class="target-ring__crosshair"></span>
        <span class="target-ring__label">20 英尺</span>
      </div>
      <aside class="demo-fx-badge" aria-label="火球特效状态">
        <span class="demo-fx-badge__signal" aria-hidden="true"></span>
        <span><strong>FIREBALL · LIVE PREVIEW</strong><small id="demo-fx-metrics">正在准备火焰…</small></span>
      </aside>

      <div id="demo-tip" class="target-tip demo-tip" role="status">
        <strong>正在准备火焰</strong><span>首次使用需要片刻准备</span>
      </div>

      <button id="demo-fireball" class="fireball-button demo-fireball-button" type="button" aria-label="释放火球术" disabled>
        <span class="fireball-button__orb" aria-hidden="true"><span class="fireball-button__core"></span></span>
        <span class="fireball-button__copy"><strong>火球术</strong><small id="demo-button-hint">准备中…</small></span>
      </button>
    </main>
  `;

  const stage = requireElement<HTMLElement>("#demo-stage");
  const ring = requireElement<HTMLElement>("#demo-ring");
  const caster = requireElement<HTMLElement>("#demo-caster");
  const button = requireElement<HTMLButtonElement>("#demo-fireball");
  const buttonHint = requireElement<HTMLElement>("#demo-button-hint");
  const tip = requireElement<HTMLElement>("#demo-tip");
  const welcome = requireElement<HTMLElement>("#demo-welcome");
  const fxMetrics = requireElement<HTMLElement>("#demo-fx-metrics");
  const qualityControls = requireElement<HTMLElement>("#demo-quality-controls");
  const qualitySelect = requireElement<HTMLSelectElement>("#demo-quality");
  const qualityActive = requireElement<HTMLElement>("#demo-quality-active");

  let fx: FxRenderer | null = null;
  let requestedQuality = readQuality();
  qualitySelect.value = requestedQuality;
  let armed = false;
  let animating = false;
  let preparing = false;
  let alive = true;
  let cancelled = false;
  let preferCanvas = false;
  let target = { x: innerWidth * 0.64, y: innerHeight * 0.48 };

  const updateMetrics = () => {
    if (!fx) return;
    const backend = fx.kind === "webgl" ? "WebGL" : "Canvas 后备";
    const actual = fx.currentQuality === "low" ? "轻量" : "标准";
    qualityActive.textContent = `当前：${actual} · ${backend}`;
    fxMetrics.textContent = `${backend} · ${actual}画质 · 飞行 / 爆炸 / 余烟`;
    fxMetrics.title = fx.lastAverageFps > 0
      ? `${fx.particleCount} 个特效元素 · 本画布 rAF 估算 ${fx.lastAverageFps} FPS（非 Owlbear 房间帧率）`
      : `${fx.particleCount} 个特效元素 · 已完成预热`;
  };

  const prepareRenderer = async (): Promise<boolean> => {
    if (preparing || !alive) return false;
    preparing = true;
    button.disabled = true;
    qualitySelect.disabled = true;
    buttonHint.textContent = "准备中…";
    qualityActive.textContent = "正在准备…";
    fxMetrics.textContent = "正在预热火球和烟雾…";
    stage.dataset.vfx = "preparing";
    let candidate: FxRenderer | null = null;
    try {
      if (!preferCanvas) {
        try {
          candidate = new ThreeFireballPrototype(stage, requestedQuality);
          await candidate.ready();
        } catch (error) {
          console.warn("WebGL preparation failed; switching to Canvas", error);
          candidate?.dispose();
          candidate = null;
          preferCanvas = true;
        }
      }
      if (!alive) { candidate?.dispose(); return false; }
      if (!candidate) {
        candidate = new CanvasFireballFallback(stage, requestedQuality);
        await candidate.ready();
      }
      if (!alive) { candidate.dispose(); return false; }
      fx?.dispose();
      fx = candidate;
      updateMetrics();
      stage.dataset.vfx = fx.kind === "webgl" ? "three-ready" : "canvas-ready";
      buttonHint.textContent = "点击瞄准";
      tip.innerHTML = fx.kind === "canvas"
        ? "<strong>轻量效果已就绪</strong><span>已自动启用后备效果，点击右上角开始</span>"
        : "<strong>准备施法</strong><span>点击右上角的火球术按钮</span>";
      return true;
    } catch (error) {
      candidate?.dispose();
      fx = null;
      if (alive) {
        console.error("Fireball preparation failed", error);
        stage.dataset.vfx = "unavailable";
        qualityActive.textContent = "特效暂不可用";
        fxMetrics.textContent = "准备失败 · 可点击火球术重试";
        buttonHint.textContent = "重试准备";
        tip.innerHTML = "<strong>特效准备失败</strong><span>点击右上角重试；也可以尝试其他浏览器</span>";
      }
      return false;
    } finally {
      preparing = false;
      if (alive) {
        button.disabled = animating;
        qualitySelect.disabled = false;
      }
    }
  };

  const moveRing = (x: number, y: number) => {
    target = { x, y };
    ring.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
  };

  const setArmed = (value: boolean) => {
    armed = value;
    stage.classList.toggle("demo-stage--armed", value);
    ring.classList.toggle("demo-target-ring--visible", value);
    button.classList.toggle("demo-fireball-button--armed", value);
    buttonHint.textContent = value ? "点击战场释放" : "点击瞄准";
    tip.innerHTML = value
      ? "<strong>移动鼠标选择爆炸中心</strong><span>点击战场释放 · 再点按钮取消</span>"
      : "<strong>准备施法</strong><span>点击右上角的火球术按钮</span>";
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (animating || preparing) return;
    if (!fx) { void prepareRenderer(); return; }
    welcome.classList.add("demo-welcome--hidden");
    setArmed(!armed);
    if (armed) moveRing(target.x, target.y);
  });

  stage.addEventListener("pointermove", (event) => {
    if (armed && !animating && !qualityControls.contains(event.target as Node)) moveRing(event.clientX, event.clientY);
  });

  qualityControls.addEventListener("click", (event) => event.stopPropagation());
  qualitySelect.addEventListener("change", () => {
    const selected = qualitySelect.value;
    if (selected !== "auto" && selected !== "standard" && selected !== "low") return;
    requestedQuality = selected;
    try { localStorage.setItem("owlbear-fireball-demo-quality", selected); } catch { /* Private mode may deny storage. */ }
    fx?.setQuality(selected);
    updateMetrics();
  });

  stage.addEventListener("click", async (event) => {
    if (!armed || animating || preparing || !fx || button.contains(event.target as Node) || qualityControls.contains(event.target as Node)) return;
    animating = true;
    cancelled = false;
    button.disabled = true;
    setArmed(false);
    buttonHint.textContent = "施法中…";
    tip.innerHTML = "<strong>火球已释放</strong><span>正在飞向目标…</span>";

    const casterBounds = caster.getBoundingClientRect();
    const from = {
      x: casterBounds.left + casterBounds.width / 2,
      y: casterBounds.top + casterBounds.height / 2,
    };
    const to = { x: event.clientX, y: event.clientY };
    const renderer = fx;
    let impacted = false;
    let outcome: "complete" | "cancelled" | "failed" = "complete";

    const showImpact = () => {
      if (!alive || cancelled) return;
      impacted = true;
      stage.dataset.vfx = renderer.kind === "webgl" ? "three-explosion" : "canvas-explosion";
      tip.innerHTML = "<strong>命中！</strong><span>烈焰翻卷，余烬渐熄</span>";
      updateMetrics();
    };
    // Only sample the display label during a cast; the idle demo has no polling loop.
    const metricsTimer = window.setInterval(updateMetrics, 300);
    try {
      stage.dataset.vfx = renderer.kind === "webgl" ? "three-flight" : "canvas-flight";
      await renderer.play(from, to, showImpact, ring.getBoundingClientRect().width / 2);
      if (cancelled || !impacted) outcome = "cancelled";
    } catch (error) {
      outcome = "failed";
      console.error("Fireball playback failed", error);
      renderer.dispose();
      if (fx === renderer) fx = null;
      if (renderer.kind === "webgl" && alive) {
        preferCanvas = true;
        await prepareRenderer();
      }
    } finally {
      window.clearInterval(metricsTimer);
      animating = false;
      if (alive) {
        button.disabled = preparing;
        buttonHint.textContent = fx ? "再次瞄准" : "重试准备";
        stage.dataset.vfx = fx ? (fx.kind === "webgl" ? "three-ready" : "canvas-ready") : "unavailable";
        updateMetrics();
        if (!fx) {
          qualityActive.textContent = "特效暂不可用";
          fxMetrics.textContent = "特效未就绪 · 点击火球术重新准备";
        }
        if (outcome === "failed") {
          tip.innerHTML = fx
            ? "<strong>刚才的施法已中止</strong><span>已切换到轻量效果，请重新瞄准</span>"
            : "<strong>特效播放失败</strong><span>点击右上角重新准备；操作已恢复</span>";
        } else if (outcome === "cancelled") {
          tip.innerHTML = "<strong>施法已取消</strong><span>点击右上角，重新选择目标</span>";
        } else {
          tip.innerHTML = "<strong>烟尘散尽</strong><span>点击右上角，再次释放火球术</span>";
        }
      }
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (armed) setArmed(false);
    if (animating) { cancelled = true; fx?.cancel(); }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    if (armed) setArmed(false);
    if (animating) { cancelled = true; fx?.cancel(); }
  });
  window.addEventListener("pagehide", (event) => {
    cancelled = true;
    fx?.cancel();
    if (!event.persisted) {
      alive = false;
      fx?.dispose();
      fx = null;
    }
  });
  void prepareRenderer();
}

function readQuality(): FxQuality {
  try {
    const stored = localStorage.getItem("owlbear-fireball-demo-quality");
    if (stored === "auto" || stored === "standard" || stored === "low") return stored;
  } catch { /* Settings remain session-local if storage is unavailable. */ }
  return "auto";
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Demo markup is missing: ${selector}`);
  return element;
}

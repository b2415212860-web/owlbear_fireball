import "./styles.css";
import { ThreeFireballPrototype } from "./three-fx";

export function mountDemo(): void {
  document.title = "Owlbear 火球术 · 交互演示";
  document.body.className = "demo-page";
  document.body.innerHTML = `
    <main id="demo-stage" class="demo-stage">
      <div class="demo-grid" aria-hidden="true"></div>
      <div class="demo-vignette" aria-hidden="true"></div>

      <header class="demo-header">
        <span class="demo-mark" aria-hidden="true">O</span>
        <span><strong>Owlbear Fireball</strong><small>独立交互演示</small></span>
      </header>

      <div class="demo-token demo-token--caster" id="demo-caster">
        <span>🧙</span><small>施法者</small>
      </div>
      <div class="demo-token demo-token--enemy demo-token--enemy-one"><span>👹</span><small>敌人</small></div>
      <div class="demo-token demo-token--enemy demo-token--enemy-two"><span>🧟</span><small>敌人</small></div>

      <section class="demo-welcome" id="demo-welcome">
        <span class="demo-welcome__eyebrow">D&amp;D 5E · EVOCATION</span>
        <h1>火球术</h1>
        <p>点击右上角按钮，移动半径 20 英尺的范围圈，再点击战场释放。</p>
        <div><span>20 ft 半径</span><span>多人同步</span><span>GPU 特效</span></div>
      </section>

      <div id="demo-ring" class="target-ring demo-target-ring" aria-hidden="true">
        <span class="target-ring__crosshair"></span>
        <span class="target-ring__label">20 英尺</span>
      </div>
      <div id="demo-projectile" class="demo-projectile" aria-hidden="true"></div>
      <div id="demo-explosion" class="demo-explosion" aria-hidden="true"><span></span></div>
      <div id="demo-cinematic-flash" class="demo-cinematic-flash" aria-hidden="true"></div>

      <aside class="demo-fx-badge" aria-label="Three.js 原型状态">
        <span class="demo-fx-badge__signal" aria-hidden="true"></span>
        <span><strong>THREE.JS VFX PROTOTYPE</strong><small id="demo-fx-metrics">正在初始化 GPU…</small></span>
      </aside>

      <div id="demo-tip" class="target-tip demo-tip" role="status">
        <strong>准备施法</strong><span>点击右上角的火球术按钮</span>
      </div>

      <button id="demo-fireball" class="fireball-button demo-fireball-button" type="button" aria-label="释放火球术">
        <span class="fireball-button__orb" aria-hidden="true"><span class="fireball-button__core"></span></span>
        <span class="fireball-button__copy"><strong>火球术</strong><small id="demo-button-hint">点击瞄准</small></span>
      </button>
    </main>
  `;

  const stage = requireElement<HTMLElement>("#demo-stage");
  const ring = requireElement<HTMLElement>("#demo-ring");
  const projectile = requireElement<HTMLElement>("#demo-projectile");
  const explosion = requireElement<HTMLElement>("#demo-explosion");
  const caster = requireElement<HTMLElement>("#demo-caster");
  const button = requireElement<HTMLButtonElement>("#demo-fireball");
  const buttonHint = requireElement<HTMLElement>("#demo-button-hint");
  const tip = requireElement<HTMLElement>("#demo-tip");
  const welcome = requireElement<HTMLElement>("#demo-welcome");
  const cinematicFlash = requireElement<HTMLElement>("#demo-cinematic-flash");
  const fxMetrics = requireElement<HTMLElement>("#demo-fx-metrics");

  let fx: ThreeFireballPrototype | null = null;
  try {
    fx = new ThreeFireballPrototype(stage);
    stage.dataset.vfx = "three-ready";
    fxMetrics.textContent = `${fx.particleCount.toLocaleString()} GPU 粒子 · BLOOM · 俯瞰体积云`;
  } catch (error) {
    console.error("Unable to initialize the Three.js prototype", error);
    stage.dataset.vfx = "css-fallback";
    fxMetrics.textContent = "WebGL 不可用 · CSS 后备效果";
  }

  let armed = false;
  let animating = false;
  let target = { x: innerWidth * 0.64, y: innerHeight * 0.48 };

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
    if (animating) return;
    welcome.classList.add("demo-welcome--hidden");
    setArmed(!armed);
    if (armed) moveRing(target.x, target.y);
  });

  stage.addEventListener("pointermove", (event) => {
    if (armed && !animating) moveRing(event.clientX, event.clientY);
  });

  stage.addEventListener("click", async (event) => {
    if (!armed || animating || button.contains(event.target as Node)) return;
    animating = true;
    setArmed(false);
    tip.innerHTML = "<strong>火球已释放</strong><span>正在飞向目标…</span>";

    const casterBounds = caster.getBoundingClientRect();
    const from = {
      x: casterBounds.left + casterBounds.width / 2,
      y: casterBounds.top + casterBounds.height / 2,
    };
    const to = { x: event.clientX, y: event.clientY };

    const showImpact = () => {
      stage.dataset.vfx = "three-explosion";
      tip.innerHTML = "<strong>命中！俯瞰 3D 爆炸</strong><span>圆形云冠、中心烟柱与电影级 Bloom 正在渲染</span>";
      cinematicFlash.classList.remove("demo-cinematic-flash--active");
      void cinematicFlash.offsetWidth;
      cinematicFlash.classList.add("demo-cinematic-flash--active");
      stage.animate(
        [
          { transform: "translate3d(0, 0, 0)" },
          { transform: "translate3d(-5px, 3px, 0)", offset: 0.16 },
          { transform: "translate3d(6px, -4px, 0)", offset: 0.32 },
          { transform: "translate3d(-3px, 3px, 0)", offset: 0.5 },
          { transform: "translate3d(2px, -1px, 0)", offset: 0.72 },
          { transform: "translate3d(0, 0, 0)" },
        ],
        { duration: 430, easing: "ease-out" },
      );
    };

    if (fx) {
      stage.dataset.vfx = "three-flight";
      await fx.play(from, to, showImpact);
      fxMetrics.textContent = `${fx.particleCount.toLocaleString()} GPU 粒子 · ${fx.lastAverageFps} FPS · BLOOM`;
    } else {
      await playCssFallback(projectile, explosion, from, to, showImpact);
    }

    cinematicFlash.classList.remove("demo-cinematic-flash--active");
    stage.dataset.vfx = fx ? "three-ready" : "css-fallback";
    animating = false;
    buttonHint.textContent = "再次释放";
    tip.innerHTML = "<strong>原型播放完成</strong><span>点击右上角可再次验证</span>";
  });
}

async function playCssFallback(
  projectile: HTMLElement,
  explosion: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
  onImpact: () => void,
): Promise<void> {
  projectile.classList.add("demo-projectile--visible");
  const flight = projectile.animate(
    [
      { transform: `translate3d(${from.x}px, ${from.y}px, 0) scale(.5)` },
      { transform: `translate3d(${to.x}px, ${to.y}px, 0) scale(.78)` },
    ],
    { duration: 720, easing: "cubic-bezier(.55,.02,.8,.42)", fill: "forwards" },
  );
  await flight.finished;
  projectile.classList.remove("demo-projectile--visible");
  explosion.style.left = `${to.x}px`;
  explosion.style.top = `${to.y}px`;
  explosion.classList.add("demo-explosion--active");
  onImpact();
  await new Promise((resolve) => window.setTimeout(resolve, 1150));
  explosion.classList.remove("demo-explosion--active");
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Demo markup is missing: ${selector}`);
  return element;
}

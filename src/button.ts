import OBR from "@owlbear-rodeo/sdk";
import { LOCAL_CHANNEL, RELEASE, isLocalMessage, isQuality, type LocalMessage } from "./protocol";
import "./styles.css";
import "./button.css";

const button = document.querySelector<HTMLButtonElement>("#fireball-button")!;
const hint = document.querySelector<HTMLElement>("#button-hint")!;
const quality = document.querySelector<HTMLSelectElement>("#quality")!;
const reset = document.querySelector<HTMLButtonElement>("#reset")!;
const residueSelect = document.querySelector<HTMLButtonElement>("#residue-select")!;
const residueClear = document.querySelector<HTMLButtonElement>("#residue-clear")!;
const residueName = document.querySelector<HTMLElement>("#residue-name")!;
button.disabled = true;
hint.textContent = "正在连接…";
reset.title = `恢复当前客户端 · v${RELEASE}`;

OBR.onReady(() => { void connect().catch((error: unknown) => {
  console.error(error);
  hint.textContent = "连接失败 · 请重新启用扩展";
}); });

async function connect(): Promise<void> {
  const connection = await OBR.player.getConnectionId();
  let received = false;
  const send = (message: LocalMessage) => OBR.broadcast.sendMessage(LOCAL_CHANNEL, message, { destination: "LOCAL" });
  const showError = (error: unknown) => { console.warn(error); button.disabled = false; hint.textContent = "连接中断 · 点恢复"; };
  const unsubscribe = OBR.broadcast.onMessage(LOCAL_CHANNEL, (event) => {
    if (event.connectionId !== connection || !isLocalMessage(event.data) || event.data.kind !== "status") return;
    received = true;
    const status = event.data.status;
    const canConfigureResidue = status.residueCanConfigure === true;
    button.disabled = !!status.residueBusy || ["loading", "preparing", "flying", "smoke"].includes(status.phase);
    const residueDisabled = !!status.residueBusy || ["loading", "aiming", "preparing", "flying", "smoke"].includes(status.phase);
    residueSelect.disabled = residueDisabled || !canConfigureResidue;
    residueClear.disabled = residueDisabled || !canConfigureResidue || !status.residueName;
    residueSelect.textContent = status.residueBusy ? "正在发布…" : canConfigureResidue ? "GM 设置残留" : "由 GM 设置";
    residueName.textContent = status.residueName ? `房间残留：${status.residueName}` : canConfigureResidue ? "未设置 · 无残留" : "GM 未设置 · 无残留";
    residueName.title = status.residueName
      ? `${status.residueName} · 全房间共用 · 动画结束生成 · 手动删除`
      : canConfigureResidue ? "选择一次 Props 素材并发布给全房间" : "等待 GM 设置全房间残留素材";
    button.setAttribute("aria-pressed", String(status.phase === "aiming"));
    hint.textContent = status.hint;
    hint.title = status.hint;
    quality.value = status.quality;
    quality.disabled = status.phase === "flying" || status.phase === "smoke";
  });
  button.addEventListener("click", () => {
    button.disabled = true;
    void send({ kind: "button-command", action: "toggle" }).catch(showError);
  });
  reset.addEventListener("click", () => { void send({ kind: "button-command", action: "reset" }).catch(showError); });
  for (const [control, action] of [[residueSelect, "select"], [residueClear, "clear"]] as const) {
    control.addEventListener("click", () => {
      residueSelect.disabled = true;
      residueClear.disabled = true;
      void send({ kind: "residue-command", action }).catch(showError);
    });
  }
  quality.addEventListener("change", () => { if (isQuality(quality.value)) void send({ kind: "quality", quality: quality.value }).catch(showError); });
  await send({ kind: "button-ready" });
  const retry = setInterval(() => {
    if (received) { clearInterval(retry); return; }
    hint.textContent = "等待后台 · 可点恢复";
    void send({ kind: "button-ready" }).catch(showError);
  }, 2500);
  window.addEventListener("pagehide", () => { clearInterval(retry); unsubscribe(); }, { once: true });
}

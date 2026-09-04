import OBR from "@owlbear-rodeo/sdk";
import { TARGET_MODAL_ID } from "./constants";
import "./styles.css";

const button = document.querySelector<HTMLButtonElement>("#fireball-button");
const hint = document.querySelector<HTMLElement>("#button-hint");

if (!button || !hint) throw new Error("Fireball button markup is missing");

button.disabled = true;
hint.textContent = "正在连接…";

OBR.onReady(async () => {
  const updateAvailability = (ready: boolean) => {
    button.disabled = !ready;
    hint.textContent = ready ? "点击瞄准" : "请先打开场景";
  };

  updateAvailability(await OBR.scene.isReady());
  OBR.scene.onReadyChange(updateAvailability);

  button.addEventListener("click", async () => {
    if (!(await OBR.scene.isReady())) return;

    button.disabled = true;
    hint.textContent = "进入瞄准…";
    try {
      await OBR.modal.open({
        id: TARGET_MODAL_ID,
        url: `${import.meta.env.BASE_URL}target.html`,
        fullScreen: true,
        hideBackdrop: true,
        hidePaper: true,
      });
    } finally {
      button.disabled = false;
      hint.textContent = "点击瞄准";
    }
  });
});

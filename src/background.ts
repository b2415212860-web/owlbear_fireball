import OBR from "@owlbear-rodeo/sdk";
import { RELEASE, errorText } from "./protocol";

if (!OBR.isAvailable) {
  document.body.style.cssText = "margin:32px;background:#171419;color:#f7e6d0;font:16px/1.8 system-ui";
  document.body.textContent = "火球术 · Owlbear 扩展。请在 Owlbear 房间中启用本扩展，再选中法师棋子，点击右上角的火球术按钮。安装入口：";
  const manifest = document.createElement("a");
  manifest.href = `${import.meta.env.BASE_URL}manifest.json`;
  manifest.style.color = "#ffb45f";
  manifest.textContent = new URL(manifest.href, location.href).href;
  document.body.append(manifest);
} else {
  let started = false;
  OBR.onReady(() => {
    if (started) return;
    started = true;
    let step = "加载控制器";
    void import("./controller").then(({ startController }) => {
      step = "启动控制器";
      return startController();
    }).catch((error: unknown) => {
      console.error(`Fireball initialization ${RELEASE} [${step}]`, error);
      const detail = errorText(error).slice(0, 260);
      void OBR.notification.show(`火球术 ${RELEASE} 初始化失败（${step}）：${detail}`, "ERROR").catch(console.warn);
    });
  });
}

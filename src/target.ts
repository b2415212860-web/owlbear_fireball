import OBR, { type Vector2 } from "@owlbear-rodeo/sdk";
import { FIREBALL_RADIUS_FEET, FX_CHANNEL, TARGET_MODAL_ID } from "./constants";
import { worldRadiusForFeet } from "./geometry";
import type { FireballCastMessage } from "./types";
import "./styles.css";

const ring = requireElement<HTMLElement>("#target-ring");
const tip = requireElement<HTMLElement>("#target-tip");
const cancelButton = requireElement<HTMLButtonElement>("#cancel-button");

let pointerScreen: Vector2 = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
let worldRadius = 0;
let gridDpi = 150;
let casting = false;

OBR.onReady(async () => {
  if (!(await OBR.scene.isReady())) {
    await closeTargeting();
    return;
  }

  const [dpi, scale, viewportScale] = await Promise.all([
    OBR.scene.grid.getDpi(),
    OBR.scene.grid.getScale(),
    OBR.viewport.getScale(),
  ]);

  gridDpi = dpi;
  worldRadius = worldRadiusForFeet(
    FIREBALL_RADIUS_FEET,
    dpi,
    scale.parsed.multiplier,
    scale.parsed.unit,
  );
  setRingDiameter(worldRadius * viewportScale * 2);
  moveRing(pointerScreen);

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("click", onWindowClick);
  window.addEventListener("keydown", onKeyDown);
  cancelButton.addEventListener("click", onCancelClick);
});

function onPointerMove(event: PointerEvent): void {
  pointerScreen = { x: event.clientX, y: event.clientY };
  moveRing(pointerScreen);
}

async function onWindowClick(event: MouseEvent): Promise<void> {
  if (casting || cancelButton.contains(event.target as Node)) return;
  casting = true;

  ring.classList.add("target-ring--casting");
  tip.innerHTML = "<strong>火球已释放</strong><span>命中后将产生 20 英尺爆炸</span>";

  try {
    const target = await OBR.viewport.inverseTransformPoint({
      x: event.clientX,
      y: event.clientY,
    });
    const from = await getCastOrigin();
    const message: FireballCastMessage = {
      kind: "fireball-cast",
      castId: crypto.randomUUID(),
      from,
      to: target,
      radius: worldRadius,
      projectileSize: Math.max(gridDpi * 0.22, worldRadius * 0.08),
    };

    await OBR.broadcast.sendMessage(FX_CHANNEL, message, { destination: "ALL" });
    await closeTargeting();
  } catch (error) {
    casting = false;
    ring.classList.remove("target-ring--casting");
    tip.innerHTML = "<strong>施法失败，请重试</strong><span>移动鼠标后再次点击地图</span>";
    console.error("Unable to cast fireball", error);
  }
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") void closeTargeting();
}

function onCancelClick(event: MouseEvent): void {
  event.stopPropagation();
  void closeTargeting();
}

async function getCastOrigin(): Promise<Vector2> {
  const selection = await OBR.player.getSelection();
  if (selection && selection.length > 0) {
    const bounds = await OBR.scene.items.getItemBounds(selection);
    return bounds.center;
  }

  const [width, height] = await Promise.all([
    OBR.viewport.getWidth(),
    OBR.viewport.getHeight(),
  ]);
  return OBR.viewport.inverseTransformPoint({ x: width / 2, y: height / 2 });
}

function setRingDiameter(diameter: number): void {
  const clampedDiameter = Math.max(24, diameter);
  ring.style.width = `${clampedDiameter}px`;
  ring.style.height = `${clampedDiameter}px`;
}

function moveRing(position: Vector2): void {
  ring.style.transform = `translate3d(${position.x}px, ${position.y}px, 0) translate(-50%, -50%)`;
}

async function closeTargeting(): Promise<void> {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("click", onWindowClick);
  window.removeEventListener("keydown", onKeyDown);
  await OBR.modal.close(TARGET_MODAL_ID);
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Targeting markup is missing: ${selector}`);
  return element;
}

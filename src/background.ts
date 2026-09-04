import OBR from "@owlbear-rodeo/sdk";
import {
  BUTTON_HEIGHT,
  BUTTON_MARGIN,
  BUTTON_POPOVER_ID,
  BUTTON_WIDTH,
  FX_CHANNEL,
} from "./constants";
import { playFireball } from "./effects";
import { isFireballCastMessage } from "./types";

let lastViewportWidth = 0;
let buttonVisible = false;
let repositioning = false;

if (!OBR.isAvailable) {
  void import("./demo").then(({ mountDemo }) => mountDemo());
} else {
  OBR.onReady(async () => {
  OBR.broadcast.onMessage(FX_CHANNEL, (event) => {
    if (isFireballCastMessage(event.data)) {
      void playFireball(event.data).catch((error) => {
        console.error("Unable to play fireball effect", error);
      });
    }
  });

  OBR.scene.onReadyChange((ready) => {
    void syncFloatingButton(ready);
  });

  await syncFloatingButton(await OBR.scene.isReady());
  window.setInterval(() => void keepButtonAnchored(), 800);
  });
}

async function syncFloatingButton(sceneReady: boolean): Promise<void> {
  if (sceneReady) {
    await openFloatingButton();
    return;
  }

  if (buttonVisible) {
    await OBR.popover.close(BUTTON_POPOVER_ID);
    buttonVisible = false;
    lastViewportWidth = 0;
  }
}

async function openFloatingButton(): Promise<void> {
  const viewportWidth = await OBR.viewport.getWidth();
  await OBR.popover.open({
    id: BUTTON_POPOVER_ID,
    url: `${import.meta.env.BASE_URL}button.html`,
    width: BUTTON_WIDTH,
    height: BUTTON_HEIGHT,
    anchorReference: "POSITION",
    anchorPosition: {
      left: viewportWidth - BUTTON_MARGIN,
      top: BUTTON_MARGIN,
    },
    anchorOrigin: {
      horizontal: "RIGHT",
      vertical: "TOP",
    },
    transformOrigin: {
      horizontal: "RIGHT",
      vertical: "TOP",
    },
    hidePaper: true,
    disableClickAway: true,
    marginThreshold: 0,
  });

  buttonVisible = true;
  lastViewportWidth = viewportWidth;
}

async function keepButtonAnchored(): Promise<void> {
  if (!buttonVisible || repositioning || !(await OBR.scene.isReady())) return;

  const viewportWidth = await OBR.viewport.getWidth();
  if (Math.abs(viewportWidth - lastViewportWidth) < 2) return;

  repositioning = true;
  try {
    await OBR.popover.close(BUTTON_POPOVER_ID);
    buttonVisible = false;
    await openFloatingButton();
  } finally {
    repositioning = false;
  }
}

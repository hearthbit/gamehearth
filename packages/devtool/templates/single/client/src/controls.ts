import type { Texts } from "./texts";
import { directionOfKey, padDirection, pressKey, releaseKey, topKey, type Direction } from "./view";

const buttons: Exclude<Direction, "none">[] = ["up", "left", "right", "down"];

export interface Controls {
  readonly direction: Direction;
  reset(): void;
}

export function mountControls(pad: HTMLElement, t: Texts): Controls {
  pad.setAttribute("aria-label", t.pad);
  let fromPad: Direction = "none";
  let finger: number | undefined;
  let keys: Direction[] = [];
  const show = () => {
    const current = finger !== undefined ? fromPad : topKey(keys);
    for (const button of pad.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset["dir"] === current));
    }
  };

  for (const dir of buttons) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = t[dir];
    button.dataset["dir"] = dir;
    button.style.gridArea = dir;
    button.setAttribute("aria-pressed", "false");
    pad.append(button);
  }

  const aim = (event: PointerEvent): Direction => {
    const box = pad.getBoundingClientRect();
    return padDirection(event.clientX - (box.left + box.width / 2), event.clientY - (box.top + box.height / 2), Math.min(box.width, box.height) * 0.1);
  };
  pad.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    finger = event.pointerId;
    pad.setPointerCapture(event.pointerId);
    fromPad = aim(event);
    show();
  });
  pad.addEventListener("pointermove", (event) => {
    if (event.pointerId === finger) {
      fromPad = aim(event);
      show();
    }
  });
  const release = (event: PointerEvent) => {
    if (event.pointerId === finger) {
      finger = undefined;
      fromPad = "none";
      show();
    }
  };
  pad.addEventListener("pointerup", release);
  pad.addEventListener("pointercancel", release);
  pad.addEventListener("lostpointercapture", release);

  addEventListener("keydown", (event) => {
    const dir = directionOfKey(event.key);
    if (dir !== undefined) {
      event.preventDefault();
      keys = pressKey(keys, dir);
      show();
    }
  });
  addEventListener("keyup", (event) => {
    const dir = directionOfKey(event.key);
    if (dir !== undefined) {
      keys = releaseKey(keys, dir);
      show();
    }
  });
  const letGo = () => {
    keys = [];
    finger = undefined;
    fromPad = "none";
    show();
  };
  addEventListener("blur", letGo);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      letGo();
    }
  });

  return {
    get direction() {
      return finger !== undefined ? fromPad : topKey(keys);
    },
    reset: letGo,
  };
}

import type { GameConnection } from "@gamehearth/sdk/client";
import type { Direction, TagAction, TagState } from "../../src/index";
import type { Texts } from "./texts";
import { controllerLine, controllerSound, cssColor, keyDirections, nameOf, needsResend, padDirection, pressKey, releaseKey, seatColor, steer, topKey, type Snapshot } from "./view";

const pad: { dir: Exclude<Direction, "none">; area: string }[] = [
  { dir: "up", area: "up" },
  { dir: "left", area: "left" },
  { dir: "right", area: "right" },
  { dir: "down", area: "down" },
];

export function mountController(root: HTMLElement, game: GameConnection<TagState, TagAction>, t: Texts): void {
  const color = cssColor(seatColor(game.seat));
  const title = document.createElement("h1");
  const status = document.createElement("p");
  status.className = "status";
  status.setAttribute("aria-live", "polite");
  const grid = document.createElement("div");
  grid.className = "pad";
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", t.pad);
  root.append(title, status, grid);
  document.body.style.setProperty("--seat", color);

  let held: Direction = "none";
  let finger: number | undefined;
  let keys: Direction[] = [];
  let pending = 0;
  const transmit = (dir: Direction) => {
    pending += 1;
    const done = () => {
      pending -= 1;
    };
    game.move(steer(dir)).then(done, done);
  };
  const send = (dir: Direction) => {
    if (dir === held) {
      return;
    }
    held = dir;
    for (const button of grid.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset["dir"] === dir));
    }
    transmit(dir);
  };

  for (const entry of pad) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = t[entry.dir];
    button.dataset["dir"] = entry.dir;
    button.style.gridArea = entry.area;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        send(entry.dir);
      }
    });
    button.addEventListener("keyup", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        send("none");
      }
    });
    grid.append(button);
  }

  const aim = (event: PointerEvent): Direction => {
    const box = grid.getBoundingClientRect();
    return padDirection(event.clientX - (box.left + box.width / 2), event.clientY - (box.top + box.height / 2), Math.min(box.width, box.height) * 0.1);
  };
  grid.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    finger = event.pointerId;
    grid.setPointerCapture(event.pointerId);
    send(aim(event));
  });
  grid.addEventListener("pointermove", (event) => {
    if (event.pointerId === finger) {
      send(aim(event));
    }
  });
  const release = (event: PointerEvent) => {
    if (event.pointerId === finger) {
      finger = undefined;
      send("none");
    }
  };
  grid.addEventListener("pointerup", release);
  grid.addEventListener("pointercancel", release);
  grid.addEventListener("lostpointercapture", release);

  addEventListener("keydown", (event) => {
    const dir = keyDirections[event.key];
    if (dir !== undefined) {
      event.preventDefault();
      if (!event.repeat) {
        keys = pressKey(keys, dir);
        send(dir);
      }
    }
  });
  addEventListener("keyup", (event) => {
    const dir = keyDirections[event.key];
    if (dir === undefined) {
      return;
    }
    const before = topKey(keys);
    keys = releaseKey(keys, dir);
    if (before === held) {
      send(topKey(keys));
    }
  });
  const letGo = () => {
    keys = [];
    send("none");
  };
  addEventListener("blur", letGo);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      letGo();
    }
  });

  let previous: Snapshot | undefined;
  game.onUpdate(({ snapshot, players }) => {
    const current = snapshot as Snapshot;
    const sound = controllerSound(previous, current);
    if (sound !== undefined) {
      game.sound(sound);
    }
    previous = current;
    title.textContent = nameOf(game.seat, players);
    status.textContent = controllerLine(t, current, players);
    document.body.classList.toggle("catcher", current.public.catcher === game.seat);
    if (needsResend(current, held, pending)) {
      transmit(held);
    }
  });
}

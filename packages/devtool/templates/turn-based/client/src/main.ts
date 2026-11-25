import Phaser from "phaser";
import { connect } from "@gamehearth/sdk/client";
import type { DuelAction, DuelState, Ids, Options } from "../../src/index";
import { mountAccessibleControls } from "./access";
import { DuelScene } from "./scene";
import { texts } from "./texts";
import { soundFor, type Snapshot } from "./view";

async function start(): Promise<void> {
  const parent = document.getElementById("game");
  if (parent === null) {
    return;
  }
  let connection;
  try {
    connection = await connect<DuelState, DuelAction, Options, Ids>();
  } catch (error) {
    const fallback = document.getElementById("fallback");
    if (fallback !== null) {
      fallback.textContent = `${texts(navigator.language).fallback} ${error instanceof Error ? error.message : ""}`;
      fallback.hidden = false;
    }
    return;
  }
  const t = texts(connection.language);
  document.documentElement.lang = connection.language;
  document.title = t.name;
  let previous: Snapshot | undefined;
  connection.onUpdate((update) => {
    const sound = soundFor(previous, update.snapshot as Snapshot);
    if (sound !== undefined) {
      connection.sound(sound);
    }
    previous = update.snapshot as Snapshot;
  });
  const access = document.getElementById("access");
  if (access !== null) {
    access.setAttribute("aria-label", t.name);
    mountAccessibleControls(access, connection, t);
  }
  const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
  const size = () => ({ width: Math.max(parent.clientWidth, 1) * dpr, height: Math.max(parent.clientHeight, 1) * dpr });
  const initial = size();
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: initial.width,
    height: initial.height,
    scale: { mode: Phaser.Scale.NONE, zoom: 1 / dpr },
    banner: false,
    autoFocus: false,
    audio: { noAudio: true },
    scene: new DuelScene(connection, dpr, t),
  });
  new ResizeObserver(() => {
    const next = size();
    game.scale.resize(next.width, next.height);
    game.scale.setZoom(1 / dpr);
  }).observe(parent);
}

void start();

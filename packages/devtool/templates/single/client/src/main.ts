import Phaser from "phaser";
import { connectSolo } from "@gamehearth/sdk/client";
import { finishLevel, readSave, startRun, withLevelTime, type Save } from "../../src/rules";
import { mountControls } from "./controls";
import { fieldHeight, fieldWidth, LevelScene } from "./scene";
import { texts } from "./texts";
import { finishLine, finishSound, menuEntries, recordLine, sceneMusic, sharpness, type MenuEntry } from "./view";

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`#${id} is missing in index.html`);
  }
  return node;
}

async function start(): Promise<void> {
  try {
    const game = await connectSolo<Save, "best-time">();
    const t = texts(game.language);
    document.documentElement.lang = game.language;
    document.title = t.name;
    byId("title").textContent = t.name;
    let save = readSave(game.saved);
    const controls = mountControls(byId("pad"), t);
    const zoom = sharpness(window.devicePixelRatio);
    const scene = new LevelScene(controls, zoom, t, (sound) => game.sound(sound));
    const phaser = new Phaser.Game({
      type: Phaser.AUTO,
      parent: byId("field"),
      width: fieldWidth * zoom,
      height: fieldHeight * zoom,
      backgroundColor: "#1f3326",
      physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      banner: false,
      autoFocus: false,
      audio: { noAudio: true },
      scene,
    });
    const menu = byId("menu");
    const entries = byId("entries");

    const showMenu = (message: string) => {
      game.music(sceneMusic("menu"));
      byId("record").textContent = recordLine(t, game.best["best-time"]);
      byId("message").textContent = message;
      entries.replaceChildren(
        ...menuEntries(t, save).map((entry) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = entry.label;
          button.disabled = !entry.enabled;
          button.addEventListener("click", () => void play(entry));
          return button;
        }),
      );
      menu.hidden = false;
      entries.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    };

    let saved = JSON.stringify(save);
    let playing = false;
    let earlierMs = 0;

    const store = async (next: Save) => {
      save = next;
      const text = JSON.stringify(next);
      if (text === saved) {
        return;
      }
      try {
        await game.save(next);
        saved = text;
      } catch (error) {
        console.error(error);
      }
    };

    const keepLevelTime = () => {
      if (playing) {
        void store(withLevelTime(save, earlierMs + scene.attemptMs));
      }
    };
    setInterval(keepLevelTime, 2000);
    document.addEventListener("visibilitychange", () => document.hidden && keepLevelTime());

    const done = async (levelMs: number) => {
      playing = false;
      const outcome = finishLevel(save, levelMs);
      game.sound(finishSound(outcome.finished));
      if (outcome.finished?.ranked === true) {
        try {
          await game.record("best-time", outcome.finished.totalMs);
        } catch (error) {
          console.error(error);
        }
      }
      await store(outcome.save);
      showMenu(outcome.finished === undefined ? t.levelDone : finishLine(t, outcome.finished.totalMs, outcome.finished.ranked, game.best["best-time"]));
    };

    const play = async (entry: MenuEntry) => {
      if (entry.id !== "continue") {
        await store(startRun(save, entry.level));
      }
      menu.hidden = true;
      game.sound("start");
      game.music(sceneMusic("level"));
      controls.reset();
      const run = save.run;
      if (run !== null) {
        earlierMs = run.levelMs;
        playing = true;
        phaser.scene.start("level", { level: run.level, elapsedMs: run.elapsedMs + run.levelMs, onDone: (attemptMs: number) => void done(earlierMs + attemptMs) });
      }
    };

    showMenu(game.saved === undefined ? "" : t.welcomeBack);
  } catch (error) {
    const fallback = byId("fallback");
    fallback.textContent = `${texts(navigator.language).fallback} ${error instanceof Error ? error.message : ""}`;
    fallback.hidden = false;
  }
}

void start();

import { musicSeconds, trackProblem } from "@gamehearth/sdk/platform";
import { describe, expect, it } from "vitest";
import manifest from "../manifest.json";
import { texts } from "../client/src/texts";
import {
  cell,
  directionOfKey,
  finishLine,
  finishSound,
  formatTime,
  frameMs,
  hudLine,
  levelMusic,
  menuEntries,
  padDirection,
  pressKey,
  recordLine,
  releaseKey,
  sceneMusic,
  sharpness,
  speed,
  steerTowardLane,
  topKey,
  velocity,
} from "../client/src/view";

const en = texts("en");
const de = texts("de");

describe("Display", () => {
  it("shows times as minutes, seconds and tenths", () => {
    expect(formatTime(en, 0)).toBe("0:00.0");
    expect(formatTime(en, 83_456)).toBe("1:23.5");
    expect(formatTime(en, -5)).toBe("0:00.0");
  });

  it("offers continue, new and unlocked levels in the menu", () => {
    expect(menuEntries(en, { format: 1, unlocked: 1, run: null }).map((entry) => [entry.label, entry.enabled])).toEqual([
      ["Start game", true],
      ["Level 2 (still locked)", false],
      ["Level 3 (still locked)", false],
    ]);
    const entries = menuEntries(en, { format: 1, unlocked: 2, run: { start: 0, level: 1, elapsedMs: 41_200, levelMs: 5000 } });
    expect(entries[0]).toEqual({ id: "continue", label: "Continue: Level 2 (so far 0:46.2)", enabled: true, level: 1 });
    expect(entries.map((entry) => entry.label)).toContain("Practice Level 2");
  });

  it("words the record, the finish and the header line", () => {
    expect(recordLine(en, undefined)).toContain("No best time yet");
    expect(recordLine(en, 75_400)).toBe("Best time: 1:15.4");
    expect(finishLine(en, 75_400, true, 75_400)).toBe("New best time: 1:15.4!");
    expect(finishLine(en, 80_000, true, 75_400)).toBe("Done in 1:20.0.");
    expect(finishLine(en, 20_000, false, 75_400)).toContain("start at Level 1");
    expect(hudLine(en, 0, 12_300, 2, 5)).toBe("Level 1/3   0:12.3   Mushrooms 2/5");
  });

  it("speaks German when the platform passes de, with a decimal comma in times", () => {
    expect(formatTime(de, 83_456)).toBe("1:23,5");
    expect(menuEntries(de, { format: 1, unlocked: 2, run: null }).map((entry) => entry.label)).toEqual(["Spiel starten", "Level 2 üben", "Level 3 (noch gesperrt)"]);
    expect(recordLine(de, 75_400)).toBe("Bestzeit: 1:15,4");
    expect(finishLine(de, 75_400, true, 75_400)).toBe("Neue Bestzeit: 1:15,4!");
    expect(hudLine(de, 0, 12_300, 2, 5)).toBe("Level 1/3   0:12,3   Pilze 2/5");
    expect([de.pad, de.down]).toEqual(["Steuerkreuz", "Runter"]);
    expect(texts("de-AT")).toBe(texts("de"));
  });
});

describe("Sound", () => {
  it("plays a coin for a level done and a fanfare for the whole run", () => {
    expect(finishSound(undefined)).toBe("coin");
    expect(finishSound({ totalMs: 61_000, ranked: true })).toBe("win");
    expect(finishSound({ totalMs: 20_000, ranked: false })).toBe("win");
  });
});

describe("Music", () => {
  it("plays a valid music-box loop in a level and nothing in the menu", () => {
    expect(trackProblem(levelMusic)).toBeUndefined();
    expect(musicSeconds(levelMusic)).toBeCloseTo(4.8);
    expect(sceneMusic("level")).toBe(levelMusic);
    expect(sceneMusic("menu")).toBeNull();
  });
});

describe("Controls", () => {
  it("moves in exactly one direction", () => {
    expect(velocity("up")).toEqual({ x: 0, y: -speed });
    expect(velocity("none")).toEqual({ x: 0, y: 0 });
  });

  it("pulls the figure to the middle of the lane so it fits around corners", () => {
    expect(steerTowardLane(cell * 1.5, 0)).toBe(0);
    expect(steerTowardLane(cell * 1.5 - 6, 0)).toBeGreaterThan(0);
    expect(steerTowardLane(cell * 1.5 + 6, 0)).toBeLessThan(0);
    expect(Math.abs(steerTowardLane(cell * 1.01, 0))).toBeLessThanOrEqual(speed);
  });

  it("reads the d-pad from the position of the finger relative to the center", () => {
    expect(padDirection(2, 1, 10)).toBe("none");
    expect(padDirection(-40, 10, 10)).toBe("left");
    expect(padDirection(5, 40, 10)).toBe("down");
  });

  it("keeps held keys as a stack", () => {
    let keys = pressKey([], "left");
    keys = pressKey(keys, "up");
    expect(topKey(keys)).toBe("up");
    keys = releaseKey(keys, "up");
    expect(topKey(keys)).toBe("left");
    expect(topKey(releaseKey(keys, "left"))).toBe("none");
  });

  it("draws at the resolution of the device, at most three times", () => {
    expect(sharpness(undefined)).toBe(1);
    expect(sharpness(1.5)).toBe(2);
    expect(sharpness(2.625)).toBe(3);
    expect(sharpness(4)).toBe(3);
    expect(sharpness(0.5)).toBe(1);
  });

  it("review 9b: reads W, A, S, D also with Shift or Caps Lock", () => {
    expect(directionOfKey("a")).toBe("left");
    expect(directionOfKey("A")).toBe("left");
    expect(directionOfKey("ArrowUp")).toBe("up");
    expect(directionOfKey("constructor")).toBeUndefined();
    expect(directionOfKey("x")).toBeUndefined();
  });

  it("counts at most 250 ms per frame, never more than Phaser itself catches up", () => {
    expect(frameMs(16)).toBe(16);
    expect(frameMs(200)).toBe(200);
    expect(frameMs(5000)).toBe(250);
    expect(frameMs(-3)).toBe(0);
  });
});

describe("Languages", () => {
  it("has a block of texts for every language of the manifest, the default language first", () => {
    const languages = manifest.languages;
    for (const language of languages) {
      expect(texts(language)).toBeDefined();
    }
    expect(texts("xx")).toBe(texts(languages[0]));
    expect(new Set(languages.map((language) => texts(language))).size).toBe(languages.length);
  });
});

import { describe, expect, it } from "vitest";
import manifest from "../manifest.json";
import { texts } from "../client/src/texts";
import { blendPositions, clock, controllerLine, controllerSound, fitField, needsResend, padDirection, pressKey, ranking, releaseKey, resultLine, screenSound, seatColor, steer, topKey, type Screen, type Snapshot } from "../client/src/view";
import type { Public } from "../src/index";

const en = texts("en");
const de = texts("de");

const players = { p1: { name: "Anna", connected: true, you: true }, p2: { name: "Ben", connected: true, you: false } };

function view(changes: Partial<Public> = {}): Public {
  return {
    pos: { p1: { x: 10, y: 10 }, p2: { x: 100, y: 50 } },
    dir: { p1: "none", p2: "none" },
    catcher: "p2",
    frozen: 0,
    tagBack: null,
    tagBackLeft: 0,
    caught: { p1: 40, p2: 30 },
    ticksLeft: 1200,
    ...changes,
  };
}

function snapshot(changes: Partial<Snapshot> = {}): Snapshot {
  return { player: "p1", players: ["p1", "p2"], public: view(), me: {}, moves: [], version: 1, tick: 1, ...changes };
}

describe("UI of Tag", () => {
  it("blends positions between two updates, but jumps on large jumps", () => {
    const from = view({ pos: { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 } } });
    const to = view({ pos: { p1: { x: 4, y: 0 }, p2: { x: 200, y: 0 } } });
    expect(blendPositions(from, to, 0.5)).toEqual({ p1: { x: 2, y: 0 }, p2: { x: 200, y: 0 } });
  });

  it("fits the field with a margin into any area and centers it", () => {
    expect(fitField(400, 240, 840, 280, 20)).toEqual({ scale: 1, left: 220, top: 20 });
    expect(fitField(400, 240, 440, 1000, 20).scale).toBe(1);
  });

  it("shows the remaining time as minutes and seconds", () => {
    expect(clock(1200)).toBe("1:00");
    expect(clock(1199)).toBe("1:00");
    expect(clock(19)).toBe("0:01");
    expect(clock(0)).toBe("0:00");
  });

  it("sorts by the shortest time as catcher", () => {
    expect(ranking(en, view(), players)).toEqual([
      { seat: "p2", name: "Ben", time: "1.5 s" },
      { seat: "p1", name: "Anna", time: "2.0 s" },
    ]);
  });

  it("tells every phone what to do and names the winners at the end", () => {
    expect(controllerLine(en, snapshot(), players)).toBe("Run away from Ben!");
    expect(controllerLine(en, snapshot({ public: view({ catcher: "p1", frozen: 3 }) }), players)).toBe("You are the catcher! Starting in a moment …");
    expect(controllerLine(en, snapshot({ result: { winners: ["p1", "p2"] } }), players)).toBe("Tie: Anna, Ben");
    expect(resultLine(en, ["p2"], players)).toBe("Ben wins");
  });

  it("speaks German when the platform passes de, with a decimal comma", () => {
    expect(controllerLine(de, snapshot(), players)).toBe("Lauf weg vor Ben!");
    expect(controllerLine(de, snapshot({ public: view({ catcher: "p1", frozen: 0 }) }), players)).toBe("Du fängst! Fang jemanden.");
    expect(resultLine(de, ["p1", "p2"], players)).toBe("Unentschieden: Anna, Ben");
    expect(ranking(de, view(), players).map((entry) => entry.time)).toEqual(["1,5 s", "2,0 s"]);
    expect([de.pad, de.up, de.down]).toEqual(["Steuerkreuz", "Hoch", "Runter"]);
    expect(texts("de-AT")).toBe(texts("de"));
  });

  it("takes the direction from the position of the finger relative to the center of the d-pad, so the thumb can slide", () => {
    expect(padDirection(0, -50, 10)).toBe("up");
    expect(padDirection(0, 50, 10)).toBe("down");
    expect(padDirection(-50, 10, 10)).toBe("left");
    expect(padDirection(50, -10, 10)).toBe("right");
    expect(padDirection(3, 4, 10)).toBe("none");
  });

  it("returns to the key still held when a key is released", () => {
    let keys = pressKey([], "left");
    keys = pressKey(keys, "up");
    expect(topKey(keys)).toBe("up");
    keys = releaseKey(keys, "up");
    expect(topKey(keys)).toBe("left");
    keys = pressKey(keys, "left");
    expect(keys).toEqual(["left"]);
    expect(topKey(releaseKey(keys, "left"))).toBe("none");
  });

  it("sends the held direction again if it got lost on the server and nothing is in flight", () => {
    const moves = ["up", "down", "left", "right", "none"].map((dir) => steer(dir as "up"));
    const lost = snapshot({ moves, public: view({ dir: { p1: "none", p2: "none" } }) });
    expect(needsResend(lost, "right", 0)).toBe(true);
    expect(needsResend(lost, "right", 1)).toBe(false);
    expect(needsResend(snapshot({ moves, public: view({ dir: { p1: "right", p2: "none" } }) }), "right", 0)).toBe(false);
    expect(needsResend({ ...lost, result: { winners: ["p1"] } }, "right", 0)).toBe(false);
    expect(needsResend({ ...lost, moves: [] }, "right", 0)).toBe(false);
  });

  it("plays the shared sounds on the TV: start, a tag, the last seconds and the end", () => {
    const screen = (tick: number, changes: Partial<Public> = {}, result?: { winners: string[] }): Screen => ({
      players: ["p1", "p2"],
      public: view(changes),
      version: tick,
      tick,
      ...(result === undefined ? {} : { result }),
    });
    expect(screenSound(undefined, screen(0))).toBeUndefined();
    expect(screenSound(screen(0), screen(1))).toBe("start");
    expect(screenSound(screen(5), screen(6))).toBeUndefined();
    expect(screenSound(screen(5), screen(6, { catcher: "p1" }))).toBe("hit");
    expect(screenSound(screen(5, { ticksLeft: 81 }), screen(6, { ticksLeft: 80 }))).toBe("tick");
    expect(screenSound(screen(5, { ticksLeft: 121 }), screen(6, { ticksLeft: 120 }))).toBeUndefined();
    expect(screenSound(screen(5, { ticksLeft: 1 }), screen(6, { ticksLeft: 0 }, { winners: ["p2"] }))).toBe("win");
  });

  it("plays the personal sounds on the phone: you are it, and you got rid of it", () => {
    const caught = snapshot({ public: view({ catcher: "p1" }) });
    expect(controllerSound(undefined, caught)).toBeUndefined();
    expect(controllerSound(snapshot(), caught)).toBe("error");
    expect(controllerSound(caught, snapshot())).toBe("coin");
    expect(controllerSound(snapshot(), snapshot({ public: view({ catcher: "p2", ticksLeft: 10 }) }))).toBeUndefined();
    expect(controllerSound(caught, { ...snapshot(), result: { winners: ["p2"] } })).toBeUndefined();
  });

  it("gives every seat its own color", () => {
    expect(new Set(["p1", "p2", "p3", "p4", "p5", "p6"].map(seatColor)).size).toBe(6);
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

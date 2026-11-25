import { describe, expect, it } from "vitest";
import { parseGameMessage, parsePlatformMessage, readSound, soundNames, soundNotes, soundProblem } from "../src/platform";

describe("Sounds", () => {
  it("has valid notes for every named sound", () => {
    for (const name of soundNames) {
      expect(soundProblem(name)).toBeUndefined();
      expect(soundProblem({ notes: soundNotes(name) })).toBeUndefined();
    }
  });

  it("accepts own notes and fills in the defaults", () => {
    expect(soundNotes({ notes: [{ freq: 440, length: 0.1 }] })).toEqual([{ freq: 440, at: 0, length: 0.1, wave: "square", volume: 0.5 }]);
    expect(readSound({ notes: [{ freq: 440, to: 880, at: 0.1, length: 0.2, wave: "sine", volume: 1 }] })).toEqual({
      notes: [{ freq: 440, to: 880, at: 0.1, length: 0.2, wave: "sine", volume: 1 }],
    });
  });

  it("names what is wrong with a sound", () => {
    expect(soundProblem("boing")).toMatch(/"boing" is not a sound of the SDK/);
    expect(soundProblem(7)).toMatch(/A sound is a name/);
    expect(soundProblem({ notes: [] })).toMatch(/1 to 16 notes/);
    expect(soundProblem({ notes: Array.from({ length: 17 }, () => ({ freq: 440, length: 0.1 })) })).toMatch(/1 to 16 notes/);
    expect(soundProblem({ notes: [{ freq: 440, length: 0.1 }], extra: 1 })).toMatch(/exactly one field/);
    expect(soundProblem({ notes: [{ freq: 10, length: 0.1 }] })).toMatch(/notes\[0\]: freq/);
    expect(soundProblem({ notes: [{ freq: 440, to: 9000, length: 0.1 }] })).toMatch(/to must be/);
    expect(soundProblem({ notes: [{ freq: 440, length: 0 }] })).toMatch(/length/);
    expect(soundProblem({ notes: [{ freq: 440, at: 1.95, length: 0.1 }] })).toMatch(/within 2 seconds/);
    expect(soundProblem({ notes: [{ freq: 440, length: 0.1, wave: "noise" }] })).toMatch(/wave/);
    expect(soundProblem({ notes: [{ freq: 440, length: 0.1, volume: 2 }] })).toMatch(/volume/);
    expect(soundProblem({ notes: [{ freq: 440, length: 0.1, pan: 1 }] })).toMatch(/unknown field pan/);
    expect(soundProblem({ notes: [{ freq: Number.NaN, length: 0.1 }] })).toMatch(/freq/);
  });

  it("travels over the bridge only when it is valid", () => {
    expect(parseGameMessage({ gamehearth: 1, type: "sound", sound: "coin" })).toEqual({ gamehearth: 1, type: "sound", sound: "coin" });
    expect(parseGameMessage({ gamehearth: 1, type: "sound", sound: { notes: [{ freq: 440, length: 0.1 }] } })).toEqual({
      gamehearth: 1,
      type: "sound",
      sound: { notes: [{ freq: 440, at: 0, length: 0.1, wave: "square", volume: 0.5 }] },
    });
    expect(parseGameMessage({ gamehearth: 1, type: "sound", sound: "boing" })).toBeUndefined();
    expect(parsePlatformMessage({ gamehearth: 1, type: "settings", sound: true })).toEqual({ gamehearth: 1, type: "settings", sound: true });
    expect(parsePlatformMessage({ gamehearth: 1, type: "settings", sound: "yes" })).toBeUndefined();
  });
});

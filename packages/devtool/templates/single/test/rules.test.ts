import { describe, expect, it } from "vitest";
import { canStart, finishLevel, freshSave, levelCount, readSave, startRun, withLevelTime, type Save } from "../src/rules";

describe("Reading the save", () => {
  it("starts fresh without a save", () => {
    expect(readSave(undefined)).toEqual({ format: 1, unlocked: 1, run: null });
  });

  it("takes over a valid save", () => {
    const save = { format: 1, unlocked: 2, run: { start: 0, level: 1, elapsedMs: 12_345, levelMs: 4000 } };
    expect(readSave(save)).toEqual(save);
    expect(readSave({ format: 1, unlocked: 2, run: { start: 0, level: 1, elapsedMs: 12_345 } })?.run?.levelMs).toBe(0);
  });

  it("starts fresh on an unknown or broken format instead of crashing", () => {
    expect(readSave({ format: 2, unlocked: 3, run: null })).toEqual(freshSave());
    expect(readSave({ format: 1, unlocked: 99, run: null })).toEqual(freshSave());
    expect(readSave("Level 3")).toEqual(freshSave());
    expect(readSave({ format: 1, unlocked: 2, run: { start: 0, level: 7, elapsedMs: 0 } })).toEqual({ format: 1, unlocked: 2, run: null });
  });
});

describe("Run", () => {
  it("unlocks the levels while playing through and adds up the time", () => {
    let save = startRun(freshSave(), 0);
    let outcome = finishLevel(save, 20_000);
    expect(outcome.finished).toBeUndefined();
    expect(outcome.save).toEqual({ format: 1, unlocked: 2, run: { start: 0, level: 1, elapsedMs: 20_000, levelMs: 0 } });
    save = outcome.save;
    outcome = finishLevel(save, 25_000);
    save = outcome.save;
    outcome = finishLevel(save, 30_400);
    expect(outcome.finished).toEqual({ totalMs: 75_400, ranked: true });
    expect(outcome.save).toEqual({ format: 1, unlocked: levelCount, run: null });
  });

  it("review 9b: aborted attempts at a level count too, so reloading saves no time", () => {
    let save = startRun(freshSave(), 0);
    save = withLevelTime(save, 20_000);
    expect(readSave(JSON.parse(JSON.stringify(save)))?.run).toEqual({ start: 0, level: 0, elapsedMs: 0, levelMs: 20_000 });
    const outcome = finishLevel(save, 20_000 + 15_000);
    expect(outcome.save.run).toEqual({ start: 0, level: 1, elapsedMs: 35_000, levelMs: 0 });
    expect(withLevelTime(freshSave(), 5)).toEqual(freshSave());
  });

  it("does not count practice from a later level for the best time", () => {
    let save: Save = { format: 1, unlocked: 3, run: null };
    save = startRun(save, 1);
    save = finishLevel(save, 10_000).save;
    expect(finishLevel(save, 10_000).finished).toEqual({ totalMs: 20_000, ranked: false });
  });

  it("starts only unlocked levels", () => {
    expect(canStart(freshSave(), 0)).toBe(true);
    expect(canStart(freshSave(), 1)).toBe(false);
    expect(() => startRun(freshSave(), 2)).toThrow("not unlocked yet");
  });

  it("requires a run in progress to finish a level", () => {
    expect(() => finishLevel(freshSave(), 1000)).toThrow("no run in progress");
  });
});

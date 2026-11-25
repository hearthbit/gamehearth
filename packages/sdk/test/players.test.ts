import { describe, expect, it } from "vitest";
import { allowedPlayerCounts, isPlayerCountAllowed, validatePlayerCountSpec } from "../src/platform";

const serverMax = 12;

describe("Player count", () => {
  it("allows exactly the numbers 2 to 5 for 2–5", () => {
    expect(allowedPlayerCounts({ min: 2, max: 5 }, serverMax)).toEqual([2, 3, 4, 5]);
  });

  it("allows only 4 for exactly 4", () => {
    const spec = { min: 4, max: 4 };
    expect(allowedPlayerCounts(spec, serverMax)).toEqual([4]);
    expect(isPlayerCountAllowed(spec, 3, serverMax)).toBe(false);
    expect(isPlayerCountAllowed(spec, 5, serverMax)).toBe(false);
  });

  it("caps 3 or more at the server's maximum", () => {
    const spec = { min: 3 };
    expect(isPlayerCountAllowed(spec, 2, serverMax)).toBe(false);
    expect(isPlayerCountAllowed(spec, 12, serverMax)).toBe(true);
    expect(isPlayerCountAllowed(spec, 13, serverMax)).toBe(false);
  });

  it("lets the server's maximum also cap a higher max", () => {
    expect(isPlayerCountAllowed({ min: 2, max: 20 }, 13, serverMax)).toBe(false);
  });

  it("allows only the listed numbers with counts", () => {
    expect(allowedPlayerCounts({ min: 4, max: 6, counts: [4, 6] }, serverMax)).toEqual([4, 6]);
  });

  it("accepts valid specs without errors", () => {
    expect(validatePlayerCountSpec({ min: 2, max: 6 })).toEqual([]);
    expect(validatePlayerCountSpec({ min: 3 })).toEqual([]);
    expect(validatePlayerCountSpec({ min: 4, max: 6, counts: [4, 6] })).toEqual([]);
  });

  it("reports invalid specs", () => {
    expect(validatePlayerCountSpec({ min: 0 })).toHaveLength(1);
    expect(validatePlayerCountSpec({ min: 4, max: 2 })).toHaveLength(1);
    expect(validatePlayerCountSpec({ min: 2, max: 4, counts: [] })).toHaveLength(1);
    expect(validatePlayerCountSpec({ min: 2, max: 4, counts: [3, 8] })).toHaveLength(1);
  });

  it.each([
    ["not an object", 4, "players must be an object"],
    ["an array", [2, 4], "players must be an object"],
    ["a typo in the field name", { min: 2, maximum: 4 }, "players.maximum is unknown"],
    ["min as text", { min: "2" }, "players.min must be an integer"],
    ["counts as a number", { min: 2, counts: 4 }, "players.counts must be a list"],
    ["counts with text", { min: 2, counts: ["4"] }, 'players.counts contains "4"'],
    ["missing min", { max: 4 }, "players.min must be an integer"],
  ])("reports %s instead of crashing", (_name, spec, expected) => {
    expect(validatePlayerCountSpec(spec)).toEqual(expect.arrayContaining([expect.stringContaining(expected)]));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, 2.5])("rejects the server maximum %s", (bad) => {
    expect(() => isPlayerCountAllowed({ min: 2 }, 3, bad)).toThrow(RangeError);
    expect(() => allowedPlayerCounts({ min: 2 }, bad)).toThrow(RangeError);
  });
});

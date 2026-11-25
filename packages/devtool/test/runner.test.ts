import { describe, expect, it } from "vitest";
import { countsToTest } from "../src/check";
import { satisfies } from "../src/manifest";
import { firstDifference, gameFrames } from "../src/runner";
import { validateManifest } from "../src/manifest";

describe("countsToTest", () => {
  it("checks all counts up to the limit plus minimum and maximum", () => {
    expect(countsToTest({ min: 2, max: 6 }, 8)).toEqual([2, 3, 4, 5, 6]);
    expect(countsToTest({ min: 4, max: 10 }, 8)).toEqual([4, 5, 6, 7, 8, 10]);
    expect(countsToTest({ min: 10 }, 8)).toEqual([10]);
    expect(countsToTest({ min: 3 }, 8)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(countsToTest({ min: 4, max: 12, counts: [4, 6, 12] }, 8)).toEqual([4, 6, 12]);
  });
});

describe("satisfies", () => {
  it.each([
    ["0.1.0", "^0.1.0", true],
    ["0.1.3", "^0.1.0", true],
    ["0.2.0", "^0.1.0", false],
    ["0.1.0", "^0.1.2", false],
    ["1.4.0", "^1.2.0", true],
    ["2.0.0", "^1.2.0", false],
    ["0.1.0", "0.1.0", true],
    ["0.1.1", "0.1.0", false],
  ])("%s satisfies %s: %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it("reports an SDK version in the manifest that is not installed", () => {
    const manifest = {
      id: "x",
      name: "X",
      version: "0.1.0",
      sdk: "^0.2.0",
      license: { code: "MIT", assets: "CC0-1.0" },
      mode: "turn-based",
      players: { min: 2, max: 4 },
      server: true,
      client: "dist/client",
      roles: { player: { inputs: ["touch"], screen: "small" } },
    };
    const checked = validateManifest(manifest, "0.1.0");
    expect(checked.ok ? [] : checked.problems).toEqual(["sdk requires ^0.2.0, but the installed SDK is 0.1.0"]);
    expect(validateManifest({ ...manifest, sdk: "latest" }, "0.1.0").ok).toBe(false);
  });
});

describe("firstDifference", () => {
  it("names the first differing path with both values", () => {
    expect(firstDifference({ a: { b: [1, 2] } }, { a: { b: [1, 3] } }, "match")).toBe(
      "match.a.b[1]: on the first run 2, on the repeat 3",
    );
    expect(firstDifference({ a: 1 }, { a: 1, b: 2 }, "match")).toBe("match.b: on the first run not present, on the repeat 2");
    expect(firstDifference({ a: 1 }, { a: 1 }, "match")).toBeUndefined();
  });
});

describe("gameFrames", () => {
  it("hides lines from the SDK and the dev tool, also when they are installed from npm", () => {
    const stack = [
      "Error: broken",
      "    at apply (/home/anna/game/src/game.ts:12:5)",
      "    at applyMove (/home/anna/game/node_modules/@gamehearth/sdk/src/match.ts:80:3)",
      "    at play (/home/anna/game/node_modules/gamehearth/src/runner.ts:40:7)",
      "    at play (C:\\Users\\anna\\game\\node_modules\\gamehearth\\dist\\cli.js:900:7)",
    ].join("\n");
    expect(gameFrames(stack)).toBe("Error: broken\n    at apply (/home/anna/game/src/game.ts:12:5)");
  });
});

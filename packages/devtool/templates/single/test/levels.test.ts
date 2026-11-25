import { describe, expect, it } from "vitest";
import { levelTexts, levels, parseLevel, reachable } from "../src/levels";

describe("Levels", () => {
  it.each(levels.map((level, index) => [index + 1, level] as const))("level %i is valid: border of walls, one start, every mushroom reachable", (_number, level) => {
    expect(level.width).toBeGreaterThan(2);
    for (let x = 0; x < level.width; x++) {
      expect(level.walls).toContainEqual({ x, y: 0 });
      expect(level.walls).toContainEqual({ x, y: level.height - 1 });
    }
    for (let y = 0; y < level.height; y++) {
      expect(level.walls).toContainEqual({ x: 0, y });
      expect(level.walls).toContainEqual({ x: level.width - 1, y });
    }
    const open = reachable(level);
    for (const mushroom of level.mushrooms) {
      expect(open.has(`${mushroom.x},${mushroom.y}`), `mushroom at ${mushroom.x},${mushroom.y}`).toBe(true);
    }
  });

  it("has three levels of the same size, so the field does not jump", () => {
    expect(levelTexts).toHaveLength(3);
    expect(new Set(levels.map((level) => `${level.width}x${level.height}`)).size).toBe(1);
  });

  it("reports broken levels clearly", () => {
    expect(() => parseLevel("###\n#S\n###")).toThrow("same length");
    expect(() => parseLevel("####\n#..#\n####")).toThrow("start S");
    expect(() => parseLevel("####\n#SS#\n####")).toThrow("exactly one start");
    expect(() => parseLevel("####\n#S.#\n####")).toThrow("at least one mushroom");
    expect(() => parseLevel("####\n#SX#\n####")).toThrow("Unknown character \"X\"");
  });

  it("finds unreachable mushrooms", () => {
    const level = parseLevel("#####\n#S#M#\n#####");
    expect(reachable(level).has("3,1")).toBe(false);
  });
});

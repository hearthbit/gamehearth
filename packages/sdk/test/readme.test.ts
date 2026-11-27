import { describe, expect, it } from "vitest";
import readme from "../README.md?raw";
import fixture from "./fixtures/readme-example.ts?raw";
import example from "./fixtures/readme-example";
import * as gameApi from "../src/index";
import { applyMove, createMatch, playerSnapshot, trackProblem } from "../src/platform";
import { expectMatch } from "./helpers";

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

describe("README", () => {
  it("shows exactly the example that is compiled and tested here", () => {
    const block = /## A game in one file\s+```ts\n([\s\S]*?)```/.exec(normalize(readme));
    expect(block?.[1]).toBeDefined();
    expect(normalize(block?.[1] ?? "")).toBe(normalize(fixture));
  });

  it("lets the example play a whole match", () => {
    let match = expectMatch(createMatch(example, { playerCount: 3, seed: "readme" }));
    for (const player of match.players) {
      match = expectMatch(applyMove(example, match, { player, action: { type: "reveal" }, now: 0 }));
    }
    expect(match.result?.winners.length).toBeGreaterThan(0);
    expect(playerSnapshot(match, "p1").public.revealed).toHaveProperty("p3");
  });

  it("shows a valid music track", () => {
    const literal = /const forest: MusicTrack = (\{[\s\S]*?\n\});/.exec(normalize(readme))?.[1];
    expect(literal).toBeDefined();
    const track = new Function(`return ${literal ?? "undefined"};`)() as unknown;
    expect(trackProblem(track)).toBeUndefined();
  });

  it("gives games only defineGame, the placeholders and types, no platform tools", () => {
    expect(Object.keys(gameApi).sort()).toEqual(["defineGame", "int", "isPlaceholder", "text"]);
  });
});

describe("SDK version", () => {
  it("matches package.json", async () => {
    const { sdkVersion } = await import("../src/platform");
    const pkg = (await import("../package.json")) as { version: string };
    expect(sdkVersion).toBe(pkg.version);
  });
});

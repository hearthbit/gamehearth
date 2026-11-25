import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleGameForDev } from "../src/bundle";
import { DevEngine } from "../src/dev/engine";
import { DevSession, type DevProblem } from "../src/dev/session";

const devtool = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(devtool, "dev-placeholders-"));

afterAll(() => rmSync(work, { recursive: true, force: true }));

function writeGame(dir: string, realtime: boolean): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "index.ts"),
    [
      'import { defineGame, int, text } from "@gamehearth/sdk";',
      "type State = { public: { said: string[]; sum: number; ticks: number }; players: Record<string, object>; secret: Record<string, never> };",
      'type Action = { type: "say"; text: string; n: number };',
      "export default defineGame<State, Action>({",
      "  setup({ players }) {",
      "    return { public: { said: [], sum: 0, ticks: 0 }, players: Object.fromEntries(players.map((p) => [p, {}])), secret: {} };",
      "  },",
      "  legalMoves(state) {",
      '    return state.public.said.length >= 50 ? [] : [{ type: "say", text: text({ min: 1, max: 8 }), n: int({ min: 1, max: 3 }) }];',
      "  },",
      "  apply(state, action) {",
      "    state.public.said.push(action.text);",
      "    state.public.sum += action.n;",
      "  },",
      ...(realtime ? ["  tick(state) {", "    state.public.ticks += 1;", "  },"] : []),
      "  result(state) {",
      "    return state.public.said.length >= 50 ? { winners: [] } : undefined;",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
}

describe("dev: placeholders", () => {
  let engine: DevEngine;

  beforeAll(async () => {
    engine = await DevEngine.start({ limitMs: 1500 });
  });
  afterAll(async () => engine.close());

  it("accepts typed moves that fit the placeholders and reports those that do not", async () => {
    const dir = join(work, "turns");
    writeGame(dir, false);
    const bundle = await bundleGameForDev(dir);
    expect(await engine.load(bundle.code)).toEqual({ ok: true });
    const logged: DevProblem[] = [];
    const dev = new DevSession({ engine, realtime: false, timers: false, pick: () => 0, now: () => 1000, log: (problem) => logged.push(problem) });
    await dev.newMatch(2, "typed");
    expect(await dev.move("p1", { type: "say", text: "Hallo", n: 2 }, { expectedVersion: 0 })).toEqual({ ok: true });
    expect(await dev.move("p2", { type: "say", text: "viel zu lang", n: 2 }, { expectedVersion: 1 })).toMatchObject({ ok: false, code: "illegal-move" });
    expect(logged.map((problem) => problem.title)).toEqual(["The UI of p2 sent a move that is not legal"]);
    expect(dev.view().moves.map((entry) => entry.action)).toEqual([{ type: "say", text: "Hallo", n: 2 }]);
    dev.close();
  });

  it("lets bots fill placeholders with values instead of sending the placeholder", async () => {
    const dir = join(work, "bots");
    writeGame(dir, true);
    const bundle = await bundleGameForDev(dir);
    expect(await engine.load(bundle.code)).toEqual({ ok: true });
    const dev = new DevSession({ engine, realtime: true, timers: false, pick: () => 0, now: () => 1000, log: () => undefined });
    await dev.newMatch(2, "bots");
    dev.setBot("p1", true);
    for (let i = 0; i < 3; i++) {
      await dev.step();
    }
    const sent = dev.view().moves.filter((entry) => entry.bot).map((entry) => entry.action as { text: unknown; n: unknown });
    expect(sent.length).toBeGreaterThan(0);
    for (const action of sent) {
      expect(typeof action.text).toBe("string");
      expect(typeof action.n).toBe("number");
    }
    dev.close();
  }, 20_000);
});

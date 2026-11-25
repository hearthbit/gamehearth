import { describe, expect, it } from "vitest";
import { applyMove, cloneJson, createMatch, defineGame, stepMatch, tickMs, type GameState } from "../src/platform";
import { expectError, expectMatch } from "./helpers";

interface Options {
  runden: number;
  doppelt: boolean;
}

type State = GameState<{ runde: number; ziel: number; punkte: number; gesehen: string[] }, Record<string, never>, null>;
type Action = { type: "zug"; wert: number };

const seen: { phase: string; options: unknown }[] = [];

const game = defineGame<State, Action, Options>({
  setup({ players, options }) {
    seen.push({ phase: "setup", options });
    return {
      public: { runde: 0, ziel: options.runden, punkte: 0, gesehen: [`setup:${options.runden}`] },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: null,
    };
  },
  legalMoves(state, player, ctx) {
    seen.push({ phase: `legalMoves:${player}`, options: ctx.options });
    return player === "p1" && state.public.runde < ctx.options.runden ? [{ type: "zug", wert: ctx.options.doppelt ? 2 : 1 }] : [];
  },
  apply(state, action, { options }) {
    seen.push({ phase: "apply", options });
    state.public.runde += 1;
    state.public.punkte += action.wert;
    state.public.gesehen.push(`apply:${options.doppelt}`);
  },
  result(state) {
    return state.public.runde >= state.public.ziel ? { winners: ["p1"] } : undefined;
  },
});

const ticking = defineGame<State, Action, Options>({
  ...game,
  legalMoves: () => [{ type: "zug", wert: 1 }],
  tick(state, _dt, { options }) {
    seen.push({ phase: "tick", options });
    state.public.runde += 1;
    state.public.gesehen.push(`tick:${options.runden}`);
  },
  result: (state) => (state.public.runde >= 30 ? { winners: [] } : undefined),
});

describe("Options in the match", () => {
  it("passes the options to setup, legalMoves and apply and stores them in the match", () => {
    seen.length = 0;
    const options = { runden: 2, doppelt: true };
    const start = expectMatch(createMatch(game, { playerCount: 2, seed: "optionen", options }));
    expect(start.options).toEqual(options);
    expect(start.moves).toEqual({ p1: [{ type: "zug", wert: 2 }], p2: [] });
    const after = expectMatch(applyMove(game, start, { player: "p1", action: { type: "zug", wert: 2 }, now: 0 }));
    expect(after.options).toEqual(options);
    expect(after.state.public).toEqual({ runde: 1, ziel: 2, punkte: 2, gesehen: ["setup:2", "apply:true"] });
    const last = expectMatch(applyMove(game, after, { player: "p1", action: { type: "zug", wert: 2 }, now: 0 }));
    expect(last.result).toEqual({ winners: ["p1"] });
    expect(last.options).toEqual(options);
    expect(seen.map((entry) => entry.phase)).toEqual([
      "setup",
      "legalMoves:p1",
      "legalMoves:p2",
      "apply",
      "legalMoves:p1",
      "legalMoves:p2",
      "apply",
    ]);
    expect(seen.every((entry) => JSON.stringify(entry.options) === JSON.stringify(options))).toBe(true);
  });

  it("survives saving as JSON and playing on from the saved match", () => {
    const start = expectMatch(createMatch(game, { playerCount: 1, seed: "json", options: { runden: 3, doppelt: false } }));
    const stored = JSON.parse(JSON.stringify(start)) as typeof start;
    const after = expectMatch(applyMove(game, stored, { player: "p1", action: { type: "zug", wert: 1 }, now: 0 }));
    expect(after.options).toEqual({ runden: 3, doppelt: false });
  });

  it("gives games without options an empty object and then stores nothing", () => {
    seen.length = 0;
    const plain = defineGame<State, Action>({
      setup: (ctx) => {
        seen.push({ phase: "setup", options: ctx.options });
        return { public: { runde: 0, ziel: 1, punkte: 0, gesehen: [] }, players: { p1: {} }, secret: null };
      },
      legalMoves: () => [{ type: "zug", wert: 1 }],
      apply: () => undefined,
      result: () => undefined,
    });
    const match = expectMatch(createMatch(plain, { playerCount: 1, seed: "ohne" }));
    expect("options" in match).toBe(false);
    expect(seen[0]?.options).toEqual({});
    expect("options" in expectMatch(createMatch(plain, { playerCount: 1, seed: "leer", options: {} }))).toBe(false);
  });

  it("freezes the options so no game changes them for the next phase", () => {
    const sneaky = defineGame<State, Action, Options>({
      ...game,
      setup(ctx) {
        (ctx.options as { runden: number }).runden = 99;
        return game.setup(ctx);
      },
    });
    const error = expectError(createMatch(sneaky, { playerCount: 1, seed: "frieren", options: { runden: 1, doppelt: false } }));
    expect(error).toMatchObject({ code: "game-error", phase: "setup" });
  });

  it("gives every phase its own copy so a game cannot reach the stored options", () => {
    let captured: Options | undefined;
    const keeping = defineGame<State, Action, Options>({
      ...game,
      setup(ctx) {
        captured = ctx.options;
        return game.setup(ctx);
      },
    });
    const match = expectMatch(createMatch(keeping, { playerCount: 1, seed: "kopie", options: { runden: 1, doppelt: false } }));
    expect(captured).not.toBe(match.options);
    expect(Object.isFrozen(captured)).toBe(true);
  });

  it("rejects options that are not a flat JSON object", () => {
    expect(() => createMatch(game, { playerCount: 1, seed: "x", options: { runden: 1.5, doppelt: false } })).toThrow(TypeError);
    expect(() => createMatch(game, { playerCount: 1, seed: "x", options: [] as unknown as Options })).toThrow(TypeError);
  });

  it("also passes the options to tick and keeps them in every step", () => {
    seen.length = 0;
    const start = expectMatch(createMatch(ticking, { playerCount: 1, seed: "tick", options: { runden: 7, doppelt: false } }));
    const first = stepMatch(ticking, cloneJson(start), { inputs: [{ player: "p1", action: { type: "zug", wert: 1 } }], now: 0, dt: tickMs });
    if (!first.ok) {
      throw new Error(first.error.message);
    }
    expect(first.match.options).toEqual({ runden: 7, doppelt: false });
    expect(first.match.state.public.gesehen).toEqual(["setup:7", "apply:false", "tick:7"]);
    expect(first.match.state.public.runde).toBe(2);
    expect(seen.filter((entry) => entry.phase === "tick")).toEqual([{ phase: "tick", options: { runden: 7, doppelt: false } }]);
  });

  it("still lets tests call legalMoves without ctx as long as the game does not need ctx", () => {
    const simple = defineGame<State, Action, Options>({
      ...game,
      legalMoves: (state, player) => (player === "p1" && state.public.runde < 1 ? [{ type: "zug", wert: 1 }] : []),
    });
    const state = expectMatch(createMatch(simple, { playerCount: 1, seed: "test" })).state;
    expect(simple.legalMoves(state, "p1")).toEqual([{ type: "zug", wert: 1 }]);
  });
});

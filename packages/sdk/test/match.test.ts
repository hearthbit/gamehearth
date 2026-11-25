import { describe, expect, it } from "vitest";
import { applyMove, createMatch, type Match } from "../src/platform";
import { counterGame, type CounterAction, type CounterState } from "./fixtures/counter";
import { highCard, type HighCardAction, type HighCardState } from "./fixtures/high-card";
import { expectError, expectMatch } from "./helpers";

const reveal: HighCardAction = { type: "reveal" };

function startHighCard(playerCount: number, seed = "start"): Match<HighCardState, HighCardAction> {
  return expectMatch(createMatch(highCard, { playerCount, seed }));
}

function revealBy(match: Match<HighCardState, HighCardAction>, player: string) {
  return expectMatch(applyMove(highCard, match, { player, action: reveal, now: 0 }));
}

function brokenSetup(state: unknown) {
  return counterGame({ setup: () => state as CounterState });
}

describe("createMatch", () => {
  it("assigns seats p1 to pN and creates an area for every seat", () => {
    const match = startHighCard(3);
    expect(match.players).toEqual(["p1", "p2", "p3"]);
    expect(Object.keys(match.state.players)).toEqual(["p1", "p2", "p3"]);
  });

  it("builds the same match for the same seed and a different one for a different seed", () => {
    expect(startHighCard(2, "s1")).toEqual(startHighCard(2, "s1"));
    expect(startHighCard(2, "s1").state).not.toEqual(startHighCard(2, "s2").state);
  });

  it("remembers the seed and the legal moves of every seat", () => {
    const match = startHighCard(2, "merken");
    expect(match.seed).toBe("merken");
    expect(match.moves).toEqual({ p1: [reveal], p2: [reveal] });
    expect(match.version).toBe(0);
    expect(match.result).toBeUndefined();
  });

  it("rejects an invalid player count as a caller error", () => {
    expect(() => createMatch(highCard, { playerCount: 0, seed: "x" })).toThrow(RangeError);
    expect(() => createMatch(highCard, { playerCount: 1.5, seed: "x" })).toThrow(RangeError);
  });

  it("catches an error in setup and reports it", () => {
    const game = counterGame({
      setup: () => {
        throw new Error("deck empty");
      },
    });
    const error = expectError(createMatch(game, { playerCount: 2, seed: "x" }));
    expect(error).toMatchObject({
      code: "game-error",
      phase: "setup",
      message: "setup threw an error: deck empty",
    });
    expect(error.stack).toContain("match.test.ts");
  });

  it.each([
    ["a missing field", { public: {}, players: { p1: {}, p2: {} } }, 'the state is missing the field "secret"'],
    [
      "an unknown field",
      { public: {}, players: { p1: {}, p2: {} }, secret: {}, extra: 1 },
      'the state has the unknown field "extra"',
    ],
    ["a missing seat", { public: {}, players: { p1: {} }, secret: {} }, "no entry for the seat p2"],
    [
      "an unknown seat",
      { public: {}, players: { p1: {}, p2: {}, anna: {} }, secret: {} },
      'state.players contains "anna"',
    ],
    ["a Set", { public: { used: new Set([1]) }, players: { p1: {}, p2: {} }, secret: {} }, "state.public.used is a Set"],
    ["a date", { public: {}, players: { p1: { at: new Date(0) }, p2: {} }, secret: {} }, "state.players.p1.at is a Date"],
    ["NaN", { public: { score: Number.NaN }, players: { p1: {}, p2: {} }, secret: {} }, "state.public.score is NaN"],
    ["undefined in an array", { public: { list: [1, undefined] }, players: { p1: {}, p2: {} }, secret: {} }, "state.public.list[1] is undefined"],
    ["not an object", "hallo", "the state must be an object"],
  ])("reports %s in the initial state with its path", (_name, state, expected) => {
    const error = expectError(createMatch(brokenSetup(state), { playerCount: 2, seed: "x" }));
    expect(error.code).toBe("game-error");
    expect(error.message).toContain("setup returned an invalid state");
    expect(error.message).toContain(expected);
  });

  it("accepts fields with undefined in objects, because they act like missing fields", () => {
    const state = { public: { last: undefined }, players: { p1: { turns: 0 }, p2: { turns: 0 } }, secret: {} };
    const game = counterGame({ setup: () => state as unknown as CounterState, legalMoves: () => [{ type: "roll" }] });
    const match = expectMatch(createMatch(game, { playerCount: 2, seed: "x" }));
    expect(match.state.public).toEqual({});
  });
});

describe("applyMove", () => {
  it("applies a legal move, counts it and updates the legal moves", () => {
    const start = startHighCard(2, "zug");
    const next = revealBy(start, "p1");
    expect(next.version).toBe(1);
    expect(next.state.public.revealed["p1"]).toBe(start.state.players["p1"]?.card);
    expect(next.moves).toEqual({ p1: [], p2: [reveal] });
  });

  it("accepts a reducer that changes the state and returns nothing", () => {
    const next = revealBy(startHighCard(2, "mutieren"), "p2");
    expect(Object.keys(next.state.public.revealed)).toEqual(["p2"]);
  });

  it("accepts a reducer that returns a new state", () => {
    const game = counterGame();
    const start = expectMatch(createMatch(game, { playerCount: 2, seed: "neu" }));
    const next = expectMatch(applyMove(game, start, { player: "p1", action: { type: "step", by: 2 }, now: 7 }));
    expect(next.state.public).toEqual({ count: 2, rolls: [], log: ["p1@7"] });
    expect(next.state.players["p1"]).toEqual({ turns: 1 });
  });

  it("never changes the previous match", () => {
    const start = startHighCard(2, "unveraendert");
    const before = JSON.stringify(start);
    revealBy(start, "p1");
    expect(JSON.stringify(start)).toBe(before);
  });

  it("reports not-your-turn when the seat has no moves right now", () => {
    const afterP1 = revealBy(startHighCard(2, "doppelt"), "p1");
    expect(expectError(applyMove(highCard, afterP1, { player: "p1", action: reveal, now: 0 })).code).toBe(
      "not-your-turn",
    );
  });

  it("reports illegal-move for actions that are not in legalMoves", () => {
    const start = startHighCard(2, "fremd");
    const cheat = { type: "cheat" } as unknown as HighCardAction;
    expect(expectError(applyMove(highCard, start, { player: "p1", action: cheat, now: 0 })).code).toBe("illegal-move");
  });

  it("reports unknown-player for seats that don't exist", () => {
    const start = startHighCard(2, "fremder");
    expect(expectError(applyMove(highCard, start, { player: "p3", action: reveal, now: 0 })).code).toBe(
      "unknown-player",
    );
  });

  it("compares actions regardless of the order of the fields", () => {
    const game = counterGame();
    const start = expectMatch(createMatch(game, { playerCount: 1, seed: "felder" }));
    const action = { by: 1, type: "step" } as CounterAction;
    expect(applyMove(game, start, { player: "p1", action, now: 0 }).ok).toBe(true);
  });

  it("passes seat, time and player list to apply in the context", () => {
    const seen: unknown[] = [];
    const game = counterGame({
      apply: (state, _action, ctx) => {
        seen.push({ player: ctx.player, now: ctx.now, players: ctx.players });
        state.public.count = 1;
      },
    });
    const start = expectMatch(createMatch(game, { playerCount: 2, seed: "kontext" }));
    expectMatch(applyMove(game, start, { player: "p1", action: { type: "roll" }, now: 1234 }));
    expect(seen).toEqual([{ player: "p1", now: 1234, players: ["p1", "p2"] }]);
  });

  it("catches an error in apply and leaves the match unchanged", () => {
    const game = counterGame({
      apply: () => {
        throw new Error("broken");
      },
    });
    const start = expectMatch(createMatch(game, { playerCount: 2, seed: "wurf" }));
    const before = JSON.stringify(start);
    expect(expectError(applyMove(game, start, { player: "p1", action: { type: "roll" }, now: 0 }))).toMatchObject({
      code: "game-error",
      phase: "apply",
      player: "p1",
      message: "apply threw an error: broken",
    });
    expect(JSON.stringify(start)).toBe(before);
  });

  it("reports an invalid state after apply with its path", () => {
    const game = counterGame({
      apply: (state) => {
        (state.secret as unknown as { seen: Set<number> }).seen = new Set();
      },
    });
    const start = expectMatch(createMatch(game, { playerCount: 2, seed: "set" }));
    const error = expectError(applyMove(game, start, { player: "p1", action: { type: "roll" }, now: 0 }));
    expect(error.message).toBe("apply returned an invalid state: state.secret.seen is a Set, only plain objects, arrays and primitive values are allowed");
  });

  it("continues randomness deterministically across moves", () => {
    const game = counterGame({ result: () => undefined });
    const rollTimes = (count: number) => {
      let match = expectMatch(createMatch(game, { playerCount: 1, seed: "wuerfel" }));
      for (let i = 0; i < count; i++) {
        match = expectMatch(applyMove(game, match, { player: "p1", action: { type: "roll" }, now: i }));
      }
      return match;
    };
    const rolls = rollTimes(8).state.public.rolls;
    expect(rolls).toEqual(rollTimes(8).state.public.rolls);
    expect(new Set(rolls).size).toBeGreaterThan(1);
  });

  it("continues randomness exactly after saving and loading", () => {
    const game = counterGame({ result: () => undefined });
    let match = expectMatch(createMatch(game, { playerCount: 1, seed: "laden" }));
    match = expectMatch(applyMove(game, match, { player: "p1", action: { type: "roll" }, now: 0 }));
    const reloaded = JSON.parse(JSON.stringify(match)) as typeof match;
    const a = expectMatch(applyMove(game, match, { player: "p1", action: { type: "roll" }, now: 1 }));
    const b = expectMatch(applyMove(game, reloaded, { player: "p1", action: { type: "roll" }, now: 1 }));
    expect(a).toEqual(b);
  });
});

describe("End of the match", () => {
  it("sets the result, clears all moves and accepts no more moves", () => {
    const start = startHighCard(2, "ende");
    const finished = revealBy(revealBy(start, "p1"), "p2");
    const p1 = start.state.players["p1"]?.card ?? 0;
    const p2 = start.state.players["p2"]?.card ?? 0;
    expect(finished.result).toEqual({ winners: [p1 > p2 ? "p1" : "p2"] });
    expect(finished.moves).toEqual({ p1: [], p2: [] });
    expect(expectError(applyMove(highCard, finished, { player: "p1", action: reveal, now: 0 })).code).toBe(
      "game-over",
    );
  });

  it("allows a result without winners", () => {
    const game = counterGame({ result: (state) => (state.public.log.length > 0 ? { winners: [] } : undefined) });
    const start = expectMatch(createMatch(game, { playerCount: 2, seed: "niemand" }));
    const finished = expectMatch(applyMove(game, start, { player: "p1", action: { type: "roll" }, now: 0 }));
    expect(finished.result).toEqual({ winners: [] });
  });

  it("treats null from result like a running match", () => {
    const game = counterGame({ result: () => null as unknown as undefined });
    const match = expectMatch(createMatch(game, { playerCount: 2, seed: "null" }));
    expect(match.result).toBeUndefined();
  });

  it.each([
    ["an unknown seat", { winners: ["anna"] }, 'winners contains "anna"'],
    ["a duplicate seat", { winners: ["p1", "p1"] }, "winners contains a seat more than once"],
    ["the wrong shape", { winner: "p1" }, "{ winners: [...] }"],
  ])("reports a result with %s", (_name, result, expected) => {
    const game = counterGame({ result: () => result as never });
    const error = expectError(createMatch(game, { playerCount: 2, seed: "x" }));
    expect(error.code).toBe("game-error");
    expect(error.message).toContain(expected);
  });

  it("reports a match in which nobody can move and that still does not end", () => {
    const game = counterGame({ legalMoves: () => [], result: () => undefined });
    const error = expectError(createMatch(game, { playerCount: 2, seed: "haengt" }));
    expect(error.message).toContain("nobody can move");
  });
});

describe("Errors in legalMoves and result", () => {
  it("catches an error in legalMoves", () => {
    const game = counterGame({
      legalMoves: () => {
        throw new Error("no idea");
      },
    });
    expect(expectError(createMatch(game, { playerCount: 2, seed: "x" })).message).toBe(
      "legalMoves for p1 threw an error: no idea",
    );
  });

  it("reports when legalMoves does not return an array", () => {
    const game = counterGame({ legalMoves: () => ({ type: "roll" }) as unknown as CounterAction[] });
    expect(expectError(createMatch(game, { playerCount: 2, seed: "x" })).message).toBe(
      "legalMoves for p1 must return an array",
    );
  });

  it("reports moves that are not JSON values", () => {
    const game = counterGame({ legalMoves: () => [{ type: "step", by: Number.POSITIVE_INFINITY }] });
    expect(expectError(createMatch(game, { playerCount: 2, seed: "x" })).message).toContain(
      "legalMoves(p1)[0].by is Infinity",
    );
  });

  it("catches an error in result", () => {
    const game = counterGame({
      result: () => {
        throw new Error("counting broken");
      },
    });
    expect(expectError(createMatch(game, { playerCount: 2, seed: "x" })).message).toBe(
      "result threw an error: counting broken",
    );
  });
});

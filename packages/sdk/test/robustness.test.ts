import { describe, expect, it } from "vitest";
import { applyMove, createMatch, defineGame, maxActionLength, type GameState } from "../src/platform";
import { counterGame, type CounterAction, type CounterState } from "./fixtures/counter";
import { expectError, expectMatch } from "./helpers";

function start(game = counterGame(), playerCount = 2) {
  return expectMatch(createMatch(game, { playerCount, seed: "robust" }));
}

describe("Game code does not crash the server", () => {
  it("reports an async apply and catches the rejected Promise", async () => {
    const game = counterGame({
      apply: (async () => {
        throw new Error("broken later");
      }) as never,
    });
    const error = expectError(applyMove(game, start(game), { player: "p1", action: { type: "roll" }, now: 0 }));
    expect(error).toMatchObject({ code: "game-error", phase: "apply", player: "p1" });
    expect(error.message).toBe("apply must not be async or return a Promise");
    for (let tick = 0; tick < 5; tick++) {
      await Promise.resolve();
    }
  });

  it("reports an async setup, legalMoves and result", () => {
    const asyncSetup = counterGame({ setup: (async () => ({})) as never });
    expect(expectError(createMatch(asyncSetup, { playerCount: 1, seed: "x" })).message).toContain(
      "setup must not be async",
    );
    const asyncMoves = counterGame({ legalMoves: (async () => []) as never });
    expect(expectError(createMatch(asyncMoves, { playerCount: 1, seed: "x" })).message).toContain(
      "legalMoves for p1 must not be async",
    );
    const asyncResult = counterGame({ result: (async () => undefined) as never });
    expect(expectError(createMatch(asyncResult, { playerCount: 1, seed: "x" })).message).toContain(
      "result must not be async",
    );
  });

  it("reports a too deeply nested state with its path", () => {
    const game = counterGame({
      apply: (state) => {
        let history: unknown = null;
        for (let i = 0; i < 1500; i++) {
          history = { prev: history };
        }
        (state.secret as unknown as { history: unknown }).history = history;
      },
    });
    const error = expectError(applyMove(game, start(game), { player: "p1", action: { type: "roll" }, now: 0 }));
    expect(error.code).toBe("game-error");
    expect(error.message).toContain("nested deeper than 100 levels");
    expect(error.message).toContain("state.secret.history.prev");
  });

  it("catches errors that cannot even become a string", () => {
    const game = counterGame({
      apply: () => {
        throw Object.create(null);
      },
    });
    const error = expectError(applyMove(game, start(game), { player: "p1", action: { type: "roll" }, now: 0 }));
    expect(error.message).toBe("apply threw an error: unknown error");
  });

  it("reports a getter in the state instead of running it", () => {
    const game = counterGame({
      apply: (state) => {
        Object.defineProperty(state.public, "count", {
          enumerable: true,
          get() {
            throw new Error("Getter");
          },
        });
      },
    });
    const error = expectError(applyMove(game, start(game), { player: "p1", action: { type: "roll" }, now: 0 }));
    expect(error.message).toContain("state.public.count is a getter or setter property");
  });

  it("reports when legalMoves tries to change the state", () => {
    const game = counterGame({
      legalMoves: (state) => {
        state.public.count += 1;
        return [{ type: "roll" }];
      },
    });
    const error = expectError(createMatch(game, { playerCount: 1, seed: "x" }));
    expect(error).toMatchObject({ code: "game-error", phase: "legalMoves", player: "p1" });
    expect(error.message).toContain("legalMoves for p1 threw an error");
  });

  it("reports when result tries to change the state", () => {
    const game = counterGame({
      result: (state) => {
        state.public.log.push("ende?");
        return undefined;
      },
    });
    expect(expectError(createMatch(game, { playerCount: 1, seed: "x" })).phase).toBe("result");
  });

  it("reports moves that are too large to ever be sent", () => {
    const game = counterGame({ legalMoves: () => [{ type: "step", by: 1, pad: "x".repeat(maxActionLength) } as CounterAction] });
    expect(expectError(createMatch(game, { playerCount: 1, seed: "x" })).message).toContain(
      "could never be sent",
    );
  });
});

describe("Moves from the client", () => {
  it("rejects a hugely nested action instead of crashing", () => {
    let deep: unknown = [];
    for (let i = 0; i < 200_000; i++) {
      deep = [deep];
    }
    const outcome = applyMove(counterGame(), start(), { player: "p1", action: deep as CounterAction, now: 0 });
    expect(expectError(outcome).code).toBe("illegal-move");
  });

  it("rejects a very large action quickly", () => {
    const moves = Array.from({ length: 500 }, (_, by) => ({ type: "step", by }) as CounterAction);
    const game = counterGame({ legalMoves: () => moves });
    const match = start(game, 1);
    const huge = { type: "step", by: 1, junk: "x".repeat(2_500_000) } as CounterAction;
    const started = Date.now();
    const outcome = applyMove(game, match, { player: "p1", action: huge, now: 0 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(expectError(outcome)).toMatchObject({ code: "illegal-move", message: expect.stringContaining("longer than") });
  });

  it("rejects actions that are not JSON values", () => {
    const outcome = applyMove(counterGame(), start(), {
      player: "p1",
      action: { type: "roll", at: new Date(0) } as unknown as CounterAction,
      now: 0,
    });
    expect(expectError(outcome).code).toBe("illegal-move");
  });

  it("gives apply the stored move, not the object from the client", () => {
    let received: unknown;
    const game = counterGame({
      apply: (state, action) => {
        received = action;
        state.public.count = 1;
      },
    });
    const fromClient = JSON.parse('{"type":"roll"}') as CounterAction;
    expectMatch(applyMove(game, start(game), { player: "p1", action: fromClient, now: 0 }));
    expect(received).not.toBe(fromClient);
    expect(received).toEqual({ type: "roll" });
  });

  it("reports stale when the move refers to an old version", () => {
    const game = counterGame();
    const first = start(game);
    const second = expectMatch(applyMove(game, first, { player: "p1", action: { type: "roll" }, now: 0, expectedVersion: 0 }));
    expect(second.version).toBe(1);
    const outcome = applyMove(game, second, { player: "p2", action: { type: "roll" }, now: 0, expectedVersion: 0 });
    expect(expectError(outcome).code).toBe("stale");
  });

  it("treats caller errors of the platform as exceptions", () => {
    const game = counterGame();
    const match = start(game);
    expect(() => applyMove(game, match, { player: "p1", action: { type: "roll" }, now: Number.NaN })).toThrow(RangeError);
    expect(() => applyMove(game, match, { player: "p1", action: { type: "roll" }, now: "gestern" as never })).toThrow(
      RangeError,
    );
    expect(() => applyMove(game, { ...match, format: 2 as never }, { player: "p1", action: { type: "roll" }, now: 0 })).toThrow();
    expect(() => createMatch(game, { playerCount: 2, seed: "" })).toThrow(TypeError);
  });
});

describe("Built-in names as keys", () => {
  type WordState = GameState<{ counts: Record<string, number>; used: Record<string, true> }, Record<string, never>, Record<string, never>>;
  type WordAction = { type: "say"; word: string };
  const words = ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf", "apfel"];

  const wordGame = defineGame<WordState, WordAction>({
    setup: ({ players }) => ({
      public: { counts: {}, used: {} },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: {},
    }),
    legalMoves: (state) => words.filter((word) => !state.public.used[word]).map((word) => ({ type: "say", word })),
    apply: (state, action) => {
      state.public.counts[action.word] = (state.public.counts[action.word] ?? 0) + 1;
      state.public.used[action.word] = true;
    },
    result: (state) => (Object.keys(state.public.used).length === words.length ? { winners: [] } : undefined),
  });

  it("offers all words as moves and counts them correctly", () => {
    let match = expectMatch(createMatch(wordGame, { playerCount: 1, seed: "woerter" }));
    expect(match.moves["p1"]?.map((move) => move.word)).toEqual(words);
    for (const word of words) {
      match = expectMatch(applyMove(wordGame, match, { player: "p1", action: { type: "say", word }, now: 0 }));
    }
    expect(JSON.parse(JSON.stringify(match.state.public.counts))).toEqual(
      JSON.parse('{"constructor":1,"toString":1,"hasOwnProperty":1,"__proto__":1,"valueOf":1,"apfel":1}'),
    );
    expect(match.result).toEqual({ winners: [] });
  });
});

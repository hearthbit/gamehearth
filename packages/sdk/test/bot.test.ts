import { describe, expect, it } from "vitest";
import { botMove, createMatch, hasBot, int, stepMatch, text, tickMs, type GameState } from "../src/platform";
import { defineGame } from "../src/index";
import { counterGame, type CounterAction } from "./fixtures/counter";
import { runnerGame } from "./fixtures/runner";
import { expectMatch } from "./helpers";

describe("botMove in turn-based matches", () => {
  it("takes the move the game's bot picks", () => {
    const game = counterGame({ bot: (_state, _player, moves) => moves.find((move) => move.type === "roll") });
    const match = expectMatch(createMatch(game, { playerCount: 2, seed: "bots" }));
    expect(botMove(game, match, "p1", { now: 1 })).toEqual({ ok: true, action: { type: "roll" }, chosen: "bot" });
  });

  it("knows whether a game has a bot", () => {
    expect(hasBot(counterGame())).toBe(false);
    expect(hasBot(counterGame({ bot: () => undefined }))).toBe(true);
  });

  it("picks a random legal move when the game has no bot or the bot leaves the choice open", () => {
    for (const game of [counterGame(), counterGame({ bot: () => undefined })]) {
      const match = expectMatch(createMatch(game, { playerCount: 2, seed: "bots" }));
      const outcome = botMove(game, match, "p1", { now: 1 });
      expect(outcome.chosen).toBe("random");
      expect(outcome.problem).toBeUndefined();
      expect(match.moves["p1"]).toContainEqual(outcome.action);
    }
  });

  it("returns no move for a seat that cannot move", () => {
    const game = counterGame({ bot: (_state, _player, moves) => moves[0] });
    const match = expectMatch(createMatch(game, { playerCount: 2, seed: "bots" }));
    expect(botMove(game, match, "p2", { now: 1 })).toEqual({ ok: true, chosen: "none" });
  });

  it("replaces a move that is not legal and names the problem", () => {
    const game = counterGame({ bot: () => ({ type: "step", by: 7 }) as CounterAction });
    const match = expectMatch(createMatch(game, { playerCount: 2, seed: "bots" }));
    const outcome = botMove(game, match, "p1", { now: 1 });
    expect(outcome.chosen).toBe("random");
    expect(outcome.problem).toMatch(/bot for p1 chose a move that is not legal right now: \{"type":"step","by":7\}/);
    expect(match.moves["p1"]).toContainEqual(outcome.action);
  });

  it("replaces a move when the bot throws", () => {
    const game = counterGame({
      bot: () => {
        throw new Error("kaputt");
      },
    });
    const match = expectMatch(createMatch(game, { playerCount: 2, seed: "bots" }));
    const outcome = botMove(game, match, "p1", { now: 1 });
    expect(outcome.chosen).toBe("random");
    expect(outcome.problem).toMatch(/bot for p1 failed: .*kaputt/);
  });

  it("does not let the bot change the state, the moves or the profiles", () => {
    const writers = [
      counterGame({
        bot: (state) => {
          state.public.count = 99;
          return undefined;
        },
      }),
      counterGame({
        bot: (_state, _player, moves) => {
          moves.pop();
          return undefined;
        },
      }),
      counterGame({
        bot: (_state, player, _moves, ctx) => {
          (ctx as unknown as { profile: { stat(seat: string, name: string, n: number): void } }).profile.stat(player, "x", 1);
          return undefined;
        },
      }),
    ];
    for (const game of writers) {
      const match = expectMatch(createMatch(game, { playerCount: 2, seed: "bots" }));
      const before = JSON.stringify(match);
      const outcome = botMove(game, match, "p1", { now: 1 });
      expect(outcome.problem).toMatch(/bot for p1 failed/);
      expect(JSON.stringify(match)).toBe(before);
    }
  });

  it("draws from its own randomness, so the match's randomness stays untouched and the choice repeats", () => {
    const seen: number[] = [];
    const game = counterGame({
      bot: (_state, _player, moves, { random }) => {
        seen.push(random.int(1, 1_000_000));
        return moves[0];
      },
    });
    const match = expectMatch(createMatch(game, { playerCount: 2, seed: "bots" }));
    const before = JSON.stringify(match.randomState);
    botMove(game, match, "p1", { now: 1 });
    botMove(game, match, "p1", { now: 2 });
    expect(JSON.stringify(match.randomState)).toBe(before);
    expect(seen[0]).toBe(seen[1]);
  });

  it("passes players, options, profiles, now and away to the bot", () => {
    let context: unknown;
    const game = counterGame({
      bot: (_state, _player, moves, ctx) => {
        context = { players: ctx.players, options: ctx.options, profiles: ctx.profiles, now: ctx.now, away: ctx.away };
        return moves[0];
      },
    });
    const match = expectMatch(createMatch(game, { playerCount: 2, seed: "bots" }));
    botMove(game, match, "p1", { now: 42, away: ["p2"] });
    expect(context).toEqual({
      players: ["p1", "p2"],
      options: {},
      profiles: { p1: { items: {}, stats: {}, flags: {} }, p2: { items: {}, stats: {}, flags: {} } },
      now: 42,
      away: ["p2"],
    });
  });

  it("fills placeholders when it falls back to a random move, and checks the filled moves of the bot", () => {
    type Notes = GameState<{ notes: string[] }, Record<string, never>, null>;
    type Note = { type: "note"; text: string; size: number };
    const notes = (bot?: () => Note | undefined) =>
      defineGame<Notes, Note>({
        setup: ({ players }) => ({ public: { notes: [] }, players: Object.fromEntries(players.map((p) => [p, {}])), secret: null }),
        legalMoves: () => [{ type: "note", text: text({ min: 1, max: 5 }), size: int({ min: 1, max: 3 }) }],
        apply: (state, action) => {
          state.public.notes.push(action.text);
        },
        result: (state) => (state.public.notes.length >= 3 ? { winners: [] } : undefined),
        ...(bot === undefined ? {} : { bot }),
      });
    const random = notes();
    const match = expectMatch(createMatch(random, { playerCount: 1, seed: "notes" }));
    const filled = botMove(random, match, "p1", { now: 1 }).action as Note;
    expect(typeof filled.text).toBe("string");
    expect(filled.size).toBeGreaterThanOrEqual(1);
    const good = notes(() => ({ type: "note", text: "hallo", size: 2 }));
    expect(botMove(good, match, "p1", { now: 1 })).toEqual({ ok: true, action: { type: "note", text: "hallo", size: 2 }, chosen: "bot" });
    const bad = notes(() => ({ type: "note", text: "much too long", size: 2 }));
    expect(botMove(bad, match, "p1", { now: 1 }).problem).toMatch(/not legal/);
  });

  it("refuses seats that are not in the match", () => {
    const game = counterGame();
    const match = expectMatch(createMatch(game, { playerCount: 2, seed: "bots" }));
    expect(() => botMove(game, match, "p9", { now: 1 })).toThrow(/not a seat/);
    expect(() => botMove(game, match, "p1", { now: 1, away: ["p1", "p1"] })).toThrow(/distinct seats/);
  });
});

describe("Bots and away seats in realtime steps", () => {
  it("lets bot seats move after the inputs, before the tick", () => {
    const order: string[] = [];
    const game = runnerGame({
      bot: (state, player, moves) => {
        order.push(`${player}:${state.players[player]?.taps ?? 0}`);
        return moves.find((move) => move.type === "dir" && move.dir === 1);
      },
    });
    const match = expectMatch(createMatch(game, { playerCount: 3, seed: "rt" }));
    const step = stepMatch(game, match, { inputs: [{ player: "p1", action: { type: "dir", dir: -1 } }], now: 1, dt: tickMs, bots: ["p2", "p3"] });
    if (!step.ok) {
      throw new Error(step.error.message);
    }
    expect(step.results).toEqual([{ ok: true }]);
    expect(step.match.state.public.x).toEqual({ p1: -1, p2: 1, p3: 1 });
    expect(order).toEqual(["p2:0", "p3:0"]);
    expect(step.bots).toBeUndefined();
  });

  it("gives a realtime bot no input when it picks nothing, throws or picks an illegal move", () => {
    const games = [
      runnerGame({ bot: () => undefined }),
      runnerGame({
        bot: () => {
          throw new Error("kaputt");
        },
      }),
      runnerGame({ bot: () => ({ type: "dir", dir: 5 }) as never }),
    ];
    const problems = games.map((game) => {
      const match = expectMatch(createMatch(game, { playerCount: 2, seed: "rt" }));
      const step = stepMatch(game, match, { inputs: [], now: 1, dt: tickMs, bots: ["p2"] });
      if (!step.ok) {
        throw new Error(step.error.message);
      }
      expect(step.match.state.public.x).toEqual({ p1: 0, p2: 0 });
      return step.bots;
    });
    expect(problems[0]).toBeUndefined();
    expect(problems[1]?.[0]?.message).toMatch(/bot for p2 failed: .*kaputt/);
    expect(problems[2]?.[0]?.message).toMatch(/not legal/);
  });

  it("gives realtime games without a bot no random moves for bot seats", () => {
    const game = runnerGame();
    const match = expectMatch(createMatch(game, { playerCount: 2, seed: "rt" }));
    const step = stepMatch(game, match, { inputs: [], now: 1, dt: tickMs, bots: ["p2"] });
    expect(step.ok && step.match.state.public.x).toEqual({ p1: 0, p2: 0 });
  });

  it("passes the away seats to apply, tick and bot", () => {
    const seen: string[] = [];
    const game = runnerGame({
      apply: (_state, _action, { away }) => {
        seen.push(`apply:${away.join(",")}`);
      },
      tick: (state, _dt, { away }) => {
        state.public.ticks += 1;
        seen.push(`tick:${away.join(",")}`);
      },
      bot: (_state, _player, _moves, { away }) => {
        seen.push(`bot:${away.join(",")}`);
        return undefined;
      },
    });
    const match = expectMatch(createMatch(game, { playerCount: 3, seed: "rt" }));
    stepMatch(game, match, { inputs: [{ player: "p1", action: { type: "dir", dir: 1 } }], now: 1, dt: tickMs, away: ["p3"], bots: ["p2"] });
    stepMatch(game, match, { inputs: [], now: 2, dt: tickMs });
    expect(seen).toEqual(["apply:p3", "bot:p3", "tick:p3", "tick:"]);
  });

  it("refuses away and bot lists with unknown or repeated seats", () => {
    const game = runnerGame();
    const match = expectMatch(createMatch(game, { playerCount: 2, seed: "rt" }));
    expect(() => stepMatch(game, match, { inputs: [], now: 1, dt: tickMs, away: ["p7"] })).toThrow(/away must be a list of distinct seats/);
    expect(() => stepMatch(game, match, { inputs: [], now: 1, dt: tickMs, bots: ["p1", "p1"] })).toThrow(/bots must be a list of distinct seats/);
  });

  it("stays reproducible from seed, inputs, away and bots", () => {
    const game = runnerGame({ bot: (_state, _player, moves, { random }) => random.pick(moves) });
    const play = () => {
      let match = expectMatch(createMatch(game, { playerCount: 3, seed: "same" }));
      for (let tick = 0; tick < 8 && match.result === undefined; tick++) {
        const step = stepMatch(game, match, { inputs: [], now: tick * tickMs, dt: tickMs, bots: ["p1", "p3"], away: tick % 2 === 0 ? ["p2"] : [] });
        if (!step.ok) {
          throw new Error(step.error.message);
        }
        match = step.match;
      }
      return JSON.stringify(match);
    };
    expect(play()).toBe(play());
  });
});

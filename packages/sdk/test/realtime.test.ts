import { describe, expect, it } from "vitest";
import {
  applyMove,
  createMatch,
  playerSnapshot,
  screenSnapshot,
  stepMatch,
  tickMs,
  type Match,
  type StepOutcome,
} from "../src/platform";
import { counterGame } from "./fixtures/counter";
import { runnerGame, type RunnerAction, type RunnerState } from "./fixtures/runner";
import { expectMatch } from "./helpers";

type RunnerMatch = Match<RunnerState, RunnerAction>;

const runner = runnerGame();

function start(playerCount = 2, seed = "echtzeit"): RunnerMatch {
  return expectMatch(createMatch(runner, { playerCount, seed }));
}

function expectStep(outcome: StepOutcome<RunnerState, RunnerAction>) {
  if (!outcome.ok) {
    throw new Error(`expected a valid step, got ${outcome.error.code}: ${outcome.error.message}`);
  }
  return outcome;
}

describe("Realtime match", () => {
  it("counts ticks only for games with tick", () => {
    expect(start().tick).toBe(0);
    expect(expectMatch(createMatch(counterGame(), { playerCount: 2, seed: "x" })).tick).toBeUndefined();
  });

  it("applies the collected inputs in order and then computes a tick", () => {
    const match = start();
    const step = expectStep(
      stepMatch(runner, match, {
        inputs: [
          { player: "p1", action: { type: "dir", dir: 1 } },
          { player: "p2", action: { type: "dir", dir: -1 } },
          { player: "p1", action: { type: "dir", dir: -1 } },
        ],
        now: 1000,
        dt: tickMs,
      }),
    );
    expect(step.results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(step.match.state.public.x).toEqual({ p1: -1, p2: -1 });
    expect(step.match.state.players["p1"]?.taps).toBe(2);
    expect(step.match.state.public.dts).toEqual([50]);
    expect(step.match.version).toBe(match.version + 1);
    expect(step.match.tick).toBe(1);
  });

  it("rejects single inputs without holding up the tick", () => {
    const step = expectStep(
      stepMatch(runner, start(), {
        inputs: [
          { player: "p9", action: { type: "dir", dir: 1 } },
          { player: "p1", action: { type: "dir", dir: 2 } as unknown as RunnerAction },
          { player: "p2", action: { type: "dir", dir: 1 } },
        ],
        now: 0,
        dt: tickMs,
      }),
    );
    expect(step.results.map((result) => (result.ok ? "ok" : result.code))).toEqual(["unknown-player", "illegal-move", "ok"]);
    expect(step.match.state.public.x).toEqual({ p1: 0, p2: 1 });
  });

  it("computes no further tick when an input ends the match", () => {
    const match = start();
    const step = expectStep(
      stepMatch(runner, match, {
        inputs: [
          { player: "p1", action: { type: "finish" } },
          { player: "p2", action: { type: "dir", dir: 1 } },
        ],
        now: 0,
        dt: tickMs,
      }),
    );
    expect(step.results.map((result) => (result.ok ? "ok" : result.code))).toEqual(["ok", "game-over"]);
    expect(step.match.result).toEqual({ winners: ["p1", "p2"] });
    expect(step.match.state.public.dts).toEqual([]);
    expect(step.match.version).toBe(match.version + 1);
    expect(step.match.tick).toBe(1);
    expect(() => stepMatch(runner, step.match, { inputs: [], now: 0, dt: tickMs })).toThrow(/already over/);
  });

  it("ends the match when result returns a result after a tick", () => {
    let match = start();
    for (let tick = 0; tick < 10; tick++) {
      match = expectStep(stepMatch(runner, match, { inputs: [], now: tick * tickMs, dt: tickMs })).match;
    }
    expect(match.tick).toBe(10);
    expect(match.result).toEqual({ winners: ["p1", "p2"] });
  });

  it("allows phases in which nobody has inputs", () => {
    const game = runnerGame({ setup: (ctx) => ({ ...runner.setup(ctx), public: { ...runner.setup(ctx).public, countdown: 3 } }) });
    const created = expectMatch(createMatch(game, { playerCount: 2, seed: "countdown" }));
    expect(created.moves).toEqual({ p1: [], p2: [] });
    const step = expectStep(stepMatch(game, created, { inputs: [{ player: "p1", action: { type: "dir", dir: 1 } }], now: 0, dt: tickMs }));
    expect(step.results).toEqual([{ ok: false, code: "not-your-turn", message: "p1 cannot move right now" }]);
    expect(step.match.state.public.countdown).toBe(2);
  });

  it("reports an error in tick as game-error of phase tick without changing the match", () => {
    const game = runnerGame({
      tick: () => {
        throw new Error("wall");
      },
    });
    const match = expectMatch(createMatch(game, { playerCount: 2, seed: "x" }));
    const before = JSON.stringify(match);
    const outcome = stepMatch(game, match, { inputs: [{ player: "p1", action: { type: "dir", dir: 1 } }], now: 0, dt: tickMs });
    expect(outcome).toMatchObject({ ok: false, error: { code: "game-error", phase: "tick", message: "tick threw an error: wall" } });
    expect(JSON.stringify(match)).toBe(before);
  });

  it("makes the whole step fail when apply throws an error", () => {
    const game = runnerGame({
      apply: () => {
        throw new Error("broken");
      },
    });
    const match = expectMatch(createMatch(game, { playerCount: 2, seed: "x" }));
    const outcome = stepMatch(game, match, { inputs: [{ player: "p2", action: { type: "dir", dir: 1 } }], now: 0, dt: tickMs });
    expect(outcome).toMatchObject({ ok: false, error: { code: "game-error", phase: "apply", player: "p2" } });
  });

  it("reports invalid states and async from tick", () => {
    const broken = runnerGame({ tick: (state) => ({ ...state, extra: 1 }) as unknown as RunnerState });
    const asyncTick = runnerGame({ tick: (async () => undefined) as unknown as () => void });
    for (const [game, message] of [
      [broken, /tick returned an invalid state/],
      [asyncTick, /tick must not be async/],
    ] as const) {
      const match = expectMatch(createMatch(game, { playerCount: 2, seed: "x" }));
      const outcome = stepMatch(game, match, { inputs: [], now: 0, dt: tickMs });
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? "" : outcome.error.message).toMatch(message);
    }
  });

  it("accepts a new state returned by tick", () => {
    const game = runnerGame({ tick: (state) => ({ ...state, public: { ...state.public, ticks: 7 } }) });
    const match = expectMatch(createMatch(game, { playerCount: 2, seed: "x" }));
    expect(expectStep(stepMatch(game, match, { inputs: [], now: 0, dt: tickMs })).match.state.public.ticks).toBe(7);
  });

  it("is replayable from seed and inputs, also with randomness in tick", () => {
    const play = () => {
      let match = start(3, "gleich");
      for (let tick = 0; tick < 5; tick++) {
        match = expectStep(
          stepMatch(runner, match, { inputs: [{ player: `p${(tick % 3) + 1}`, action: { type: "dir", dir: 1 } }], now: tick, dt: tickMs }),
        ).match;
      }
      return JSON.stringify(match);
    };
    expect(play()).toBe(play());
  });

  it("protects the given match from changes", () => {
    const match = start();
    const before = JSON.stringify(match);
    stepMatch(runner, match, { inputs: [{ player: "p1", action: { type: "dir", dir: 1 } }], now: 0, dt: tickMs });
    expect(JSON.stringify(match)).toBe(before);
  });

  it("rejects stepMatch for turn-based matches and nonsensical times as caller errors", () => {
    const counter = counterGame();
    const turnBased = expectMatch(createMatch(counter, { playerCount: 2, seed: "x" }));
    expect(() => stepMatch(counter, turnBased, { inputs: [], now: 0, dt: tickMs })).toThrow(/only for realtime/);
    expect(() => stepMatch(runner, start(), { inputs: [], now: Number.NaN, dt: tickMs })).toThrow(RangeError);
    expect(() => stepMatch(runner, start(), { inputs: [], now: 0, dt: 0 })).toThrow(RangeError);
  });

  it("keeps the tick number for a single move and shows it in the snapshots", () => {
    const match = expectStep(stepMatch(runner, start(), { inputs: [], now: 0, dt: tickMs })).match;
    const moved = expectMatch(applyMove(runner, match, { player: "p1", action: { type: "dir", dir: 1 }, now: 0 }));
    expect(moved.tick).toBe(1);
    expect(playerSnapshot(moved, "p1").tick).toBe(1);
    expect(screenSnapshot(moved)).toEqual({ players: ["p1", "p2"], public: moved.state.public, version: moved.version, tick: 1 });
    expect("tick" in playerSnapshot(expectMatch(createMatch(counterGame(), { playerCount: 2, seed: "x" })), "p1")).toBe(false);
  });
});

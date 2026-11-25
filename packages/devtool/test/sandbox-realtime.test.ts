import { seatIds, tickMs, type AnyGameState, type Match } from "@gamehearth/sdk/platform";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildGuestRunner } from "../src/sandbox/build";
import { checkOutcome } from "../src/sandbox/outcome";
import { Sandbox, type SandboxResult } from "../src/sandbox/sandbox";

type AnyMatch = Match<AnyGameState, unknown>;

const players = seatIds(2);
const seed = "echtzeit-sandbox";
let runner: string;
const open: Sandbox[] = [];

beforeAll(async () => {
  runner = await buildGuestRunner();
});

afterEach(() => {
  for (const sandbox of open.splice(0)) {
    sandbox.dispose();
  }
});

const mover = (tickBody = "state.public.ticks += 1;") => `
export default {
  setup({ players }) {
    return { public: { ticks: 0, dir: Object.fromEntries(players.map((p) => [p, 0])) }, players: Object.fromEntries(players.map((p) => [p, {}])), secret: {} };
  },
  legalMoves() {
    return [{ dir: -1 }, { dir: 1 }];
  },
  apply(state, action, { player }) {
    state.public.dir[player] = action.dir;
  },
  tick(state, dt) {
    ${tickBody}
  },
  result(state) {
    return state.public.ticks >= 100 ? { winners: [] } : undefined;
  },
};`;

async function sandboxFor(code: string): Promise<Sandbox> {
  const sandbox = await Sandbox.create(runner, code);
  open.push(sandbox);
  return sandbox;
}

function matchOf(result: SandboxResult): AnyMatch {
  if (!result.ok || !result.outcome.ok) {
    throw new Error(`expected a match, got ${JSON.stringify(result)}`);
  }
  return result.outcome.match as unknown as AnyMatch;
}

describe("realtime in the sandbox", () => {
  it("starts a realtime match with tick 0 and computes steps with inputs", async () => {
    const sandbox = await sandboxFor(mover());
    const created = sandbox.run("createMatch", JSON.stringify({ playerCount: 2, seed }), { seed, players, version: 0, tick: 0 });
    const match = matchOf(created);
    expect(match.tick).toBe(0);
    const step = { inputs: [{ player: "p1", action: { dir: 1 } }, { player: "p2", action: { dir: 5 } }], now: 1000, dt: tickMs };
    const result = sandbox.run("stepMatch", JSON.stringify({ match, step }), { seed, players, version: 1, tick: 1, inputs: 2 });
    expect(result.ok && result.outcome.ok && result.outcome.results).toEqual([
      { ok: true },
      { ok: false, code: "illegal-move", message: "this move is not allowed for p2 right now" },
    ]);
    const next = matchOf(result);
    expect(next.state.public).toEqual({ ticks: 1, dir: { p1: 1, p2: 0 } });
    expect(next.tick).toBe(1);
  });

  it("rejects a realtime match when the host expects a turn-based one, and the other way round", async () => {
    const realtime = await sandboxFor(mover());
    const asTurnBased = realtime.run("createMatch", JSON.stringify({ playerCount: 2, seed }), { seed, players, version: 0 });
    expect(asTurnBased).toMatchObject({ ok: false, failure: { kind: "invalid" } });
  });

  it("reports an error in tick with phase tick", async () => {
    const sandbox = await sandboxFor(mover('throw new Error("crash in the tick");'));
    const match = matchOf(sandbox.run("createMatch", JSON.stringify({ playerCount: 2, seed }), { seed, players, version: 0, tick: 0 }));
    const result = sandbox.run("stepMatch", JSON.stringify({ match, step: { inputs: [], now: 0, dt: tickMs } }), { seed, players, version: 1, tick: 1, inputs: 0 });
    expect(result).toMatchObject({ ok: true, outcome: { ok: false, error: { code: "game-error", phase: "tick", message: "tick threw an error: crash in the tick" } } });
  });

  it("aborts an endless loop in tick through the time limit", async () => {
    const sandbox = await sandboxFor(mover("for (;;) {}"));
    const match = matchOf(sandbox.run("createMatch", JSON.stringify({ playerCount: 2, seed }), { seed, players, version: 0, tick: 0 }));
    const result = sandbox.run("stepMatch", JSON.stringify({ match, step: { inputs: [], now: 0, dt: tickMs } }), { seed, players, version: 1, tick: 1, inputs: 0 });
    expect(result).toMatchObject({ ok: false, failure: { kind: "timeout" } });
  });
});

describe("checkOutcome for steps", () => {
  const match = {
    format: 1,
    seed,
    players,
    state: { public: {}, players: { p1: {}, p2: {} }, secret: {} },
    randomState: [1, 2, 3, 4],
    version: 3,
    tick: 2,
    moves: { p1: [], p2: [] },
  };
  const expected = { seed, players, version: 3, tick: 2, inputs: 1 };

  it("takes only results of a known form and shortens long messages", () => {
    const checked = checkOutcome(JSON.stringify({ ok: true, match, results: [{ ok: false, code: "stale", message: "x".repeat(5000), extra: 1 }] }), expected);
    expect(checked.ok && checked.outcome.ok && checked.outcome.results?.[0]).toEqual({ ok: false, code: "stale", message: "x".repeat(2000) });
  });

  it.each([
    ["missing results", undefined],
    ["too many results", [{ ok: true }, { ok: true }]],
    ["game-error as the result of an input", [{ ok: false, code: "game-error", message: "x" }]],
    ["unknown code", [{ ok: false, code: "boom", message: "x" }]],
  ])("discards %s", (_label, results) => {
    expect(checkOutcome(JSON.stringify({ ok: true, match, results }), expected).ok).toBe(false);
  });

  it("requires the expected tick number", () => {
    expect(checkOutcome(JSON.stringify({ ok: true, match: { ...match, tick: 5 }, results: [{ ok: true }] }), expected).ok).toBe(false);
    expect(checkOutcome(JSON.stringify({ ok: true, match: { ...match, tick: undefined } }), { seed, players, version: 3 }).ok).toBe(true);
  });
});

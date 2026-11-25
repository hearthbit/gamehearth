import { seatIds, tickMs, type AnyGameState, type Match } from "@gamehearth/sdk/platform";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildGuestRunner } from "../src/sandbox/build";
import { checkOutcome } from "../src/sandbox/outcome";
import { Sandbox, type SandboxResult } from "../src/sandbox/sandbox";

type AnyMatch = Match<AnyGameState, unknown>;

const players = seatIds(2);
const seed = "bot-sandbox";
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

const game = (bot: string, tick = "") => `
export default {
  setup({ players }) {
    return { public: { turn: 0, dir: Object.fromEntries(players.map((p) => [p, 0])), ticks: 0 }, players: Object.fromEntries(players.map((p) => [p, {}])), secret: {} };
  },
  legalMoves(state, player) {
    return ${tick === "" ? 'player === "p" + (state.public.turn % 2 + 1) ? [{ dir: -1 }, { dir: 1 }] : []' : "[{ dir: -1 }, { dir: 1 }]"};
  },
  apply(state, action, { player }) {
    state.public.dir[player] = action.dir;
    state.public.turn += 1;
  },
  ${tick === "" ? "" : `tick(state) { ${tick} },`}
  bot(state, player, moves, ctx) { ${bot} },
  result(state) {
    return state.public.turn >= 50 || state.public.ticks >= 50 ? { winners: [] } : undefined;
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

describe("bots in the sandbox", () => {
  it("asks the game's bot for a move and hands back the match unchanged", async () => {
    const sandbox = await sandboxFor(game("return moves[1];"));
    const match = matchOf(sandbox.run("createMatch", JSON.stringify({ playerCount: 2, seed }), { seed, players, version: 0 }));
    const result = sandbox.run("botMove", JSON.stringify({ match, player: "p1", now: 1 }), { seed, players, version: 0 });
    expect(result.ok && result.outcome.ok && result.outcome.bot).toEqual({ chosen: "bot", action: { dir: 1 } });
    expect(result.ok && result.outcome.ok && result.outcome.hasBot).toBe(true);
    expect(matchOf(result)).toEqual(match);
  });

  it("says whether the game has a bot at all", async () => {
    const sandbox = await sandboxFor(game("return undefined;").replace(/bot\(state, player, moves, ctx\) \{ return undefined; \},/, ""));
    const match = matchOf(sandbox.run("createMatch", JSON.stringify({ playerCount: 2, seed }), { seed, players, version: 0 }));
    const result = sandbox.run("botMove", JSON.stringify({ match, player: "p1", now: 1 }), { seed, players, version: 0 });
    expect(result.ok && result.outcome.ok ? [result.outcome.hasBot, result.outcome.bot?.chosen] : undefined).toEqual([false, "random"]);
    const base = { seed, players, version: 0 };
    expect(checkOutcome(JSON.stringify({ ok: true, match, bot: { chosen: "none" }, hasBot: "yes" }), base)).toEqual({ ok: false, problem: "hasBot is not true or false" });
  });

  it("names the problem when the bot throws and takes a random move", async () => {
    const sandbox = await sandboxFor(game('throw new Error("kaputt");'));
    const match = matchOf(sandbox.run("createMatch", JSON.stringify({ playerCount: 2, seed }), { seed, players, version: 0 }));
    const result = sandbox.run("botMove", JSON.stringify({ match, player: "p1", now: 1 }), { seed, players, version: 0 });
    const bot = result.ok && result.outcome.ok ? result.outcome.bot : undefined;
    expect(bot?.chosen).toBe("random");
    expect(bot?.problem).toMatch(/kaputt/);
  });

  it("reports bot problems of a realtime step and moves bot seats in the step", async () => {
    const sandbox = await sandboxFor(game('return player === "p2" ? { dir: 9 } : moves[0];', "state.public.ticks += 1;"));
    const match = matchOf(sandbox.run("createMatch", JSON.stringify({ playerCount: 2, seed }), { seed, players, version: 0, tick: 0 }));
    const step = { inputs: [], now: 1, dt: tickMs, bots: ["p1", "p2"], away: ["p2"] };
    const result = sandbox.run("stepMatch", JSON.stringify({ match, step }), { seed, players, version: 1, tick: 1, inputs: 0 });
    expect(matchOf(result).state.public).toMatchObject({ dir: { p1: -1, p2: 0 } });
    expect(result.ok && result.outcome.ok && result.outcome.bots).toEqual([{ player: "p2", message: expect.stringMatching(/not legal/) }]);
  });

  it("refuses a bot answer of the wrong form", () => {
    const base = { seed, players, version: 0 };
    const match = { format: 1, seed, players, state: { public: {}, players: { p1: {}, p2: {} }, secret: {} }, randomState: [1, 2, 3, 4], version: 0, moves: { p1: [], p2: [] } };
    expect(checkOutcome(JSON.stringify({ ok: true, match, bot: { chosen: "magic" } }), base)).toEqual({ ok: false, problem: "bot has an unknown form" });
    expect(checkOutcome(JSON.stringify({ ok: true, match, bot: { chosen: "bot" } }), base)).toMatchObject({ ok: false });
    expect(checkOutcome(JSON.stringify({ ok: true, match, bots: [{ player: "p9", message: "x" }] }), base)).toMatchObject({ ok: false });
    expect(checkOutcome(JSON.stringify({ ok: true, match, bot: { chosen: "none", problem: "x".repeat(5000) } }), base)).toMatchObject({
      ok: true,
      outcome: { bot: { chosen: "none", problem: "x".repeat(2000) } },
    });
  });
});

describe("game features in the sandbox", () => {
  it("tells whether a game has a bot", async () => {
    const withBot = await sandboxFor(game("return moves[0];"));
    expect(withBot.features).toEqual({ bot: true });
    const without = await sandboxFor(game("return moves[0];").replace(/bot\(state, player, moves, ctx\) \{[^}]*\},/, ""));
    expect(without.features).toEqual({ bot: false });
  });
});

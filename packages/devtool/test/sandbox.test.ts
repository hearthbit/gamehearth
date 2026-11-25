import { SeededRandom, applyMove, createMatch, randomStateFromSeed, seatIds, type AnyGameState, type GameDefinition, type Match } from "@gamehearth/sdk/platform";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import mauMau from "../../../fixtures/mau-mau/src";
import { bundleGameModule } from "../src/bundle";
import { buildGuestRunner } from "../src/sandbox/build";
import type { GuestOutcome } from "../src/sandbox/outcome";
import { Sandbox, SandboxLoadError, type SandboxOptions, type SandboxResult } from "../src/sandbox/sandbox";

type AnyMatch = Match<AnyGameState, unknown>;

const mauMauDir = fileURLToPath(new URL("../../../fixtures/mau-mau", import.meta.url));
const players = seatIds(2);
const seed = "sandbox-test";
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

function counter(overrides = "", top = ""): string {
  return `${top}
const base = {
  setup({ players, random }) {
    const pile = random.shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    return {
      public: { count: 0, current: players[0] },
      players: Object.fromEntries(players.map((player) => [player, { secret: pile.pop() }])),
      secret: { pile },
    };
  },
  legalMoves(state, player) {
    return player === state.public.current ? [{ type: "step" }] : [];
  },
  apply(state, action, { player, players }) {
    state.public.count += 1;
    state.public.current = players[(players.indexOf(player) + 1) % players.length];
  },
  result(state) {
    return state.public.count >= 10 ? { winners: [state.public.current] } : undefined;
  },
};
export default { ...base, ${overrides} };`;
}

const memoryOnly: Partial<SandboxOptions> = { callTimeoutMs: 10_000 };

async function sandboxFor(code: string, options: Partial<SandboxOptions> = {}): Promise<Sandbox> {
  const sandbox = await Sandbox.create(runner, code, options);
  open.push(sandbox);
  return sandbox;
}

function create(sandbox: Sandbox): SandboxResult {
  return sandbox.run("createMatch", JSON.stringify({ playerCount: 2, seed }), { seed, players, version: 0 });
}

function matchOf(result: SandboxResult): AnyMatch {
  if (!result.ok || !result.outcome.ok) {
    throw new Error(`expected a match, got ${JSON.stringify(result)}`);
  }
  return result.outcome.match as unknown as AnyMatch;
}

function firstMove(sandbox: Sandbox, timed = false): { result: SandboxResult; elapsed: number } {
  const match = matchOf(create(sandbox));
  const input = JSON.stringify({ match, move: { player: "p1", action: { type: "step" }, now: 1000 } });
  const started = performance.now();
  const result = sandbox.run("applyMove", input, { seed, players, version: 1 });
  return { result, elapsed: timed ? performance.now() - started : 0 };
}

function failureOf(result: SandboxResult) {
  if (result.ok) {
    throw new Error(`expected a failure, got ${result.json.slice(0, 200)}`);
  }
  return result.failure;
}

function gameErrorOf(result: SandboxResult): string {
  if (!result.ok || result.outcome.ok) {
    throw new Error(`expected a game error, got ${JSON.stringify(result).slice(0, 200)}`);
  }
  return result.outcome.error.message;
}

describe("sandbox: same results as V8", () => {
  it("plays Mau-Mau for 2 to 6 players byte-identical to V8", async () => {
    const sandbox = await sandboxFor(await bundleGameModule(mauMauDir));
    const game = mauMau as unknown as GameDefinition<AnyGameState, unknown>;
    for (let playerCount = 2; playerCount <= 6; playerCount++) {
      for (let round = 0; round < 4; round++) {
        const gameSeed = `same-${playerCount}-${round}`;
        const seats = seatIds(playerCount);
        const v8 = createMatch(game, { playerCount, seed: gameSeed });
        const created = sandbox.run("createMatch", JSON.stringify({ playerCount, seed: gameSeed }), { seed: gameSeed, players: seats, version: 0 });
        expect(created.ok && created.json).toBe(JSON.stringify(v8));
        let match = (v8 as { match: AnyMatch }).match;
        const bot = new SeededRandom(randomStateFromSeed(gameSeed));
        for (let step = 0; match.result === undefined && step < 2000; step++) {
          const player = bot.pick(match.players.filter((seat) => (match.moves[seat] ?? []).length > 0));
          const move = { player, action: bot.pick(match.moves[player] ?? []), now: 1000 + step, expectedVersion: match.version };
          const expected = applyMove(game, match, move);
          const actual = sandbox.run("applyMove", JSON.stringify({ match, move }), { seed: gameSeed, players: seats, version: match.version + 1 });
          expect(actual.ok && actual.json).toBe(JSON.stringify(expected));
          match = (expected as { match: AnyMatch }).match;
        }
        expect(match.result).toBeDefined();
      }
    }
  }, 60_000);
});

describe("sandbox: time", () => {
  it("aborts an endless loop in apply after the time limit and wants to be set up anew", async () => {
    const sandbox = await sandboxFor(counter("apply(state) { for (;;) { state.public.count += 1; } },"));
    const { result, elapsed } = firstMove(sandbox, true);
    expect(failureOf(result).kind).toBe("timeout");
    expect(elapsed).toBeLessThan(1000);
    expect(sandbox.tainted).toBe("timeout");
    expect(failureOf(create(sandbox)).message).toContain("set up anew");
  });

  it("aborts an endless loop in legalMoves", async () => {
    const sandbox = await sandboxFor(counter("legalMoves(state, player) { while (state.public.count >= 1) {} return base.legalMoves(state, player); },"));
    expect(failureOf(firstMove(sandbox).result).kind).toBe("timeout");
  });

  it("does not let try, catch and finally catch the abort", async () => {
    const sandbox = await sandboxFor(counter("apply() { let n = 0; for (;;) { try { for (;;) { n += 1; } } catch { n += 1; } finally { n += 1; } } },"));
    expect(failureOf(firstMove(sandbox).result).kind).toBe("timeout");
  });

  it("aborts an endless loop while loading", async () => {
    await expect(Sandbox.create(runner, counter("", "let spins = 0; for (;;) { spins += 1; }"), { loadTimeoutMs: 200 })).rejects.toThrow(
      /Time limit exceeded while loading/,
    );
  });

  it("discards the result when built-in functions run past the time limit without an abort", async () => {
    const sandbox = await sandboxFor(
      counter("apply(state) { const values = new Int32Array(1000000); for (let round = 0; round < 20; round++) { values.reverse(); values.sort(); } state.public.count += values[0] + 1; },"),
      { callTimeoutMs: 10 },
    );
    const failure = failureOf(firstMove(sandbox).result);
    expect(failure.kind).toBe("timeout");
    expect(failure.message).toMatch(/took \d+ ms/);
  });

  it("reads an error with a hanging getter only with a deadline", async () => {
    const top = "const evil = { get name() { for (;;) {} }, message: 'hangs' }; JSON.stringify = () => { throw evil; };";
    const sandbox = await sandboxFor(counter("", top));
    const started = performance.now();
    const failure = failureOf(create(sandbox));
    expect(failure.kind).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("sandbox: memory and stack", () => {
  it("stops unlimited allocation of memory at the cap and wants to be set up anew", async () => {
    const sandbox = await sandboxFor(counter("apply() { const hog = []; for (;;) { hog.push(new Array(100000).fill(hog.length)); } },"), memoryOnly);
    expect(gameErrorOf(firstMove(sandbox).result)).toContain("out of memory");
    expect(sandbox.tainted).toBe("memory");
  });

  it("sets up a sandbox anew after more than 8 MB of growth, even without out of memory", async () => {
    const sandbox = await sandboxFor(counter("apply(state, action, ctx) { base.apply(state, action, ctx); globalThis.kept = new Array(1200000).fill(1.5); },"), memoryOnly);
    const { result } = firstMove(sandbox);
    expect(result.ok && result.outcome.ok).toBe(true);
    expect(sandbox.tainted).toBe("memory");
  });

  it("rejects a game that already uses a lot of memory while loading", async () => {
    await expect(Sandbox.create(runner, counter("", "export const hog = new Array(1200000).fill(1.5);"))).rejects.toThrow(/more than \d+ MB while loading/);
  });

  it("reports endless recursion as a game error and stays usable", async () => {
    const sandbox = await sandboxFor(counter("apply(state) { const deep = (n) => deep(n + 1) + 1; state.public.count = deep(0); },"));
    expect(gameErrorOf(firstMove(sandbox).result)).toMatch(/stack overflow/);
    expect(sandbox.tainted).toBeUndefined();
    expect(create(sandbox).ok).toBe(true);
  });

  it("discards a sandbox after an overflow of the native stack without disturbing the process", async () => {
    const code = counter("apply(state) { const depth = 2000000; state.public.count = JSON.parse('['.repeat(depth) + ']'.repeat(depth)).length; },");
    const sandbox = await sandboxFor(code);
    const nest = (depth: number, run: () => SandboxResult): SandboxResult => (depth === 0 ? run() : nest(depth - 1, run));
    const match = matchOf(create(sandbox));
    const input = JSON.stringify({ match, move: { player: "p1", action: { type: "step" }, now: 1000 } });
    const result = nest(6000, () => sandbox.run("applyMove", input, { seed, players, version: 1 }));
    expect(failureOf(result).kind).toBe("crash");
    expect(() => sandbox.dispose()).not.toThrow();
    const fresh = await sandboxFor(code);
    expect(create(fresh).ok).toBe(true);
  });
});

describe("sandbox: isolation", () => {
  it("gives games no access to Node, network, randomness, clock or code from text", async () => {
    const probe = `apply(state, action, ctx) {
      base.apply(state, action, ctx);
      const attempt = (run) => { try { return "returns " + String(run()); } catch (error) { return "throws"; } };
      state.public.report = {
        types: ["require", "process", "fetch", "module", "Buffer", "console", "setTimeout", "WebAssembly", "XMLHttpRequest", "WebSocket", "performance", "WeakRef"].map((name) => typeof globalThis[name]),
        calls: [
          attempt(() => Math.random()),
          attempt(() => Date.now()),
          attempt(() => new Date()),
          attempt(() => new Date(0).constructor.now()),
          attempt(() => eval("1")),
          attempt(() => Function("return 1")()),
          attempt(() => Object.getPrototypeOf(function* () {}).constructor("yield 1")),
          attempt(() => (async () => {}).constructor("return 1")),
          attempt(() => (() => {}).constructor("return process")()),
          attempt(() => Object.getOwnPropertyDescriptor(Date, "now").value()),
          attempt(() => Reflect.getOwnPropertyDescriptor(new Date(0).constructor, "now").value()),
          attempt(() => new Date(0).getHours()),
          attempt(() => new Date(0).getTimezoneOffset()),
          attempt(() => new Date(0).toString()),
          attempt(() => new Date(2026, 0, 1)),
          attempt(() => new Date("2026-01-01T12:00")),
          attempt(() => Date.parse("2026-01-01T12:00")),
        ],
        allowed: [
          new Date(0).getTime(),
          new Date(0).getUTCFullYear(),
          Date.UTC(2026, 0, 1),
          new Date(Date.UTC(2026, 0, 1)).toISOString(),
          (function () {}) instanceof Function,
          (function () {}).constructor === Function,
          typeof Function.prototype.call,
          Object.getPrototypeOf(function* () {}).constructor.prototype === Object.getPrototypeOf(function* () {}),
        ],
      };
    },`;
    const sandbox = await sandboxFor(counter(probe));
    const { result } = firstMove(sandbox);
    const report = ((result as { outcome: GuestOutcome }).outcome as { match: AnyMatch }).match.state.public as {
      report: { types: string[]; calls: string[]; allowed: unknown[] };
    };
    expect(report.report.types.every((type) => type === "undefined")).toBe(true);
    expect(report.report.calls).toEqual(report.report.calls.map(() => "throws"));
    expect(report.report.allowed).toEqual([0, 1970, 1767225600000, "2026-01-01T00:00:00.000Z", true, true, "function", true]);
  });

  it("loads no game that imports Node modules", async () => {
    const code = `import { readFileSync } from "node:fs";\n${counter()}\nexport const peek = () => readFileSync("secret.txt", "utf8");`;
    await expect(Sandbox.create(runner, code)).rejects.toThrow(/could not load module/);
  });

  it("loads no module that does not export a game", async () => {
    await expect(Sandbox.create(runner, "export default { setup() {} };")).rejects.toThrow(SandboxLoadError);
    await expect(Sandbox.create(runner, "export default 42;")).rejects.toThrow(/does not export a game/);
  });
});

describe("sandbox: the host checks the output", () => {
  const tamper = (replace: string) =>
    `const original = JSON.stringify; JSON.stringify = function (value, ...rest) { const text = original.call(JSON, value, ...rest); const final = value !== null && typeof value === "object" && value.ok === true && value.match !== undefined; return final ? ${replace} : text; };`;

  it("detects a forged version number", async () => {
    const sandbox = await sandboxFor(counter("", tamper("text.replace('\"version\":0', '\"version\":9999')")));
    const failure = failureOf(create(sandbox));
    expect(failure).toMatchObject({ kind: "invalid", message: expect.stringContaining("version is 9999") });
    expect(sandbox.tainted).toBe("invalid");
  });

  it("detects a smuggled-in seat even if the check in the SDK is bypassed", async () => {
    const top = "const includes = Array.prototype.includes; Array.prototype.includes = function (...args) { return args[0] === 'p9' ? true : includes.apply(this, args); };";
    const sandbox = await sandboxFor(counter("apply(state, action, ctx) { base.apply(state, action, ctx); state.players.p9 = { secret: 0 }; },", top));
    expect(failureOf(firstMove(sandbox).result).message).toContain("state.players does not match the seats");
  });

  it("detects nesting that is too deep and takes no extra fields", async () => {
    const deep = "'['.repeat(2000) + ']'.repeat(2000)";
    const tooDeep = await sandboxFor(counter("", tamper(`text.replace('"public":{', '"public":{"deep":' + ${deep} + ',')`)));
    expect(failureOf(create(tooDeep)).message).toContain("deeper than 100 levels");
    const extra = await sandboxFor(counter("", tamper(`text.replace('"match":{', '"match":{"extra":' + '['.repeat(120000) + ']'.repeat(120000) + ',')`)));
    const result = create(extra);
    expect(result.ok).toBe(true);
    expect(JSON.stringify((result as { outcome: GuestOutcome }).outcome)).not.toContain("extra");
  });

  it("does not even copy out output that is too large", async () => {
    const sandbox = await sandboxFor(counter("apply(state, action, ctx) { base.apply(state, action, ctx); state.public.blob = 'x'.repeat(300000); },"));
    expect(failureOf(firstMove(sandbox).result)).toMatchObject({ kind: "invalid", message: expect.stringContaining("allowed are 262144") });
  });

  it("measures the output in UTF-8 bytes, not in characters", async () => {
    const sandbox = await sandboxFor(counter("apply(state, action, ctx) { base.apply(state, action, ctx); state.public.blob = 'ä'.repeat(200000); },"));
    expect(failureOf(firstMove(sandbox).result)).toMatchObject({ kind: "invalid", message: expect.stringContaining("bytes") });
  });

  it("limits the number of nodes so that the host does not compute long on one state", async () => {
    const sandbox = await sandboxFor(counter("", tamper(`text.replace('"public":{', '"public":{"bloat":[' + '{},'.repeat(84999) + '{}],')`)));
    expect(failureOf(create(sandbox))).toMatchObject({ kind: "invalid", message: expect.stringContaining("nodes") });
  });
});

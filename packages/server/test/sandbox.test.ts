import { bundleGameModule } from "gamehearth";
import { seatIds } from "@gamehearth/sdk/platform";
import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { SandboxHost, sandboxWorkerFile, type HostResult, type SandboxHostOptions } from "../src/sandbox/host";
import { mauMauDir } from "./helpers";

const players = seatIds(2);
const seed = "worker-test";
const hosts: SandboxHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.close();
  }
});

export function counterGame(overrides = "", top = ""): string {
  return `${top}
const base = {
  setup({ players, random }) {
    const pile = random.shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    return { public: { count: 0, current: players[0] }, players: Object.fromEntries(players.map((player) => [player, { secret: pile.pop() }])), secret: { pile } };
  },
  legalMoves(state, player) { return player === state.public.current ? [{ type: "step" }] : []; },
  apply(state, action, { player, players }) { state.public.count += 1; state.public.current = players[(players.indexOf(player) + 1) % players.length]; },
  result(state) { return state.public.count >= 10 ? { winners: [state.public.current] } : undefined; },
};
export default { ...base, ${overrides} };`;
}

async function startHost(options: Partial<SandboxHostOptions> = {}): Promise<{ host: SandboxHost; logs: string[] }> {
  const logs: string[] = [];
  const host = await SandboxHost.start({ callHardLimitMs: 300, log: (message) => logs.push(message), ...options });
  hosts.push(host);
  return { host, logs };
}

function create(host: SandboxHost, room: string, build: string): Promise<HostResult> {
  return host.run(room, build, "createMatch", JSON.stringify({ playerCount: 2, seed }), { seed, players, version: 0 });
}

async function firstMove(host: SandboxHost, room: string, build: string, options: Parameters<SandboxHost["run"]>[5] = {}): Promise<HostResult> {
  const created = await create(host, room, build);
  if (!created.ok || !created.outcome.ok) {
    throw new Error(`createMatch failed: ${JSON.stringify(created)}`);
  }
  const input = JSON.stringify({ match: created.outcome.match, move: { player: "p1", action: { type: "step" }, now: 1000 } });
  return host.run(room, build, "applyMove", input, { seed, players, version: 1 }, options);
}

const forever = counterGame(
  "apply(state) { const values = new Int32Array(4000000); for (let round = 0; round < 1000000; round++) { values.reverse(); values.sort(); } state.public.count = values[0]; },",
);

describe("Sandbox worker", () => {
  it("runs Mau-Mau in the worker", async () => {
    const { host } = await startHost();
    host.register("mau-mau@test", await bundleGameModule(mauMauDir));
    const created = await host.run("RAUM01", "mau-mau@test", "createMatch", JSON.stringify({ playerCount: 3, seed }), { seed, players: seatIds(3), version: 0 });
    expect(created.ok && created.outcome.ok && created.outcome.match.players).toEqual(["p1", "p2", "p3"]);
  });

  it("checks on install whether the module is a game", async () => {
    const { host } = await startHost();
    expect(await host.verify("gut@1", counterGame())).toBeUndefined();
    expect(await host.verify("schlecht@1", "export default 42;")).toMatch(/does not export a game/);
    expect(await host.verify("schleife@1", "for (;;) {}\nexport default 1;")).toMatch(/Time limit exceeded while loading/);
  });

  it("aborts an endless loop after the time limit and sets up the room's sandbox anew", async () => {
    const { host } = await startHost();
    host.register("schleife@1", counterGame("apply(state) { for (;;) { state.public.count += 1; } },"));
    const result = await firstMove(host, "RAUM01", "schleife@1");
    expect(!result.ok && result.failure.kind).toBe("timeout");
    expect((await create(host, "RAUM01", "schleife@1")).ok).toBe(true);
    expect(host.restarts).toBe(0);
  });

  it("stops the worker after the hard limit and repeats the waiting move of another room", async () => {
    const { host, logs } = await startHost();
    host.register("ewig@1", forever);
    host.register("zaehlen@1", counterGame());
    const created = await create(host, "BOESE1", "ewig@1");
    expect(created.ok).toBe(true);
    const match = created.ok && created.outcome.ok ? created.outcome.match : undefined;
    const started = performance.now();
    const attack = host.run("BOESE1", "ewig@1", "applyMove", JSON.stringify({ match, move: { player: "p1", action: { type: "step" }, now: 1 } }), {
      seed,
      players,
      version: 1,
    });
    const bystander = create(host, "NEBEN1", "zaehlen@1");
    const [attacked, waited] = await Promise.all([attack, bystander]);
    expect(!attacked.ok && attacked.failure.kind).toBe("killed");
    expect(performance.now() - started).toBeLessThan(3000);
    expect(waited.ok).toBe(true);
    expect(host.restarts).toBe(1);
    expect(logs.join("\n")).toMatch(/hard limit of 300 ms exceeded during a call; build ewig@1, room BOESE1/);
  }, 20_000);

  it("quarantines a build after three hard aborts", async () => {
    const { host, logs } = await startHost({ callHardLimitMs: 150 });
    host.register("ewig@1", forever);
    for (let round = 0; round < 3; round++) {
      const result = await firstMove(host, `RAUM0${round}`, "ewig@1");
      expect(!result.ok && result.failure.kind).toBe("killed");
    }
    const blocked = await create(host, "RAUM09", "ewig@1");
    expect(!blocked.ok && blocked.failure.kind).toBe("quarantine");
    expect(host.quarantined("ewig@1")).toBe(true);
    expect(logs.join("\n")).toContain("quarantined after 3 hard");
  }, 20_000);

  it("also stops a game that catches out of memory and continues", async () => {
    const { host } = await startHost();
    host.register(
      "fresser@1",
      counterGame("apply(state) { let hog = []; for (;;) { try { for (;;) { hog.push('y'.repeat(1000000) + hog.length); } } catch { hog = []; } } },"),
    );
    const result = await firstMove(host, "RAUM01", "fresser@1");
    expect(result.ok).toBe(false);
    expect(["killed", "timeout"]).toContain(!result.ok && result.failure.kind);
  }, 20_000);

  it("measures slow loading in the middle of a call against the loading limit", async () => {
    const { host } = await startHost({ callHardLimitMs: 100, loadHardLimitMs: 5000, sandbox: { loadTimeoutMs: 4000 } });
    host.register("langsam@1", counterGame("", "let spins = 0; for (let i = 0; i < 30000000; i++) { spins += 1; }"));
    const started = performance.now();
    const result = await create(host, "RAUM01", "langsam@1");
    expect(performance.now() - started).toBeGreaterThan(150);
    expect(result.ok).toBe(true);
    expect(host.restarts).toBe(0);
  }, 20_000);
});

const counting = counterGame(
  "",
  "globalThis.calls = 0; const setupBase = { setup(ctx) { globalThis.calls += 1; const state = base.setup(ctx); state.public.calls = globalThis.calls; return state; } };",
).replace("export default { ...base, ", "export default { ...base, ...setupBase, ");

async function calls(host: SandboxHost, room: string, build: string): Promise<number> {
  const result = await create(host, room, build);
  if (!result.ok || !result.outcome.ok) {
    throw new Error(`createMatch failed: ${JSON.stringify(result)}`);
  }
  return (result.outcome.match.state.public as { calls: number }).calls;
}

describe("Sandbox worker: findings from the review", () => {
  it("registers a build only if it passes the check", async () => {
    const { host } = await startHost();
    expect(await host.verify("schlecht@1", "export default 42;")).toMatch(/does not export a game/);
    const result = await create(host, "RAUM01", "schlecht@1");
    expect(!result.ok && result.failure.message).toMatch(/not loaded/);
  });

  it("quarantines a build after repeated soft aborts too", async () => {
    const { host, logs } = await startHost({ softQuarantineAfter: 3 });
    host.register("schleife@1", counterGame("apply(state) { for (;;) { state.public.count += 1; } },"));
    for (let round = 0; round < 3; round++) {
      const result = await firstMove(host, "RAUM01", "schleife@1");
      expect(!result.ok && result.failure.kind).toBe("timeout");
    }
    const blocked = await create(host, "RAUM02", "schleife@1");
    expect(!blocked.ok && blocked.failure.kind).toBe("quarantine");
    expect(logs.join("\n")).toContain("0 hard and 3 soft aborts");
    expect(host.quarantinedBuilds()).toEqual([{ build: "schleife@1", since: expect.any(Number), reason: "0 hard and 3 soft aborts in 10 minutes", hardAborts: 0, softAborts: 3, windowMinutes: 10 }]);
  });

  it("Review 8b: does not count an abort that the caller recomputes itself", async () => {
    const { host } = await startHost({ softQuarantineAfter: 2 });
    host.register("schleife@1", counterGame("apply(state) { for (;;) { state.public.count += 1; } },"));
    for (let round = 0; round < 3; round++) {
      const result = await firstMove(host, "RAUM01", "schleife@1", { tolerate: ["timeout", "memory"] });
      expect(!result.ok && result.failure.kind).toBe("timeout");
    }
    expect(host.quarantined("schleife@1")).toBe(false);
    expect((await firstMove(host, "RAUM01", "schleife@1")).ok).toBe(false);
    expect((await firstMove(host, "RAUM01", "schleife@1")).ok).toBe(false);
    expect(host.quarantined("schleife@1")).toBe(true);
  });

  it("lets aborts expire after the time window", async () => {
    const { host } = await startHost({ softQuarantineAfter: 2, abortWindowMs: 300 });
    host.register("schleife@1", counterGame("apply(state) { for (;;) { state.public.count += 1; } },"));
    expect((await firstMove(host, "RAUM01", "schleife@1")).ok).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await firstMove(host, "RAUM01", "schleife@1")).ok).toBe(false);
    expect(host.quarantined("schleife@1")).toBe(false);
  });

  it("repeats a waiting request exactly once", async () => {
    const { host } = await startHost({ callHardLimitMs: 200 });
    host.register("ewig@1", forever);
    host.register("zaehlen@1", counterGame());
    const createdA = await create(host, "BOESE1", "ewig@1");
    const createdC = await create(host, "BOESE2", "ewig@1");
    const move = (result: HostResult) =>
      JSON.stringify({ match: result.ok && result.outcome.ok ? result.outcome.match : undefined, move: { player: "p1", action: { type: "step" }, now: 1 } });
    const attackA = host.run("BOESE1", "ewig@1", "applyMove", move(createdA), { seed, players, version: 1 });
    const attackC = host.run("BOESE2", "ewig@1", "applyMove", move(createdC), { seed, players, version: 1 });
    const bystander = create(host, "NEBEN1", "zaehlen@1");
    const [a, c, b] = await Promise.all([attackA, attackC, bystander]);
    expect(!a.ok && a.failure.kind).toBe("killed");
    expect(!c.ok && c.failure.kind).toBe("killed");
    expect(!b.ok && b.failure.message).toMatch(/aborted after a restart of the sandbox worker/);
    expect(host.restarts).toBe(2);
  }, 20_000);

  it("answers open requests on close", async () => {
    const { host } = await startHost();
    host.register("ewig@1", forever);
    const created = await create(host, "RAUM01", "ewig@1");
    expect(created.ok && created.outcome.ok).toBe(true);
    const match = created.ok && created.outcome.ok ? created.outcome.match : undefined;
    const pending = host.run("RAUM01", "ewig@1", "applyMove", JSON.stringify({ match, move: { player: "p1", action: { type: "step" }, now: 1000 } }), {
      seed,
      players,
      version: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await host.close();
    const result = await pending;
    expect(!result.ok && result.failure.kind).toBe("killed");
  });

  it("discards sandboxes after idling and keeps at most the allowed number", async () => {
    const { host } = await startHost({ idleMs: 1000, maxSandboxes: 2 });
    host.register("zaehlen@1", counting);
    expect(await calls(host, "RAUM01", "zaehlen@1")).toBe(1);
    expect(await calls(host, "RAUM01", "zaehlen@1")).toBe(2);
    expect(await calls(host, "RAUM02", "zaehlen@1")).toBe(1);
    expect(await calls(host, "RAUM03", "zaehlen@1")).toBe(1);
    expect(await calls(host, "RAUM01", "zaehlen@1")).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(await calls(host, "RAUM01", "zaehlen@1")).toBe(1);
  }, 20_000);

  it("rewrites the worker script when it vanished before a restart", async () => {
    const { host, logs } = await startHost({ callHardLimitMs: 200 });
    host.register("ewig@1", forever);
    host.register("zaehlen@1", counterGame());
    expect((await create(host, "RAUM02", "zaehlen@1")).ok).toBe(true);
    rmSync(await sandboxWorkerFile());
    const killed = await firstMove(host, "RAUM01", "ewig@1");
    expect(!killed.ok && killed.failure.kind).toBe("killed");
    expect((await create(host, "RAUM02", "zaehlen@1")).ok).toBe(true);
    expect(host.restarts, logs.join(" | ")).toBe(1);
  }, 20_000);
});

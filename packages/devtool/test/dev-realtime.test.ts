import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleGameForDev } from "../src/bundle";
import { DevEngine } from "../src/dev/engine";
import { startDev, type DevServer } from "../src/dev/server";
import { buildErrorCollectMs } from "../src/dev/server";
import { DevSession, inputsPerSecond, maxLagMs, nextDue, type DevProblem, type SandboxCaller } from "../src/dev/session";

const devtool = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(devtool, "dev-realtime-"));

afterAll(() => rmSync(work, { recursive: true, force: true }));

const allDirections = 'state.public.ticks >= 100 ? [] : [{ type: "dir", dir: -1 }, { type: "dir", dir: 0 }, { type: "dir", dir: 1 }]';

function writeGame(dir: string, tickBody = "state.public.ticks += 1;", legal = allDirections): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "index.ts"),
    [
      'import { defineGame } from "@gamehearth/sdk";',
      "type State = { public: { ticks: number; x: Record<string, number>; dir: Record<string, number> }; players: Record<string, object>; secret: { note: string } };",
      'type Action = { type: "dir"; dir: -1 | 0 | 1 };',
      "export default defineGame<State, Action>({",
      "  setup({ players }) {",
      "    return { public: { ticks: 0, x: Object.fromEntries(players.map((p) => [p, 0])), dir: Object.fromEntries(players.map((p) => [p, 0])) }, players: Object.fromEntries(players.map((p) => [p, {}])), secret: { note: \"secret\" } };",
      "  },",
      "  legalMoves(state, player) {",
      `    return ${legal};`,
      "  },",
      "  apply(state, action, { player }) {",
      "    state.public.dir[player] = action.dir;",
      "  },",
      "  tick(state) {",
      `    ${tickBody}`,
      "    for (const player of Object.keys(state.public.x)) {",
      "      state.public.x[player] = (state.public.x[player] ?? 0) + (state.public.dir[player] ?? 0);",
      "    }",
      "  },",
      "  result(state) {",
      "    return state.public.ticks >= 100 ? { winners: [] } : undefined;",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "punkte",
      name: "Punkte",
      version: "0.1.0",
      sdk: "^0.1.1",
      license: { code: "MIT", assets: "CC0-1.0" },
      mode: "realtime",
      players: { min: 2, max: 3 },
      server: true,
      client: "dist/client",
      roles: { screen: { inputs: [], screen: "large" }, controller: { inputs: ["touch"], screen: "small" } },
    }),
  );
}

async function session(
  dir: string,
  engine: DevEngine,
  logged: DevProblem[] = [],
  pick: (count: number) => number = () => 1,
  caller: SandboxCaller = engine,
): Promise<DevSession> {
  const bundle = await bundleGameForDev(dir);
  expect(await engine.load(bundle.code)).toEqual({ ok: true });
  return new DevSession({ engine: caller, realtime: true, timers: false, pick, now: () => 1000, log: (problem) => logged.push(problem) });
}

function settled<T>(promise: Promise<T>, ms = 1000): Promise<T | "hangs"> {
  return Promise.race([promise, new Promise<"hangs">((resolve) => setTimeout(() => resolve("hangs"), ms))]);
}

function failingTicks(engine: DevEngine, failures: number, kind: "timeout" | "memory" | "crash" | "error" = "timeout"): SandboxCaller & { calls: number } {
  let left = failures;
  const caller = {
    calls: 0,
    call: async (...args: Parameters<SandboxCaller["call"]>) => {
      if (args[0] === "stepMatch") {
        caller.calls += 1;
        if (left > 0) {
          left -= 1;
          return { ok: false as const, failure: { kind, message: "The game code did not respond in time" } };
        }
      }
      return engine.call(...args);
    },
  };
  return caller;
}

describe("dev: realtime match", () => {
  let engine: DevEngine;

  beforeAll(async () => {
    engine = await DevEngine.start({ limitMs: 1500 });
  });
  afterAll(async () => engine.close());

  it("collects inputs until the next tick and shows tick, TV and inputs", async () => {
    const dir = join(work, "match");
    writeGame(dir);
    const logged: DevProblem[] = [];
    const dev = await session(dir, engine, logged);
    await dev.newMatch(2, "fixed");
    expect(dev.view().realtime).toMatchObject({ tick: 0, running: true, speed: 1, inputs: 0 });
    const move = dev.move("p1", { type: "dir", dir: 1 });
    const wrong = dev.move("p2", { type: "dir", dir: 7 });
    await dev.step();
    expect(await move).toEqual({ ok: true });
    expect(await wrong).toMatchObject({ ok: false, code: "illegal-move" });
    expect(logged.map((problem) => problem.title)).toEqual(["The UI of p2 sent an input that is not legal"]);
    await dev.step();
    const view = dev.view();
    expect(view.realtime).toMatchObject({ tick: 2, inputs: 1 });
    expect(view.screen).toEqual({ players: ["p1", "p2"], public: { ticks: 2, x: { p1: 2, p2: 0 }, dir: { p1: 1, p2: 0 } }, version: 2, tick: 2 });
    expect(JSON.stringify(view.screen)).not.toContain("secret");
    expect(view.moves).toEqual([{ number: 1, seat: "p1", action: { type: "dir", dir: 1 }, bot: false }]);
    dev.close();
  });

  it("lets bots press at random per tick and drops the oldest input like the server", async () => {
    const dir = join(work, "bots");
    writeGame(dir);
    const dev = await session(dir, engine, [], () => 0);
    await dev.newMatch(2, "bots");
    dev.setBot("p2", true);
    const flood = [-1, 0, 1, 0].map((direction) => dev.move("p1", { type: "dir", dir: direction }));
    const newest = dev.move("p1", { type: "dir", dir: 1 });
    expect(await flood[0]).toMatchObject({ ok: false, code: "too-many-inputs" });
    await dev.step();
    expect(await Promise.all([...flood.slice(1), newest])).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
    expect(dev.view().moves.filter((entry) => entry.seat === "p1").map((entry) => entry.action)).toEqual([0, 1, 0, 1].map((direction) => ({ type: "dir", dir: direction })));
    expect(dev.view().moves.filter((entry) => entry.bot).map((entry) => entry.seat)).toEqual(["p2"]);
    dev.close();
  }, 20_000);

  it("pauses on an error in tick and runs again after Resume", async () => {
    const dir = join(work, "error");
    writeGame(dir, 'state.public.ticks += 1; if (state.public.ticks === 2) { throw new Error("wall"); }');
    const logged: DevProblem[] = [];
    const dev = await session(dir, engine, logged);
    await dev.newMatch(2, "error");
    await dev.step();
    await dev.step();
    expect(dev.view().realtime?.running).toBe(false);
    expect(dev.view().problem?.title).toMatch(/Error in tick \(tick 2\); the match is paused/);
    expect(logged[0]?.message).toBe("tick threw an error: wall");
    dev.pause(false);
    expect(dev.view().problem).toBeUndefined();
    expect(dev.view().realtime?.tick).toBe(1);
    dev.close();
  });

  it("Review 8b: answers inputs while paused right away and takes the last one per seat into the next tick", async () => {
    const dir = join(work, "pause");
    writeGame(dir);
    const dev = await session(dir, engine);
    await dev.newMatch(2, "pause");
    dev.pause(true);
    expect(await settled(dev.move("p1", { type: "dir", dir: 1 }))).toEqual({ ok: true });
    expect(await settled(dev.move("p1", { type: "dir", dir: -1 }))).toEqual({ ok: true });
    expect(await settled(dev.move("p2", { type: "dir", dir: 1 }))).toEqual({ ok: true });
    await dev.step();
    expect(dev.view().screen).toMatchObject({ public: { x: { p1: -1, p2: 1 } }, tick: 1 });
    await dev.step();
    expect(dev.view().screen).toMatchObject({ public: { x: { p1: -2, p2: 2 } }, tick: 2 });
    const waiting = dev.move("p2", { type: "dir", dir: 0 });
    dev.pause(true);
    expect(await settled(waiting)).toEqual({ ok: true });
    dev.pause(false);
    await dev.step();
    expect(dev.view().screen).toMatchObject({ public: { dir: { p2: 0 } } });
    dev.close();
  });

  it("Review 8b: answers inputs after an error in tick right away and plays them in after Resume", async () => {
    const dir = join(work, "error-input");
    writeGame(dir, 'state.public.ticks += 1; if (state.public.ticks === 2 && state.public.dir.p2 === 0) { throw new Error("wall"); }');
    const dev = await session(dir, engine);
    await dev.newMatch(2, "error-input");
    await dev.step();
    await dev.step();
    expect(dev.view().realtime?.running).toBe(false);
    expect(await settled(dev.move("p2", { type: "dir", dir: 1 }))).toEqual({ ok: true });
    dev.pause(false);
    await dev.step();
    expect(dev.view().problem).toBeUndefined();
    expect(dev.view().screen).toMatchObject({ public: { dir: { p2: 1 }, x: { p2: 1 } }, tick: 2 });
    dev.close();
  });

  it("Review 8b: computes a tick once more after a timeout, memory problem or crash", async () => {
    const dir = join(work, "retry");
    writeGame(dir);
    for (const kind of ["timeout", "memory", "crash"] as const) {
      const caller = failingTicks(engine, 1, kind);
      const logged: DevProblem[] = [];
      const dev = await session(dir, engine, logged, () => 1, caller);
      await dev.newMatch(2, "retry");
      await dev.step();
      expect(caller.calls).toBe(2);
      expect(dev.view().realtime).toMatchObject({ tick: 1, running: true });
      expect(logged).toEqual([]);
      dev.close();
    }
  });

  it("Review 8b: names the tick on the second failure instead of an error while creating", async () => {
    const dir = join(work, "twice");
    writeGame(dir);
    const caller = failingTicks(engine, 2);
    const logged: DevProblem[] = [];
    const dev = await session(dir, engine, logged, () => 1, caller);
    await dev.newMatch(2, "twice");
    await dev.step();
    expect(caller.calls).toBe(2);
    expect(dev.view().problem).toMatchObject({ title: "Tick 1 failed; the match is paused", message: "The game code did not respond in time" });
    expect(logged.map((problem) => problem.title)).toEqual(["Tick 1 failed; the match is paused"]);
    const plain = failingTicks(engine, 1, "error");
    const other = await session(dir, engine, [], () => 1, plain);
    await other.newMatch(2, "twice");
    await other.step();
    expect(plain.calls).toBe(1);
    expect(other.view().problem?.title).toBe("Tick 1 failed; the match is paused");
    dev.close();
    other.close();
  });

  it("Review 8b: rejects more than 30 inputs per second and seat like the platform", async () => {
    const dir = join(work, "rate");
    writeGame(dir);
    const dev = await session(dir, engine);
    await dev.newMatch(2, "rate");
    dev.pause(true);
    const answers = await Promise.all(Array.from({ length: inputsPerSecond + 1 }, () => dev.move("p1", { type: "dir", dir: 1 })));
    expect(answers.slice(0, inputsPerSecond).every((answer) => answer.ok)).toBe(true);
    expect(answers.at(-1)).toMatchObject({ ok: false, code: "rate-limited" });
    expect(await dev.move("p2", { type: "dir", dir: 1 })).toEqual({ ok: true });
    dev.close();
  });

  it("Review 8b: reports an input only if it was not legal on arrival", async () => {
    const dir = join(work, "on-arrival");
    writeGame(dir, undefined, '[-1, 0, 1].filter((dir) => dir !== state.public.dir[player]).map((dir) => ({ type: "dir", dir }))');
    const logged: DevProblem[] = [];
    const dev = await session(dir, engine, logged);
    await dev.newMatch(2, "on-arrival");
    const first = dev.move("p1", { type: "dir", dir: 1 });
    const again = dev.move("p1", { type: "dir", dir: 1 });
    const wrong = dev.move("p2", { type: "dir", dir: 0 });
    await dev.step();
    expect(await first).toEqual({ ok: true });
    expect(await again).toMatchObject({ ok: false, code: "illegal-move" });
    expect(await wrong).toMatchObject({ ok: false, code: "illegal-move" });
    expect(logged.map((problem) => problem.seat)).toEqual(["p2"]);
    dev.close();
  });

  it("Review 8b: stops the ticks while new rules are loading", async () => {
    const dir = join(work, "hold");
    writeGame(dir);
    const bundle = await bundleGameForDev(dir);
    expect(await engine.load(bundle.code)).toEqual({ ok: true });
    const dev = new DevSession({ engine, realtime: true });
    await dev.newMatch(2, "hold");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await dev.hold();
    const held = dev.view().realtime?.tick ?? 0;
    expect(held).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(dev.view().realtime?.tick).toBe(held);
    await dev.reload();
    expect(dev.view().realtime?.tick).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(dev.view().realtime?.tick).toBe(0);
    dev.unhold();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(dev.view().realtime?.tick ?? 0).toBeGreaterThan(0);
    dev.close();
  });

  it("starts a new match with the same seed and bots after new rules", async () => {
    const dir = join(work, "new");
    writeGame(dir);
    const dev = await session(dir, engine);
    await dev.newMatch(3, "same");
    dev.setBot("p3", true);
    await dev.step();
    await dev.reload();
    const view = dev.view();
    expect(view).toMatchObject({ seed: "same", playerCount: 3, note: "Rules reloaded, new match with the same seats and bots." });
    expect(view.realtime?.tick).toBe(0);
    expect(view.seats[2]?.bot).toBe(true);
    dev.pause(true);
    dev.setSpeed(0.25);
    dev.setSpeed(3);
    expect(dev.view().realtime).toMatchObject({ running: false, speed: 0.25 });
    dev.close();
  });
});

describe("acceptance run: dev", () => {
  it("catches up on late ticks, at most 200 ms behind", () => {
    expect(nextDue(1000, 1000, 50)).toBe(1050);
    expect(nextDue(1000, 1120, 50)).toBe(1050);
    expect(nextDue(1000, 1000 + maxLagMs + 500, 50)).toBe(1000 + 500 + 50);
  });

  it("reports a broken build with the lines after the first error line", async () => {
    const dir = join(work, "build-error");
    writeGame(dir);
    const lines: string[] = [];
    const script = join(dir, "build.cjs");
    writeFileSync(
      script,
      [
        'console.log("vite build");',
        'console.log("Build failed with 1 error:");',
        'setTimeout(() => console.log("client/src/screen.ts:182:43: ERROR: Unterminated string literal"), 100);',
        "setTimeout(() => {}, 60000);",
      ].join("\n"),
    );
    const dev = await startDev(dir, { port: 0, out: (line) => lines.push(line), build: `node "${script}"` });
    try {
      await new Promise((resolve) => setTimeout(resolve, buildErrorCollectMs + 600));
      const problem = dev.view().problems.find((entry) => entry.source === "build");
      expect(problem?.message).toContain("Build failed with 1 error:");
      expect(problem?.message).toContain("client/src/screen.ts:182:43: ERROR: Unterminated string literal");
    } finally {
      await dev.close();
    }
  }, 30_000);
});

describe("dev: realtime server", () => {
  let server: DevServer;
  const dir = join(work, "server");
  const lines: string[] = [];

  beforeAll(async () => {
    writeGame(dir);
    mkdirSync(join(dir, "dist", "client"), { recursive: true });
    writeFileSync(join(dir, "dist", "client", "index.html"), '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    server = await startDev(dir, { port: 0, out: (line) => lines.push(line), pollMs: 50 });
  });
  afterAll(async () => server.close());

  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${server.port}` },
      body: JSON.stringify(body),
    });

  it("ticks by itself, can be paused and stepped tick by tick", async () => {
    expect(server.view().game).toMatchObject({ mode: "realtime", roles: ["screen", "controller"] });
    expect(lines).toContain(`  TV:          ${server.url}/tv`);
    const page = await fetch(`http://127.0.0.1:${server.port}/tv`);
    expect(await page.text()).toContain('id="step"');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.view().session.realtime?.tick ?? 0).toBeGreaterThan(0);
    expect(await (await post("/__dev/pause", { paused: true })).json()).toEqual({ ok: true });
    await server.session.idle();
    const frozen = server.view().session.realtime?.tick ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.view().session.realtime?.tick).toBe(frozen);
    await post("/__dev/step", {});
    expect(server.view().session.realtime?.tick).toBe(frozen + 1);
    await post("/__dev/speed", { speed: 0.5 });
    expect(server.view().session.realtime).toMatchObject({ speed: 0.5, running: false });
  });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleGameForDev } from "../src/bundle";
import { DevEngine } from "../src/dev/engine";
import { injectScript } from "../src/dev/page";
import { startDev, type DevServer } from "../src/dev/server";
import { DevSession, type DevProblem } from "../src/dev/session";
import { mapStack, sourceMapOf } from "../src/dev/stack";
import { formatProblem } from "../src/dev/view";

const devtool = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(devtool, "dev-test-"));

afterAll(() => rmSync(work, { recursive: true, force: true }));

interface Variant {
  steps?: string;
  limit?: number;
  apply?: string;
  anyone?: boolean;
  prelude?: string;
}

function gameSource(variant: Variant = {}): string {
  return [
    'import { defineGame } from "@gamehearth/sdk";',
    variant.prelude ?? "",
    "type State = { public: { count: number; turn: number }; players: Record<string, { touched: number }>; secret: { hidden: string } };",
    "type Action = { type: \"add\"; n: number };",
    "",
    `const limit = ${variant.limit ?? 10};`,
    "",
    "export default defineGame<State, Action>({",
    "  setup({ players }) {",
    "    return { public: { count: 0, turn: 0 }, players: Object.fromEntries(players.map((player) => [player, { touched: 0 }])), secret: { hidden: \"secret\" } };",
    "  },",
    "  legalMoves(state, player) {",
    "    const seats = Object.keys(state.players);",
    `    if (state.public.count >= limit || (${variant.anyone === true ? "false" : "true"} && seats[state.public.turn % seats.length] !== player)) {`,
    "      return [];",
    "    }",
    `    return [${variant.steps ?? "1, 2"}].map((n) => ({ type: "add", n }));`,
    "  },",
    "  apply(state, action, { player }) {",
    `    ${variant.apply ?? ""}`,
    "    state.public.count += action.n;",
    "    state.public.turn += 1;",
    "    state.players[player]!.touched += 1;",
    "  },",
    "  result(state) {",
    "    return state.public.count >= limit ? { winners: [\"p1\"] } : undefined;",
    "  },",
    "});",
    "",
  ].join("\n");
}

function writeGame(dir: string, variant: Variant = {}): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), gameSource(variant));
}

function manifest(dir: string, players = { min: 2, max: 3 }): void {
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "counter",
      name: "Counter",
      version: "0.1.0",
      sdk: "^0.1.0",
      license: { code: "MIT", assets: "CC0-1.0" },
      mode: "turn-based",
      players,
      server: true,
      client: "dist/client",
      roles: { player: { inputs: ["touch"], screen: "small" } },
    }),
  );
}

async function sessionFor(dir: string, engine: DevEngine, logged: DevProblem[] = [], botDelayMs = 5): Promise<{ session: DevSession; load: () => Promise<void> }> {
  let map: ReturnType<typeof sourceMapOf>;
  const load = async () => {
    const bundle = await bundleGameForDev(dir);
    map = sourceMapOf(bundle.map);
    const loaded = await engine.load(bundle.code);
    expect(loaded).toEqual({ ok: true });
  };
  await load();
  const session = new DevSession({
    engine,
    mapStack: (stack) => mapStack(stack, (file) => (file === "game.mjs" && map !== undefined ? { map, dir } : undefined), dir),
    botDelayMs,
    pick: () => 0,
    now: () => 1000,
    log: (problem) => logged.push(problem),
  });
  return { session, load };
}

describe("dev: match", () => {
  let engine: DevEngine;

  beforeAll(async () => {
    engine = await DevEngine.start({ limitMs: 1500 });
  });
  afterAll(async () => engine.close());

  it("plays moves, reports illegal moves of the UI and shows snapshots per seat", async () => {
    const dir = join(work, "match");
    writeGame(dir);
    const logged: DevProblem[] = [];
    const { session } = await sessionFor(dir, engine, logged);
    await session.newMatch(2, "fixed");
    expect(session.view().seats.map((seat) => [seat.seat, seat.name])).toEqual([
      ["p1", "Anna"],
      ["p2", "Ben"],
    ]);
    expect(await session.move("p1", { type: "add", n: 2 }, { expectedVersion: 0 })).toEqual({ ok: true });
    expect(await session.move("p1", { type: "add", n: 1 })).toMatchObject({ ok: false, code: "not-your-turn" });
    expect(await session.move("p2", { type: "add", n: 5 })).toMatchObject({ ok: false, code: "illegal-move" });
    expect(await session.move("p2", { type: "add", n: 1 }, { expectedVersion: 0 })).toMatchObject({ ok: false, code: "stale" });
    expect(logged.map((problem) => problem.title)).toEqual([
      "The UI of p1 sent a move that is not legal",
      "The UI of p2 sent a move that is not legal",
    ]);
    const view = session.view();
    expect(view.version).toBe(1);
    expect(view.screen).toMatchObject({ players: ["p1", "p2"], public: { count: 2, turn: 1 }, version: 1 });
    expect(JSON.stringify(view.screen)).not.toContain("secret");
    expect(view.moves).toEqual([{ number: 1, seat: "p1", action: { type: "add", n: 2 }, bot: false }]);
    expect(view.seats[1]?.snapshot).toMatchObject({ player: "p2", me: { touched: 0 }, public: { count: 2 } });
    expect(JSON.stringify(view.seats[1]?.snapshot)).not.toContain("secret");
    expect(view.state).toMatchObject({ secret: { hidden: "secret" } });
    session.close();
  });

  it("replays the match after a rule change and stops where a move no longer fits", async () => {
    const dir = join(work, "replay");
    writeGame(dir);
    const { session, load } = await sessionFor(dir, engine);
    await session.newMatch(2, "fixed");
    await session.move("p1", { type: "add", n: 1 });
    await session.move("p2", { type: "add", n: 2 });
    await session.move("p1", { type: "add", n: 1 });

    writeGame(dir, { limit: 20 });
    await load();
    await session.reload();
    expect(session.view().note).toBe("Rules reloaded, 3 moves replayed.");
    expect(session.view().moves).toHaveLength(3);
    expect(session.view().problem).toBeUndefined();

    writeGame(dir, { steps: "1" });
    await load();
    await session.reload();
    const view = session.view();
    expect(view.note).toBe("Rules reloaded, 1 of 3 moves replayed.");
    expect(view.moves).toHaveLength(1);
    expect(view.version).toBe(1);
    expect(view.problem?.title).toBe('Replay stopped at move 2 (p2: {"type":"add","n":2})');
    expect(view.problem?.message).toContain("no longer possible");
    session.close();
  });

  it("shows errors in the game code with the location in the source code", async () => {
    const dir = join(work, "error");
    writeGame(dir, { apply: 'if (state.public.count === 3) { throw new Error("broken at three"); }' });
    const logged: DevProblem[] = [];
    const { session } = await sessionFor(dir, engine, logged);
    await session.newMatch(2, "fixed");
    await session.move("p1", { type: "add", n: 1 });
    await session.move("p2", { type: "add", n: 2 });
    const failed = await session.move("p1", { type: "add", n: 1 });
    expect(failed).toMatchObject({ ok: false, code: "game-error" });
    const problem = session.view().problem;
    expect(problem?.title).toBe("Error in apply for p1");
    expect(problem?.message).toContain("broken at three");
    expect(problem?.stack).toMatch(/at apply \(src\/index\.ts:20:\d+\)/);
    expect(problem?.stack).not.toContain("gamehearth-runner");
    expect(problem?.stack).not.toContain("sdk");
    expect(formatProblem(problem as DevProblem)).toContain('Move by p1: {"type":"add","n":1}');
    expect(logged).toHaveLength(1);
    expect(session.view().version).toBe(2);
    session.close();
  });

  it("lets bots move until the match is over", async () => {
    const dir = join(work, "bots");
    writeGame(dir, { limit: 6 });
    const { session } = await sessionFor(dir, engine);
    await session.newMatch(3, "fixed");
    session.setBot("p2", true);
    session.setBot("p3", true);
    await session.move("p1", { type: "add", n: 1 });
    await expect.poll(() => session.view().version, { timeout: 5000 }).toBe(3);
    expect(session.view().moves.map((move) => [move.seat, move.bot])).toEqual([
      ["p1", false],
      ["p2", true],
      ["p3", true],
    ]);
    session.setBot("p1", true);
    await expect.poll(() => session.view().result, { timeout: 5000 }).toEqual({ winners: ["p1"] });
    session.close();
  });

  it("Review 1: a bot move leaves the error of a human in place, only their own move clears it", async () => {
    const dir = join(work, "review-1");
    writeGame(dir, { anyone: true, limit: 50, apply: 'if (player === "p1" && action.n === 2) { throw new Error("p1 broken"); }' });
    const { session } = await sessionFor(dir, engine);
    await session.newMatch(2, "fixed");
    session.setBot("p2", true);
    expect(await session.move("p1", { type: "add", n: 2 })).toMatchObject({ ok: false, code: "game-error" });
    expect(session.view().problem?.title).toBe("Error in apply for p1");
    await expect.poll(() => session.view().moves.filter((move) => move.bot).length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    expect(session.view().problem?.title).toBe("Error in apply for p1");
    session.setBot("p2", false);
    await session.idle();
    expect(await session.move("p1", { type: "add", n: 1 })).toEqual({ ok: true });
    expect(session.view().problem).toBeUndefined();
    session.close();
  });

  it("Review 2: a bot whose move fails pauses instead of repeating it endlessly", async () => {
    const dir = join(work, "review-2");
    writeGame(dir, { anyone: true, limit: 50, apply: 'if (player === "p2") { throw new Error("p2 broken"); }' });
    const logged: DevProblem[] = [];
    const { session, load } = await sessionFor(dir, engine, logged);
    await session.newMatch(2, "fixed");
    session.setBot("p2", true);
    await expect.poll(() => logged.length, { timeout: 5000 }).toBe(1);
    await new Promise((done) => setTimeout(done, 100));
    expect(logged).toHaveLength(1);
    expect(session.view().seats[1]).toMatchObject({ bot: true, paused: true });
    expect(session.view().problem?.message).toContain("p2 broken");
    expect(session.view().problem?.title).toContain("bot of p2 paused");

    writeGame(dir, { anyone: true, limit: 50 });
    await load();
    await session.reload();
    expect(session.view().seats[1]).toMatchObject({ bot: true, paused: false });
    await expect.poll(() => session.view().moves.length, { timeout: 5000 }).toBeGreaterThan(0);
    session.close();
  });
});

describe("dev: loading in QuickJS", () => {
  it("Review 5: if the new version does not load, the last one keeps running", async () => {
    const engine = await DevEngine.start();
    try {
      const dir = join(work, "review-5");
      writeGame(dir);
      const { session } = await sessionFor(dir, engine);
      await session.newMatch(2, "fixed");
      writeGame(dir, { prelude: 'console.log("broken at the top");' });
      const broken = await bundleGameForDev(dir);
      const loaded = await engine.load(broken.code);
      expect(loaded.ok).toBe(false);
      expect(await session.move("p1", { type: "add", n: 1 })).toEqual({ ok: true });
      await session.reload();
      expect(session.view().moves).toHaveLength(1);
      expect(session.view().problem).toBeUndefined();
      session.close();
    } finally {
      await engine.close();
    }
  });
});

describe("dev: time limit", () => {
  it("aborts hanging game code and keeps running with a fresh worker afterwards", async () => {
    const engine = await DevEngine.start({ limitMs: 300 });
    try {
      const dir = join(work, "hangs");
      writeGame(dir, { apply: "if (state.public.count === 1) { const end = Date.UTC(2000, 0, 1) + 0; let x = 0; for (let i = 0; i < 1e12; i++) { x += i % end; } }" });
      const { session } = await sessionFor(dir, engine);
      await session.newMatch(2, "fixed");
      await session.move("p1", { type: "add", n: 1 });
      const stuck = await session.move("p2", { type: "add", n: 1 });
      expect(stuck).toMatchObject({ ok: false, code: "game-error" });
      expect(session.view().problem?.message).toMatch(/did not respond|Time limit/);
      await session.newMatch(2, "new");
      expect(await session.move("p1", { type: "add", n: 2 })).toEqual({ ok: true });
      session.close();
    } finally {
      await engine.close();
    }
  }, 30_000);
});

describe("dev: stack traces", () => {
  it("maps lines from the browser to the source code via the source map", () => {
    const map = sourceMapOf(JSON.stringify({ version: 3, sources: ["../../../client/src/scene.ts"], names: [], mappings: "AAAA;AACA,IAAI" }));
    expect(map).toBeDefined();
    const stack = ["TypeError: x is undefined", "    at render (http://localhost:5180/game/assets/index.js:2:5)", "    at http://localhost:5180/game/assets/other.js:1:1"].join("\n");
    const mapped = mapStack(stack, (file) => (file.endsWith("/assets/index.js") ? { map: map!, dir: join(work, "game", "dist", "client", "assets") } : undefined), join(work, "game"));
    expect(mapped.split("\n")).toEqual(["TypeError: x is undefined", "    at render (client/src/scene.ts:2:5)", "    at http://localhost:5180/game/assets/other.js:1:1"]);
  });

  it("Review 3: also maps stacks from Firefox and Safari (name@url:line:column)", () => {
    const map = sourceMapOf(JSON.stringify({ version: 3, sources: ["../../../client/src/scene.ts"], names: [], mappings: "AAAA;AACA,IAAI" }));
    const stack = ["statusLine@http://localhost:5180/game/assets/index.js:2:5", "@http://localhost:5180/game/assets/index.js:1:1", "start@http://localhost:5180/game/assets/other.js:7:3"].join("\n");
    const mapped = mapStack(stack, (file) => (file.endsWith("/assets/index.js") ? { map: map!, dir: join(work, "game", "dist", "client", "assets") } : undefined), join(work, "game"));
    expect(mapped.split("\n")).toEqual(["statusLine@client/src/scene.ts:2:5", "@client/src/scene.ts:1:1", "start@http://localhost:5180/game/assets/other.js:7:3"]);
  });
});

describe("dev: Server", () => {
  let server: DevServer;
  const dir = join(work, "server");
  const lines: string[] = [];

  beforeAll(async () => {
    writeGame(dir);
    manifest(dir);
    mkdirSync(join(dir, "dist", "client", "assets"), { recursive: true });
    writeFileSync(join(dir, "dist", "client", "index.html"), '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="./assets/app.js"></script></body></html>');
    writeFileSync(join(dir, "dist", "client", "assets", "app.js"), "console.log('hello');\nthrow new Error('broken');\n");
    writeFileSync(join(dir, "dist", "client", "assets", "app.js.map"), JSON.stringify({ version: 3, sources: ["../../../client/src/main.ts"], names: [], mappings: "AAAA;AACA" }));
    server = await startDev(dir, { port: 0, out: (line) => lines.push(line), pollMs: 50, botDelayMs: 5 });
  });
  afterAll(async () => server.close());

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${server.port}`, ...headers },
      body: JSON.stringify(body),
    });

  it("serves the host page, seat pages and game files with the same isolation as the platform", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    for (const path of ["/", "/p2"]) {
      const page = await fetch(`${base}${path}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("frame-src 'self'");
      expect(await page.text()).toContain("/__dev/host.js");
    }
    const index = await fetch(`${base}/game/index.html`);
    expect(index.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(index.headers.get("content-security-policy")).toContain(`script-src ${base}/game/`);
    expect(index.headers.get("access-control-allow-origin")).toBe("*");
    expect(await index.text()).toContain('<script src="./__gamehearth-dev.js"></script>');
    expect((await fetch(`${base}/game/__gamehearth-dev.js`)).status).toBe(200);
    expect((await fetch(`${base}/game/index.html`, { headers: { "sec-fetch-dest": "document" } })).status).toBe(403);
    expect((await fetch(`${base}/game/..%2f..%2fmanifest.json`)).status).toBe(400);
    expect((await fetch(`${base}/game/assets/missing.js`)).status).toBe(404);
    expect(lines[0]).toBe("Gamehearth dev: Counter");
    expect(lines.some((line) => line.includes("Profiles:"))).toBe(false);
    expect(server.view().game?.profiles).toBe(false);
  });

  it("accepts moves only from the own page", async () => {
    expect((await post("/__dev/move", { seat: "p1", action: { type: "add", n: 1 } }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await post("/__dev/move", { seat: "p1", action: { type: "add", n: 1 } }, { "content-type": "text/plain" })).status).toBe(403);
    expect((await post("/__dev/move", { seat: "p9", action: { type: "add", n: 1 } })).status).toBe(400);
    const moved = await post("/__dev/move", { seat: "p1", action: { type: "add", n: 1 }, expectedVersion: server.view().session.version });
    expect(await moved.json()).toEqual({ ok: true });
    expect(server.view().session.moves).toHaveLength(1);
  });

  it("starts new matches only with an allowed player count and switches bots", async () => {
    expect((await post("/__dev/new", { playerCount: 5 })).status).toBe(400);
    expect(await (await post("/__dev/new", { playerCount: 3 })).json()).toEqual({ ok: true });
    expect(server.view().session.seats.map((seat) => seat.seat)).toEqual(["p1", "p2", "p3"]);
    expect(await (await post("/__dev/bot", { seat: "p3", on: true })).json()).toEqual({ ok: true });
    expect(server.view().session.seats[2]?.bot).toBe(true);
    await post("/__dev/bot", { seat: "p3", on: false });
  });

  it("shows errors from the UI with the location in the source code and passes on output", async () => {
    await post("/__dev/log", { seat: "p2", level: "log", text: "hello" });
    expect(lines).toContain("[p2] hello");
    await post("/__dev/log", { seat: "p1", level: "error", text: "Uncaught Error: broken", stack: `Error: broken\n    at http://127.0.0.1:${server.port}/game/assets/app.js:2:7` });
    const problem = server.view().problems.find((entry) => entry.source === "ui");
    expect(problem?.title).toBe("Error in the UI of p1");
    expect(problem?.stack).toBe("    at client/src/main.ts:2:1");
    expect(lines.join("\n")).toContain("ERROR (UI): Error in the UI of p1");

    await post("/__dev/log", { seat: "p2", level: "error", text: "Error: broken", stack: `start@http://127.0.0.1:${server.port}/game/assets/app.js:2:7\n` });
    const firefox = server.view().problems.find((entry) => entry.title === "Error in the UI of p2");
    expect(firefox?.stack).toBe("start@client/src/main.ts:2:1");
  });

  it("reloads changed rules and replays the match", async () => {
    await post("/__dev/new", { playerCount: 2 });
    await post("/__dev/move", { seat: "p1", action: { type: "add", n: 2 } });
    writeGame(dir, { limit: 30 });
    await server.reloadRules();
    expect(server.view().session.note).toBe("Rules reloaded, 1 move replayed.");
    writeFileSync(join(dir, "src", "index.ts"), "export default {");
    await server.reloadRules();
    expect(server.view().problems.map((problem) => problem.title)).toContain("Cannot build the rules");
    expect(server.view().session.moves).toHaveLength(1);
    writeGame(dir);
    await server.reloadRules();
    expect(server.view().problems.map((problem) => problem.title)).not.toContain("Cannot build the rules");
  });

  it("starts a fitting match when the player count in the manifest changes", async () => {
    await post("/__dev/new", { playerCount: 3 });
    manifest(dir, { min: 2, max: 2 });
    await server.reloadRules();
    expect(server.view().session.playerCount).toBe(2);
    expect(server.view().game?.counts).toEqual([2]);
  });

  it("reloads the UI when it was rebuilt", async () => {
    const before = server.view().client.version;
    await new Promise((done) => setTimeout(done, 60));
    writeFileSync(join(dir, "dist", "client", "index.html"), '<!doctype html><html><head><title>new</title></head><body></body></html>');
    await expect.poll(() => server.view().client.version, { timeout: 5000 }).toBe(before + 1);
    expect(server.view().problems.find((entry) => entry.source === "ui")).toBeUndefined();
  });

  it("does not reload the frames when a new build gives the same result or the folder is briefly empty", async () => {
    const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
    const index = join(dir, "dist", "client", "index.html");
    const content = readFileSync(index, "utf8");
    const before = server.view().client.version;
    await wait(60);
    writeFileSync(index, content);
    writeFileSync(join(dir, "dist", "client", "assets", "app.js.map"), JSON.stringify({ version: 3, sources: ["../../../client/src/main.ts"], names: [], mappings: "AAAA" }));
    await wait(500);
    expect(server.view().client.version).toBe(before);
    rmSync(index);
    await wait(500);
    expect(server.view().client).toMatchObject({ version: before, ready: true });
    const during = fetch(`http://127.0.0.1:${server.port}/game/index.html`);
    await wait(300);
    writeFileSync(index, content);
    const answer = await during;
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain("__gamehearth-dev.js");
    await wait(500);
    expect(server.view().client.version).toBe(before);
    writeFileSync(join(dir, "dist", "client", "assets", "app.js"), "console.log('changed');\n");
    writeFileSync(index, content);
    await expect.poll(() => server.view().client.version, { timeout: 5000 }).toBe(before + 1);
  });
});

describe("dev: page", () => {
  it("injects the error script as the first script into the head", () => {
    expect(injectScript('<html><head lang="de"><script type="module" src="./a.js"></script></head></html>')).toBe(
      '<html><head lang="de">\n    <script src="./__gamehearth-dev.js"></script><script type="module" src="./a.js"></script></head></html>',
    );
    expect(injectScript("<p>without a head</p>")).toBe('<script src="./__gamehearth-dev.js"></script>\n<p>without a head</p>');
  });
});

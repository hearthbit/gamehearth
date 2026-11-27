import { parsePlatformMessage, readSound } from "@gamehearth/sdk/platform";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleGameForDev } from "../src/bundle";
import { DevEngine } from "../src/dev/engine";
import { startDev } from "../src/dev/server";
import { DevSession, type DevProblem } from "../src/dev/session";
import { admitSound, frameUpdate, maxSoundsPerSecond, settingsMessage, soundLabel, soundPeakGain, soundPlan, type DevView } from "../src/dev/view";

const devtool = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(devtool, "dev-bots-"));

afterAll(() => rmSync(work, { recursive: true, force: true }));

function writeTurnGame(dir: string, bot: string | undefined): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "index.ts"),
    [
      'import { defineGame } from "@gamehearth/sdk";',
      "type State = { public: { count: number; turn: number }; players: Record<string, object>; secret: Record<string, never> };",
      'type Action = { type: "add"; n: number };',
      "export default defineGame<State, Action>({",
      "  setup({ players }) {",
      "    return { public: { count: 0, turn: 0 }, players: Object.fromEntries(players.map((player) => [player, {}])), secret: {} };",
      "  },",
      "  legalMoves(state, player) {",
      "    const seats = Object.keys(state.players);",
      "    if (state.public.count >= 12 || seats[state.public.turn % seats.length] !== player) {",
      "      return [];",
      "    }",
      '    return [1, 2, 3].map((n) => ({ type: "add", n }));',
      "  },",
      "  apply(state, action) {",
      "    state.public.count += action.n;",
      "    state.public.turn += 1;",
      "  },",
      ...(bot === undefined ? [] : ["  bot(state, player, moves) {", `    ${bot}`, "  },"]),
      "  result(state) {",
      '    return state.public.count >= 12 ? { winners: ["p1"] } : undefined;',
      "  },",
      "});",
      "",
    ].join("\n"),
  );
}

function writeRealtimeGame(dir: string, bot: string | undefined, away?: "play-on"): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "index.ts"),
    [
      'import { defineGame } from "@gamehearth/sdk";',
      "type State = { public: { ticks: number; dir: Record<string, number>; away: string[] }; players: Record<string, object>; secret: Record<string, never> };",
      'type Action = { type: "dir"; dir: -1 | 0 | 1 };',
      "export default defineGame<State, Action>({",
      "  setup({ players }) {",
      "    return { public: { ticks: 0, dir: Object.fromEntries(players.map((player) => [player, 0])), away: [] }, players: Object.fromEntries(players.map((player) => [player, {}])), secret: {} };",
      "  },",
      "  legalMoves(state) {",
      '    return state.public.ticks >= 400 ? [] : [{ type: "dir", dir: -1 }, { type: "dir", dir: 0 }, { type: "dir", dir: 1 }];',
      "  },",
      "  apply(state, action, { player }) {",
      "    state.public.dir[player] = action.dir;",
      "  },",
      "  tick(state, _dt, { away }) {",
      "    state.public.ticks += 1;",
      "    state.public.away = [...away];",
      "  },",
      ...(bot === undefined ? [] : ["  bot(state, player, moves) {", `    ${bot}`, "  },"]),
      "  result(state) {",
      "    return state.public.ticks >= 400 ? { winners: [] } : undefined;",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "dots",
      name: "Dots",
      version: "0.1.0",
      sdk: away === undefined ? "^0.1.1" : "^0.1.8",
      license: { code: "MIT", assets: "CC0-1.0" },
      mode: "realtime",
      ...(away === undefined ? {} : { away }),
      players: { min: 2, max: 3 },
      server: true,
      client: "dist/client",
      roles: { screen: { inputs: [], screen: "large" }, controller: { inputs: ["touch"], screen: "small" } },
    }),
  );
}

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("dev: the game's bot", () => {
  let engine: DevEngine;

  beforeAll(async () => {
    engine = await DevEngine.start({ limitMs: 1500 });
  });
  afterAll(async () => engine.close());

  async function turnSession(name: string, bot: string | undefined, logged: DevProblem[] = []): Promise<DevSession> {
    const dir = join(work, name);
    writeTurnGame(dir, bot);
    expect(await engine.load((await bundleGameForDev(dir)).code)).toEqual({ ok: true });
    return new DevSession({ engine, botDelayMs: 5, pick: () => 0, now: () => 1000, log: (problem) => logged.push(problem) });
  }

  async function realtimeSession(name: string, bot: string | undefined, options: { playOn?: boolean; pick?: number; logged?: DevProblem[] } = {}): Promise<DevSession> {
    const dir = join(work, name);
    writeRealtimeGame(dir, bot);
    expect(await engine.load((await bundleGameForDev(dir)).code)).toEqual({ ok: true });
    const logged = options.logged ?? [];
    return new DevSession({
      engine,
      realtime: true,
      timers: false,
      playOn: options.playOn === true,
      pick: () => options.pick ?? 0,
      now: () => 1000,
      log: (problem) => logged.push(problem),
    });
  }

  it("lets a turn-based bot seat play the game's bot, and plays random moves for a game without bot", async () => {
    const withBot = await turnSession("turn-bot", "return moves[moves.length - 1];");
    await withBot.newMatch(2, "bots");
    withBot.setBot("p1", true);
    withBot.setBot("p2", true);
    await until(() => withBot.view().result !== undefined);
    expect(withBot.view().moves.every((move) => move.bot && (move.action as { n: number }).n === 3)).toBe(true);
    withBot.close();

    const random = await turnSession("turn-random", undefined);
    await random.newMatch(2, "bots");
    random.setBot("p1", true);
    random.setBot("p2", true);
    await until(() => random.view().result !== undefined);
    expect(random.view().moves.every((move) => (move.action as { n: number }).n === 1)).toBe(true);
    random.close();
  });

  it("shows a bot problem once in the terminal, keeps it on the page and plays a random move instead", async () => {
    const logged: DevProblem[] = [];
    const session = await turnSession("turn-broken", 'if (player === "p2") { throw new Error("the bot is lost"); } return moves[0];', logged);
    await session.newMatch(2, "broken");
    session.setBot("p1", true);
    session.setBot("p2", true);
    await until(() => session.view().result !== undefined);
    expect(session.view().moves.filter((move) => move.seat === "p2").length).toBeGreaterThan(1);
    const problems = logged.filter((problem) => problem.title === "Problem in bot for p2");
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toMatch(/the bot is lost/);
    expect(problems[0]?.message).toMatch(/dev played a random legal move for the seat instead/);
    expect(session.view().botProblems).toEqual([expect.objectContaining({ seat: "p2", title: "Problem in bot for p2" })]);
    expect(session.view().problem).toBeUndefined();
    session.setBot("p2", false);
    expect(session.view().botProblems).toEqual([]);
    session.close();
  });

  it("moves realtime bot seats through stepMatch with the game's bot instead of random inputs", async () => {
    const withBot = await realtimeSession("rt-bot", "return state.public.dir[player] === 1 ? undefined : moves.find((move) => move.dir === 1);");
    await withBot.newMatch(2, "rt");
    withBot.setBot("p1", true);
    await withBot.step();
    await withBot.step();
    expect((withBot.view().state as { public: { dir: Record<string, number> } }).public.dir).toEqual({ p1: 1, p2: 0 });
    withBot.close();

    const random = await realtimeSession("rt-random", undefined);
    await random.newMatch(2, "rt");
    random.setBot("p1", true);
    await random.step();
    expect((random.view().state as { public: { dir: Record<string, number> } }).public.dir).toEqual({ p1: -1, p2: 0 });
    random.close();
  });

  it("reports a realtime bot problem once without pausing the match", async () => {
    const logged: DevProblem[] = [];
    const session = await realtimeSession("rt-broken", 'return { type: "dir", dir: 5 } as never;', { logged });
    await session.newMatch(2, "rt");
    session.setBot("p1", true);
    for (let tick = 0; tick < 5; tick++) {
      await session.step();
    }
    expect(session.view().realtime?.tick).toBe(5);
    expect(session.view().problem).toBeUndefined();
    expect(logged.filter((problem) => problem.seat === "p1")).toHaveLength(1);
    expect(session.view().botProblems[0]?.message).toMatch(/not legal[\s\S]*In this tick the seat sends no input/);
    session.close();
  });

  it("passes seats switched to away as ctx.away in games that play on, but never a bot seat", async () => {
    const playOn = await realtimeSession("rt-away", undefined, { playOn: true, pick: 1 });
    await playOn.newMatch(3, "away");
    playOn.setAway("p2", true);
    await playOn.step();
    expect((playOn.view().state as { public: { away: string[] } }).public.away).toEqual(["p2"]);
    expect(playOn.view().seats.map((seat) => seat.away)).toEqual([false, true, false]);
    playOn.setBot("p2", true);
    playOn.setAway("p3", true);
    await playOn.step();
    expect((playOn.view().state as { public: { away: string[] } }).public.away).toEqual(["p3"]);
    playOn.close();

    const pausing = await realtimeSession("rt-pause", undefined, { playOn: false, pick: 1 });
    await pausing.newMatch(2, "away");
    pausing.setAway("p2", true);
    await pausing.step();
    expect((pausing.view().state as { public: { away: string[] } }).public.away).toEqual([]);
    expect(pausing.view().seats.map((seat) => seat.away)).toEqual([false, false]);
    pausing.close();
  });
});

describe("dev: away switch on the server", () => {
  it("accepts away only for realtime games that play on", async () => {
    for (const away of ["play-on", undefined] as const) {
      const dir = join(work, `server-${away ?? "pause"}`);
      writeRealtimeGame(dir, undefined, away);
      const server = await startDev(dir, { port: 0, out: () => undefined, pollMs: 50 });
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/__dev/away`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: `http://127.0.0.1:${server.port}` },
          body: JSON.stringify({ seat: "p2", on: true }),
        });
        expect(response.status).toBe(away === undefined ? 400 : 200);
        expect(server.view().game?.away).toBe(away);
        expect(server.view().session.seats[1]?.away).toBe(away !== undefined);
      } finally {
        await server.close();
      }
    }
  }, 60_000);
});

describe("dev: sound and bots in the bridge", () => {
  it("plans notes with a quick attack, a peak of about 0.12 at full volume and no silent notes", () => {
    const sound = readSound({ notes: [{ freq: 440, length: 0.1, volume: 1 }, { freq: 660, to: 880, at: 0.1, length: 0.2, wave: "sine" }, { freq: 300, length: 0.1, volume: 0 }] });
    expect(sound).toBeDefined();
    expect(soundPlan(sound!, 2)).toEqual([
      { wave: "square", from: 440, begin: 2, end: 2.1, peak: soundPeakGain },
      { wave: "sine", from: 660, to: 880, begin: 2.1, end: expect.closeTo(2.3, 6), peak: soundPeakGain / 2 },
    ]);
    expect(soundPlan("coin", 0)).toHaveLength(2);
    expect(soundLabel("coin")).toBe("coin");
    expect(soundLabel(sound!)).toBe("own sound with 3 notes");
  });

  it("plays at most 12 sounds per second and frame", () => {
    const recent: number[] = [];
    const admitted = Array.from({ length: 20 }, (_, index) => admitSound(recent, index * 10)).filter(Boolean);
    expect(admitted).toHaveLength(maxSoundsPerSecond);
    expect(admitSound(recent, 1005)).toBe(true);
  });

  it("tells the frames whether sound is on, and marks bots in the players", () => {
    expect(parsePlatformMessage(settingsMessage(true))).toEqual({ gamehearth: 1, type: "settings", sound: true, music: false });
    const view: DevView = {
      game: { id: "probe", name: "Probe", counts: [2], mode: "turn-based", roles: ["player"], profiles: false },
      session: {
        playerCount: 2,
        seed: "seed",
        options: {},
        version: 1,
        result: undefined,
        screen: { players: ["p1", "p2"], public: {}, version: 1 },
        seats: [
          { seat: "p1", name: "Anna", bot: false, paused: false, away: false, snapshot: { player: "p1", players: ["p1", "p2"], public: {}, me: {}, moves: [], version: 1 }, profile: { items: {}, stats: {}, flags: {} }, guest: false },
          { seat: "p2", name: "Ben", bot: true, paused: false, away: false, snapshot: { player: "p2", players: ["p1", "p2"], public: {}, me: {}, moves: [], version: 1 }, profile: { items: {}, stats: {}, flags: {} }, guest: false },
        ],
        state: undefined,
        moves: [],
        problem: undefined,
        botProblems: [],
        note: undefined,
      },
      client: { version: 1, ready: true, note: undefined },
      problems: [],
      logs: [],
    };
    const update = parsePlatformMessage(frameUpdate(view, "p1"));
    expect(update?.type === "update" ? update.players : undefined).toEqual({
      p1: { name: "Anna", connected: true, you: true },
      p2: { name: "Ben (Bot)", connected: true, you: false, bot: true },
    });
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDev, type DevServer } from "../src/dev/server";

const devtool = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(devtool, "dev-options-test-"));
const dir = join(work, "game");

afterAll(() => rmSync(work, { recursive: true, force: true }));

const source = `import { defineGame } from "@gamehearth/sdk";

interface Options {
  ziel: number;
  doppelt: boolean;
}
type State = { public: { count: number; ziel: number; turn: number }; players: Record<string, Record<string, never>>; secret: null };
type Action = { type: "add"; n: number };

export default defineGame<State, Action, Options>({
  setup({ players, options }) {
    return { public: { count: 0, ziel: options.ziel, turn: 0 }, players: Object.fromEntries(players.map((player) => [player, {}])), secret: null };
  },
  legalMoves(state, player, { options }) {
    const seats = Object.keys(state.players);
    return seats[state.public.turn % seats.length] === player ? [{ type: "add", n: options.doppelt ? 2 : 1 }] : [];
  },
  apply(state, action) {
    state.public.count += action.n;
    state.public.turn += 1;
  },
  result(state) {
    return state.public.count >= state.public.ziel ? { winners: ["p1"] } : undefined;
  },
});
`;

function manifest(options: Record<string, unknown>): void {
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "ziel",
      name: "Ziel",
      version: "0.1.0",
      sdk: "^0.1.3",
      license: { code: "MIT", assets: "CC0-1.0" },
      mode: "turn-based",
      players: { min: 1, max: 2 },
      server: true,
      client: "dist/client",
      roles: { player: { inputs: ["touch"], screen: "small" } },
      options,
    }),
  );
}

const ziel = { label: "Ziel", type: "choice", default: 10, choices: [{ value: 10, label: "10" }, { value: 20, label: "20" }] };
const doppelt = { label: "Doppelt", type: "boolean", default: false };

describe("dev with options", () => {
  let server: DevServer;
  const lines: string[] = [];

  beforeAll(async () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), source);
    manifest({ ziel, doppelt });
    mkdirSync(join(dir, "dist", "client"), { recursive: true });
    writeFileSync(join(dir, "dist", "client", "index.html"), '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    server = await startDev(dir, { port: 0, out: (line) => lines.push(line), pollMs: 50, botDelayMs: 5 });
  });
  afterAll(async () => server.close());

  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${server.port}` },
      body: JSON.stringify(body),
    });

  const state = () => server.view().session.seats[0]?.snapshot as { public: { ziel: number }; moves: unknown[] };

  it("starts with the defaults and shows the options from the manifest", () => {
    expect(server.view().game?.options).toEqual({ ziel, doppelt });
    expect(server.view().session.options).toEqual({ ziel: 10, doppelt: false });
    expect(state().public.ziel).toBe(10);
  });

  it("starts a new match on a new choice and keeps the choice for the next one", async () => {
    await post("/__dev/move", { seat: "p1", action: { type: "add", n: 1 } });
    expect(await (await post("/__dev/new", { playerCount: 2, options: { ziel: 20 } })).json()).toEqual({ ok: true });
    expect(server.view().session.options).toEqual({ ziel: 20, doppelt: false });
    expect(server.view().session.moves).toEqual([]);
    expect(state().public.ziel).toBe(20);
    expect(lines).toContain("New match with 2 players, options ziel=20.");
    await post("/__dev/new", { playerCount: 2, options: { doppelt: true } });
    expect(server.view().session.options).toEqual({ ziel: 20, doppelt: true });
    expect(state().moves).toEqual([{ type: "add", n: 2 }]);
    expect(await (await post("/__dev/move", { seat: "p1", action: { type: "add", n: 2 } })).json()).toEqual({ ok: true });
    expect(server.view().session.seats[1]?.snapshot).toMatchObject({ moves: [{ type: "add", n: 2 }] });
    await post("/__dev/new", { playerCount: 1 });
    expect(server.view().session.options).toEqual({ ziel: 20, doppelt: true });
  });

  it("rejects unknown options and values", async () => {
    const wrong = await post("/__dev/new", { playerCount: 1, options: { ziel: 30 } });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: "invalid-option", message: expect.stringContaining("possible values are 10, 20") });
    expect((await post("/__dev/new", { playerCount: 1, options: { color: "red" } })).status).toBe(400);
    expect(server.view().session.options).toEqual({ ziel: 20, doppelt: true });
  });

  it("replays with the same options after the rules changed", async () => {
    await post("/__dev/new", { playerCount: 1 });
    await post("/__dev/move", { seat: "p1", action: { type: "add", n: 2 } });
    writeFileSync(join(dir, "src", "index.ts"), `${source}\n`);
    await server.reloadRules();
    expect(server.view().session.note).toBe("Rules reloaded, 1 move replayed.");
    expect(server.view().session.options).toEqual({ ziel: 20, doppelt: true });
  });

  it("starts over when the options in the manifest change and sets unknown values to the default", async () => {
    manifest({ ziel: { ...ziel, choices: [{ value: 10, label: "10" }, { value: 40, label: "40" }] } });
    await server.reloadRules();
    expect(server.view().session.options).toEqual({ ziel: 10 });
    expect(lines).toContain("The options in manifest.json have changed, new match started.");
  });
});

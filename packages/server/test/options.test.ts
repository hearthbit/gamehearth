import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseClientMessage } from "../src/protocol";
import { RoomError } from "../src/rooms";
import { startServer } from "../src/transport";
import { packageOf } from "./catalog-helpers";
import { Client } from "./client";
import { createSetup, gluecksradDir, hostRoom, joinRoom, takt, zaehlenV1, type Seat, type Setup } from "./helpers";

let setup: Setup;
let now = 1_000_000;
const temporary: string[] = [];

beforeEach(async () => {
  now = 1_000_000;
  setup = await createSetup(undefined, {}, { clock: () => now, realtime: { timers: false } });
  await setup.library.install(gluecksradDir);
  await setup.library.install(takt);
});

afterEach(async () => {
  await setup.cleanup();
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function expectRoomError(work: Promise<unknown> | (() => unknown), code: string): Promise<RoomError> {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    expect(error).toBeInstanceOf(RoomError);
    expect((error as RoomError).code).toBe(code);
    return error as RoomError;
  }
  throw new Error(`expected RoomError ${code}`);
}

async function lobby(): Promise<[Seat, Seat]> {
  const anna = hostRoom(setup, "gluecksrad", "Anna");
  const ben = await joinRoom(setup, anna.code, "Ben");
  return [anna, ben];
}

function secondVersion(): string {
  const dir = mkdtempSync(join(tmpdir(), "gamehearth-gluecksrad-v2-"));
  temporary.push(dir);
  cpSync(gluecksradDir, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
  manifest["version"] = "0.2.0";
  manifest["options"] = {
    runden: {
      label: "Runden",
      type: "choice",
      default: 3,
      choices: [
        { value: 3, label: "3 Runden" },
        { value: 5, label: "5 Runden" },
        { value: 7, label: "7 Runden" },
      ],
    },
    tempo: { label: "Tempo", type: "boolean", default: false },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

describe("Options in the lobby", () => {
  it("shows all members the options with default values", async () => {
    const [anna, ben] = await lobby();
    const view = await setup.rooms.view(ben.code, ben.user);
    expect(view.options?.values).toEqual({ runden: 3, joker: false });
    expect(view.options?.spec["runden"]).toMatchObject({ label: "Runden", type: "choice" });
    expect((await setup.rooms.view(anna.code, anna.user)).options?.values).toEqual({ runden: 3, joker: false });
  });

  it("lets only the host choose valid values", async () => {
    const [anna, ben] = await lobby();
    await setup.rooms.setOption(anna.code, anna.user, "runden", 5);
    await setup.rooms.setOption(anna.code, anna.user, "joker", true);
    expect((await setup.rooms.view(ben.code, ben.user)).options?.values).toEqual({ runden: 5, joker: true });
    await expectRoomError(setup.rooms.setOption(ben.code, ben.user, "runden", 2), "not-host");
    const wrong = await expectRoomError(setup.rooms.setOption(anna.code, anna.user, "runden", 4), "invalid-option");
    expect(wrong.message).toContain("possible values are 2, 3, 5");
    await expectRoomError(setup.rooms.setOption(anna.code, anna.user, "joker", "ja"), "invalid-option");
    await expectRoomError(setup.rooms.setOption(anna.code, anna.user, "farbe", "rot"), "invalid-option");
    await expectRoomError(setup.rooms.setOption(anna.code, anna.user, "__proto__", 1), "invalid-option");
    expect((await setup.rooms.view(ben.code, ben.user)).options?.values).toEqual({ runden: 5, joker: true });
  });

  it("shows no options for games without options and rejects a choice", async () => {
    await setup.library.install(zaehlenV1);
    const plain = hostRoom(setup, "zaehlen", "Cem");
    expect((await setup.rooms.view(plain.code, plain.user)).options).toBeUndefined();
    await expectRoomError(setup.rooms.setOption(plain.code, plain.user, "runden", 3), "invalid-option");
    await joinRoom(setup, plain.code, "Dora");
    await setup.rooms.start(plain.code, plain.user);
    const stored = JSON.parse((setup.db.prepare("SELECT match FROM rooms WHERE code = ?").get(plain.code) as { match: string }).match) as Record<string, unknown>;
    expect("options" in stored).toBe(false);
  });
});

describe("Options in the match", () => {
  it("starts the match with the choice and keeps it across all moves", async () => {
    const [anna, ben] = await lobby();
    await setup.rooms.setOption(anna.code, anna.user, "runden", 2);
    await setup.rooms.setOption(anna.code, anna.user, "joker", true);
    await setup.rooms.start(anna.code, anna.user);
    let view = await setup.rooms.view(anna.code, anna.user);
    expect(view.options?.values).toEqual({ runden: 2, joker: true });
    expect(view.snapshot?.public).toMatchObject({ lastRound: 2 });
    expect(view.snapshot?.moves).toEqual([{ type: "spin" }, { type: "joker" }]);
    await setup.rooms.move(anna.code, anna.user, { type: "spin" });
    const benView = await setup.rooms.view(ben.code, ben.user);
    expect(benView.snapshot?.moves).toEqual([{ type: "spin" }, { type: "joker" }]);
    await setup.rooms.move(ben.code, ben.user, { type: "joker" });
    view = await setup.rooms.view(anna.code, anna.user);
    expect(view.snapshot?.moves).toEqual([{ type: "spin" }, { type: "joker" }]);
    const stored = JSON.parse((setup.db.prepare("SELECT match FROM rooms WHERE code = ?").get(anna.code) as { match: string }).match) as { options: unknown };
    expect(stored.options).toEqual({ runden: 2, joker: true });
  });

  it("keeps the options unchanged during the match and keeps them for the next round", async () => {
    const [anna, ben] = await lobby();
    await setup.rooms.setOption(anna.code, anna.user, "runden", 2);
    await setup.rooms.start(anna.code, anna.user);
    await expectRoomError(setup.rooms.setOption(anna.code, anna.user, "runden", 5), "already-started");
    for (let turn = 0; turn < 4; turn++) {
      const player = turn % 2 === 0 ? anna : ben;
      await setup.rooms.move(player.code, player.user, { type: "spin" });
    }
    expect((await setup.rooms.view(anna.code, anna.user)).status).toBe("finished");
    setup.rooms.newRound(anna.code, anna.user);
    const view = await setup.rooms.view(ben.code, ben.user);
    expect(view).toMatchObject({ status: "lobby", round: 2, options: { values: { runden: 2, joker: false } } });
  });

  it("keeps the choice across a server restart", async () => {
    const [anna] = await lobby();
    await setup.rooms.setOption(anna.code, anna.user, "joker", true);
    setup = await setup.reopen();
    expect((await setup.rooms.view(anna.code, anna.user)).options?.values).toEqual({ runden: 3, joker: true });
  });

  it("computes realtime ticks with the options, even after many steps", async () => {
    const anna = hostRoom(setup, "takt", "Anna");
    await setup.rooms.setOption(anna.code, anna.user, "schritt", 5);
    setup.rooms.realtime.presence(anna.code, { seats: new Set(["p1"]), screens: 0 });
    await setup.rooms.start(anna.code, anna.user);
    for (let i = 0; i < 80; i++) {
      now += 50;
      await setup.rooms.realtime.tickAll();
    }
    const pressed = setup.rooms.move(anna.code, anna.user, { type: "press" });
    for (let i = 0; i < 3; i++) {
      now += 50;
      await setup.rooms.realtime.tickAll();
    }
    await pressed;
    const view = await setup.rooms.view(anna.code, anna.user);
    expect(view.live?.state).toBe("running");
    const state = view.snapshot?.public as { counter: number; presses: number };
    expect(state.presses).toBe(5);
    expect(state.counter % 5).toBe(0);
    expect(state.counter).toBeGreaterThan(5);
    expect(view.options?.values).toEqual({ schritt: 5, tasten: true });
    expect(setup.logs.filter((line) => /error|incident/i.test(line))).toEqual([]);
  });
});

describe("Options with a new build", () => {
  it("resets unknown options and values to the default in the lobby", async () => {
    const [anna, ben] = await lobby();
    await setup.rooms.setOption(anna.code, anna.user, "runden", 2);
    await setup.rooms.setOption(anna.code, anna.user, "joker", true);
    await setup.library.install(secondVersion());
    expect(setup.rooms.gameChanged("gluecksrad").moved).toEqual([anna.code]);
    const view = await setup.rooms.view(ben.code, ben.user);
    expect(view.game.version).toBe("0.2.0");
    expect(view.options?.values).toEqual({ runden: 3, tempo: false });
    const stored = (setup.db.prepare("SELECT options FROM rooms WHERE code = ?").get(anna.code) as { options: string | null }).options;
    expect(stored).toBeNull();
  });

  it("Review 10: stores only explicit choices, so a new default also reaches rooms with a different choice", async () => {
    const [anna, ben] = await lobby();
    await setup.rooms.setOption(anna.code, anna.user, "joker", true);
    const stored = (setup.db.prepare("SELECT options FROM rooms WHERE code = ?").get(anna.code) as { options: string }).options;
    expect(JSON.parse(stored)).toEqual({ joker: true });
    const dir = secondVersion();
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { options: Record<string, Record<string, unknown>> };
    manifest.options = { ...manifest.options, runden: { ...manifest.options["runden"], default: 5 }, joker: { label: "Joker", type: "boolean", default: false } };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    await setup.library.install(dir);
    setup.rooms.gameChanged("gluecksrad");
    expect((await setup.rooms.view(ben.code, ben.user)).options?.values).toEqual({ runden: 5, tempo: false, joker: true });
  });

  it("Review 10: a start while the host changes options fails with stale and takes the new choice next time", async () => {
    const [anna] = await lobby();
    const starting = setup.rooms.start(anna.code, anna.user);
    await setup.rooms.setOption(anna.code, anna.user, "runden", 5);
    await expectRoomError(starting, "stale");
    await setup.rooms.start(anna.code, anna.user);
    const view = await setup.rooms.view(anna.code, anna.user);
    expect(view.snapshot?.public).toMatchObject({ lastRound: 5 });
  });

  it("keeps valid values and carries them into the new build with the new round", async () => {
    const [anna, ben] = await lobby();
    await setup.rooms.setOption(anna.code, anna.user, "runden", 5);
    await setup.rooms.start(anna.code, anna.user);
    await setup.library.install(secondVersion());
    setup.rooms.gameChanged("gluecksrad");
    expect((await setup.rooms.view(anna.code, anna.user)).options?.values).toEqual({ runden: 5, joker: false });
    setup.rooms.abort(anna.code, anna.user);
    const view = await setup.rooms.view(ben.code, ben.user);
    expect(view).toMatchObject({ status: "lobby", game: { version: "0.2.0" }, options: { values: { runden: 5, tempo: false } } });
  });
});

describe("Options when installing", () => {
  it("Review 10: plays a package's trial match with the default options", async () => {
    const realtime = await packageOf(takt, { id: "takt-paket" });
    expect((await setup.library.installPackage(realtime.archive)).manifest.id).toBe("takt-paket");
    const dir = mkdtempSync(join(tmpdir(), "gamehearth-optionen-paket-"));
    temporary.push(dir);
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "client"));
    writeFileSync(join(dir, "client", "index.html"), "<!doctype html><title>Plus</title>");
    writeFileSync(
      join(dir, "src", "index.ts"),
      `import { defineGame } from "@gamehearth/sdk";
type State = { public: { n: number }; players: Record<string, Record<string, never>>; secret: null };
export default defineGame<State, { type: "plus" }, { schritt: number }>({
  setup: ({ players }) => ({ public: { n: 0 }, players: Object.fromEntries(players.map((player) => [player, {}])), secret: null }),
  legalMoves: () => [{ type: "plus" }],
  apply(state, _action, { options }) {
    if (typeof options.schritt !== "number") {
      throw new Error("Optionen fehlen");
    }
    state.public.n += options.schritt;
  },
  result: (state) => (state.public.n >= 20 ? { winners: [] } : undefined),
});
`,
    );
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        id: "plus",
        name: "Plus",
        version: "1.0.0",
        sdk: "^0.1.3",
        license: { code: "MIT", assets: "CC0-1.0" },
        mode: "turn-based",
        players: { min: 1, max: 2 },
        server: true,
        client: "client",
        roles: { player: { inputs: ["touch"], screen: "small" } },
        options: { schritt: { label: "Schritt", type: "choice", default: 1, choices: [{ value: 1, label: "eins" }, { value: 2, label: "zwei" }] } },
      }),
    );
    expect((await setup.library.installPackage((await packageOf(dir)).archive)).manifest.id).toBe("plus");
  });
});

describe("Options over the network", () => {
  it("accepts set-option and sends everyone the update", async () => {
    const [anna, ben] = await lobby();
    const running = await startServer({ rooms: setup.rooms, accounts: setup.accounts, library: setup.library, port: 0, host: "127.0.0.1", log: (line) => setup.logs.push(line) });
    try {
      const host = await Client.connect(running.port, { token: anna.token });
      const guest = await Client.connect(running.port, { token: ben.token });
      host.send({ type: "hello", room: anna.code });
      guest.send({ type: "hello", room: ben.code });
      await host.room();
      await guest.room();
      host.send({ type: "set-option", name: "runden", value: 5, id: 1 });
      await host.next((message) => message.type === "ack" && message.id === 1);
      expect((await guest.room((room) => room.options?.values["runden"] === 5)).options?.values).toEqual({ runden: 5, joker: false });
      guest.send({ type: "set-option", name: "runden", value: 2, id: 2 });
      expect(await guest.next((message) => message.type === "error" && message.id === 2)).toMatchObject({ code: "not-host" });
      host.close();
      guest.close();
    } finally {
      await running.close();
    }
  });

  it("checks set-option already when reading the message", () => {
    expect(parseClientMessage(JSON.stringify({ type: "set-option", name: "runden", value: 5 }))).toEqual({ type: "set-option", name: "runden", value: 5 });
    expect(parseClientMessage(JSON.stringify({ type: "set-option", name: "joker", value: true }))).toEqual({ type: "set-option", name: "joker", value: true });
    expect(parseClientMessage(JSON.stringify({ type: "set-option", name: "runden", value: 1.5 }))).toEqual(expect.stringContaining("value"));
    expect(parseClientMessage(JSON.stringify({ type: "set-option", name: "runden", value: { a: 1 } }))).toEqual(expect.stringContaining("value"));
    expect(parseClientMessage(JSON.stringify({ type: "set-option", value: 5 }))).toEqual(expect.stringContaining("name"));
  });
});

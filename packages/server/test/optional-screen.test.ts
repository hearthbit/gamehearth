import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoomError } from "../src/rooms";
import { startServer, type RunningServer } from "../src/transport";
import { Client, postJson } from "./client";
import { account, createSetup, hostRoom, joinRoom, mauMauDir, wettlaufDir, type Seat, type Setup } from "./helpers";

const phone = { inputs: ["touch", "mouse", "keyboard"], screen: "small" };
const optionalTv = { inputs: [], screen: "large", optional: true };
const staffel = variant(wettlaufDir, "staffel", { player: phone, screen: optionalTv });
const skat = variant(mauMauDir, "skat", { player: phone, screen: optionalTv });

function variant(source: string, id: string, roles: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "gamehearth-optional-tv-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  cpSync(source, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, id, sdk: "^0.1.7", roles }, null, 2));
  return dir;
}

let setup: Setup;
let now = 1_000_000;

async function expectRoomError(work: Promise<unknown>, code: string): Promise<void> {
  const error = await work.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(RoomError);
  expect((error as RoomError).code).toBe(code);
}

async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    now += 50;
    await setup.rooms.realtime.tickAll();
  }
}

function present(code: string, seats: string[], screens = 0): void {
  setup.rooms.realtime.presence(code, { seats: new Set(seats), screens });
}

async function room(game: string): Promise<Seat[]> {
  const host = hostRoom(setup, game, "Anna");
  return [host, await joinRoom(setup, host.code, "Ben")];
}

describe("Optional TV", () => {
  beforeEach(async () => {
    now = 1_000_000;
    setup = await createSetup(undefined, {}, { clock: () => now, realtime: { timers: false } });
    await setup.library.install(staffel);
    await setup.library.install(skat);
    await setup.library.install(wettlaufDir);
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it("starts without a TV and tells the room that the TV is optional", async () => {
    const [anna] = await room("staffel");
    const code = anna!.code;
    const lobby = await setup.rooms.view(code, anna!.user);
    expect(lobby.game).toMatchObject({ roles: ["player", "screen"], screenOptional: true });
    expect(lobby.canStart).toBe(true);
    present(code, ["p1", "p2"]);
    await setup.rooms.start(code, anna!.user);
    await ticks(60);
    expect(setup.rooms.realtime.view(code)).toMatchObject({ state: "running", screenMissing: false });
  });

  it("starts a turn-based game with an optional TV without one", async () => {
    const [anna] = await room("skat");
    expect((await setup.rooms.view(anna!.code, anna!.user)).canStart).toBe(true);
    await setup.rooms.start(anna!.code, anna!.user);
    expect((await setup.rooms.view(anna!.code, anna!.user)).status).toBe("running");
  });

  it("never pauses for a missing TV, but still for a missing seat", async () => {
    const [anna] = await room("staffel");
    const code = anna!.code;
    present(code, ["p1", "p2"], 1);
    await setup.rooms.start(code, anna!.user);
    await ticks(60);
    present(code, ["p1", "p2"], 0);
    await ticks(100);
    expect(setup.rooms.realtime.view(code)).toMatchObject({ state: "running", screenMissing: false });
    present(code, ["p1"], 0);
    await ticks(40);
    expect(setup.rooms.realtime.view(code)).toMatchObject({ state: "paused", missingSeats: ["p2"], screenMissing: false });
    present(code, ["p1", "p2"], 0);
    await ticks(1);
    expect(setup.rooms.realtime.view(code)?.state).toBe("countdown");
    await ticks(60);
    expect(setup.rooms.realtime.view(code)?.state).toBe("running");
  });

  it("continues after a restart as soon as the seats are back, without a TV", async () => {
    const [anna] = await room("staffel");
    const code = anna!.code;
    present(code, ["p1", "p2"]);
    await setup.rooms.start(code, anna!.user);
    await ticks(60);
    setup = await setup.reopen();
    await setup.library.restore();
    expect(await setup.rooms.restoreRealtime()).toEqual([code]);
    expect(setup.rooms.realtime.view(code)).toMatchObject({ state: "paused", missingSeats: ["p1", "p2"], screenMissing: false });
    present(code, ["p1", "p2"]);
    await ticks(1);
    expect(setup.rooms.realtime.view(code)?.state).toBe("countdown");
  });

  it("pairs TVs as before, lists the room for pairing and shows paired TVs the game", async () => {
    const [anna, ben] = await room("staffel");
    const code = anna!.code;
    await setup.rooms.addScreen(code, ben!.user, "fernseher-1");
    expect((await setup.rooms.view(code, anna!.user)).screens).toHaveLength(1);
    expect(setup.rooms.rooms(anna!.user)[0]).toMatchObject({ code, screen: true });
    present(code, ["p1", "p2"], 1);
    await setup.rooms.start(code, anna!.user);
    await ticks(61);
    const tv = await setup.rooms.screenView(code, setup.rooms.screen("fernseher-1")?.id as number, { members: new Set(), screens: new Set([1]) });
    expect(tv.game).toMatchObject({ screenOptional: true });
    expect(tv.snapshot).toEqual({ players: ["p1", "p2"], public: expect.any(Object), version: expect.any(Number), tick: expect.any(Number) });
  });

  it("keeps a required TV required: no start without one, a pause when it is missing", async () => {
    const [anna] = await room("wettlauf");
    const code = anna!.code;
    const lobby = await setup.rooms.view(code, anna!.user);
    expect(lobby.game).not.toHaveProperty("screenOptional");
    expect(lobby.canStart).toBe(false);
    await expectRoomError(setup.rooms.start(code, anna!.user), "screen-missing");
    await setup.rooms.addScreen(code, anna!.user, "fernseher-1");
    present(code, ["p1", "p2"], 1);
    await setup.rooms.start(code, anna!.user);
    await ticks(60);
    present(code, ["p1", "p2"], 0);
    await ticks(41);
    expect(setup.rooms.realtime.view(code)).toMatchObject({ state: "paused", missingSeats: [], screenMissing: true });
  });
});

describe("Optional TV over HTTP and WebSocket", () => {
  let running: RunningServer;
  let base: string;

  beforeEach(async () => {
    setup = await createSetup(undefined, {}, { clock: Date.now, realtime: { graceMs: 150, countdownMs: 150 } });
    await setup.library.install(staffel);
    running = await startServer({
      rooms: setup.rooms,
      accounts: setup.accounts,
      library: setup.library,
      port: 0,
      host: "127.0.0.1",
      limits: { realtimeHeartbeatMs: 200 },
      log: (message) => setup.logs.push(message),
    });
    base = `http://127.0.0.1:${running.port}`;
  });

  afterEach(async () => {
    await running.close();
    await setup.cleanup();
  });

  it("lets the host start without a TV and pairs a TV by code all the same", async () => {
    const anna = account(setup, "Anna");
    const code = String((await postJson(base, "/api/rooms", { game: "staffel" }, anna.token)).body["code"]);
    expect((await postJson(base, `/api/rooms/${code}/join`, { name: "Ben" })).status).toBe(201);
    const host = await Client.connect(running.port, { token: anna.token });
    host.send({ type: "hello", room: code });
    expect((await host.room((view) => view.members.length === 2)).canStart).toBe(true);
    const response = await fetch(`${base}/api/tv`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const token = /(?:^|\s)gh-tv=([^;]*)/.exec(response.headers.get("set-cookie") ?? "")?.[1] as string;
    const tv = await Client.connect(running.port, { headers: { cookie: `gh-tv=${token}` } });
    tv.send({ type: "screen" });
    const pairing = (await tv.next((message) => message.type === "pairing")) as { code: string };
    expect((await postJson(base, `/api/rooms/${code}/screens`, { code: pairing.code }, anna.token)).status).toBe(201);
    const screen = await tv.next((message) => message.type === "screen-room");
    expect(screen).toMatchObject({ room: { code, status: "lobby", game: { id: "staffel", screenOptional: true } } });
  });
});

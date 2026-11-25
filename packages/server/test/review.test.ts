import { bundleGameModule } from "gamehearth";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config";
import { GameLibrary } from "../src/games";
import { RoomError } from "../src/rooms";
import { startServer, type Limits, type RunningServer } from "../src/transport";
import { Client, postJson, settle } from "./client";
import { account, createSetup, guest, hostRoom, joinRoom, mauMauDir, zaehlenV1, type Setup } from "./helpers";

const leckfehler = fileURLToPath(new URL("./fixtures/leckfehler", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function prepare(...games: string[]): Promise<Setup> {
  const setup = await createSetup();
  cleanups.push(() => setup.cleanup());
  for (const game of games) {
    await setup.library.install(game);
  }
  return setup;
}

async function serve(setup: Setup, limits: Partial<Limits> = {}): Promise<{ running: RunningServer; base: string }> {
  const running = await startServer({
    rooms: setup.rooms,
    accounts: setup.accounts,
    library: setup.library,
    port: 0,
    host: "127.0.0.1",
    limits,
    log: (message) => setup.logs.push(message),
  });
  cleanups.push(() => running.close());
  return { running, base: `http://127.0.0.1:${running.port}` };
}

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

describe("Errors in the game code reveal nothing", () => {
  it("sends the client a general message with an incident number and writes details only to the log", async () => {
    const setup = await prepare(leckfehler);
    const host = hostRoom(setup, "leckfehler", "Anna");
    await joinRoom(setup, host.code, "Ben");
    await setup.rooms.start(host.code, host.user);
    const error = await expectRoomError(setup.rooms.move(host.code, host.user, { type: "aufdecken" }), "game-error");
    expect(error.message).not.toMatch(/geheim/);
    expect(error.message).toMatch(/incident [0-9a-f]{8}/);
    const incident = /incident ([0-9a-f]{8})/.exec(error.message)?.[1];
    expect(setup.logs.join("\n")).toContain(`[Incident ${incident}]`);
    expect(setup.logs.join("\n")).toMatch(/geheim/);
  });

  it("reveals no hidden values over WebSocket either", async () => {
    const setup = await prepare(leckfehler);
    const { running, base } = await serve(setup);
    const anna = account(setup, "Anna");
    const { code } = (await postJson(base, "/api/rooms", { game: "leckfehler" }, anna.token)).body as { code: string };
    expect((await postJson(base, `/api/rooms/${code}/join`, { name: "Ben" })).status).toBe(201);
    const client = await Client.connect(running.port, { token: anna.token });
    client.send({ type: "hello", room: code });
    await client.room();
    client.send({ type: "start" });
    await client.room((room) => room.status === "running");
    client.send({ type: "move", action: { type: "aufdecken" } });
    const error = await client.error();
    expect(error.code).toBe("game-error");
    expect(JSON.stringify(client.received) + error.message).not.toMatch(/geheim/);
    client.close();
  });
});

describe("Protection against overload", () => {
  it("answers a repeated hello only on this connection", async () => {
    const setup = await prepare(mauMauDir);
    const { running } = await serve(setup);
    const host = hostRoom(setup, "mau-mau", "Anna");
    const ben = await joinRoom(setup, host.code, "Ben");
    const anna = await Client.connect(running.port, { token: host.token });
    const benClient = await Client.connect(running.port, { token: ben.token });
    anna.send({ type: "hello", room: host.code });
    benClient.send({ type: "hello", room: host.code });
    await anna.room((room) => room.members.every((member) => member.connected));
    await benClient.room((room) => room.members.every((member) => member.connected));
    await settle();
    benClient.received.length = 0;
    anna.received.length = 0;
    for (let i = 0; i < 20; i++) {
      anna.send({ type: "hello", room: host.code });
    }
    await settle(300);
    expect(anna.received.filter((message) => message.type === "room")).toHaveLength(20);
    expect(benClient.received).toEqual([]);
    anna.close();
    benClient.close();
  });

  it("sends each member exactly one update after a move", async () => {
    const setup = await prepare(mauMauDir);
    const { running } = await serve(setup);
    const host = hostRoom(setup, "mau-mau", "Anna");
    const ben = await joinRoom(setup, host.code, "Ben");
    const clients = [await Client.connect(running.port, { token: host.token }), await Client.connect(running.port, { token: ben.token })];
    clients[0]!.send({ type: "hello", room: host.code });
    clients[1]!.send({ type: "hello", room: host.code });
    await clients[0]!.room((room) => room.members.every((member) => member.connected));
    clients[0]!.send({ type: "start" });
    const view = await clients[0]!.room((room) => room.status === "running");
    await clients[1]!.room((room) => room.status === "running");
    await settle();
    clients.forEach((client) => (client.received.length = 0));
    clients[0]!.send({ type: "move", action: view.snapshot?.moves[0], expectedVersion: 0 });
    await settle(300);
    for (const client of clients) {
      expect(client.received.map((message) => (message.type === "room" ? message.room.snapshot?.version : message.type))).toEqual([1]);
    }
    clients.forEach((client) => client.close());
  });

  it("limits connections per member", async () => {
    const setup = await prepare(mauMauDir);
    const { running } = await serve(setup, { maxConnectionsPerMember: 2 });
    const host = hostRoom(setup, "mau-mau", "Anna");
    const clients = [];
    for (let i = 0; i < 3; i++) {
      const client = await Client.connect(running.port, { token: host.token });
      client.send({ type: "hello", room: host.code });
      clients.push(client);
    }
    await clients[0]!.room();
    await clients[1]!.room();
    expect(await clients[2]!.error()).toMatchObject({ code: "too-many-connections" });
    expect((await clients[2]!.closed).code).toBe(4000);
    clients.forEach((client) => client.close());
  });

  it("rate-limits creating rooms and guessing room codes per address, but not other people's rooms", async () => {
    const setup = await prepare(mauMauDir);
    const { running, base } = await serve(setup, { roomsPerMinute: 2, failedAuthPerMinute: 2 });
    const anna = account(setup, "Anna");
    expect((await postJson(base, "/api/rooms", { game: "mau-mau" }, anna.token)).status).toBe(201);
    const second = await postJson(base, "/api/rooms", { game: "mau-mau" }, anna.token);
    expect(second.status).toBe(201);
    const third = await postJson(base, "/api/rooms", { game: "mau-mau" }, anna.token);
    expect(third).toMatchObject({ status: 429, body: { code: "rate-limited" } });

    const guesser = await Client.connect(running.port, { token: guest(setup, "Mallory").token });
    for (let i = 0; i < 3; i++) {
      guesser.send({ type: "hello", room: String(second.body["code"]) });
      expect(await guesser.error()).toMatchObject({ code: "not-member" });
    }
    guesser.send({ type: "hello", room: "AAAAAA" });
    expect(await guesser.error()).toMatchObject({ code: "unknown-room" });
    expect(await postJson(base, "/api/rooms/BBBBBB/join", { name: "X" })).toMatchObject({ status: 404, body: { code: "unknown-room" } });
    guesser.send({ type: "hello", room: "CCCCCC" });
    expect(await guesser.error()).toMatchObject({ code: "rate-limited" });
    expect((await guesser.closed).code).toBe(4000);
    expect((await postJson(base, "/api/rooms/DDDDDD/join", { name: "X" })).status).toBe(429);
    expect((await postJson(base, `/api/rooms/${String(second.body["code"])}/join`, { name: "X" })).status).toBe(429);
  });

  it("disconnects connections that no longer answer pings", async () => {
    const setup = await prepare(mauMauDir);
    const { running } = await serve(setup, { heartbeatMs: 80 });
    const host = hostRoom(setup, "mau-mau", "Anna");
    const silent = await Client.connect(running.port, { autoPong: false, token: host.token });
    silent.send({ type: "hello", room: host.code });
    await silent.room();
    const closed = await Promise.race([silent.closed, settle(2000).then(() => undefined)]);
    expect(closed).toBeDefined();
  });

  it("reports a dropped connection to the others as not connected", async () => {
    const setup = await prepare(mauMauDir);
    const { running } = await serve(setup);
    const host = hostRoom(setup, "mau-mau", "Anna");
    const ben = await joinRoom(setup, host.code, "Ben");
    const anna = await Client.connect(running.port, { token: host.token });
    const benClient = await Client.connect(running.port, { token: ben.token });
    anna.send({ type: "hello", room: host.code });
    benClient.send({ type: "hello", room: host.code });
    await anna.room((room) => room.members[1]?.connected === true);
    benClient.close();
    await anna.room((room) => room.members[1]?.connected === false);
    anna.close();
  });
});

describe("Lobby", () => {
  it("lets members leave, passes on the host role and closes empty rooms", async () => {
    const setup = await prepare(mauMauDir);
    const anna = hostRoom(setup, "mau-mau", "Anna");
    const ben = await joinRoom(setup, anna.code, "Ben");
    const cem = await joinRoom(setup, anna.code, "Cem");
    setup.rooms.leave(anna.code, ben.user);
    await expectRoomError(() => setup.rooms.member(anna.code, ben.user), "not-member");
    const dora = await joinRoom(setup, anna.code, "Dora");
    expect((await setup.rooms.view(anna.code, dora.user)).members.map((member) => member.name)).toEqual(["Anna", "Cem", "Dora"]);
    setup.rooms.leave(anna.code, anna.user);
    const view = await setup.rooms.view(anna.code, cem.user);
    expect(view.members.find((member) => member.host)?.name).toBe("Cem");
    setup.rooms.leave(anna.code, cem.user);
    setup.rooms.leave(anna.code, dora.user);
    await expectRoomError(() => setup.rooms.member(anna.code, dora.user), "unknown-room");
  });

  it("lets the host remove someone, but nobody else and not during the match", async () => {
    const setup = await prepare(mauMauDir);
    const anna = hostRoom(setup, "mau-mau", "Anna");
    const ben = await joinRoom(setup, anna.code, "Ben");
    const cem = await joinRoom(setup, anna.code, "Cem");
    const members = (await setup.rooms.view(anna.code, anna.user)).members;
    const benId = members[1]!.id;
    const cemId = members[2]!.id;
    await expectRoomError(() => setup.rooms.kick(anna.code, ben.user, cemId), "not-host");
    await expectRoomError(() => setup.rooms.kick(anna.code, anna.user, members[0]!.id), "unknown-member");
    setup.rooms.kick(anna.code, anna.user, cemId);
    await expectRoomError(() => setup.rooms.member(anna.code, cem.user), "not-member");
    await setup.rooms.start(anna.code, anna.user);
    await expectRoomError(() => setup.rooms.kick(anna.code, anna.user, benId), "already-started");
    await expectRoomError(() => setup.rooms.leave(anna.code, ben.user), "already-started");
  });

  it("disconnects removed members over WebSocket", async () => {
    const setup = await prepare(mauMauDir);
    const { running } = await serve(setup);
    const anna = hostRoom(setup, "mau-mau", "Anna");
    const ben = await joinRoom(setup, anna.code, "Ben");
    const annaClient = await Client.connect(running.port, { token: anna.token });
    const benClient = await Client.connect(running.port, { token: ben.token });
    annaClient.send({ type: "hello", room: anna.code });
    benClient.send({ type: "hello", room: anna.code });
    const lobby = await annaClient.room((room) => room.members.length === 2 && room.members.every((member) => member.connected));
    annaClient.send({ type: "kick", member: lobby.members[1]!.id });
    expect(await benClient.error()).toMatchObject({ code: "removed" });
    expect((await benClient.closed).code).toBe(4000);
    await annaClient.room((room) => room.members.length === 1);
    annaClient.close();
  });

  it("removes orphaned lobbies, but no running matches", async () => {
    const setup = await prepare(mauMauDir);
    const idle = hostRoom(setup, "mau-mau", "Anna");
    const playing = hostRoom(setup, "mau-mau", "Ben");
    await joinRoom(setup, playing.code, "Cem");
    await setup.rooms.start(playing.code, playing.user);
    expect(setup.rooms.expireIdleLobbies(1)).toEqual([idle.code]);
    await expectRoomError(() => setup.rooms.member(idle.code, idle.user), "unknown-room");
    expect((await setup.rooms.view(playing.code, playing.user)).status).toBe("running");
  });
});

describe("Concurrency", () => {
  it("starts exactly once on concurrent starts", async () => {
    const setup = await prepare(mauMauDir);
    const anna = hostRoom(setup, "mau-mau", "Anna");
    await joinRoom(setup, anna.code, "Ben");
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => setup.rooms.start(anna.code, anna.user)));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    for (const outcome of outcomes.filter((item) => item.status === "rejected")) {
      expect(((outcome as PromiseRejectedResult).reason as RoomError).code).toBe("already-started");
    }
  });

  it("applies exactly one of concurrent moves on the same state", async () => {
    const setup = await prepare(zaehlenV1);
    const anna = hostRoom(setup, "zaehlen", "Anna");
    await joinRoom(setup, anna.code, "Ben");
    await setup.rooms.start(anna.code, anna.user);
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => setup.rooms.move(anna.code, anna.user, { type: "add" }, 0)));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(setup.db.prepare("SELECT COUNT(*) AS n FROM history").get()).toEqual({ n: 1 });
  });

  it("creates exactly one member on concurrent joins of the same user", async () => {
    const setup = await prepare(mauMauDir);
    const anna = hostRoom(setup, "mau-mau", "Anna");
    const ben = guest(setup, "Ben");
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => setup.rooms.joinRoom(anna.code, ben.user)));
    expect(outcomes.filter((outcome) => outcome.joined)).toHaveLength(1);
    expect((await setup.rooms.view(anna.code, anna.user)).members.map((member) => member.name)).toEqual(["Anna", "Ben"]);
  });
});

describe("Builds", () => {
  function copyGame(source: string): string {
    const dir = mkdtempSync(join(tmpdir(), "gamehearth-spiel-"));
    cpSync(source, dir, { recursive: true });
    const entry = join(dir, "src", "index.ts");
    const sdk = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url)).replaceAll("\\", "/");
    writeFileSync(entry, readFileSync(entry, "utf8").replace('"@gamehearth/sdk"', JSON.stringify(sdk)));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it("detects a change only to the manifest as a new build", async () => {
    const setup = await prepare();
    const dir = copyGame(zaehlenV1);
    const first = await setup.library.install(dir);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { players: { max: number } };
    manifest.players.max = 2;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    const second = await setup.library.install(dir);
    expect(second.build).not.toBe(first.build);
    expect(setup.library.current("zaehlen")?.manifest.players).toEqual({ min: 2, max: 2 });
  });

  it("builds the same file regardless of the working directory", async () => {
    const absolute = await bundleGameModule(mauMauDir);
    const relativeToCwd = await bundleGameModule(relative(process.cwd(), mauMauDir));
    expect(relativeToCwd).toBe(absolute);
  });

  it("detects a damaged build and repairs it on the next installation", async () => {
    const setup = await prepare(zaehlenV1);
    const room = hostRoom(setup, "zaehlen", "Anna");
    const build = setup.library.current("zaehlen")!.build;
    const versionDir = readdirSync(join(setup.dir, "builds", "zaehlen"))[0] as string;
    writeFileSync(join(setup.dir, "builds", "zaehlen", versionDir, "game.mjs"), "export default {");
    const fresh = new GameLibrary(join(setup.dir, "builds"), setup.sandbox, setup.db);
    expect(await fresh.load(build)).toBeUndefined();
    const reopened = await setup.reopen();
    cleanups.push(() => reopened.cleanup());
    await expectRoomError(joinRoom(reopened, room.code, "Ben"), "game-unavailable");
    await reopened.library.install(zaehlenV1);
    await joinRoom(reopened, room.code, "Ben");
  });
});

describe("internal errors", () => {
  it("reports a broken stored match as a server error and logs it", async () => {
    const setup = await prepare(zaehlenV1);
    const { running } = await serve(setup);
    const anna = hostRoom(setup, "zaehlen", "Anna");
    await joinRoom(setup, anna.code, "Ben");
    await setup.rooms.start(anna.code, anna.user);
    setup.db.prepare("UPDATE rooms SET match = '{kaputt' WHERE code = ?").run(anna.code);
    const client = await Client.connect(running.port, { token: anna.token });
    client.send({ type: "hello", room: anna.code });
    expect(await client.error()).toMatchObject({ code: "server-error" });
    expect(setup.logs.join("\n")).toContain("Internal error");
    client.close();
  });
});

describe("Environment variables", () => {
  it("reads valid values and defaults", () => {
    expect(readConfig({ PORT: "9000", MAX_PLAYERS: "8", TRUST_PROXY: "1" })).toMatchObject({ port: 9000, serverMaxPlayers: 8, trustProxy: true });
    expect(readConfig({})).toMatchObject({ port: 8080, serverMaxPlayers: 12, trustProxy: false });
  });

  it("reports invalid values instead of running on with NaN", () => {
    expect(readConfig({ MAX_PLAYERS: "abc", PORT: "70000", TRUST_PROXY: "ja" })).toEqual([
      'TRUST_PROXY must be 0 or 1, got "ja"',
      'PORT must be a whole number from 0 to 65535, got "70000"',
      'MAX_PLAYERS must be a whole number from 1 to 100, got "abc"',
    ]);
  });
});

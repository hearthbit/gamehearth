import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db";
import { RoomError } from "../src/rooms";
import { startServer } from "../src/transport";
import { Client, postJson } from "./client";
import { account, createSetup, hostRoom, joinRoom, zaehlenV1, zaehlenV2, type Seat, type Setup } from "./helpers";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function prepare(): Promise<Setup> {
  const setup = await createSetup();
  cleanups.push(() => setup.cleanup());
  await setup.library.install(zaehlenV1);
  return setup;
}

async function expectRoomError(work: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    expect(error).toBeInstanceOf(RoomError);
    expect((error as RoomError).code).toBe(code);
    return;
  }
  throw new Error(`expected RoomError ${code}`);
}

async function runningRoom(setup: Setup): Promise<[Seat, Seat]> {
  const anna = hostRoom(setup, "zaehlen", "Anna");
  const ben = await joinRoom(setup, anna.code, "Ben");
  await setup.rooms.start(anna.code, anna.user);
  return [anna, ben];
}

async function finish(setup: Setup, anna: Seat, ben: Seat): Promise<void> {
  for (let turn = 0; turn < 6; turn++) {
    const player = turn % 2 === 0 ? anna : ben;
    await setup.rooms.move(player.code, player.user, { type: "add" });
  }
}

describe("New round", () => {
  it("brings a finished room back to the lobby with the same members", async () => {
    const setup = await prepare();
    const [anna, ben] = await runningRoom(setup);
    await finish(setup, anna, ben);
    expect((await setup.rooms.view(anna.code, anna.user)).status).toBe("finished");
    setup.rooms.newRound(anna.code, anna.user);
    const view = await setup.rooms.view(ben.code, ben.user);
    expect(view).toMatchObject({ status: "lobby", round: 2, canStart: false });
    expect(view.snapshot).toBeUndefined();
    expect(view.members.map((member) => [member.name, member.seat])).toEqual([
      ["Anna", null],
      ["Ben", null],
    ]);
    await setup.rooms.start(anna.code, anna.user);
    const next = await setup.rooms.view(anna.code, anna.user);
    expect(next).toMatchObject({ status: "running", round: 2 });
    expect(next.snapshot?.version).toBe(0);
    await setup.rooms.move(anna.code, anna.user, { type: "add" });
  });

  it("keeps the finished round and counts the history per round", async () => {
    const setup = await prepare();
    const [anna, ben] = await runningRoom(setup);
    await finish(setup, anna, ben);
    setup.rooms.newRound(anna.code, anna.user);
    await setup.rooms.start(anna.code, anna.user);
    await setup.rooms.move(anna.code, anna.user, { type: "add" });
    const rounds = setup.db.prepare("SELECT round, outcome, json_extract(match, '$.result.winners') AS winners FROM rounds WHERE room_code = ?").all(anna.code);
    expect(rounds).toEqual([{ round: 1, outcome: "finished", winners: '["p2"]' }]);
    const history = setup.db.prepare("SELECT round, COUNT(*) AS moves FROM history WHERE room_code = ? GROUP BY round ORDER BY round").all(anna.code);
    expect(history).toEqual([
      { round: 1, moves: 6 },
      { round: 2, moves: 1 },
    ]);
  });

  it("starts the new round with the current build", async () => {
    const setup = await prepare();
    const [anna, ben] = await runningRoom(setup);
    const old = (await setup.rooms.view(anna.code, anna.user)).game.client;
    await setup.library.install(zaehlenV2);
    await finish(setup, anna, ben);
    expect((await setup.rooms.view(anna.code, anna.user)).game.client).toBe(old);
    setup.rooms.newRound(anna.code, anna.user);
    const view = await setup.rooms.view(anna.code, anna.user);
    expect(view.game.version).toBe("1.1.0");
    expect(view.game.client).not.toBe(old);
  });

  it("allows the new round only for the host and only after the end", async () => {
    const setup = await prepare();
    const [anna, ben] = await runningRoom(setup);
    await expectRoomError(() => setup.rooms.newRound(anna.code, anna.user), "not-finished");
    await finish(setup, anna, ben);
    await expectRoomError(() => setup.rooms.newRound(ben.code, ben.user), "not-host");
  });
});

describe("Aborting a match", () => {
  it("brings a running match back to the lobby without a result and keeps it", async () => {
    const setup = await prepare();
    const [anna] = await runningRoom(setup);
    await setup.rooms.move(anna.code, anna.user, { type: "add" });
    setup.rooms.abort(anna.code, anna.user);
    expect(await setup.rooms.view(anna.code, anna.user)).toMatchObject({ status: "lobby", round: 2 });
    expect(setup.db.prepare("SELECT round, outcome, json_extract(match, '$.version') AS version FROM rounds").all()).toEqual([
      { round: 1, outcome: "aborted", version: 1 },
    ]);
  });

  it("allows aborting only for the host and only during the match", async () => {
    const setup = await prepare();
    const [anna, ben] = await runningRoom(setup);
    await expectRoomError(() => setup.rooms.abort(ben.code, ben.user), "not-host");
    await finish(setup, anna, ben);
    await expectRoomError(() => setup.rooms.abort(anna.code, anna.user), "not-running");
  });

  it("does not let a move that was in the sandbox during the abort write into the new round", async () => {
    const setup = await prepare();
    const [anna] = await runningRoom(setup);
    const original = setup.sandbox.run.bind(setup.sandbox);
    let injected = false;
    setup.sandbox.run = (async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (!injected && args[2] === "applyMove") {
        injected = true;
        setup.rooms.abort(anna.code, anna.user);
        await setup.rooms.start(anna.code, anna.user);
      }
      return result;
    }) as typeof setup.sandbox.run;
    await expectRoomError(setup.rooms.move(anna.code, anna.user, { type: "add" }, 0), "stale");
    expect(injected).toBe(true);
    const view = await setup.rooms.view(anna.code, anna.user);
    expect(view).toMatchObject({ status: "running", round: 2 });
    expect(view.snapshot?.version).toBe(0);
  });
});

describe("Cleanup", () => {
  it("does not remove a lobby after a new round and keeps the stored rounds", async () => {
    const setup = await prepare();
    const [anna, ben] = await runningRoom(setup);
    await finish(setup, anna, ben);
    setup.rooms.newRound(anna.code, anna.user);
    expect(setup.rooms.expireIdleLobbies(0)).toEqual([]);
    expect((await setup.rooms.view(ben.code, ben.user)).status).toBe("lobby");
    expect(setup.db.prepare("SELECT COUNT(*) AS n FROM rounds").get()).toEqual({ n: 1 });
  });

  it("still removes lobbies that were never played in", async () => {
    const setup = await prepare();
    const anna = hostRoom(setup, "zaehlen", "Anna");
    expect(setup.rooms.expireIdleLobbies(0)).toEqual([anna.code]);
  });
});

describe("Start", () => {
  it("writes no start when the round changed during createMatch", async () => {
    const setup = await prepare();
    const anna = hostRoom(setup, "zaehlen", "Anna");
    await joinRoom(setup, anna.code, "Ben");
    const original = setup.sandbox.run.bind(setup.sandbox);
    let injected = false;
    setup.sandbox.run = (async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (!injected && args[2] === "createMatch") {
        injected = true;
        await setup.rooms.start(anna.code, anna.user);
        setup.rooms.abort(anna.code, anna.user);
      }
      return result;
    }) as typeof setup.sandbox.run;
    await expectRoomError(setup.rooms.start(anna.code, anna.user), "stale");
    expect(injected).toBe(true);
    expect(await setup.rooms.view(anna.code, anna.user)).toMatchObject({ status: "lobby", round: 2 });
  });
});

describe("Leaving", () => {
  it("works after the end, but not during the match", async () => {
    const setup = await prepare();
    const [anna, ben] = await runningRoom(setup);
    await expectRoomError(() => setup.rooms.leave(ben.code, ben.user), "already-started");
    await finish(setup, anna, ben);
    setup.rooms.leave(anna.code, anna.user);
    const view = await setup.rooms.view(ben.code, ben.user);
    expect(view.members).toEqual([expect.objectContaining({ name: "Ben", host: true })]);
    setup.rooms.leave(ben.code, ben.user);
    await expectRoomError(setup.rooms.view(ben.code, ben.user), "unknown-room");
  });
});

describe("Acknowledgements over WebSocket", () => {
  it("acknowledges messages with an id and names the id on errors", async () => {
    const setup = await prepare();
    const running = await startServer({ rooms: setup.rooms, accounts: setup.accounts, library: setup.library, port: 0, host: "127.0.0.1", log: () => {} });
    cleanups.push(() => running.close());
    const base = `http://127.0.0.1:${running.port}`;
    const anna = account(setup, "Anna");
    const { code } = (await postJson(base, "/api/rooms", { game: "zaehlen" }, anna.token)).body as { code: string };
    expect((await postJson(base, `/api/rooms/${code}/join`, { name: "Ben" })).status).toBe(201);
    const client = await Client.connect(running.port, { token: anna.token });
    cleanups.push(() => client.close());
    client.send({ type: "hello", room: code, id: 1 });
    await client.room();
    client.send({ type: "start", id: 2 });
    expect(await client.next((message) => message.type === "ack")).toEqual({ type: "ack", id: 2 });
    await client.room((room) => room.status === "running");
    client.send({ type: "move", action: { type: "add" }, expectedVersion: 7, id: 3 });
    expect(await client.error()).toMatchObject({ code: "stale", id: 3 });
    client.send({ type: "move", action: { type: "add" }, expectedVersion: 0, id: 4 });
    expect(await client.next((message) => message.type === "ack")).toEqual({ type: "ack", id: 4 });
    client.send({ type: "abort", id: 5 });
    expect(await client.next((message) => message.type === "ack")).toEqual({ type: "ack", id: 5 });
    expect(await client.room((room) => room.status === "lobby")).toMatchObject({ round: 2 });
    client.send({ type: "move", action: {}, id: -1 });
    expect(await client.error()).toMatchObject({ code: "bad-message" });
  });

  it("sends the update before the acknowledgement", async () => {
    const setup = await prepare();
    const running = await startServer({ rooms: setup.rooms, accounts: setup.accounts, library: setup.library, port: 0, host: "127.0.0.1", log: () => {} });
    cleanups.push(() => running.close());
    const base = `http://127.0.0.1:${running.port}`;
    const anna = account(setup, "Anna");
    const { code } = (await postJson(base, "/api/rooms", { game: "zaehlen" }, anna.token)).body as { code: string };
    expect((await postJson(base, `/api/rooms/${code}/join`, { name: "Ben" })).status).toBe(201);
    const client = await Client.connect(running.port, { token: anna.token });
    cleanups.push(() => client.close());
    client.send({ type: "hello", room: code });
    await client.room();
    client.send({ type: "start", id: 1 });
    await client.next((message) => message.type === "ack");
    const order: string[] = [];
    client.socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type: string; id?: number; room?: { snapshot?: { version: number } } };
      order.push(message.type === "room" ? `room v${message.room?.snapshot?.version ?? "-"}` : `${message.type} ${message.id ?? ""}`.trim());
    });
    client.send({ type: "move", action: { type: "add" }, expectedVersion: 0, id: 2 });
    await client.next((message) => message.type === "ack" && message.id === 2);
    await client.room((room) => room.snapshot?.version === 1);
    expect(order.indexOf("room v1")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("room v1")).toBeLessThan(order.indexOf("ack 2"));
  });
});

describe("Migration", () => {
  it("takes over the history of a database from step 4 as round 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "gamehearth-db-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "alt.sqlite");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE rooms (code TEXT PRIMARY KEY, game_id TEXT NOT NULL, build TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, match TEXT);
      CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, host INTEGER NOT NULL DEFAULT 0, seat TEXT, joined_at INTEGER NOT NULL);
      CREATE TABLE history (room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE, version INTEGER NOT NULL, kind TEXT NOT NULL, seat TEXT, action TEXT, now INTEGER NOT NULL, profiles TEXT, PRIMARY KEY (room_code, version));
      INSERT INTO rooms VALUES ('ABCDEF', 'zaehlen', 'zaehlen@1.0.0+000000000000', 'running', 1, 1, 1, '{}');
      INSERT INTO history VALUES ('ABCDEF', 1, 'move', 'p1', '{"type":"add"}', 5, NULL);
      INSERT INTO members VALUES (7, 'ABCDEF', 'Anna', 'hash-anna', 1, 'p1', 3);
      PRAGMA user_version = 1;
    `);
    old.close();
    const db = openDatabase(file);
    expect(db.prepare("SELECT round FROM rooms").get()).toEqual({ round: 1 });
    expect(db.prepare("SELECT round, version, seat FROM history").get()).toEqual({ round: 1, version: 1, seat: "p1" });
    expect(
      db.prepare("SELECT m.id, m.user_id, m.legacy_token_hash, m.host, m.seat, u.kind, u.display_name FROM members m JOIN users u ON u.id = m.user_id").all(),
    ).toEqual([{ id: 7, user_id: 7, legacy_token_hash: "hash-anna", host: 1, seat: "p1", kind: "guest", display_name: "Anna" }]);
    db.close();
  });

  it("keeps the final state of a match finished in step 4 at the new round", async () => {
    const setup = await prepare();
    const [anna, ben] = await runningRoom(setup);
    await finish(setup, anna, ben);
    setup.db.prepare("DELETE FROM rounds").run();
    setup.rooms.newRound(anna.code, anna.user);
    expect(setup.db.prepare("SELECT round, outcome, json_extract(match, '$.result.winners') AS winners FROM rounds").all()).toEqual([
      { round: 1, outcome: "finished", winners: '["p2"]' },
    ]);
  });
});

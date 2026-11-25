import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RoomError } from "../src/rooms";
import { startServer } from "../src/transport";
import { Client } from "./client";
import { createSetup, hostRoom, joinRoom, mauMauDir, zaehlenV1, type Setup } from "./helpers";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function prepare(...games: string[]): Promise<Setup> {
  const setup = await createSetup(undefined, { callHardLimitMs: 300 });
  cleanups.push(() => setup.cleanup());
  for (const game of games) {
    await setup.library.install(game);
  }
  return setup;
}

async function runningRoom(setup: Setup, gameId: string): Promise<{ code: string; user: number; token: string; other: number }> {
  const host = hostRoom(setup, gameId, "Anna");
  const other = await joinRoom(setup, host.code, "Ben");
  await setup.rooms.start(host.code, host.user);
  return { code: host.code, user: host.user, token: host.token, other: other.user };
}

async function roomError(work: Promise<unknown>): Promise<RoomError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(RoomError);
    return error as RoomError;
  }
  throw new Error("expected a RoomError");
}

describe("Rooms with game code in the sandbox", () => {
  it("aborts an endless loop, reports an incident and lets the match continue", async () => {
    const setup = await prepare(fixture("endlos"));
    const room = await runningRoom(setup, "endlos");
    const error = await roomError(setup.rooms.move(room.code, room.user, { type: "schleife" }));
    expect(error.code).toBe("game-error");
    expect(error.message).toMatch(/incident [0-9a-f]{8}/);
    expect(setup.logs.join("\n")).toMatch(/Sandbox \(timeout\)/);
    expect((await setup.rooms.view(room.code, room.user)).snapshot?.version).toBe(0);
    await setup.rooms.move(room.code, room.user, { type: "add" });
    expect((await setup.rooms.view(room.code, room.user)).snapshot?.version).toBe(1);
  });

  it("keeps the main thread free while a game hangs in the worker, repeats the waiting move of another room and quarantines the build after three hard aborts", async () => {
    const setup = await prepare(fixture("ewig"), mauMauDir);
    const room = await runningRoom(setup, "ewig");
    const other = await runningRoom(setup, "mau-mau");
    for (let round = 1; round <= 3; round++) {
      const attack = roomError(setup.rooms.move(room.code, room.user, { type: "sortieren" }));
      await new Promise((resolve) => setTimeout(resolve, 60));
      const started = performance.now();
      const views = await Promise.all([other.user, other.other].map((user) => setup.rooms.view(other.code, user)));
      expect(performance.now() - started).toBeLessThan(250);
      const mover = views.findIndex((view) => (view.snapshot?.moves.length ?? 0) > 0);
      const view = views[mover]!;
      const waiting = setup.rooms.move(other.code, mover === 0 ? other.user : other.other, view.snapshot?.moves[0], view.snapshot?.version);
      expect((await attack).code).toBe("game-error");
      await waiting;
      expect(setup.sandbox.restarts).toBe(round);
      expect((await setup.rooms.view(other.code, other.user)).snapshot?.version).toBe(round);
    }
    const blocked = await roomError(setup.rooms.move(room.code, room.user, { type: "add" }));
    expect(blocked.code).toBe("game-unavailable");
    expect(setup.logs.join("\n")).toContain("quarantined after 3 hard");
    expect((await roomError(Promise.resolve().then(() => hostRoom(setup, "ewig", "Cem")))).code).toBe("game-unavailable");
    expect((await setup.rooms.view(room.code, room.user)).status).toBe("running");
  }, 30_000);

  it("does not start when the lobby changes during the start", async () => {
    const setup = await prepare(zaehlenV1);
    const host = hostRoom(setup, "zaehlen", "Anna");
    await joinRoom(setup, host.code, "Ben");
    const starting = setup.rooms.start(host.code, host.user);
    const joining = joinRoom(setup, host.code, "Cem");
    const [started, joined] = await Promise.allSettled([starting, joining]);
    expect(joined.status).toBe("fulfilled");
    expect(started.status).toBe("rejected");
    expect(((started as PromiseRejectedResult).reason as RoomError).code).toBe("stale");
    const view = await setup.rooms.view(host.code, host.user);
    expect(view.status).toBe("lobby");
    expect(view.members.map((member) => member.seat)).toEqual([null, null, null]);
    await setup.rooms.start(host.code, host.user);
    expect((await setup.rooms.view(host.code, host.user)).members.map((member) => member.seat)).toEqual(["p1", "p2", "p3"]);
  });

  it("does not install a module that is not a game in the sandbox", async () => {
    const setup = await prepare();
    await expect(setup.library.install(fixture("kein-spiel"))).rejects.toThrow(/cannot be loaded in the sandbox: .*does not export a game/);
    expect(setup.library.current("kein-spiel")).toBeUndefined();
  });

  it("rate-limits moves", async () => {
    const setup = await prepare(zaehlenV1);
    const room = await runningRoom(setup, "zaehlen");
    const running = await startServer({ rooms: setup.rooms, accounts: setup.accounts, library: setup.library, port: 0, host: "127.0.0.1", limits: { movesPerMinute: 2 }, log: (message) => setup.logs.push(message) });
    cleanups.push(() => running.close());
    const client = await Client.connect(running.port, { token: room.token });
    client.send({ type: "hello", room: room.code });
    await client.room();
    for (let move = 0; move < 3; move++) {
      client.send({ type: "move", action: { type: "unbekannt" } });
    }
    const errors = [await client.error(), await client.error(), await client.error()];
    expect(errors.map((error) => error.code).sort()).toEqual(["illegal-move", "illegal-move", "rate-limited"]);
    client.close();
  });
});

describe("Rooms: findings from the review", () => {
  it("applies all concurrent moves without expectedVersion", async () => {
    const setup = await prepare(fixture("frei"));
    const room = await runningRoom(setup, "frei");
    await Promise.all([room.user, room.other, room.user].map((user) => setup.rooms.move(room.code, user, { type: "add" })));
    const view = await setup.rooms.view(room.code, room.user);
    expect(view.snapshot?.version).toBe(3);
    expect((view.snapshot?.public as { count: number }).count).toBe(3);
  });

  it("rate-limits moves per member, also across several connections", async () => {
    const setup = await prepare(zaehlenV1);
    const room = await runningRoom(setup, "zaehlen");
    const running = await startServer({ rooms: setup.rooms, accounts: setup.accounts, library: setup.library, port: 0, host: "127.0.0.1", limits: { movesPerMinute: 2 }, log: (message) => setup.logs.push(message) });
    cleanups.push(() => running.close());
    const clients = [await Client.connect(running.port, { token: room.token }), await Client.connect(running.port, { token: room.token })];
    for (const client of clients) {
      client.send({ type: "hello", room: room.code });
      await client.room();
    }
    clients[0]!.send({ type: "move", action: { type: "unbekannt" } });
    clients[0]!.send({ type: "move", action: { type: "unbekannt" } });
    expect([(await clients[0]!.error()).code, (await clients[0]!.error()).code]).toEqual(["illegal-move", "illegal-move"]);
    clients[1]!.send({ type: "move", action: { type: "unbekannt" } });
    expect((await clients[1]!.error()).code).toBe("rate-limited");
    for (const client of clients) {
      client.close();
    }
  });

  it("computes the snapshot per member only once, even with several connections", async () => {
    const setup = await prepare(zaehlenV1);
    const room = await runningRoom(setup, "zaehlen");
    const running = await startServer({ rooms: setup.rooms, accounts: setup.accounts, library: setup.library, port: 0, host: "127.0.0.1", log: (message) => setup.logs.push(message) });
    cleanups.push(() => running.close());
    const clients = await Promise.all([0, 1, 2].map(() => Client.connect(running.port, { token: room.token })));
    for (const client of clients) {
      client.send({ type: "hello", room: room.code });
      await client.room();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const original = setup.rooms.view.bind(setup.rooms);
    let views = 0;
    setup.rooms.view = (...args) => {
      views += 1;
      return original(...args);
    };
    await setup.rooms.move(room.code, room.user, { type: "add" });
    await Promise.all(clients.map((client) => client.room((view) => view.snapshot?.version === 1)));
    expect(views).toBe(1);
    for (const client of clients) {
      client.close();
    }
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountService } from "../src/accounts";
import { cleanUp, describeCleanup } from "../src/cleanup";
import { readConfig } from "../src/config";
import { openDatabase } from "../src/db";
import { GameLibrary } from "../src/games";
import { RoomError, RoomService } from "../src/rooms";
import { SandboxHost } from "../src/sandbox/host";
import { cheapPasswords, mauMauDir } from "./helpers";

const day = 24 * 60 * 60 * 1000;
let dir: string;
let sandbox: SandboxHost;
let db: ReturnType<typeof openDatabase>;
let now: number;
let rooms: RoomService;
let accounts: AccountService;
let closed: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gamehearth-limits-"));
  sandbox = await SandboxHost.start({ log: () => undefined });
  db = openDatabase(join(dir, "test.sqlite"));
  const library = new GameLibrary(join(dir, "builds"), sandbox, db);
  await library.install(mauMauDir);
  now = 1_000_000_000;
  rooms = new RoomService(db, library, sandbox, { serverMaxPlayers: 12, maxHostedRooms: 2, maxRoomsPerUser: 3, clock: () => now, log: () => undefined });
  accounts = new AccountService(db, { clock: () => now, passwordCost: cheapPasswords });
  closed = [];
  rooms.on({ closed: (code) => closed.push(code) });
});

afterEach(async () => {
  db.close();
  await sandbox.close();
  rmSync(dir, { recursive: true, force: true });
});

function user(name: string, role: "player" | "admin" = "player"): number {
  return Number(
    db
      .prepare("INSERT INTO users (kind, username, display_name, role, created_at, active_at) VALUES ('account', ?, ?, ?, ?, ?)")
      .run(name, name, role, now, now).lastInsertRowid,
  );
}

function code(error: unknown): string {
  return error instanceof RoomError ? error.code : String(error);
}

describe("Limits", () => {
  it("limits open rooms as host, except for admins, and does not count finished ones", () => {
    const anna = user("anna");
    const first = rooms.createRoom("mau-mau", anna).code;
    rooms.createRoom("mau-mau", anna);
    expect(code(captured(() => rooms.createRoom("mau-mau", anna)))).toBe("too-many-rooms");
    db.prepare("UPDATE rooms SET status = 'finished' WHERE code = ?").run(first);
    expect(rooms.createRoom("mau-mau", anna).code).toMatch(/^[A-Z2-9]{6}$/);
    const admin = user("admin", "admin");
    rooms.createRoom("mau-mau", admin);
    rooms.createRoom("mau-mau", admin);
    expect(rooms.createRoom("mau-mau", admin).code).toMatch(/^[A-Z2-9]{6}$/);
    expect(code(captured(() => rooms.createRoom("mau-mau", admin)))).toBe("too-many-rooms");
  });

  it("limits rooms per user on joining too, but not for existing memberships", async () => {
    const hosts = [user("h1"), user("h2"), user("h3"), user("h4")];
    const codes = hosts.map((host) => rooms.createRoom("mau-mau", host).code);
    const guest = accounts.createGuest("Gast").id;
    for (const target of codes.slice(0, 3)) {
      await rooms.joinRoom(target, guest);
    }
    await expect(rooms.joinRoom(codes[3] as string, guest)).rejects.toMatchObject({ code: "too-many-rooms" });
    expect((await rooms.joinRoom(codes[0] as string, guest)).joined).toBe(false);
  });
});

describe("Cleanup", () => {
  it("removes old finished rooms after 30 days and abandoned matches after 90 days, and announces it", async () => {
    const anna = user("anna");
    const ben = accounts.createGuest("Ben").id;
    const finished = rooms.createRoom("mau-mau", anna).code;
    const running = rooms.createRoom("mau-mau", user("cem")).code;
    const lobby = rooms.createRoom("mau-mau", user("dora")).code;
    await rooms.joinRoom(running, ben);
    await rooms.start(running, (db.prepare("SELECT user_id FROM members WHERE room_code = ? AND host = 1").get(running) as { user_id: number }).user_id);
    db.prepare("UPDATE rooms SET status = 'finished' WHERE code = ?").run(finished);
    db.prepare("UPDATE rooms SET round = 2 WHERE code = ?").run(lobby);
    const summary = rooms.rooms(ben)[0];
    expect(summary?.expiresAt).toBe((summary?.updatedAt ?? 0) + 90 * day);
    expect(rooms.rooms(anna)[0]?.expiresAt).toBe(now + 30 * day);

    now += 30 * day + 1;
    expect(rooms.expireRooms().sort()).toEqual([finished, lobby].sort());
    now += 60 * day;
    expect(rooms.expireRooms()).toEqual([running]);
    expect(closed.sort()).toEqual([finished, lobby, running].sort());
  });

  it("expires guests after 30 days without activity and cleans up their seats", async () => {
    const anna = user("anna");
    const host = rooms.createRoom("mau-mau", anna).code;
    const ben = accounts.createGuest("Ben").id;
    await rooms.joinRoom(host, ben);
    const lonely = accounts.createGuest("Allein").id;
    now += 31 * day;
    db.prepare("UPDATE rooms SET updated_at = ?").run(now);
    const report = cleanUp(rooms, accounts, day);
    expect(report).toEqual({ lobbies: 0, rooms: 0, guests: 2 });
    expect(describeCleanup(report)).toBe("Cleaned up: 2 expired guests");
    expect(describeCleanup({ lobbies: 0, rooms: 0, guests: 0 })).toBeUndefined();
    expect(rooms.allRooms()[0]?.members.map((member) => member.name)).toEqual(["anna"]);
    expect(() => accounts.user(lonely)).toThrow();
  });

  it("reads limits and periods from the environment and rejects nonsense", () => {
    expect(readConfig({})).toMatchObject({ maxHostedRooms: 20, maxRoomsPerUser: 50, guestDays: 30, finishedRoomDays: 30, idleGameDays: 90 });
    expect(readConfig({ MAX_HOSTED_ROOMS: "5", GUEST_DAYS: "7", IDLE_GAME_DAYS: "365" })).toMatchObject({ maxHostedRooms: 5, guestDays: 7, idleGameDays: 365 });
    expect(readConfig({ MAX_ROOMS_PER_USER: "0" })).toEqual([expect.stringContaining("MAX_ROOMS_PER_USER")]);
  });
});

function captured(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

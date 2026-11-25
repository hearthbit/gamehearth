import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { ProfileChange, ProfileOperation } from "@gamehearth/sdk/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, schemaVersion, userVersion, migrate } from "../src/db";
import { gamePage } from "../src/game-page";
import { ProfileError } from "../src/profiles";
import { RoomError } from "../src/rooms";
import { account, createSetup, dorfladenDir, guest, hostRoom, joinRoom, sammeltakt, type Seat, type Setup } from "./helpers";

let setup: Setup;
let now = 1_000_000;
const temporary: string[] = [];

beforeEach(async () => {
  now = 1_000_000;
  setup = await createSetup(undefined, {}, { clock: () => (now += 1000), realtime: { timers: false } });
  await setup.library.install(dorfladenDir);
  await setup.library.install(sammeltakt);
});

afterEach(async () => {
  await setup.cleanup();
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Change = [ProfileOperation, string, number | string | boolean];

function give(user: number, changes: Change[], game = "dorfladen"): void {
  const catalog = setup.rooms.profiles.catalog(game).catalog;
  const list: ProfileChange[] = changes.map(([op, id, value]) => ({ player: "p1", op, id, value }));
  expect(setup.rooms.profiles.apply(user, game, list, catalog)).toBeUndefined();
}

function profile(user: number, game = "dorfladen") {
  return setup.rooms.profiles.read(user, game).profile;
}

async function started(name = "Anna", options: { runden?: number } = {}): Promise<Seat> {
  const host = hostRoom(setup, "dorfladen", name);
  if (options.runden !== undefined) {
    await setup.rooms.setOption(host.code, host.user, "runden", options.runden);
  }
  await setup.rooms.start(host.code, host.user);
  return host;
}

async function moves(seat: { code: string; user: number }): Promise<string[]> {
  const view = await setup.rooms.view(seat.code, seat.user);
  return ((view.snapshot?.moves ?? []) as { type: string }[]).map((move) => move.type);
}

async function expectRoomError(work: Promise<unknown>, code: string): Promise<RoomError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(RoomError);
    expect((error as RoomError).code).toBe(code);
    return error as RoomError;
  }
  throw new Error(`expected RoomError ${code}`);
}

function history(code: string): { version: number; kind: string; profiles: string | null }[] {
  return setup.db.prepare("SELECT version, kind, profiles FROM history WHERE room_code = ? ORDER BY round, version").all(code) as unknown as {
    version: number;
    kind: string;
    profiles: string | null;
  }[];
}

describe("Profiles in turn-based matches", () => {
  it("reads the profile at the start and shows it to the own client", async () => {
    const anna = account(setup, "Anna");
    give(anna.user, [["add", "apfel", 1]]);
    const room = setup.rooms.createRoom("dorfladen", anna.user);
    await setup.rooms.start(room.code, anna.user);
    expect(await moves({ code: room.code, user: anna.user })).toEqual(["arbeiten", "essen"]);
    expect((await setup.rooms.view(room.code, anna.user)).profile).toEqual({ items: { apfel: 1 }, stats: {}, flags: {} });
    expect(history(room.code)).toEqual([{ version: 0, kind: "start", profiles: '{"p1":{"items":{"apfel":1},"stats":{},"flags":{}}}' }]);
  });

  it("applies move and profile changes together and stores read profiles only when they changed", async () => {
    const anna = await started("Anna", { runden: 5 });
    await setup.rooms.move(anna.code, anna.user, { type: "arbeiten" });
    expect(profile(anna.user)).toEqual({ items: { muenze: 2 }, stats: {}, flags: {} });
    expect(setup.rooms.profiles.revision(anna.user, "dorfladen")).toBe(1);
    await setup.rooms.move(anna.code, anna.user, { type: "arbeiten" });
    await setup.rooms.move(anna.code, anna.user, { type: "kaufen" });
    expect(profile(anna.user).items).toEqual({ muenze: 1, apfel: 1 });
    expect(await moves(anna)).toEqual(["arbeiten", "essen"]);
    expect(history(anna.code).map((entry) => [entry.version, entry.kind, entry.profiles === null ? null : JSON.parse(entry.profiles).p1.items])).toEqual([
      [1, "move", null],
      [2, "move", { muenze: 2 }],
      [3, "move", { muenze: 4 }],
    ]);
  });

  it("writes wins, best scores, counters and flags at the end and shows leaderboards only for stats with better", async () => {
    const anna = await started("Anna", { runden: 2 });
    await setup.rooms.move(anna.code, anna.user, { type: "arbeiten" });
    await setup.rooms.move(anna.code, anna.user, { type: "arbeiten" });
    const stats = profile(anna.user).stats;
    expect(stats).toMatchObject({ siege: 1, partien: 1, bestwert: 2 });
    expect(stats["kuerzeste"]).toBeGreaterThan(0);
    expect(profile(anna.user).flags).toEqual({ titel: "Ladenkönig" });
    const page = gamePage(setup.library, setup.rooms.profiles, "dorfladen", anna.user);
    expect(Object.keys(page.boards).sort()).toEqual(["bestwert", "kuerzeste", "siege"]);
    expect(page.boards["siege"]).toEqual([{ rank: 1, name: "Anna", value: 1, you: true }]);
    expect(page.source).toBe("server");
    expect(page.game.items["alte-muenze"]).toEqual({ label: { de: "Alte Münze", en: "Old coin" }, deprecated: true });
  });

  it("gives guests a throwaway profile per match", async () => {
    const anna = hostRoom(setup, "dorfladen", "Anna");
    const ben = await joinRoom(setup, anna.code, "Ben");
    await setup.rooms.setOption(anna.code, anna.user, "runden", 2);
    await setup.rooms.start(anna.code, anna.user);
    await setup.rooms.move(anna.code, anna.user, { type: "arbeiten" });
    await setup.rooms.move(ben.code, ben.user, { type: "arbeiten" });
    expect((await setup.rooms.view(ben.code, ben.user)).profile).toEqual({ items: { muenze: 2 }, stats: {}, flags: {} });
    expect(setup.db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE user_id = ?").get(ben.user)).toEqual({ n: 0 });
    await setup.rooms.move(anna.code, anna.user, { type: "arbeiten" });
    await setup.rooms.move(ben.code, ben.user, { type: "arbeiten" });
    expect((await setup.rooms.view(ben.code, ben.user)).profile?.stats).toMatchObject({ partien: 1 });
    expect(profile(anna.user).stats).toMatchObject({ partien: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS n FROM stats WHERE user_id = ?").get(ben.user)).toEqual({ n: 0 });
    setup.rooms.newRound(anna.code, anna.user);
    expect(setup.db.prepare("SELECT guest_profiles FROM rooms WHERE code = ?").get(anna.code)).toEqual({ guest_profiles: null });
    await setup.rooms.start(anna.code, anna.user);
    expect((await setup.rooms.view(ben.code, ben.user)).profile).toEqual({ items: {}, stats: {}, flags: {} });
    expect((await setup.rooms.view(anna.code, anna.user)).profile?.items).toEqual({ muenze: 4 });
  });

  it("rejects a move with a missing item with its own error code and leaves the match unchanged", async () => {
    const anna = account(setup, "Anna");
    give(anna.user, [["add", "apfel", 1]]);
    const room = setup.rooms.createRoom("dorfladen", anna.user);
    await setup.rooms.start(room.code, anna.user);
    give(anna.user, [["use", "apfel", 1]]);
    const before = await setup.rooms.view(room.code, anna.user);
    const error = await expectRoomError(setup.rooms.move(room.code, anna.user, { type: "essen" }, before.snapshot?.version), "missing-item");
    expect(error.message).toMatch(/Something this move needs is now missing from the profile/);
    expect((await setup.rooms.view(room.code, anna.user)).snapshot?.version).toBe(before.snapshot?.version);
    expect(profile(anna.user).items).toEqual({});
  });

  it("recomputes the moves of the same player's running matches when another match changes their profile", async () => {
    const anna = account(setup, "Anna");
    give(anna.user, [["add", "apfel", 1]]);
    const first = setup.rooms.createRoom("dorfladen", anna.user);
    const second = setup.rooms.createRoom("dorfladen", anna.user);
    await setup.rooms.start(first.code, anna.user);
    await setup.rooms.start(second.code, anna.user);
    const changed: string[] = [];
    setup.rooms.on({ changed: (code) => changed.push(code) });
    await setup.rooms.move(first.code, anna.user, { type: "essen" });
    await setup.rooms.whenRefreshed();
    expect(await moves({ code: second.code, user: anna.user })).toEqual(["arbeiten"]);
    expect(changed).toContain(second.code);
    expect(history(second.code).map((entry) => entry.kind)).toEqual(["start", "refresh"]);
    expect((await setup.rooms.view(second.code, anna.user)).snapshot?.version).toBe(1);
    await setup.rooms.move(second.code, anna.user, { type: "arbeiten" }, 1);
    expect(profile(anna.user).items).toEqual({ muenze: 2 });
  });

  it("sends only an update without a new version when the moves do not change", async () => {
    const anna = account(setup, "Anna");
    const first = setup.rooms.createRoom("dorfladen", anna.user);
    const second = setup.rooms.createRoom("dorfladen", anna.user);
    await setup.rooms.start(first.code, anna.user);
    await setup.rooms.start(second.code, anna.user);
    await setup.rooms.move(first.code, anna.user, { type: "arbeiten" });
    await setup.rooms.whenRefreshed();
    const view = await setup.rooms.view(second.code, anna.user);
    expect(view.snapshot?.version).toBe(0);
    expect(view.profile?.items).toEqual({ muenze: 2 });
    expect(history(second.code).map((entry) => entry.kind)).toEqual([]);
  });

  it("recomputes a move with the new profile when the profile changes meanwhile", async () => {
    const anna = await started();
    const run = setup.sandbox.run.bind(setup.sandbox);
    let calls = 0;
    setup.sandbox.run = async (...args: Parameters<typeof run>) => {
      const result = await run(...args);
      if (args[2] === "applyMove" && calls++ === 0) {
        give(anna.user, [["add", "muenze", 5]]);
      }
      return result;
    };
    await setup.rooms.move(anna.code, anna.user, { type: "arbeiten" }, 0);
    expect(calls).toBe(2);
    expect(profile(anna.user).items).toEqual({ muenze: 7 });
    expect((await setup.rooms.view(anna.code, anna.user)).snapshot?.public).toMatchObject({ points: { p1: 1 } });
  });

  it("after an update without a known ID rejects operations on it, but keeps the values in the profile", async () => {
    const anna = account(setup, "Anna");
    give(anna.user, [["add", "apfel", 2]]);
    const dir = mkdtempSync(join(tmpdir(), "gamehearth-dorfladen-v2-"));
    temporary.push(dir);
    cpSync(dorfladenDir, dir, { recursive: true });
    const file = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(file, "utf8")) as { version: string; items: Record<string, unknown> };
    manifest.version = "0.2.0";
    delete manifest.items["apfel"];
    writeFileSync(file, JSON.stringify(manifest, null, 2));
    await setup.library.install(dir);
    expect(setup.rooms.profiles.unknownIds("dorfladen", setup.rooms.profiles.catalog("dorfladen").catalog)).toEqual({ items: ["apfel"], stats: [], flags: [] });
    const room = setup.rooms.createRoom("dorfladen", anna.user);
    await setup.rooms.start(room.code, anna.user);
    await expectRoomError(setup.rooms.move(room.code, anna.user, { type: "essen" }), "game-error");
    expect(profile(anna.user).items).toEqual({ apfel: 2 });
    expect(setup.logs.some((line) => line.includes('The item "apfel" is not listed under items in manifest.json'))).toBe(true);
  });
});

describe("Profiles in realtime matches", () => {
  async function ticks(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      now += 50;
      await setup.rooms.realtime.tickAll();
    }
  }

  it("writes changes from inputs and ticks together with the match state", async () => {
    const host = hostRoom(setup, "sammeltakt", "Anna");
    await setup.rooms.start(host.code, host.user);
    setup.rooms.realtime.presence(host.code, { seats: new Set(["p1"]), screens: 0 });
    now += 3500;
    await ticks(1);
    const input = setup.rooms.move(host.code, host.user, { type: "sammle" });
    await ticks(1);
    await input;
    expect(profile(host.user, "sammeltakt").items).toEqual({ stern: 1 });
    const stored = setup.db.prepare("SELECT match FROM rooms WHERE code = ?").get(host.code) as { match: string };
    expect(JSON.parse(stored.match).version).toBe(setup.rooms.realtime.match(host.code)?.version);
    expect((await setup.rooms.view(host.code, host.user)).profile?.items).toEqual({ stern: 1 });
    await ticks(8);
    expect(profile(host.user, "sammeltakt").stats).toEqual({ takte: 10 });
    const spent = setup.rooms.move(host.code, host.user, { type: "tausche" });
    await ticks(1);
    await spent;
    expect(profile(host.user, "sammeltakt").items).toEqual({});
    await ticks(25);
    expect(setup.rooms.realtime.has(host.code)).toBe(false);
    expect(profile(host.user, "sammeltakt").stats).toEqual({ takte: 30, rekord: 1 });
  });
});

describe("Game page, reset and admin view", () => {
  it("resets the own profile and recomputes running matches", async () => {
    const anna = account(setup, "Anna");
    give(anna.user, [["add", "apfel", 1], ["stat", "siege", 3], ["flag", "titel", "Ladenkönig"]]);
    const room = setup.rooms.createRoom("dorfladen", anna.user);
    await setup.rooms.start(room.code, anna.user);
    setup.rooms.profiles.reset(anna.user, "dorfladen");
    await setup.rooms.whenRefreshed();
    expect(profile(anna.user)).toEqual({ items: {}, stats: {}, flags: {} });
    expect(await moves({ code: room.code, user: anna.user })).toEqual(["arbeiten"]);
    expect(gamePage(setup.library, setup.rooms.profiles, "dorfladen", anna.user).boards["siege"]).toEqual([]);
  });

  it("deletes single entries in the admin view and lists profiles with content", async () => {
    const anna = account(setup, "Anna");
    const ben = account(setup, "Ben");
    give(anna.user, [["add", "apfel", 1], ["add", "muenze", 4], ["stat", "siege", 3], ["flag", "titel", "Ladenkönig"]]);
    give(ben.user, [["stat", "partien", 1]]);
    expect(setup.rooms.profiles.adminProfiles("dorfladen").map((entry) => entry.name)).toEqual(["Anna", "Ben"]);
    setup.rooms.profiles.deleteEntry(anna.user, "dorfladen", "items", "apfel");
    setup.rooms.profiles.deleteEntry(anna.user, "dorfladen", "stats", "siege");
    setup.rooms.profiles.deleteEntry(anna.user, "dorfladen", "flags", "titel");
    expect(profile(anna.user)).toEqual({ items: { muenze: 4 }, stats: {}, flags: {} });
    expect(() => setup.rooms.profiles.deleteEntry(anna.user, "dorfladen", "stats", "siege")).toThrow(ProfileError);
    expect(() => setup.rooms.profiles.deleteEntry(anna.user, "dorfladen", "items", "Apfel")).toThrow(/section must be items/);
    setup.rooms.profiles.reset(ben.user, "dorfladen");
    expect(setup.rooms.profiles.adminProfiles("dorfladen").map((entry) => entry.name)).toEqual(["Anna"]);
    const gast = guest(setup, "Gast");
    expect(() => setup.rooms.profiles.reset(gast.user, "dorfladen")).toThrow(/Only players with an account have profiles/);
  });

  it("shows guests and signed-out visitors no profile, but the leaderboard", () => {
    const anna = account(setup, "Anna");
    give(anna.user, [["record", "bestwert", 9]]);
    const page = gamePage(setup.library, setup.rooms.profiles, "dorfladen", undefined);
    expect(page.profile).toBeNull();
    expect(page.boards["bestwert"]).toEqual([{ rank: 1, name: "Anna", value: 9, you: false }]);
    expect(() => gamePage(setup.library, setup.rooms.profiles, "gibt-es-nicht", anna.user)).toThrow(ProfileError);
  });
});

describe("Migration to schema 10", () => {
  it("creates profiles and guest_profiles and keeps the history with the new entry kind start", () => {
    const dir = mkdtempSync(join(tmpdir(), "gamehearth-migration10-"));
    temporary.push(dir);
    const fresh = openDatabase(join(dir, "neu.sqlite"));
    expect(userVersion(fresh)).toBe(schemaVersion);
    fresh.close();
    const raw = new DatabaseSync(join(dir, "v9.sqlite"));
    migrate(raw, 9);
    raw.prepare("INSERT INTO rooms (code, game_id, build, status, created_at, updated_at) VALUES ('ABCDEF', 'x', 'x@1+1', 'running', 1, 1)").run();
    raw.prepare("INSERT INTO history (room_code, round, version, kind, seat, action, now) VALUES ('ABCDEF', 1, 1, 'move', 'p1', '{}', 5)").run();
    migrate(raw, 10);
    expect(userVersion(raw)).toBe(10);
    expect(raw.prepare("SELECT room_code, version, kind FROM history").all()).toEqual([{ room_code: "ABCDEF", version: 1, kind: "move" }]);
    raw.prepare("INSERT INTO history (room_code, round, version, kind, now) VALUES ('ABCDEF', 1, 0, 'start', 1)").run();
    expect(raw.prepare("SELECT guest_profiles FROM rooms").get()).toEqual({ guest_profiles: null });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM profiles").get()).toEqual({ n: 0 });
    raw.close();
  });
});

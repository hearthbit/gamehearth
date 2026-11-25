import { fileURLToPath } from "node:url";
import type { ProfileChange, ProfileOperation } from "@gamehearth/sdk/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogService } from "../src/catalogs";
import { RoomError } from "../src/rooms";
import { SoloService } from "../src/solo";
import { startServer, type RunningServer } from "../src/transport";
import { getJson, postJson } from "./client";
import { account, createSetup, dorfladenDir, hostRoom, joinRoom, sammeltakt, type Setup } from "./helpers";

const sternchen = fileURLToPath(new URL("./fixtures/sternchen", import.meta.url));

let setup: Setup;
let now = 1_000_000;

beforeEach(async () => {
  now = 1_000_000;
  setup = await createSetup(undefined, {}, { clock: () => (now += 1000), realtime: { timers: false } });
  await setup.library.install(dorfladenDir);
  await setup.library.install(sammeltakt);
});

afterEach(async () => {
  await setup.cleanup();
});

type Change = [ProfileOperation, string, number | string | boolean];

function give(user: number, changes: Change[], game = "dorfladen"): void {
  const catalog = setup.rooms.profiles.catalog(game).catalog;
  const list: ProfileChange[] = changes.map(([op, id, value]) => ({ player: "p1", op, id, value }));
  expect(setup.rooms.profiles.apply(user, game, list, catalog)).toBeUndefined();
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

async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    now += 50;
    await setup.rooms.realtime.tickAll();
  }
}

describe("Review 10b: reset and single-player games", () => {
  it("after a reset brings back no best scores that a device reached before but never synced", async () => {
    await setup.library.install(sternchen);
    const solo = new SoloService(setup.db, setup.library, { clock: () => now });
    const anna = account(setup, "Anna");
    setup.rooms.profiles.reset(anna.user, "sternchen");
    const view = solo.sync(anna.user, "sternchen", { best: { punkte: { value: 100, at: 1, generation: 0 } } });
    expect(view.best).toEqual({});
    expect(view.generations["punkte"]).toBe(1);
  });

  it("after a reset also does not bring back values reached after an earlier deletion", async () => {
    await setup.library.install(sternchen);
    const solo = new SoloService(setup.db, setup.library, { clock: () => now });
    const anna = account(setup, "Anna");
    solo.deleteBest(anna.user, "sternchen");
    setup.rooms.profiles.reset(anna.user, "sternchen");
    const view = solo.sync(anna.user, "sternchen", { best: { punkte: { value: 77, at: 1, generation: 1 } } });
    expect(view.best).toEqual({});
    expect(solo.sync(anna.user, "sternchen", { best: { punkte: { value: 78, at: 2, generation: 2 } } }).best).toEqual({ punkte: 78 });
  });
});

describe("Review 10b: error messages reveal no profiles", () => {
  it("names neither seat nor stock for a missing item", async () => {
    const anna = account(setup, "Anna");
    give(anna.user, [["add", "apfel", 1]]);
    const room = setup.rooms.createRoom("dorfladen", anna.user);
    await setup.rooms.start(room.code, anna.user);
    give(anna.user, [["use", "apfel", 1]]);
    const error = await roomError(setup.rooms.move(room.code, anna.user, { type: "essen" }));
    expect(error.code).toBe("missing-item");
    expect(error.message).toBe("Something this move needs is now missing from the profile; the move was not made");
  });

  it("not for realtime inputs either", async () => {
    const host = hostRoom(setup, "sammeltakt", "Anna");
    give(host.user, [["add", "stern", 1]], "sammeltakt");
    await setup.rooms.start(host.code, host.user);
    setup.rooms.realtime.presence(host.code, { seats: new Set(["p1"]), screens: 0 });
    now += 3500;
    await ticks(1);
    give(host.user, [["use", "stern", 1]], "sammeltakt");
    const input = setup.rooms.move(host.code, host.user, { type: "tausche" });
    await ticks(1);
    const error = await roomError(input);
    expect(error.code).toBe("missing-item");
    expect(error.message).not.toMatch(/p1|vorhanden|stern/);
  });
});

describe("Review 10b: guest becomes an account in the middle of a match", () => {
  it("keeps the throwaway profile until the end of the match and uses the account profile only from the next round", async () => {
    const anna = hostRoom(setup, "dorfladen", "Anna");
    const ben = await joinRoom(setup, anna.code, "Ben");
    await setup.rooms.setOption(anna.code, anna.user, "runden", 5);
    await setup.rooms.start(anna.code, anna.user);
    await setup.rooms.move(anna.code, anna.user, { type: "arbeiten" });
    await setup.rooms.move(ben.code, ben.user, { type: "arbeiten" });
    const { token } = setup.accounts.createInvite(anna.user, { role: "player" });
    await setup.accounts.acceptInvite(token, { username: "ben-gross", name: "Ben", password: "ein-langes-passwort" }, setup.accounts.session(ben.token));
    expect((await setup.rooms.view(ben.code, ben.user)).profile?.items).toEqual({ muenze: 2 });
    await setup.rooms.move(anna.code, anna.user, { type: "arbeiten" });
    await setup.rooms.move(ben.code, ben.user, { type: "arbeiten" });
    expect((await setup.rooms.view(ben.code, ben.user)).profile?.items).toEqual({ muenze: 4 });
    await setup.rooms.move(anna.code, anna.user, { type: "arbeiten" });
    await setup.rooms.move(ben.code, ben.user, { type: "kaufen" });
    expect(setup.rooms.profiles.read(ben.user, "dorfladen").profile).toEqual({ items: {}, stats: {}, flags: {} });
    setup.rooms.abort(anna.code, anna.user);
    await setup.rooms.start(anna.code, anna.user);
    await setup.rooms.move(anna.code, anna.user, { type: "arbeiten" });
    await setup.rooms.move(ben.code, ben.user, { type: "arbeiten" });
    expect(setup.rooms.profiles.read(ben.user, "dorfladen").profile.items).toEqual({ muenze: 2 });
  });
});

describe("Review 10b: changes without effect", () => {
  it("writes nothing and does not raise the revision when the profile does not change", () => {
    const anna = account(setup, "Anna");
    give(anna.user, [["record", "bestwert", 9]]);
    const revision = setup.rooms.profiles.revision(anna.user, "dorfladen");
    give(anna.user, [["record", "bestwert", 5], ["flag", "titel", false]]);
    expect(setup.rooms.profiles.revision(anna.user, "dorfladen")).toBe(revision);
    expect(setup.rooms.profiles.read(anna.user, "dorfladen").profile.stats).toEqual({ bestwert: 9 });
  });
});

describe("Review 10b: recomputing without a result", () => {
  it("accepts no match with a result from recomputing", async () => {
    const anna = account(setup, "Anna");
    give(anna.user, [["add", "apfel", 1]]);
    const first = setup.rooms.createRoom("dorfladen", anna.user);
    const second = setup.rooms.createRoom("dorfladen", anna.user);
    await setup.rooms.start(first.code, anna.user);
    await setup.rooms.start(second.code, anna.user);
    const run = setup.sandbox.run.bind(setup.sandbox);
    setup.sandbox.run = async (...args: Parameters<typeof run>) => {
      const result = await run(...args);
      if (args[2] === "refreshMatch" && result.ok && result.outcome.ok) {
        return { ...result, outcome: { ok: true, match: { ...result.outcome.match, result: { winners: [] } } } };
      }
      return result;
    };
    await setup.rooms.move(first.code, anna.user, { type: "essen" });
    await setup.rooms.whenRefreshed();
    const view = await setup.rooms.view(second.code, anna.user);
    expect(view.status).toBe("running");
    expect(view.snapshot?.result).toBeUndefined();
    expect(setup.logs.some((line) => line.includes("recomputing returned a result"))).toBe(true);
  });
});

describe("Review 10b: endpoints", () => {
  let running: RunningServer;
  let base: string;

  beforeEach(async () => {
    running = await startServer({
      rooms: setup.rooms,
      accounts: setup.accounts,
      library: setup.library,
      catalogs: new CatalogService(setup.db, setup.library),
      port: 0,
      host: "127.0.0.1",
      log: (message) => setup.logs.push(message),
      limits: { pushChangesPerMinute: 1, profileResetsPerMinute: 2 },
    });
    base = `http://127.0.0.1:${running.port}`;
  });

  afterEach(async () => {
    await running.close();
  });

  it("creates nothing in the admin view for an unknown game before reporting 404", async () => {
    const admin = account(setup, "Admin", "admin");
    const anna = account(setup, "Anna");
    expect((await postJson(base, `/api/admin/games/gibt-es-nicht/profiles/${anna.user}/reset`, {}, admin.token)).status).toBe(404);
    expect((await postJson(base, `/api/admin/games/gibt-es-nicht/profiles/${anna.user}/delete`, { section: "items", id: "apfel" }, admin.token)).status).toBe(404);
    expect(setup.db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE game_id = 'gibt-es-nicht'").get()).toEqual({ n: 0 });
  });

  it("rate-limits resets per account with its own bucket, independent of push", async () => {
    const anna = account(setup, "Anna");
    const room = setup.rooms.createRoom("dorfladen", anna.user);
    expect((await postJson(base, `/api/rooms/${room.code}/mute`, { muted: true }, anna.token)).status).toBe(200);
    expect((await postJson(base, `/api/rooms/${room.code}/mute`, { muted: false }, anna.token)).status).toBe(429);
    expect((await postJson(base, "/api/games/dorfladen/reset", {}, anna.token)).status).toBe(200);
    expect((await postJson(base, "/api/games/dorfladen/reset", {}, anna.token)).status).toBe(200);
    expect((await postJson(base, "/api/games/dorfladen/reset", {}, anna.token)).status).toBe(429);
    expect((await getJson(base, "/api/games/dorfladen", anna.token)).status).toBe(200);
  });
});

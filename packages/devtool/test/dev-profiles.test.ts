import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleGameForDev } from "../src/bundle";
import { DevEngine } from "../src/dev/engine";
import { DevProfiles } from "../src/dev/profiles-file";
import { DevSession } from "../src/dev/session";
import { catalogOf, type Manifest } from "../src/manifest";

const dir = fileURLToPath(new URL("./fixtures/profile-shop", import.meta.url));
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;

describe("dev with profiles", () => {
  let engine: DevEngine;

  beforeAll(async () => {
    engine = await DevEngine.start({ limitMs: 1500 });
    const bundle = await bundleGameForDev(dir);
    expect(await engine.load(bundle.code, JSON.stringify(catalogOf(manifest)))).toEqual({ ok: true });
  }, 60_000);

  afterAll(() => engine.close());

  it("keeps one profile per seat in memory, replays it on reload and starts every match empty", async () => {
    const session = new DevSession({ engine, timers: false, catalog: () => catalogOf(manifest), now: () => 1000 });
    await session.newMatch(1, "dev-profile");
    expect(session.view().seats[0]?.profile).toEqual({ items: {}, stats: {}, flags: {} });
    expect(await session.move("p1", { type: "arbeiten" })).toEqual({ ok: true });
    expect(await session.move("p1", { type: "arbeiten" })).toEqual({ ok: true });
    expect(await session.move("p1", { type: "kaufen" })).toEqual({ ok: true });
    expect(session.view().seats[0]?.profile).toEqual({ items: { muenze: 1, trank: 1 }, stats: {}, flags: {} });
    expect((session.view().seats[0]?.snapshot as { moves: unknown[] }).moves).toContainEqual({ type: "trinken" });
    await session.reload();
    expect(session.view().note).toBe("Rules reloaded, 3 moves replayed.");
    expect(session.view().seats[0]?.profile).toEqual({ items: { muenze: 1, trank: 1 }, stats: {}, flags: {} });
    expect(await session.move("p1", { type: "trinken" })).toEqual({ ok: true });
    expect(session.view().seats[0]?.profile).toEqual({ items: { muenze: 1 }, stats: { zuege: 1 }, flags: { held: true } });
    await session.newMatch(1, "dev-profile-2");
    expect(session.view().seats[0]?.profile).toEqual({ items: {}, stats: {}, flags: {} });
    session.close();
  }, 60_000);
});

describe("dev: profiles per seat in .gamehearth/dev-profiles.json", () => {
  let engine: DevEngine;
  const dirs: string[] = [];

  beforeAll(async () => {
    engine = await DevEngine.start({ limitMs: 1500 });
    const bundle = await bundleGameForDev(dir);
    expect(await engine.load(bundle.code, JSON.stringify(catalogOf(manifest)))).toEqual({ ok: true });
  }, 60_000);

  afterAll(async () => {
    await engine.close();
    for (const entry of dirs) {
      rmSync(entry, { recursive: true, force: true });
    }
  });

  function store(): DevProfiles {
    const target = mkdtempSync(join(tmpdir(), "gamehearth-dev-profiles-"));
    dirs.push(target);
    return new DevProfiles(target);
  }

  function session(profiles: DevProfiles): DevSession {
    return new DevSession({ engine, timers: false, catalog: () => catalogOf(manifest), profiles, now: () => 1000 });
  }

  it("starts with the saved profile, saves every change and keeps it across new matches", async () => {
    const profiles = store();
    const first = session(profiles);
    await first.newMatch(1, "dev-a");
    await first.move("p1", { type: "arbeiten" });
    expect(JSON.parse(readFileSync(profiles.path, "utf8"))).toEqual({ seats: { p1: { items: { muenze: 2 }, stats: {}, flags: {} } }, guests: [] });
    await first.newMatch(1, "dev-b");
    expect(first.view().seats[0]?.profile.items).toEqual({ muenze: 2 });
    first.close();
    const again = session(profiles);
    await again.newMatch(1, "dev-c");
    expect(again.view().seats[0]?.profile.items).toEqual({ muenze: 2 });
    again.close();
  }, 60_000);

  it("applies an edited profile, recomputes the moves and replays the edit on reload", async () => {
    const profiles = store();
    const play = session(profiles);
    await play.newMatch(1, "dev-edit");
    expect(await play.editProfile("p1", { items: { trank: 2 }, stats: {}, flags: {} })).toEqual({ ok: true });
    const moves = (play.view().seats[0]?.snapshot as { moves: { type: string }[] }).moves.map((move) => move.type);
    expect(moves).toEqual(["arbeiten", "trinken"]);
    expect(await play.move("p1", { type: "trinken" })).toEqual({ ok: true });
    expect(play.view().seats[0]?.profile).toEqual({ items: { trank: 1 }, stats: { zuege: 1 }, flags: { held: true } });
    await play.reload();
    expect(play.view().note).toBe("Rules reloaded, 1 move replayed.");
    expect(play.view().seats[0]?.profile).toEqual({ items: { trank: 1 }, stats: { zuege: 1 }, flags: { held: true } });
    expect(profiles.profile("p1")).toEqual({ items: { trank: 1 }, stats: { zuege: 1 }, flags: { held: true } });
    expect(await play.editProfile("p1", { items: { trank: 0 } })).toMatchObject({ ok: false, code: "invalid-profile" });
    play.close();
  }, 60_000);

  it("lets a seat play as a guest with an empty profile that is not saved", async () => {
    const profiles = store();
    const play = session(profiles);
    await play.newMatch(1, "dev-guest");
    await play.move("p1", { type: "arbeiten" });
    expect(await play.setGuest("p1", true)).toEqual({ ok: true });
    expect(play.view().seats[0]).toMatchObject({ guest: true, profile: { items: {}, stats: {}, flags: {} } });
    await play.move("p1", { type: "arbeiten" });
    expect(profiles.profile("p1").items).toEqual({ muenze: 2 });
    expect(profiles.guests()).toEqual(["p1"]);
    expect(await play.setGuest("p1", false)).toEqual({ ok: true });
    expect(play.view().seats[0]).toMatchObject({ guest: false, profile: { items: { muenze: 2 } } });
    play.close();
  }, 60_000);

  it("writes nothing into a broken file and reports it", async () => {
    const profiles = store();
    mkdirSync(join(profiles.path, ".."), { recursive: true });
    writeFileSync(profiles.path, "{ broken");
    const play = session(profiles);
    await play.newMatch(1, "dev-broken");
    await play.move("p1", { type: "arbeiten" });
    expect(readFileSync(profiles.path, "utf8")).toBe("{ broken");
    expect(profiles.problem).toMatch(/dev-profiles\.json is not valid JSON/);
    play.close();
  }, 60_000);
});

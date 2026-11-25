import { applyMove, createMatch, refreshMatch, type ProfileData } from "@gamehearth/sdk/platform";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DevProfiles } from "../src/dev/profiles-file";
import { DevSession } from "../src/dev/session";
import { catalogOf, type Manifest } from "../src/manifest";
import shop from "./fixtures/profile-shop/src/index";

const manifest = JSON.parse(readFileSync(join(__dirname, "fixtures", "profile-shop", "manifest.json"), "utf8")) as Manifest;
const catalog = catalogOf(manifest);
const dirs: string[] = [];

afterAll(() => {
  for (const entry of dirs) {
    rmSync(entry, { recursive: true, force: true });
  }
});

interface Rules {
  failCreate: boolean;
  failMove?: number;
}

function engine(rules: Rules) {
  let applied = 0;
  const calls: string[] = [];
  return {
    calls,
    async call(fn: string, input: string) {
      calls.push(fn);
      const data = JSON.parse(input) as { playerCount: number; seed: string; match: never; move: never; profiles: Record<string, ProfileData> };
      let outcome: unknown;
      if (fn === "createMatch") {
        applied = 0;
        outcome = rules.failCreate
          ? { ok: false, error: { code: "game-error", message: "setup broken", phase: "setup" } }
          : createMatch(shop, { playerCount: data.playerCount, seed: data.seed, catalog, profiles: data.profiles });
      } else if (fn === "applyMove") {
        applied += 1;
        outcome =
          rules.failMove === applied
            ? { ok: false, error: { code: "illegal-move", message: "the new rules forbid that" } }
            : applyMove(shop, data.match, data.move, { catalog, profiles: data.profiles });
      } else if (fn === "refreshMatch") {
        outcome = refreshMatch(shop, data.match, { catalog, profiles: data.profiles });
      } else {
        throw new Error(fn);
      }
      return { ok: true as const, outcome: JSON.parse(JSON.stringify(outcome)) as never, json: "" };
    },
  };
}

function store(content?: string): DevProfiles {
  const dir = mkdtempSync(join(tmpdir(), "gamehearth-dev-review-"));
  dirs.push(dir);
  const profiles = new DevProfiles(dir);
  if (content !== undefined) {
    mkdirSync(join(dir, ".gamehearth"), { recursive: true });
    writeFileSync(profiles.path, content);
  }
  return profiles;
}

function session(profiles: DevProfiles, rules: Rules = { failCreate: false }): DevSession {
  return new DevSession({ engine: engine(rules) as never, timers: false, catalog: () => catalog, profiles, now: () => 1000 });
}

const fileOf = (profiles: DevProfiles) => JSON.parse(readFileSync(profiles.path, "utf8")) as { seats: Record<string, ProfileData>; guests: string[] };
const valid = JSON.stringify({ seats: { p1: { items: {}, stats: { siege: 50 }, flags: {} }, p2: { items: {}, stats: { siege: 7 }, flags: {} } }, guests: [] });

describe("Review 10c: dev profiles", () => {
  it("does not save a match that started with a broken file, not even after repairing it", async () => {
    const profiles = store("{ broken,");
    const play = session(profiles);
    await play.newMatch(2, "broken");
    writeFileSync(profiles.path, valid);
    await play.move("p1", { type: "arbeiten" });
    expect(readFileSync(profiles.path, "utf8")).toBe(valid);
    expect(play.profilesProblem).toMatch(/new match/);
    await play.newMatch(2, "repaired");
    expect(play.profilesProblem).toBeUndefined();
    expect(play.view().seats[0]?.profile.stats).toEqual({ siege: 50 });
    await play.move("p1", { type: "arbeiten" });
    expect(fileOf(profiles).seats["p2"]?.stats).toEqual({ siege: 7 });
    expect(fileOf(profiles).seats["p1"]).toEqual({ items: { muenze: 2 }, stats: { siege: 50 }, flags: {} });
  });

  it("keeps an edit without a running match and the coins of the failed match", async () => {
    const profiles = store();
    const rules = { failCreate: false };
    const play = session(profiles, rules);
    await play.newMatch(1, "a");
    await play.move("p1", { type: "arbeiten" });
    rules.failCreate = true;
    await play.reload();
    expect(play.match).toBeUndefined();
    expect(play.view().seats[0]?.profile.items).toEqual({ muenze: 2 });
    rules.failCreate = false;
    await play.reload();
    expect(fileOf(profiles).seats["p1"]?.items).toEqual({ muenze: 2 });
    rules.failCreate = true;
    await play.reload();
    expect(await play.editProfile("p1", { items: { trank: 5 } })).toEqual({ ok: true });
    rules.failCreate = false;
    await play.reload();
    expect(play.view().seats[0]?.profile.items).toEqual({ trank: 5 });
    expect(fileOf(profiles).seats["p1"]?.items).toEqual({ trank: 5 });
  });

  it("shows the saved profile when setting up the match already fails", async () => {
    const profiles = store(JSON.stringify({ seats: { p1: { items: { muenze: 7 }, stats: { siege: 3 }, flags: {} } }, guests: [] }));
    const play = session(profiles, { failCreate: true });
    await play.newMatch(1, "a2");
    expect(play.view().seats[0]?.profile).toEqual({ items: { muenze: 7 }, stats: { siege: 3 }, flags: {} });
  });

  it("keeps edits after the spot where the replay stops", async () => {
    const profiles = store();
    const rules: Rules = { failCreate: false };
    const play = session(profiles, rules);
    await play.newMatch(1, "b");
    await play.move("p1", { type: "arbeiten" });
    await play.move("p1", { type: "arbeiten" });
    const edited = { items: { muenze: 4, trank: 9 }, stats: { siege: 10 }, flags: {} };
    expect(await play.editProfile("p1", edited)).toEqual({ ok: true });
    rules.failMove = 2;
    await play.reload();
    expect(play.view().note).toMatch(/1 of 2 moves replayed.*edit/);
    expect(play.view().seats[0]?.profile).toEqual(edited);
    expect(fileOf(profiles).seats["p1"]).toEqual(edited);
  });

  it("does not overwrite a file with an invalid seat, even if the seat does not play", async () => {
    const content = JSON.stringify({ seats: { p1: { items: {}, stats: {}, flags: {} }, p3: { items: { trank: 0 }, stats: { siege: 40 } } }, guests: [] });
    const profiles = store(content);
    const play = session(profiles);
    await play.newMatch(1, "c");
    await play.move("p1", { type: "arbeiten" });
    expect(readFileSync(profiles.path, "utf8")).toBe(content);
    expect(play.profilesProblem).toMatch(/seats\.p3/);
  });

  it.each([
    ["a typo in the key", JSON.stringify({ seat: { p1: { items: { muenze: 3 } } } }), /seat/],
    ["seats as a list", JSON.stringify({ seats: [], guests: [] }), /seats/],
    ["guests as a text", JSON.stringify({ seats: {}, guests: "p1" }), /guests/],
    ["a list instead of an object", "[]", /object/],
  ])("reports %s and overwrites nothing", async (_name, content, message) => {
    const profiles = store(content);
    const play = session(profiles);
    await play.newMatch(1, "d");
    await play.move("p1", { type: "arbeiten" });
    expect(readFileSync(profiles.path, "utf8")).toBe(content);
    expect(profiles.problem).toMatch(message);
  });

  it("uses the player count just chosen for the guest switch", async () => {
    const play = session(store());
    await play.newMatch(1, "e");
    const larger = play.newMatch(3, "e3");
    const guest = play.setGuest("p1", true);
    await Promise.all([larger, guest]);
    expect(play.view().seats).toHaveLength(3);
    expect(play.view().seats[0]?.guest).toBe(true);
  });

  it("raises the version on an edit only when the moves change", async () => {
    const play = session(store());
    await play.newMatch(1, "v");
    const before = play.match?.version;
    expect(await play.editProfile("p1", { items: { muenze: 1 } })).toEqual({ ok: true });
    expect(play.match?.version).toBe(before);
    expect(await play.editProfile("p1", { items: { trank: 1 } })).toEqual({ ok: true });
    expect(play.match?.version).toBe((before ?? 0) + 1);
  });

  it("rejects an edit with IDs that are not in the manifest", async () => {
    const play = session(store());
    await play.newMatch(1, "u");
    const answer = await play.editProfile("p1", { items: { trnak: 3 }, flags: { hold: true } });
    expect(answer).toMatchObject({ ok: false, code: "unknown-id" });
    expect(answer.ok ? "" : answer.message).toMatch(/items\.trnak.*flags\.hold/);
    expect(answer.ok ? "" : answer.message).toMatch(/trank/);
  });

  it("reports when the file cannot be written", async () => {
    const profiles = store();
    mkdirSync(`${profiles.path}.tmp`, { recursive: true });
    const play = session(profiles);
    await play.newMatch(1, "w");
    await play.move("p1", { type: "arbeiten" });
    expect(play.profilesProblem).toMatch(/cannot be written/);
  });
});

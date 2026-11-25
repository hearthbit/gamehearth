import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkGame } from "../src/check";
import { checkIdsLock, formatIdsLock, idsLockMode, parseIdsLock } from "../src/ids-lock";
import type { Manifest } from "../src/manifest";
import { ProfileSim } from "../src/profile-sim";

const fixture = fileURLToPath(new URL("./fixtures/profile-shop", import.meta.url));
const work: string[] = [];

function copy(change?: (source: string) => string, manifest?: (raw: Record<string, unknown>) => void): string {
  const dir = mkdtempSync(join(fileURLToPath(new URL("..", import.meta.url)), "check-profiles-"));
  work.push(dir);
  cpSync(fixture, dir, { recursive: true });
  if (change !== undefined) {
    const file = join(dir, "src", "index.ts");
    const before = readFileSync(file, "utf8");
    const after = change(before);
    expect(after).not.toBe(before);
    writeFileSync(file, after);
  }
  if (manifest !== undefined) {
    const file = join(dir, "manifest.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    manifest(raw);
    writeFileSync(file, JSON.stringify(raw, null, 2));
  }
  return dir;
}

afterEach(() => {
  for (const dir of work.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("check with profiles", () => {
  it("plays with empty and filled profiles, takes items away and replays in QuickJS with the same profiles", async () => {
    const dir = copy();
    const report = await checkGame(dir, { games: 30, quickjsGames: 3, idsLock: "write" });
    expect(report.findings.filter((finding) => finding.severity === "error")).toEqual([]);
    expect(report.notes).toContainEqual(expect.stringContaining("Profiles: every seat starts with an empty profile"));
    expect(report.notes).toContainEqual(expect.stringContaining("check now and then takes items away"));
    expect(report.notes).toContainEqual(expect.stringContaining("ids.lock created"));
    expect(report.summaries.map((summary) => [summary.playerCount, summary.games, summary.finished])).toEqual([
      [1, 30, 30],
      [2, 30, 30],
      [3, 30, 30],
    ]);
    expect(report.notes).toContainEqual("9 matches also replayed in QuickJS, the JS engine of the server.");
  }, 120_000);

  it("reports legalMoves that offers a move without the needed item", async () => {
    const dir = copy((source) => source.replace("if ((profiles[player]?.items.trank ?? 0) > 0) {", "if (true) {"));
    const report = await checkGame(dir, { games: 10, players: 1, quickjsGames: 0, idsLock: "write" });
    const finding = report.findings.find((entry) => entry.kind === "profile");
    expect(finding).toMatchObject({ severity: "error", player: "p1" });
    expect(finding?.message).toMatch(/legalMoves offers a move for which an item is missing in the profile/);
    expect(finding?.detail).toMatch(/"trinken".*Missing "trank"/);
  }, 60_000);

  it("reports unknown IDs as an error in the game code with a suggestion", async () => {
    const dir = copy((source) => source.replace('profile.add(player, "muenze", 2);', 'profile.add(player, "munze" as "muenze", 2);'));
    const report = await checkGame(dir, { games: 4, players: 1, quickjsGames: 0, idsLock: "write" });
    const finding = report.findings.find((entry) => entry.kind === "game-error");
    expect(finding?.message).toMatch(/The item "munze" is not listed under items in manifest.json; did you mean "muenze"\?/);
    expect(finding?.phase).toBe("apply");
    expect(finding?.stack).toMatch(/index\.ts/);
  }, 60_000);

  it("detects when a game returns different profile changes on the repeat", async () => {
    const dir = copy((source) =>
      source
        .replace("const maxTurns = 12;", "const maxTurns = 12;\nlet calls = 0;")
        .replace('profile.add(player, "muenze", 2);', 'calls += 1;\n      profile.add(player, "muenze", calls % 2 === 0 ? 2 : 3);'),
    );
    const report = await checkGame(dir, { games: 2, players: 1, quickjsGames: 0, idsLock: "write" });
    expect(report.findings.some((finding) => finding.kind === "nondeterministic")).toBe(true);
  }, 60_000);
});

describe("ids.lock", () => {
  const manifest = (ids: { items?: string[]; stats?: string[]; flags?: string[] }) =>
    ({
      items: Object.fromEntries((ids.items ?? []).map((id) => [id, { label: id }])),
      stats: Object.fromEntries((ids.stats ?? []).map((id) => [id, { label: id }])),
      flags: Object.fromEntries((ids.flags ?? []).map((id) => [id, { label: id }])),
    }) as unknown as Manifest;

  function dir(): string {
    const created = mkdtempSync(join(fileURLToPath(new URL("..", import.meta.url)), "ids-lock-"));
    work.push(created);
    return created;
  }

  it("creates the file and adds new IDs sorted", async () => {
    const target = dir();
    const first = await checkIdsLock(target, manifest({ items: ["trank", "muenze"], stats: ["siege"] }), "write");
    expect(first.written).toBe(true);
    expect(first.notes).toEqual(["ids.lock created with items: muenze, trank; stats: siege. The file belongs in the repo; it records which IDs ever existed."]);
    const second = await checkIdsLock(target, manifest({ items: ["trank", "muenze", "apfel"], stats: ["siege"], flags: ["held"] }), "write");
    expect(second.notes).toEqual(["ids.lock: newly added items: apfel; flags: held. The change belongs in the repo."]);
    expect(parseIdsLock(readFileSync(join(target, "ids.lock"), "utf8"))).toEqual({ format: 1, items: ["apfel", "muenze", "trank"], stats: ["siege"], flags: ["held"] });
    const third = await checkIdsLock(target, manifest({ items: ["trank", "muenze", "apfel"], stats: ["siege"], flags: ["held"] }), "write");
    expect(third).toEqual({ findings: [], notes: [], written: false });
  });

  it("reports IDs that disappeared from the manifest and keeps them in the file", async () => {
    const target = dir();
    writeFileSync(join(target, "ids.lock"), formatIdsLock({ format: 1, items: ["muenze", "trank"], stats: [], flags: [] }));
    const report = await checkIdsLock(target, manifest({ items: ["muenze", "apfel"] }), "write");
    expect(report.findings).toEqual([expect.objectContaining({ severity: "error", kind: "ids", message: expect.stringContaining('The item "trank" is listed in ids.lock, but is missing under items') })]);
    expect(parseIdsLock(readFileSync(join(target, "ids.lock"), "utf8"))).toMatchObject({ items: ["apfel", "muenze", "trank"] });
  });

  it("writes nothing in CI and fails when the file is missing or out of date", async () => {
    const target = dir();
    const missing = await checkIdsLock(target, manifest({ stats: ["siege"] }), "verify");
    expect(missing.findings[0]?.message).toMatch(/ids\.lock is missing, although manifest\.json has IDs \(stats: siege\)/);
    expect(existsSync(join(target, "ids.lock"))).toBe(false);
    writeFileSync(join(target, "ids.lock"), formatIdsLock({ format: 1, items: [], stats: ["siege"], flags: [] }));
    expect((await checkIdsLock(target, manifest({ stats: ["siege"] }), "verify")).findings).toEqual([]);
    const stale = await checkIdsLock(target, manifest({ stats: ["siege", "zuege"] }), "verify");
    expect(stale.findings[0]?.message).toMatch(/ids\.lock is out of date, it lacks stats: zuege/);
  });

  it("needs no file for games without IDs and reports a broken file", async () => {
    const target = dir();
    expect(await checkIdsLock(target, manifest({}), "verify")).toEqual({ findings: [], notes: [], written: false });
    writeFileSync(join(target, "ids.lock"), "{ broken");
    expect((await checkIdsLock(target, manifest({ items: ["trank"] }), "write")).findings[0]?.message).toMatch(/ids\.lock is not valid JSON/);
  });

  it("writes the note in English and still reads an ids.lock with the old German note, comparing only the IDs", async () => {
    const target = dir();
    expect(Object.keys(JSON.parse(formatIdsLock({ format: 1, items: [], stats: ["siege"], flags: [] })) as object)).toEqual(["format", "note", "items", "stats", "flags"]);
    writeFileSync(join(target, "ids.lock"), `${JSON.stringify({ format: 1, hinweis: "Von gamehearth check gepflegt.", items: ["trank"], stats: [], flags: [] }, null, 2)}\n`);
    expect(await checkIdsLock(target, manifest({ items: ["trank"] }), "verify")).toEqual({ findings: [], notes: [], written: false });
    expect(await checkIdsLock(target, manifest({ items: ["trank"] }), "write")).toEqual({ findings: [], notes: [], written: false });
  });

  it("detects CI from the environment variable CI", () => {
    expect(idsLockMode({})).toBe("write");
    expect(idsLockMode({ CI: "true" })).toBe("verify");
    expect(idsLockMode({ CI: "1" })).toBe("verify");
    expect(idsLockMode({ CI: "false" })).toBe("write");
  });
});

describe("profiles in check", () => {
  it("fills profiles only from the catalog and takes away only items that exist", () => {
    const catalog = { items: { trank: { label: "Trank" } }, stats: { siege: { label: "Siege", better: "higher" as const } }, flags: { held: { label: "Held" } } };
    const sims = Array.from({ length: 20 }, (_, index) => ProfileSim.fresh(catalog, ["p1", "p2"], `check-2-${index}`));
    const starts = sims.flatMap((sim) => Object.values(sim.trace.start));
    expect(starts.length).toBeGreaterThan(5);
    for (const profile of starts) {
      expect(Object.keys(profile.items).every((id) => id === "trank")).toBe(true);
      expect(Object.keys(profile.stats).every((id) => id === "siege")).toBe(true);
      expect(Object.keys(profile.flags).every((id) => id === "held")).toBe(true);
    }
    expect(ProfileSim.fresh(undefined, ["p1"], "x").trace.start).toEqual({});
  });
});

describe("Review 10b: check", () => {
  const realtime = fileURLToPath(new URL("./fixtures/profile-tick", import.meta.url));

  function copyOf(source: string, change?: (text: string) => string): string {
    const dir = mkdtempSync(join(fileURLToPath(new URL("..", import.meta.url)), "check-review10b-"));
    work.push(dir);
    cpSync(source, dir, { recursive: true });
    if (change !== undefined) {
      const file = join(dir, "src", "index.ts");
      const before = readFileSync(file, "utf8");
      const after = change(before);
      expect(after).not.toBe(before);
      writeFileSync(file, after);
    }
    return dir;
  }

  it("reports also in realtime an input that legalMoves offers and use always rejects", async () => {
    const dir = copyOf(realtime, (text) => text.replace('return (profiles[player]?.items.stern ?? 0) > 0 ? [{ type: "sammle" }, { type: "tausche" }] : [{ type: "sammle" }];', 'return [{ type: "sammle" }, { type: "tausche" }];'));
    const report = await checkGame(dir, { games: 4, players: 1, quickjsGames: 0, idsLock: "write" });
    const finding = report.findings.find((entry) => entry.kind === "profile");
    expect(finding).toMatchObject({ severity: "error", unit: "tick", player: "p1" });
    expect(finding?.detail).toMatch(/"tausche"/);
    expect(report.notes.find((note) => note.startsWith("Profiles:"))).not.toContain("recomputed");
  }, 120_000);

  it("reports nothing in realtime when legalMoves respects the profile", async () => {
    const report = await checkGame(copyOf(realtime), { games: 4, players: 1, quickjsGames: 1, idsLock: "write" });
    expect(report.findings.filter((entry) => entry.severity === "error")).toEqual([]);
  }, 120_000);
});

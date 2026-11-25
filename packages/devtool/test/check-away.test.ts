import { SeededRandom, randomStateFromSeed } from "@gamehearth/sdk/platform";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkGame, type CheckOptions } from "../src/check";
import type { Finding } from "../src/findings";
import { formatReport } from "../src/format";
import { awayAt, nextAway, realtimeStep } from "../src/runner";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function check(name: string, options: CheckOptions = {}) {
  return checkGame(fixture(name), { games: 4, quickjsGames: 0, ...options });
}

function only(findings: readonly Finding[], kind: Finding["kind"]): Finding[] {
  return findings.filter((finding) => finding.kind === kind);
}

describe("away seats in check", () => {
  it("lets seats go away and come back, but never all of them at once", () => {
    const random = new SeededRandom(randomStateFromSeed("away:test"));
    const players = ["p1", "p2", "p3"];
    let away: string[] = [];
    const seen = new Set<string>();
    for (let tick = 0; tick < 20_000; tick++) {
      away = nextAway(random, players, away);
      expect(away.length).toBeLessThan(players.length);
      seen.add(away.join(","));
    }
    expect(seen).toContain("");
    expect([...seen].some((entry) => entry.includes(","))).toBe(true);
    expect(awayAt([{ tick: 5, seats: ["p2"] }, { tick: 9, seats: [] }], 4)).toEqual([]);
    expect(awayAt([{ tick: 5, seats: ["p2"] }, { tick: 9, seats: [] }], 8)).toEqual(["p2"]);
    expect(realtimeStep([], 6, [{ tick: 5, seats: ["p2"] }], ["p1"])).toMatchObject({ inputs: [], away: ["p2"], bots: ["p1"] });
    expect(realtimeStep([], 4, [{ tick: 5, seats: ["p2"] }], undefined)).not.toHaveProperty("away");
  });

  it("finds a game that crashes while a seat is away and says so", async () => {
    const report = await check("rt-away-crash", { players: 2 });
    const [crash] = only(report.findings, "game-error");
    expect(crash).toMatchObject({ severity: "error", phase: "tick", unit: "tick" });
    expect(crash?.detail).toMatch(/^This happened while p[12] was away \(ctx\.away: \["p[12]"\]\)/);
    expect(formatReport(report)).toMatch(/"away": "play-on"/);
    expect(report.notes.join("\n")).toMatch(/Away: the game plays on without seats that are away/);
  }, 60_000);

  it("lets nobody go away in a game that pauses instead", async () => {
    const report = await check("rt-away-pause", { players: 2 });
    expect(report.findings).toEqual([]);
    expect(report.notes.join("\n")).not.toMatch(/Away:/);
  }, 60_000);

  it("repeats and replays matches in QuickJS with the same seats away", async () => {
    const report = await check("rt-away-good", { quickjsGames: 2 });
    expect(report.findings).toEqual([]);
    const replay = await check("rt-away-good", { players: 2, seed: "check-2-0", quickjsGames: 1 });
    expect(replay.findings).toEqual([]);
    expect(replay.replay?.away?.length ?? 0).toBeGreaterThan(0);
    const text = formatReport(replay);
    expect(text).toMatch(/Tick \d+: away: p[12]/);
    expect(text).toMatch(/Tick \d+: nobody is away/);
    const firstAway = replay.replay?.away?.[0];
    const awayInputs = replay.replay?.moves.filter((move) => {
      const tick = Math.round((move.now - 1_767_225_600_000) / 50) + 1;
      return awayAt(replay.replay?.away, tick).includes(move.player);
    });
    expect(firstAway?.seats.length).toBe(1);
    expect(awayInputs).toEqual([]);
  }, 60_000);

  it("asks the game's bot while seats are away, so a bot that cannot cope with away seats is found", async () => {
    const report = await check("rt-away-bot", { games: 2, botGames: 2 });
    const bots = only(report.findings, "bot");
    expect(bots.length).toBeGreaterThan(0);
    expect(JSON.stringify(bots[0])).toContain("bot cannot cope with away seats");
  }, 120_000);
});

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkGame, type CheckOptions } from "../src/check";
import type { Finding } from "../src/findings";
import { formatReport } from "../src/format";
import { mauMauSource, withStubClient } from "./mau-mau";

const mauMauWithStubClient = withStubClient(mauMauSource);

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

async function check(name: string, options: CheckOptions = {}) {
  return checkGame(fixture(name), { games: 20, ...options });
}

function only(findings: readonly Finding[], kind: Finding["kind"]): Finding[] {
  return findings.filter((finding) => finding.kind === kind);
}

describe("check with Mau-Mau", () => {
  it("finds no errors and no warnings in Mau-Mau", async () => {
    const report = await checkGame(mauMauWithStubClient, { games: 50 });
    expect(report.findings).toEqual([]);
    expect(report.summaries.map((summary) => summary.playerCount)).toEqual([2, 3, 4, 5, 6]);
    for (const summary of report.summaries) {
      expect(summary.finished).toBe(50);
    }
  }, 60_000);
});

describe("check finds errors", () => {
  it("lets an error-free game pass and plays every allowed player count", async () => {
    const report = await check("counting");
    expect(report.findings).toEqual([]);
    expect(report.summaries.map((summary) => [summary.playerCount, summary.games, summary.finished])).toEqual([
      [2, 20, 20],
      [3, 20, 20],
      [4, 20, 20],
    ]);
  });

  it("reports a missing manifest", async () => {
    const report = await check("no-manifest");
    expect(report.findings).toEqual([expect.objectContaining({ severity: "error", kind: "manifest", message: expect.stringContaining("manifest.json is missing") })]);
  });

  it("reports an error that only occurs with a certain player count, with location and seed", async () => {
    const report = await check("crash-three");
    const errors = only(report.findings, "game-error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      severity: "error",
      playerCount: 3,
      phase: "legalMoves",
      message: expect.stringContaining("With three players the rule for the fourth move is missing"),
      count: 20,
    });
    expect(errors[0]?.stack).toContain("crash-three");
    expect(report.summaries.find((summary) => summary.playerCount === 3)?.failed).toBe(20);
    expect(report.summaries.find((summary) => summary.playerCount === 2)?.failed).toBe(0);
  });

  it("reports Math.random in apply with a pointer to ctx.random and the line in the game", async () => {
    const report = await check("random-apply");
    const errors = only(report.findings, "game-error");
    expect(errors).toEqual([
      expect.objectContaining({
        severity: "error",
        phase: "apply",
        step: 1,
        message: expect.stringContaining("Math.random() is not allowed in games"),
      }),
    ]);
    expect(errors[0]?.message).toContain("ctx.random");
    expect(errors[0]?.stack).toMatch(/random-apply[\\/]src[\\/]index\.ts:\d+/);
    expect(errors[0]?.stack).not.toMatch(/[\\/]sdk[\\/]src[\\/]|[\\/]devtool[\\/]src[\\/]/);
  });

  it("reports Date.now in apply", async () => {
    const report = await check("date-now");
    expect(only(report.findings, "game-error")).toEqual([
      expect.objectContaining({ phase: "apply", message: expect.stringContaining("Date.now() is not allowed in games") }),
    ]);
  });

  it("reports Math.random already while loading the game", async () => {
    const report = await check("random-import");
    expect(report.findings).toEqual([
      expect.objectContaining({ kind: "load", message: expect.stringContaining("Math.random() is not allowed in games") }),
    ]);
  });

  it("reports an endless loop with phase, seat, move and seed instead of hanging itself", async () => {
    const started = Date.now();
    const report = await check("infinite-loop", { timeoutMs: 300, games: 10 });
    expect(Date.now() - started).toBeLessThan(15_000);
    const hangs = only(report.findings, "hang");
    expect(hangs).toHaveLength(1);
    expect(hangs[0]).toMatchObject({
      severity: "error",
      phase: "apply",
      message: expect.stringContaining("apply has not responded for 300 ms"),
      count: 6,
    });
    expect(hangs[0]?.step).toBeGreaterThan(1);
    expect(hangs[0]?.player).toMatch(/^p\d$/);
    expect(hangs[0]?.seed).toMatch(/^check-\d-\d+$/);
    expect(report.notes).toEqual(expect.arrayContaining([expect.stringContaining("the remaining matches were skipped")]));
  }, 30_000);

  it("finds the hanging spot also when replaying", async () => {
    const report = await check("infinite-loop", { timeoutMs: 300, players: 2, seed: "check-2-0" });
    expect(only(report.findings, "hang")).toEqual([expect.objectContaining({ phase: "apply", seed: "check-2-0" })]);
  }, 30_000);

  it("reports state outside the functions as nondeterministic", async () => {
    const report = await check("module-counter");
    expect(only(report.findings, "nondeterministic")).toHaveLength(1);
  });

  it("reports matches that mostly do not end as an error and stops after three of them", async () => {
    const report = await check("endless", { maxMoves: 50, games: 20 });
    expect(report.findings).toEqual([
      expect.objectContaining({ severity: "error", kind: "never-ends", step: 50, count: 9 }),
    ]);
    expect(report.summaries.map((summary) => summary.games)).toEqual([3, 3, 3]);
    expect(report.notes).toEqual(expect.arrayContaining([expect.stringContaining("the remaining 17 were skipped after 3 matches without an end")]));
  });

  it("reports a default export that is not a game", async () => {
    const report = await check("bad-export");
    expect(report.findings).toEqual([expect.objectContaining({ kind: "load", message: expect.stringContaining("export default defineGame") })]);
  });

  it("reports a game that imports files outside its folder", async () => {
    const report = await check("file-leak");
    expect(report.findings).toEqual([
      expect.objectContaining({ kind: "load", message: expect.stringContaining("is outside the game folder") }),
    ]);
  });

  it("reports Date.now also via the property descriptor", async () => {
    const report = await check("date-descriptor");
    expect(only(report.findings, "game-error")).toEqual([
      expect.objectContaining({ phase: "apply", message: expect.stringContaining("Date.now() is not allowed in games") }),
    ]);
  });

  it("reports date methods that depend on the time zone", async () => {
    const report = await check("date-local");
    expect(only(report.findings, "game-error")).toEqual([
      expect.objectContaining({ phase: "apply", message: expect.stringContaining("getHours() is not allowed in games") }),
    ]);
  });

  it("reports Date.now also via new Date(0).constructor", async () => {
    const report = await check("date-constructor");
    expect(only(report.findings, "game-error")).toEqual([
      expect.objectContaining({ phase: "apply", message: expect.stringContaining("Date.now() is not allowed in games") }),
    ]);
  });

  it("reports a game that uses Node modules like fs", async () => {
    const report = await check("node-import");
    expect(report.findings).toEqual([
      expect.objectContaining({ kind: "load", message: expect.stringContaining("cannot be built") }),
    ]);
  });
});

describe("replaying on the engine of the server", () => {
  it("reports a game that fails on the server because of missing functions", async () => {
    const report = await check("structured-clone");
    expect(report.findings).toEqual([
      expect.objectContaining({ severity: "error", kind: "engine", message: expect.stringMatching(/the match fails.*structuredClone/), step: 1 }),
    ]);
  });

  it("warns when the same match runs differently on the server", async () => {
    const report = await check("float-engine");
    expect(report.findings).toEqual([expect.objectContaining({ severity: "warning", kind: "engine", message: expect.stringContaining("Math.hypot") })]);
  });

  it("allows the same recursion depth in QuickJS as the server", async () => {
    const report = await check("deep-recursion");
    expect(report.findings).toEqual([]);
  });

  it("can be switched off", async () => {
    const report = await check("structured-clone", { quickjsGames: 0 });
    expect(report.findings).toEqual([]);
  });
});

describe("replaying", () => {
  it("plays exactly one match with --seed and returns the same moves as the check run", async () => {
    const first = await check("counting", { players: 3, seed: "check-3-4" });
    const second = await check("counting", { players: 3, seed: "check-3-4" });
    expect(first.replay?.moves.length).toBeGreaterThan(0);
    expect(first.replay?.moves).toEqual(second.replay?.moves);
    expect(first.summaries).toEqual([]);
  });

  it("shows the moves and the replay command in the text", async () => {
    const replay = formatReport(await check("counting", { players: 2, seed: "check-2-0" }));
    expect(replay).toContain("Move 1: p1");
    const failing = formatReport(await check("crash-three"));
    expect(failing).toContain("ERROR");
    expect(failing).toMatch(/--players 3 --seed check-3-\d+/);
    expect(failing).toContain("Result: 1 error, no warnings");
  });
});

describe("leaks", () => {
  it("reports no false alarm for a clean card game", async () => {
    const report = await check("cards");
    expect(report.findings).toEqual([]);
  });

  it("reports as an error when a move contains a hidden card", async () => {
    const report = await check("leak-move");
    const leaks = only(report.findings, "leak");
    expect(leaks).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("The legal moves of a player depend on data the player may not see"),
        detail: expect.stringMatching(/legalMoves\(p\d\) contains \{"card":"karte-\d\d","type":"draw"\}; when hidden values are swapped, this move disappears/),
      }),
    ]);
    expect(leaks[0]?.count).toBeGreaterThan(20);
  });

  it("warns when a value is copied from secret to public", async () => {
    const report = await check("leak-copy");
    expect(report.findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        kind: "leak",
        message: expect.stringContaining("is in public and in secret at the same time"),
        detail: expect.stringMatching(/"karte-\d\d" is in public\.next and in secret\.deck\[\d+\]/),
      }),
    ]);
  });

  it("warns when a player sees a card of another player", async () => {
    const report = await check("leak-own");
    expect(report.findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        kind: "leak",
        message: expect.stringContaining("in the area of a player and at the same time in secret or with another player"),
        detail: expect.stringMatching(/"karte-\d\d" is in players\.p\d\.(peek|hand\[0\]) and in players\.p\d\.(peek|hand\[0\])/),
      }),
    ]);
  });

  it("shows the details of the leak in the text", async () => {
    const text = formatReport(await check("leak-move", { games: 2, players: 2 }));
    expect(text).toMatch(/ERROR +The legal moves of a player depend on data/);
    expect(text).toMatch(/legalMoves\(p\d\) contains \{"card":"karte-/);
  });
});

describe("findings from the second review", () => {
  it.each(["rps", "cluedo", "objcards"])("reports no leak for %s, a correct game with a hidden choice", async (name) => {
    const report = await check(name);
    expect(only(report.findings, "leak")).toEqual([]);
    expect(report.findings.filter((finding) => finding.severity === "error")).toEqual([]);
  }, 60_000);

  it("finds leaks via card names with two characters", async () => {
    const report = await check("twochar-leak");
    expect(only(report.findings, "leak")).toEqual([
      expect.objectContaining({ severity: "error", detail: expect.stringMatching(/legalMoves\(p\d\) contains \{"card":"[7-9TJQKA][SHDC]","type":"draw"\}/) }),
    ]);
  });

  it("finds leaks via sets stored as object keys", async () => {
    const report = await check("keyed-leak");
    expect(only(report.findings, "leak")).toEqual([
      expect.objectContaining({ severity: "error", detail: expect.stringContaining('"type":"steal"') }),
    ]);
  });

  it("finds state that setup remembers outside the match", async () => {
    const report = await check("seats-cache");
    expect(only(report.findings, "nondeterministic")).toEqual([
      expect.objectContaining({ severity: "error", detail: expect.stringMatching(/^match\.|^on the repeat/) }),
    ]);
  });

  it("finds Math.random even if the game catches the error", async () => {
    const report = await check("try-random");
    expect(only(report.findings, "forbidden")).toEqual([
      expect.objectContaining({ severity: "error", message: expect.stringContaining("Math.random() was called in the game, but the error was caught") }),
    ]);
  });

  it("warns when the result of random.shuffle is discarded", async () => {
    const report = await check("unshuffled");
    expect(only(report.findings, "suspicious")).toEqual([
      expect.objectContaining({ severity: "warning", message: expect.stringContaining("random.shuffle(list) does not shuffle the list itself") }),
    ]);
    expect((await check("counting")).findings).toEqual([]);
  });

  it("warns about a legal move that changes nothing", async () => {
    const report = await check("noop-move");
    expect(only(report.findings, "suspicious")).toEqual([
      expect.objectContaining({ severity: "warning", detail: expect.stringMatching(/^p\d \{"type":"double"\}$/) }),
    ]);
  });

  it("checks minimum and maximum also above the limit of 8 players", async () => {
    const wide = await check("ten-players", { games: 3 });
    expect(wide.summaries.map((summary) => summary.playerCount)).toEqual([4, 5, 6, 7, 8, 10]);
    expect(only(wide.findings, "game-error")).toEqual([expect.objectContaining({ playerCount: 10 })]);
    const high = await check("ten-min", { games: 3 });
    expect(high.summaries.map((summary) => summary.playerCount)).toEqual([10]);
    expect(only(high.findings, "game-error")).toHaveLength(1);
  });

  it("reports a missing default export clearly", async () => {
    const report = await check("no-default");
    expect(report.findings).toEqual([
      expect.objectContaining({ kind: "load", message: expect.stringContaining("src/index.ts has no default export") }),
    ]);
  });

  it("reads a manifest with a BOM", async () => {
    const report = await check("bom", { games: 2 });
    expect(only(report.findings, "manifest")).toEqual([]);
    expect(report.manifest?.id).toBe("bom");
  });

  it("reports a missing client folder as an error and plays anyway", async () => {
    const report = await checkGame(withStubClient(mauMauSource, false), { games: 2, players: 2, quickjsGames: 0 });
    expect(only(report.findings, "client")).toEqual([
      expect.objectContaining({ severity: "error", message: expect.stringContaining("The client folder dist/client is missing") }),
    ]);
    expect(report.summaries[0]?.games).toBe(2);
  });

  it("rejects a player count that the manifest does not allow", async () => {
    const report = await checkGame(mauMauWithStubClient, { players: 7, games: 1 });
    expect(report.findings).toEqual([expect.objectContaining({ kind: "players", message: expect.stringContaining("7 players are not allowed") })]);
  });

  it("reports an endless loop while loading without a wrong seat", async () => {
    const report = await check("toplevel-loop", { timeoutMs: 300, games: 3 });
    const hangs = only(report.findings, "hang");
    expect(hangs[0]).toMatchObject({ message: expect.stringContaining("Loading the game has not responded") });
    expect(hangs[0]?.player).toBeUndefined();
  }, 30_000);

  it("shows the moves up to the spot when replaying a hanging match", async () => {
    const report = await check("infinite-loop", { timeoutMs: 300, players: 2, seed: "check-2-0" });
    const hang = only(report.findings, "hang")[0];
    expect(report.replay?.moves.length).toBe(hang?.step);
    expect(formatReport(report)).toContain("Move 1: p1");
  }, 30_000);
});

describe("replay command", () => {
  it("includes changed limits and writes paths with a slash", async () => {
    const report = await check("endless", { maxMoves: 7, games: 1, timeoutMs: 1500 });
    const text = formatReport(report, fileURLToPath(new URL("../../..", import.meta.url)));
    expect(text).toMatch(/check packages\/devtool\/test\/fixtures\/endless --players \d --seed check-\d-0 --max-moves 7 --timeout 1500/);
  });

  it("puts paths with spaces in quotes", async () => {
    const report = await check("crash-three", { players: 3, games: 1 });
    const text = formatReport(report, "C:/");
    expect(text).toMatch(/check "[^"]* [^"]*crash-three" --players 3/);
  });
});

describe("Review 10c: randomness in setup", () => {
  it("does not warn when setup only needs randomness with more players (the decoy match does not count)", async () => {
    const report = await check("setup-random-later");
    expect(report.findings.filter((finding) => finding.message.includes("the same start state"))).toEqual([]);
  });

  it("still warns when setup discards the result of random.shuffle", async () => {
    const report = await check("setup-random-discarded");
    const warnings = report.findings.filter((finding) => finding.message.includes("the same start state"));
    expect(warnings.map((finding) => [finding.playerCount, finding.count])).toEqual([[1, 2]]);
  });
});

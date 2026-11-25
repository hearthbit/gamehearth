import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkGame, type CheckOptions } from "../src/check";
import type { Finding } from "../src/findings";
import { formatReport } from "../src/format";
import { botFinding } from "../src/runner";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function check(name: string, options: CheckOptions = {}) {
  return checkGame(fixture(name), { games: 4, botGames: 3, quickjsGames: 0, ...options });
}

function only(findings: readonly Finding[], kind: Finding["kind"]): Finding[] {
  return findings.filter((finding) => finding.kind === kind);
}

describe("check with the game's bot", () => {
  it("plays extra matches in which the game's bot plays every seat and lists them on their own", async () => {
    const report = await check("bot-good", { quickjsGames: 2 });
    expect(report.findings).toEqual([]);
    const withBot = report.summaries.filter((summary) => summary.bots === true);
    expect(withBot.map((summary) => [summary.playerCount, summary.games, summary.finished])).toEqual([
      [2, 3, 3],
      [3, 3, 3],
      [4, 3, 3],
    ]);
    expect(report.notes.join("\n")).toMatch(/Bots: the game has bot, so for every player count 3 more matches run in which bot plays every seat/);
    expect(report.notes.join("\n")).toMatch(/\b12 matches also replayed in QuickJS/);
    expect(formatReport(report)).toMatch(/Matches in which the game's bot plays every seat:\n {2}2 players: 3 matches, all finished/);
  }, 60_000);

  it("plays no such matches for a game without bot", async () => {
    const report = await check("counting");
    expect(report.summaries.some((summary) => summary.bots === true)).toBe(false);
    expect(report.notes.join("\n")).not.toMatch(/Bots:/);
  }, 60_000);

  it("reports a bot that throws, picks a move that is not legal or changes what it gets, with seat and context", async () => {
    const report = await check("bot-broken", { players: 4 });
    const problems = only(report.findings, "bot");
    expect(problems).toHaveLength(3);
    const byPlayer = (player: string) => problems.find((finding) => finding.player === player);
    expect(byPlayer("p1")).toMatchObject({ severity: "error", phase: "bot", bots: true, playerCount: 4, message: expect.stringMatching(/^bot threw an error/) });
    expect(byPlayer("p1")?.detail).toMatch(/the bot is confused/);
    expect(byPlayer("p1")?.seed).toMatch(/^check-bots-4-\d+$/);
    expect(byPlayer("p2")?.message).toMatch(/^bot returned a move that is not legal/);
    expect(byPlayer("p2")?.detail).toMatch(/\{"type":"add","amount":3\}/);
    const changes = problems.find((finding) => /^bot tried to change the state, its moves or the profiles/.test(finding.message));
    expect(changes?.player === "p3" ? changes.detail : "").toMatch(/read.only/);
    expect(changes?.count).toBe(6);
    const text = formatReport(report);
    expect(text).toMatch(/every seat played by the game's bot/);
    expect(text).toMatch(/Replay: npm run gamehearth -- check .* --players 4 --seed check-bots-4-\d+ --bots/);
  }, 60_000);

  it("reports matches with the game's bot that never end as an error", async () => {
    const report = await check("bot-endless", { players: 2, maxMoves: 200 });
    const endless = only(report.findings, "never-ends");
    expect(endless).toHaveLength(1);
    expect(endless[0]).toMatchObject({ severity: "error", bots: true, step: 200 });
    expect(endless[0]?.message).toMatch(/game's bot plays every seat do not end after 200 moves/);
    expect(report.summaries.find((summary) => summary.bots !== true)?.tooLong).toBe(0);
  }, 60_000);

  it("finds a bot that picks differently when the match is repeated", async () => {
    const report = await check("bot-unstable", { players: 2 });
    const [unstable] = only(report.findings, "nondeterministic");
    expect(unstable).toMatchObject({ severity: "error", phase: "bot", bots: true, step: 1 });
    expect(unstable?.message).toMatch(/bot picks a different move when the same match is repeated/);
    expect(unstable?.detail).toMatch(/^bot for p1: on the first run .* on the repeat /);
  }, 60_000);

  it("replays matches with the game's bot in QuickJS and reports a bot that picks differently there", async () => {
    const report = await check("bot-locale", { players: 2, quickjsGames: 1 });
    const [engine] = only(report.findings, "engine");
    expect(engine).toMatchObject({ severity: "warning", phase: "bot", bots: true, player: expect.stringMatching(/^p[12]$/) });
    expect(engine?.message).toMatch(/On the server \(QuickJS\) the game's bot picks a different move than here in Node/);
    const plain = await check("bot-good", { players: 2, quickjsGames: 1 });
    expect(only(plain.findings, "engine")).toEqual([]);
  }, 60_000);

  it("reports a bot that hangs with the seat", async () => {
    const report = await check("bot-loop", { players: 2, timeoutMs: 500, botGames: 1 });
    const [hang] = only(report.findings, "hang");
    expect(hang).toMatchObject({ severity: "error", phase: "bot", bots: true });
    expect(hang?.message).toMatch(/^bot for p[12] has not responded for 500 ms/);
  }, 60_000);

  it("replays one match with the game's bot with --seed and --bots, and refuses --bots for a game without bot", async () => {
    const report = await check("bot-good", { players: 2, seed: "check-bots-2-0", bots: true });
    expect(report.replay).toMatchObject({ bots: true, ending: "finished" });
    expect(report.replay?.moves.every((move) => (move.action as { amount: number }).amount >= 1)).toBe(true);
    expect(formatReport(report)).toMatch(/Match with seed check-bots-2-0 and 2 players, every seat played by the game's bot:/);
    const without = await check("counting", { players: 2, seed: "check-bots-2-0", bots: true });
    expect(only(without.findings, "bot")[0]?.message).toMatch(/The game has no function bot/);
  }, 60_000);
});

describe("bot problems", () => {
  it("sorts the problems the platform reports into causes and names each once per seat and match", () => {
    const where = { playerCount: 2, seed: "s", step: 3 };
    const reported = new Set<string>();
    const message = (problem: string, player = "p1") => botFinding(problem, player, where, reported)?.message;
    expect(message("bot for p1 failed: TypeError: Cannot assign to read only property 'count' of object")).toMatch(/^bot tried to change/);
    expect(message("bot for p1 failed: Error: ctx.profile.add does not exist in bot. The game changes profiles only in apply and tick")).toBeUndefined();
    expect(message("bot for p2 failed: Error: ctx.profile.add does not exist in bot.", "p2")).toMatch(/^bot tried to change/);
    expect(message("bot for p1 failed: Error: kaputt")).toMatch(/^bot threw an error/);
    expect(message("bot for p1 chose a move that is not legal right now: {}")).toMatch(/^bot returned a move that is not legal/);
    expect(message("the move of the bot was refused: missing-item")).toMatch(/^The move that bot chose was legal before the step/);
  });
});

describe("check with the game's bot in realtime", () => {
  it("lets the bot play every seat through stepMatch and replays it in QuickJS", async () => {
    const report = await check("rt-bot", { botGames: 1, quickjsGames: 1 });
    expect(report.findings).toEqual([]);
    expect(report.summaries.filter((summary) => summary.bots === true).map((summary) => [summary.playerCount, summary.finished])).toEqual([
      [2, 1],
      [3, 1],
    ]);
    expect(report.notes.join("\n")).toMatch(/bot plays every seat \(asked in every tick\)/);
    expect(formatReport(report)).toMatch(/Matches in which the game's bot plays every seat:\n {2}2 players: 1 match, all finished, on average 3 s of game time \(longest 3 s\), wins/);
  }, 60_000);

  it("reports realtime bots that pick a move that is not legal or throw, with the tick", async () => {
    const report = await check("rt-bot-broken", { players: 2, botGames: 1 });
    const problems = only(report.findings, "bot");
    expect(problems.find((finding) => finding.player === "p1")).toMatchObject({ unit: "tick", step: 1, message: expect.stringMatching(/^bot returned a move that is not legal/) });
    expect(problems.find((finding) => finding.player === "p2")).toMatchObject({ unit: "tick", step: 22, message: expect.stringMatching(/^bot threw an error/) });
    expect(problems.find((finding) => finding.player === "p2")?.detail).toMatch(/no idea what p2 should do/);
  }, 60_000);

  it("reports realtime matches with the game's bot that do not end within the game time limit", async () => {
    const report = await check("rt-bot-endless", { players: 2, botGames: 1, maxSeconds: 5 });
    const endless = only(report.findings, "never-ends");
    expect(endless).toHaveLength(1);
    expect(endless[0]).toMatchObject({ severity: "error", bots: true, unit: "tick", step: 100 });
    expect(endless[0]?.message).toMatch(/game's bot plays every seat do not end after 5 seconds of game time/);
  }, 60_000);
});

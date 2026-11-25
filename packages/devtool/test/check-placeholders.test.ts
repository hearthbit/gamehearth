import { fileURLToPath } from "node:url";
import { createMatch, stepMatch } from "@gamehearth/sdk/platform";
import { describe, expect, it } from "vitest";
import { checkGame } from "../src/check";
import type { Finding } from "../src/findings";
import { findLeaks } from "../src/leaks";
import type { AnyGame, AnyMatch } from "../src/runner";
import { wordsGame } from "./fixtures/rt-words/src/words";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function only(findings: readonly Finding[], kind: Finding["kind"]): Finding[] {
  return findings.filter((finding) => finding.kind === kind);
}

describe("check with placeholders in legalMoves", () => {
  it("fills placeholders with random values and replays them in QuickJS", async () => {
    const report = await checkGame(fixture("rt-words"), { games: 3, quickjsGames: 2 });
    expect(report.findings).toEqual([]);
    expect(report.summaries.every((summary) => summary.finished === 3)).toBe(true);
  }, 90_000);

  it("finds crashes on typed garbage and requires sdk ^0.1.7", async () => {
    const report = await checkGame(fixture("rt-words-old"), { games: 2, quickjsGames: 0 });
    expect(only(report.findings, "game-error")[0]?.message).toMatch(/apply threw an error: unexpected character in/);
    expect(only(report.findings, "manifest").map((finding) => finding.message)).toEqual([
      'legalMoves uses placeholders (text() or int()), so sdk in manifest.json must be at least "^0.1.7"; older servers do not know placeholders.',
    ]);
  }, 90_000);
});

describe("leak check with typed texts", () => {
  const game = wordsGame() as unknown as AnyGame;
  const where = { playerCount: 3, seed: "typed", step: 1 };

  function chatted(text: string): AnyMatch {
    const created = createMatch(game, { playerCount: 3, seed: "typed" });
    if (!created.ok) throw new Error(created.error.message);
    const stepped = stepMatch(game, created.match, { inputs: [{ player: "p1", action: { type: "say", text } }], now: 1, dt: 50 });
    if (!stepped.ok) throw new Error(stepped.error.message);
    return stepped.match;
  }

  it("does not report a typed text that the game copies into several players' areas", () => {
    expect(findLeaks(game, chatted("hallo!"), where, {}, new Set(["hallo!"]))).toEqual([]);
  });

  it("Review 14: still reports a hidden value that sits in the same small object as a typed text", () => {
    const match = chatted("hallo!");
    const state = match.state as { players: Record<string, { chat: unknown[] }> };
    for (const seat of ["p1", "p2"]) {
      state.players[seat]!.chat.push({ card: "Herz-Koenig", note: "ok" });
    }
    const details = findLeaks(game, match, where, {}, new Set(["hallo!", "ok"])).map((finding) => finding.detail);
    expect(details.some((detail) => detail?.includes("Herz-Koenig"))).toBe(true);
    expect(details.some((detail) => detail?.startsWith('"hallo!"'))).toBe(false);
  });

  it("still reports the same copy when check did not type the text (counter-check)", () => {
    const findings = findLeaks(game, chatted("hallo!"), where);
    expect(findings.map((finding) => finding.detail)).toContain('"hallo!" is in players.p1.chat[0] and in players.p2.chat[0]');
  });
});

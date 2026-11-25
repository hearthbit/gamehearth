import { describe, expect, it } from "vitest";
import { formatSummary } from "../src/format";

describe("summary of the bot matches", () => {
  it("names matches with several winners so that shares above 100% do not confuse", () => {
    const text = formatSummary({ playerCount: 2, games: 10, finished: 10, tooLong: 0, failed: 0, averageMoves: 20, longest: 37, wins: { p1: 6, p2: 5 }, withoutWinner: 0, shared: 1 });
    expect(text).toBe("2 players: 10 matches, all finished, on average 20 moves (longest 37), wins: p1 60%, p2 50%, matches with several winners (count for each of them): 1");
    const plain = formatSummary({ playerCount: 2, games: 10, finished: 10, tooLong: 0, failed: 0, averageMoves: 20, longest: 37, wins: { p1: 6, p2: 4 }, withoutWinner: 0, shared: 0 });
    expect(plain).not.toContain("several winners");
  });
});

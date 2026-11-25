import { describe, expect, it } from "vitest";
import { applyMove, createMatch, playerSnapshot, screenSnapshot } from "../src/platform";
import { highCard } from "./fixtures/high-card";
import { expectMatch } from "./helpers";

const start = expectMatch(createMatch(highCard, { playerCount: 3, seed: "sicht" }));
const afterP2 = expectMatch(applyMove(highCard, start, { player: "p2", action: { type: "reveal" }, now: 0 }));

function finish() {
  let match = afterP2;
  for (const player of ["p1", "p3"]) {
    match = expectMatch(applyMove(highCard, match, { player, action: { type: "reveal" }, now: 0 }));
  }
  return match;
}

describe("playerSnapshot", () => {
  it("contains exactly the public area, the seat's own area and its own moves", () => {
    expect(playerSnapshot(afterP2, "p1")).toEqual({
      player: "p1",
      players: ["p1", "p2", "p3"],
      public: afterP2.state.public,
      me: afterP2.state.players["p1"],
      moves: [{ type: "reveal" }],
      version: 1,
    });
  });

  it("contains neither the secret area nor other seats' areas or moves, the seed or the random state", () => {
    for (const player of start.players) {
      const snapshot = playerSnapshot(afterP2, player) as unknown as Record<string, unknown>;
      expect(Object.keys(snapshot).sort()).toEqual(["me", "moves", "player", "players", "public", "version"]);
      expect(snapshot["me"]).toEqual(afterP2.state.players[player]);
      expect(snapshot["moves"]).toEqual(afterP2.moves[player]);
    }
  });

  it("does not reveal which other seats have moves right now", () => {
    const p2 = playerSnapshot(afterP2, "p2");
    expect(p2.moves).toEqual([]);
    expect(JSON.stringify(p2)).not.toContain('"type":"reveal"');
  });

  it("contains the result as soon as the match is over", () => {
    const finished = finish();
    const snapshot = playerSnapshot(finished, "p1");
    expect(snapshot.result).toEqual(finished.result);
    expect(snapshot.moves).toEqual([]);
  });

  it("hands out a copy that cannot change the match", () => {
    const snapshot = playerSnapshot(start, "p2");
    snapshot.me.card = 999;
    snapshot.moves.push({ type: "reveal" });
    expect(start.state.players["p2"]?.card).not.toBe(999);
    expect(start.moves["p2"]).toHaveLength(1);
  });

  it("rejects seats that don't exist", () => {
    expect(() => playerSnapshot(start, "p4")).toThrow();
  });
});

describe("screenSnapshot", () => {
  it("contains only public information", () => {
    expect(screenSnapshot(afterP2)).toEqual({
      players: ["p1", "p2", "p3"],
      public: afterP2.state.public,
      version: 1,
    });
  });

  it("contains the result as soon as the match is over", () => {
    const finished = finish();
    expect(screenSnapshot(finished).result).toEqual(finished.result);
  });
});

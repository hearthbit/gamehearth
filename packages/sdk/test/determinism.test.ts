import { describe, expect, it } from "vitest";
import {
  SeededRandom,
  applyMove,
  createMatch,
  randomStateFromSeed,
  type AnyGameState,
  type GameDefinition,
  type Match,
  type Move,
} from "../src/platform";
import readmeExample from "./fixtures/readme-example";
import { counterGame } from "./fixtures/counter";
import { highCard } from "./fixtures/high-card";
import { expectMatch } from "./helpers";

interface Played<S extends AnyGameState, A> {
  final: Match<S, A>;
  moves: Move<A>[];
}

function playRandomly<S extends AnyGameState, A>(
  game: GameDefinition<S, A>,
  playerCount: number,
  seed: string,
  maxMoves: number,
): Played<S, A> {
  const bot = new SeededRandom(randomStateFromSeed(`bot-${seed}`));
  let match = expectMatch(createMatch(game, { playerCount, seed }));
  const moves: Move<A>[] = [];
  for (let step = 0; step < maxMoves && match.result === undefined; step++) {
    const active = match.players.filter((player) => (match.moves[player] ?? []).length > 0);
    const player = bot.pick(active);
    const move: Move<A> = { player, action: bot.pick(match.moves[player] ?? []), now: step * 1000, expectedVersion: match.version };
    moves.push(move);
    const stored = JSON.parse(JSON.stringify(match)) as Match<S, A>;
    match = expectMatch(applyMove(game, stored, JSON.parse(JSON.stringify(move)) as Move<A>));
  }
  return { final: match, moves };
}

function replay<S extends AnyGameState, A>(
  game: GameDefinition<S, A>,
  playerCount: number,
  seed: string,
  moves: Move<A>[],
): Match<S, A> {
  let match = expectMatch(createMatch(game, { playerCount, seed }));
  for (const move of moves) {
    match = expectMatch(applyMove(game, match, move));
  }
  return match;
}

const games = [
  { name: "High card", game: highCard as GameDefinition<AnyGameState, unknown>, counts: [1, 2, 5, 10] },
  { name: "Counter with dice", game: counterGame() as GameDefinition<AnyGameState, unknown>, counts: [1, 2, 4] },
  { name: "README example", game: readmeExample as GameDefinition<AnyGameState, unknown>, counts: [2, 3, 6] },
];

describe.each(games)("Determinism: $name", ({ game, counts }) => {
  it.each(counts)("replays random matches with %i seats exactly, also across saving and loading", (playerCount) => {
    for (let round = 0; round < 40; round++) {
      const seed = `partie-${playerCount}-${round}`;
      const played = playRandomly(game, playerCount, seed, 200);
      const replayed = replay(game, playerCount, seed, played.moves);
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(played.final));
    }
  });

  it("returns different matches for different seeds", () => {
    const a = playRandomly(game, 2, "seed-a", 200);
    const b = playRandomly(game, 2, "seed-b", 200);
    expect(JSON.stringify(a.final.randomState)).not.toBe(JSON.stringify(b.final.randomState));
  });
});

import { applyMove, botMove, createMatch, playerSnapshot, refreshMatch, type Match, type ProfileChange, type ProfileData } from "@gamehearth/sdk/platform";
import { describe, expect, it } from "vitest";
import manifest from "../manifest.json";
import { deckSize, duel, fullDeck, handSize, type DuelAction, type DuelState, type Options } from "../src";

type DuelMatch = Match<DuelState, DuelAction>;
type Profiles = Record<string, ProfileData>;

const catalog = manifest;
const empty = (): ProfileData => ({ items: {}, stats: {}, flags: {} });

function start(playerCount: number, seed = "test", options: Options = { rounds: 5 }, profiles: Profiles = {}): DuelMatch {
  const created = createMatch(duel, { playerCount, seed, options, catalog, profiles });
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  return created.match;
}

function playWith(match: DuelMatch, player: string, card: number, profiles: Profiles = {}, joker = false): { match: DuelMatch; changes: ProfileChange[] } {
  const action: DuelAction = joker ? { type: "play", card, joker: true } : { type: "play", card };
  const outcome = applyMove(duel, match, { player, action, now: 0 }, { catalog, profiles });
  if (!outcome.ok) {
    throw new Error(`${player} plays ${card}: ${outcome.error.code} ${outcome.error.message}`);
  }
  return { match: outcome.match, changes: outcome.changes ?? [] };
}

function play(match: DuelMatch, player: string, card: number): DuelMatch {
  return playWith(match, player, card).match;
}

function firstCard(match: DuelMatch, player: string): number {
  const card = match.state.players[player]?.cards[0];
  if (card === undefined) {
    throw new Error(`${player} has no card`);
  }
  return card;
}

function everyCard(match: DuelMatch): number[] {
  const { state } = match;
  const inHands = match.players.flatMap((player) => {
    const hand = state.players[player];
    return hand === undefined ? [] : [...hand.cards, ...(hand.chosen === null ? [] : [hand.chosen])];
  });
  const revealed = state.public.lastReveal === null ? [] : Object.values(state.public.lastReveal.cards);
  return [...inHands, ...state.secret.deck, ...revealed];
}

describe("Card Duel", () => {
  it("deals three cards to everyone, the rest stays secret in the deck", () => {
    const match = start(3);
    for (const player of match.players) {
      expect(match.state.players[player]?.cards).toHaveLength(handSize);
    }
    expect(match.state.secret.deck).toHaveLength(deckSize - 3 * handSize);
    expect(match.state.public.deckSize).toBe(match.state.secret.deck.length);
    expect(everyCard(match).sort((a, b) => a - b)).toEqual(fullDeck());
  });

  it("lets everyone choose at the same time and shows the choice only once everyone has played", () => {
    let match = start(2);
    expect(match.moves["p1"]).toHaveLength(handSize);
    expect(match.moves["p2"]).toHaveLength(handSize);

    const card = firstCard(match, "p1");
    match = play(match, "p1", card);
    expect(match.moves["p1"]).toEqual([]);
    expect(match.state.public.played["p1"]).toBe(true);
    expect(JSON.stringify(playerSnapshot(match, "p2"))).not.toContain(`"chosen":${card}`);

    match = play(match, "p2", firstCard(match, "p2"));
    expect(match.state.public.lastReveal?.cards["p1"]).toBe(card);
    expect(match.state.public.round).toBe(2);
    expect(match.state.public.played).toEqual({ p1: false, p2: false });
  });

  it("gives the point to the highest card and lets everyone draw a new card", () => {
    let match = start(2, "point");
    const p1 = firstCard(match, "p1");
    const p2 = firstCard(match, "p2");
    match = play(match, "p1", p1);
    match = play(match, "p2", p2);
    const winner = p1 > p2 ? "p1" : "p2";
    expect(match.state.public.lastReveal?.winners).toEqual([winner]);
    expect(match.state.public.scores[winner]).toBe(1);
    expect(match.state.players["p1"]?.cards).toHaveLength(handSize);
    expect(match.state.public.deckSize).toBe(deckSize - 2 * handSize - 2);
  });

  it.each([3, 5, 7] as const)("ends after %i rounds, and whoever has the most points wins", (rounds) => {
    let match = start(4, "end", { rounds });
    for (let round = 1; round <= rounds; round++) {
      expect(match.result).toBeUndefined();
      for (const player of match.players) {
        match = play(match, player, firstCard(match, player));
      }
    }
    expect(match.state.public.finished).toBe(true);
    const scores = match.state.public.scores;
    const best = Math.max(...Object.values(scores));
    expect(match.result?.winners).toEqual(match.players.filter((player) => scores[player] === best));
    for (const player of match.players) {
      expect(match.moves[player]).toEqual([]);
    }
  });
});

describe("Bot", () => {
  it.each([2, 3, 4])("always picks a legal move, and a match of %i bots ends", (playerCount) => {
    for (let game = 0; game < 10; game++) {
      const profiles: Profiles = { p1: { items: { joker: 2 }, stats: {}, flags: {} } };
      let match = start(playerCount, `bots-${game}`, { rounds: 5 }, profiles);
      let current = profiles;
      for (let moves = 0; moves < 100 && match.result === undefined; moves++) {
        const player = match.players.find((seat) => (match.moves[seat] ?? []).length > 0) as string;
        const choice = botMove(duel, match, player, { now: 0, catalog, profiles: current });
        expect(choice).toMatchObject({ ok: true, chosen: "bot" });
        expect(choice.problem).toBeUndefined();
        const outcome = applyMove(duel, match, { player, action: choice.action as DuelAction, now: 0 }, { catalog, profiles: current });
        if (!outcome.ok) {
          throw new Error(outcome.error.message);
        }
        if ((outcome.changes ?? []).some((change) => change.op === "use")) {
          current = { ...current, p1: { items: { joker: (current.p1?.items.joker ?? 1) - 1 }, stats: {}, flags: {} } };
        }
        match = outcome.match;
      }
      expect(match.result).toBeDefined();
    }
  });

  it("plays its highest card with a joker in the last round", () => {
    const profiles: Profiles = { p1: { items: { joker: 1 }, stats: {}, flags: {} } };
    const last = placed(start(2, "last", { rounds: 3 }, profiles), (state) => {
      state.public.round = 3;
    });
    const refreshed = refreshMatch(duel, last, { catalog, profiles });
    if (!refreshed.ok) {
      throw new Error(refreshed.error.message);
    }
    const highest = Math.max(...(refreshed.match.state.players["p1"]?.cards ?? []));
    expect(botMove(duel, refreshed.match, "p1", { now: 0, catalog, profiles })).toMatchObject({ chosen: "bot", action: { type: "play", card: highest, joker: true } });
  });
});

function placed(match: DuelMatch, changes: (state: DuelState) => void): DuelMatch {
  const copy = JSON.parse(JSON.stringify(match)) as DuelMatch;
  changes(copy.state);
  return copy;
}

describe("Jokers and wins in the profile", () => {
  it("also offers every card with a joker, but only if the profile has one", () => {
    const withJoker: Profiles = { p1: { items: { joker: 1 }, stats: {}, flags: {} } };
    const match = start(2, "joker", { rounds: 5 }, withJoker);
    expect(match.moves["p1"]).toHaveLength(2 * handSize);
    expect(match.moves["p1"]?.filter((move) => move.joker === true)).toHaveLength(handSize);
    expect(match.moves["p2"]).toHaveLength(handSize);
  });

  it("doubles a card played with a joker and uses up the joker", () => {
    const profiles: Profiles = { p1: { items: { joker: 1 }, stats: {}, flags: {} }, p2: empty() };
    const match = start(2, "double", { rounds: 5 }, profiles);
    const p1 = Math.min(...(match.state.players["p1"]?.cards ?? []));
    const p2 = Math.max(...(match.state.players["p2"]?.cards ?? []));
    const first = playWith(match, "p1", p1, profiles, true);
    expect(first.changes).toEqual([{ player: "p1", op: "use", id: "joker", value: 1 }]);
    const after: Profiles = { p1: empty(), p2: empty() };
    const second = playWith(first.match, "p2", p2, after);
    expect(second.match.state.public.lastReveal?.jokers).toEqual(["p1"]);
    expect(second.match.state.public.lastReveal?.winners).toEqual(2 * p1 >= p2 ? (2 * p1 === p2 ? ["p1", "p2"] : ["p1"]) : ["p2"]);
    expect(second.match.moves["p1"]?.some((move) => move.joker === true)).toBe(false);
  });

  it("gives the winners a win and a joker at the end", () => {
    let match = start(2, "win", { rounds: 3 });
    const changes: ProfileChange[] = [];
    for (let round = 1; round <= 3; round++) {
      for (const player of match.players) {
        const step = playWith(match, player, firstCard(match, player));
        match = step.match;
        changes.push(...step.changes);
      }
    }
    const winners = match.result?.winners ?? [];
    expect(winners.length).toBeGreaterThan(0);
    expect(changes).toEqual(
      winners.flatMap((player) => [
        { player, op: "stat", id: "wins", value: 1 },
        { player, op: "add", id: "joker", value: 1 },
      ]),
    );
  });

  it("rejects a move with a joker if the joker is gone by then", () => {
    const match = start(2, "gone", { rounds: 5 }, { p1: { items: { joker: 1 }, stats: {}, flags: {} } });
    const card = firstCard(match, "p1");
    const outcome = applyMove(duel, match, { player: "p1", action: { type: "play", card, joker: true }, now: 0 }, { catalog, profiles: { p1: empty() } });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? undefined : outcome.error.code).toBe("missing-item");
  });
});

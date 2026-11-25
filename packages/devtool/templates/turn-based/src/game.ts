import { defineGame, type CatalogOf, type GameState, type PlayerId } from "@gamehearth/sdk";
import manifest from "../manifest.json";

export const handSize = 3;
export const deckSize = 30;

export type Card = number;

export type Ids = CatalogOf<typeof manifest>;

export interface Options {
  rounds: 3 | 5 | 7;
}

export interface Reveal {
  cards: Record<PlayerId, Card>;
  jokers: PlayerId[];
  winners: PlayerId[];
}

export interface Public {
  round: number;
  scores: Record<PlayerId, number>;
  played: Record<PlayerId, boolean>;
  lastReveal: Reveal | null;
  deckSize: number;
  finished: boolean;
}

export interface Hand {
  cards: Card[];
  chosen: Card | null;
  joker: boolean;
}

export interface Secret {
  deck: Card[];
}

export type DuelState = GameState<Public, Hand, Secret>;

export type DuelAction = { type: "play"; card: Card; joker?: true };

export function fullDeck(): Card[] {
  return Array.from({ length: deckSize }, (_, index) => index + 1);
}

export function cardValue(card: Card, joker: boolean): number {
  return joker ? card * 2 : card;
}

export function highestCard(moves: readonly DuelAction[]): DuelAction | undefined {
  return moves.reduce<DuelAction | undefined>((best, move) => (best === undefined || move.card > best.card ? move : best), undefined);
}

export function matchWinners(scores: Record<PlayerId, number>): PlayerId[] {
  const entries = Object.entries(scores);
  const best = Math.max(...entries.map(([, score]) => score));
  return entries.filter(([, score]) => score === best).map(([player]) => player);
}

export const duel = defineGame<DuelState, DuelAction, Options, Ids>({
  setup({ players, random }) {
    const deck = random.shuffle(fullDeck());
    const hands: Record<PlayerId, Hand> = {};
    const scores: Record<PlayerId, number> = {};
    const played: Record<PlayerId, boolean> = {};
    for (const player of players) {
      hands[player] = { cards: deck.splice(0, handSize), chosen: null, joker: false };
      scores[player] = 0;
      played[player] = false;
    }
    return {
      public: { round: 1, scores, played, lastReveal: null, deckSize: deck.length, finished: false },
      players: hands,
      secret: { deck },
    };
  },

  legalMoves(state, player, { profiles }) {
    const hand = state.players[player];
    if (state.public.finished || hand === undefined || hand.chosen !== null) {
      return [];
    }
    const moves: DuelAction[] = hand.cards.map((card) => ({ type: "play", card }));
    if ((profiles[player]?.items.joker ?? 0) > 0) {
      moves.push(...hand.cards.map((card): DuelAction => ({ type: "play", card, joker: true })));
    }
    return moves;
  },

  apply(state, action, { player, players, options, profile }) {
    const hand = state.players[player]!;
    if (action.joker === true) {
      profile.use(player, "joker", 1);
    }
    hand.cards = hand.cards.filter((card) => card !== action.card);
    hand.chosen = action.card;
    hand.joker = action.joker === true;
    state.public.played[player] = true;

    if (!players.every((seat) => state.public.played[seat])) {
      return;
    }

    const cards: Record<PlayerId, Card> = {};
    const jokers: PlayerId[] = [];
    for (const seat of players) {
      const seatHand = state.players[seat]!;
      cards[seat] = seatHand.chosen!;
      if (seatHand.joker) {
        jokers.push(seat);
      }
    }
    const best = Math.max(...players.map((seat) => cardValue(cards[seat]!, jokers.includes(seat))));
    const winners = players.filter((seat) => cardValue(cards[seat]!, jokers.includes(seat)) === best);
    for (const seat of winners) {
      state.public.scores[seat] = (state.public.scores[seat] ?? 0) + 1;
    }
    state.public.lastReveal = { cards, jokers, winners };

    for (const seat of players) {
      state.players[seat]!.chosen = null;
      state.players[seat]!.joker = false;
      state.public.played[seat] = false;
    }

    if (state.public.round === options.rounds) {
      state.public.finished = true;
      for (const seat of matchWinners(state.public.scores)) {
        profile.stat(seat, "wins", 1);
        profile.add(seat, "joker", 1);
      }
      return;
    }
    for (const seat of players) {
      const card = state.secret.deck.pop();
      if (card !== undefined) {
        state.players[seat]!.cards.push(card);
      }
    }
    state.public.deckSize = state.secret.deck.length;
    state.public.round += 1;
  },

  bot(state, _player, moves, { random, options }) {
    const plain = moves.filter((move) => move.joker !== true);
    if (state.public.round === options.rounds) {
      const jokers = moves.filter((move) => move.joker === true);
      return highestCard(jokers.length > 0 ? jokers : plain);
    }
    return random.next() < 0.7 ? highestCard(plain) : random.pick(plain);
  },

  result(state) {
    return state.public.finished ? { winners: matchWinners(state.public.scores) } : undefined;
  },
});

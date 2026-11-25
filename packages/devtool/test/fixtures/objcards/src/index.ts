import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type Card = { suit: "hearts" | "spades" | "clubs" | "diamonds"; rank: number };
type Public = { current: PlayerId; discard: Card[]; turns: number };
type Mine = { hand: Card[] };
type Secret = { deck: Card[] };
type Action = { type: "play"; index: number } | { type: "draw" };

const suits = ["hearts", "spades", "clubs", "diamonds"] as const;

export default defineGame<GameState<Public, Mine, Secret>, Action>({
  setup({ players, random }) {
    const deck = random.shuffle(suits.flatMap((suit) => [7, 8, 9, 10, 11, 12, 13, 14].map((rank) => ({ suit, rank }))));
    const hands = Object.fromEntries(players.map((p) => [p, { hand: deck.splice(0, 4) }]));
    return { public: { current: players[0]!, discard: [deck.pop()!], turns: 0 }, players: hands, secret: { deck } };
  },
  legalMoves(state, player) {
    if (player !== state.public.current) return [];
    const top = state.public.discard.at(-1)!;
    const plays = state.players[player]!.hand.flatMap((card, index) =>
      card.suit === top.suit || card.rank === top.rank ? [{ type: "play" as const, index }] : [],
    );
    return [...plays, { type: "draw" }];
  },
  apply(state, action, { player, players }) {
    const own = state.players[player]!;
    if (action.type === "play") {
      state.public.discard.push(own.hand.splice(action.index, 1)[0]!);
    } else {
      const card = state.secret.deck.pop();
      if (card) own.hand.push(card);
    }
    state.public.turns += 1;
    state.public.current = players[(players.indexOf(player) + 1) % players.length]!;
  },
  result(state) {
    const empty = Object.keys(state.players).filter((p) => state.players[p]!.hand.length === 0);
    if (empty.length > 0) return { winners: empty };
    return state.public.turns >= 40 ? { winners: [] } : undefined;
  },
});

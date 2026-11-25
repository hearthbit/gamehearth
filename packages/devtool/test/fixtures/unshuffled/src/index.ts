import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type Public = { current: PlayerId; turns: number; discard: string[] };
type Mine = { hand: string[] };
type Secret = { deck: string[] };
type Action = { type: "play"; card: string } | { type: "draw" };

export default defineGame<GameState<Public, Mine, Secret>, Action>({
  setup({ players, random }) {
    const deck = ["kreuz", "pik", "herz", "karo"].flatMap((s) => ["7", "8", "9", "10", "B", "D", "K", "A"].map((r) => `${s}-${r}`));
    random.shuffle(deck);
    const hands = Object.fromEntries(players.map((p) => [p, { hand: deck.splice(0, 5) }]));
    return { public: { current: players[0]!, turns: 0, discard: [deck.pop()!] }, players: hands, secret: { deck } };
  },
  legalMoves(state, player) {
    if (player !== state.public.current) return [];
    return [...state.players[player]!.hand.map((card) => ({ type: "play" as const, card })), { type: "draw" as const }];
  },
  apply(state, action, { player, players }) {
    const own = state.players[player]!;
    if (action.type === "play") {
      own.hand = own.hand.filter((c) => c !== action.card);
      state.public.discard.push(action.card);
    } else {
      const card = state.secret.deck.pop();
      if (card) own.hand.push(card);
    }
    state.public.turns += 1;
    state.public.current = players[(players.indexOf(player) + 1) % players.length]!;
  },
  result(state) {
    const empty = Object.keys(state.players).filter((p) => state.players[p]!.hand.length === 0);
    return empty.length > 0 ? { winners: empty } : state.public.turns >= 60 ? { winners: [] } : undefined;
  },
});

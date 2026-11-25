import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type Public = { current: PlayerId; turns: number };
type Mine = { hand: string[] };
type Secret = { deck: string[] };
type Action = { type: "draw"; card?: string } | { type: "keep" };

const deckOf = () => ["S", "H", "D", "C"].flatMap((suit) => ["7", "8", "9", "T", "J", "Q", "K", "A"].map((rank) => rank + suit));

export default defineGame<GameState<Public, Mine, Secret>, Action>({
  setup({ players, random }) {
    const deck = random.shuffle(deckOf());
    return {
      public: { current: players[0]!, turns: 0 },
      players: Object.fromEntries(players.map((p) => [p, { hand: [deck.pop()!] }])),
      secret: { deck },
    };
  },
  legalMoves(state, player) {
    if (player !== state.public.current) return [];
    const top = state.secret.deck.at(-1);
    return top === undefined ? [{ type: "keep" }] : [{ type: "draw", card: top }, { type: "keep" }];
  },
  apply(state, action, { player, players }) {
    if (action.type === "draw") state.players[player]!.hand.push(state.secret.deck.pop()!);
    state.public.turns += 1;
    state.public.current = players[(players.indexOf(player) + 1) % players.length]!;
  },
  result(state) {
    return state.public.turns >= 9 ? { winners: [state.public.current] } : undefined;
  },
});

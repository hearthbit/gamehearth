import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type Public = { current: PlayerId; turns: number };
type Mine = { hand: Record<string, true> };
type Secret = { deck: string[] };
type Action = { type: "steal"; from: PlayerId; card: string } | { type: "keep" };

export default defineGame<GameState<Public, Mine, Secret>, Action>({
  setup({ players, random }) {
    const deck = random.shuffle(Array.from({ length: 30 }, (_, i) => `karte-${i + 10}`));
    return {
      public: { current: players[0]!, turns: 0 },
      players: Object.fromEntries(players.map((p) => [p, { hand: { [deck.pop()!]: true, [deck.pop()!]: true } }])),
      secret: { deck },
    };
  },
  legalMoves(state, player) {
    if (player !== state.public.current) return [];
    const steals = Object.keys(state.players)
      .filter((other) => other !== player)
      .flatMap((other) => Object.keys(state.players[other]!.hand).map((card) => ({ type: "steal" as const, from: other, card })));
    return [...steals, { type: "keep" }];
  },
  apply(state, action, { player, players }) {
    if (action.type === "steal") {
      delete state.players[action.from]!.hand[action.card];
      state.players[player]!.hand[action.card] = true;
    }
    state.public.turns += 1;
    state.public.current = players[(players.indexOf(player) + 1) % players.length]!;
  },
  result(state) {
    return state.public.turns >= 9 ? { winners: [state.public.current] } : undefined;
  },
});

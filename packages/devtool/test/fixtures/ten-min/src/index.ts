import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type Public = { current: PlayerId; count: number };
type Mine = { role: number };
type Action = { type: "next" };

export default defineGame<GameState<Public, Mine, Record<string, never>>, Action>({
  setup({ players, random }) {
    const roles = random.shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    return {
      public: { current: players[0]!, count: 0 },
      players: Object.fromEntries(players.map((p, i) => [p, { role: roles[i]!.valueOf() }])),
      secret: {},
    };
  },
  legalMoves(state, player) {
    return player === state.public.current ? [{ type: "next" }] : [];
  },
  apply(state, _action, { player, players }) {
    state.public.count += 1;
    state.public.current = players[(players.indexOf(player) + 1) % players.length]!;
  },
  result(state) {
    return state.public.count >= 12 ? { winners: [state.public.current] } : undefined;
  },
});

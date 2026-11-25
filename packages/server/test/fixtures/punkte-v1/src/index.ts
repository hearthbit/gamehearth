import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type Public = { count: number; current: PlayerId; last: PlayerId | null };

export default defineGame<GameState<Public, Record<string, never>, Record<string, never>>, { type: "add" }>({
  setup({ players }) {
    return {
      public: { count: 0, current: players[0] ?? "p1", last: null },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: {},
    };
  },
  legalMoves(state, player) {
    return player === state.public.current ? [{ type: "add" }] : [];
  },
  apply(state, _action, { player, players }) {
    state.public.count += 1;
    state.public.last = player;
    state.public.current = players[(players.indexOf(player) + 1) % players.length] ?? player;
  },
  result(state) {
    return state.public.count >= 6 && state.public.last !== null ? { winners: [state.public.last] } : undefined;
  },
});

import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type Public = { count: number; current: PlayerId };
type Action = { type: "add" } | { type: "schleife" };

export default defineGame<GameState<Public, Record<string, never>, Record<string, never>>, Action>({
  setup({ players }) {

    return {
      public: { count: 0, current: players[0] ?? "p1" },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: {},
    };
  },
  legalMoves(state, player) {
    return player === state.public.current ? [{ type: "add" }, { type: "schleife" }] : [];
  },
  apply(state, action, { player, players }) {
    if (action.type === "schleife") {
      for (;;) {
        state.public.count += 1;
      }
    }
    state.public.count += 1;
    state.public.current = players[(players.indexOf(player) + 1) % players.length] ?? player;
  },
  result(state) {
    return state.public.count >= 6 ? { winners: [state.public.current] } : undefined;
  },
});

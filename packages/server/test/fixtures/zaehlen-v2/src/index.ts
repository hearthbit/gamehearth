import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type Public = { count: number; current: PlayerId; last: PlayerId | null };
type Action = { type: "add" } | { type: "kaputt" };

export default defineGame<GameState<Public, { geheim: string }, Record<string, never>>, Action>({
  setup({ players }) {
    return {
      public: { count: 0, current: players[0] ?? "p1", last: null },
      players: Object.fromEntries(players.map((player) => [player, { geheim: `nur-fuer-${player}` }])),
      secret: {},
    };
  },
  legalMoves(state, player) {
    return player === state.public.current ? [{ type: "add" }, { type: "kaputt" }] : [];
  },
  apply(state, action, { player, players }) {
    if (action.type === "kaputt") {
      throw new Error("absichtlich kaputt");
    }
    state.public.count += 2;
    state.public.last = player;
    state.public.current = players[(players.indexOf(player) + 1) % players.length] ?? player;
  },
  result(state) {
    return state.public.count >= 6 && state.public.last !== null ? { winners: [state.public.last] } : undefined;
  },
});

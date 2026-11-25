import { defineGame, type GameState } from "@gamehearth/sdk";

export default defineGame<GameState<{ count: number }, Record<string, never>, Record<string, never>>, { type: "add" }>({
  setup({ players }) {
    return { public: { count: 0 }, players: Object.fromEntries(players.map((player) => [player, {}])), secret: {} };
  },
  legalMoves() {
    return [{ type: "add" }];
  },
  apply(state) {
    state.public.count += 1;
  },
  result(state) {
    return state.public.count >= 100 ? { winners: [] } : undefined;
  },
});

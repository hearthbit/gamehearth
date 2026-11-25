import { defineGame, type GameState } from "@gamehearth/sdk";

type Public = { ticks: number; boom: boolean; presses: number };
type Action = { type: "press" } | { type: "boom" };

export default defineGame<GameState<Public, Record<string, never>, Record<string, never>>, Action>({
  setup({ players }) {
    return {
      public: { ticks: 0, boom: false, presses: 0 },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: {},
    };
  },
  legalMoves() {
    return [{ type: "press" }, { type: "boom" }];
  },
  apply(state, action) {
    if (action.type === "boom") {
      state.public.boom = true;
    } else {
      state.public.presses += 1;
    }
  },
  tick(state) {
    if (state.public.boom) {
      throw new Error("Tick explodiert");
    }
    state.public.ticks += 1;
  },
  result(state) {
    return state.public.presses >= 50 ? { winners: [] } : undefined;
  },
});

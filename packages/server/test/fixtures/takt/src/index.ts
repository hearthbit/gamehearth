import { defineGame, type GameState } from "@gamehearth/sdk";

type Public = { counter: number; presses: number };
type Action = { type: "press" };
interface Options {
  schritt: number;
  tasten: boolean;
}

export default defineGame<GameState<Public, Record<string, never>, Record<string, never>>, Action, Options>({
  setup({ players }) {
    return {
      public: { counter: 0, presses: 0 },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: {},
    };
  },
  legalMoves(_state, _player, { options }) {
    return options.tasten ? [{ type: "press" }] : [];
  },
  apply(state, _action, { options }) {
    state.public.presses += options.schritt;
  },
  tick(state, _dt, { options }) {
    state.public.counter += options.schritt;
  },
  result(state) {
    return state.public.counter >= 100_000 ? { winners: [] } : undefined;
  },
});

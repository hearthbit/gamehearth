import { defineGame, type GameState } from "@gamehearth/sdk";

type State = GameState<{ ticks: number; dir: Record<string, number>; idle: Record<string, number>; away: string[] }, Record<string, never>, Record<string, never>>;
type Action = { type: "dir"; dir: -1 | 0 | 1 };

export default defineGame<State, Action>({
  setup({ players }) {
    return {
      public: { ticks: 0, dir: Object.fromEntries(players.map((player) => [player, 0])), idle: {}, away: [] },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: {},
    };
  },
  legalMoves(state) {
    return state.public.ticks >= 600
      ? []
      : [
          { type: "dir", dir: -1 },
          { type: "dir", dir: 0 },
          { type: "dir", dir: 1 },
        ];
  },
  apply(state, action, { player }) {
    state.public.dir[player] = action.dir;
  },
  tick(state, _dt, { away }) {
    state.public.ticks += 1;
    for (const seat of away) {
      state.public.idle[seat] = (state.public.idle[seat] ?? 0) + 1;
    }
    state.public.away = [...away];
  },
  result(state) {
    return state.public.ticks >= 600 ? { winners: [] } : undefined;
  },
});

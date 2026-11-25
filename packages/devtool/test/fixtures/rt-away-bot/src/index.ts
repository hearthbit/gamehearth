import { defineGame, type GameState } from "@gamehearth/sdk";

type State = GameState<{ ticks: number; dir: Record<string, number> }, Record<string, never>, Record<string, never>>;
type Action = { type: "dir"; dir: -1 | 0 | 1 };

export default defineGame<State, Action>({
  setup({ players }) {
    return {
      public: { ticks: 0, dir: Object.fromEntries(players.map((player) => [player, 0])) },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: {},
    };
  },
  legalMoves(state) {
    return state.public.ticks >= 600 ? [] : [{ type: "dir", dir: -1 }, { type: "dir", dir: 0 }, { type: "dir", dir: 1 }];
  },
  apply(state, action, { player }) {
    state.public.dir[player] = action.dir;
  },
  tick(state) {
    state.public.ticks += 1;
  },
  bot(state, player, moves, { away }) {
    if (away.length > 0) {
      throw new Error("bot cannot cope with away seats");
    }
    return state.public.ticks % 40 === 0 ? moves[(state.public.ticks / 40) % 3] : undefined;
  },
  result(state) {
    return state.public.ticks >= 600 ? { winners: [] } : undefined;
  },
});

import { defineGame, type GameDefinition, type GameState } from "@gamehearth/sdk";

export type DotsState = GameState<{ x: Record<string, number>; dir: Record<string, number>; ticks: number }, { taps: number }, { colors: string[] }>;
export type DotsAction = { type: "dir"; dir: -1 | 0 | 1 };

export function dotsGame(overrides: Partial<GameDefinition<DotsState, DotsAction>> = {}) {
  return defineGame<DotsState, DotsAction>({
    setup({ players, random }) {
      return {
        public: {
          x: Object.fromEntries(players.map((player) => [player, 0])),
          dir: Object.fromEntries(players.map((player) => [player, 0])),
          ticks: 0,
        },
        players: Object.fromEntries(players.map((player) => [player, { taps: 0 }])),
        secret: { colors: random.shuffle(["rot", "blau", "gelb"]) },
      };
    },
    legalMoves() {
      return [
        { type: "dir", dir: -1 },
        { type: "dir", dir: 0 },
        { type: "dir", dir: 1 },
      ];
    },
    apply(state, action, { player }) {
      state.public.dir[player] = action.dir;
      const own = state.players[player];
      if (own !== undefined) {
        own.taps += 1;
      }
    },
    tick(state) {
      state.public.ticks += 1;
      for (const player of Object.keys(state.public.x)) {
        state.public.x[player] = (state.public.x[player] ?? 0) + (state.public.dir[player] ?? 0);
      }
    },
    result(state) {
      return state.public.ticks >= 60 ? { winners: Object.keys(state.public.x) } : undefined;
    },
    ...overrides,
  });
}

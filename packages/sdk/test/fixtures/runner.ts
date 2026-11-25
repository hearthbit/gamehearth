import { defineGame, type GameDefinition, type GameState } from "../../src/platform";

export type RunnerState = GameState<
  { x: Record<string, number>; dir: Record<string, number>; ticks: number; countdown: number; dts: number[] },
  { taps: number },
  { bag: number[] }
>;
export type RunnerAction = { type: "dir"; dir: -1 | 0 | 1 } | { type: "finish" };

export function runnerGame(overrides: Partial<GameDefinition<RunnerState, RunnerAction>> = {}) {
  return defineGame<RunnerState, RunnerAction>({
    setup: ({ players, random }) => ({
      public: {
        x: Object.fromEntries(players.map((player) => [player, 0])),
        dir: Object.fromEntries(players.map((player) => [player, 0])),
        ticks: 0,
        countdown: 0,
        dts: [],
      },
      players: Object.fromEntries(players.map((player) => [player, { taps: 0 }])),
      secret: { bag: random.shuffle([1, 2, 3, 4]) },
    }),
    legalMoves: (state) =>
      state.public.countdown > 0
        ? []
        : [{ type: "dir", dir: -1 }, { type: "dir", dir: 0 }, { type: "dir", dir: 1 }, { type: "finish" }],
    apply: (state, action, { player }) => {
      if (action.type === "finish") {
        state.public.ticks = 1000;
        return;
      }
      state.public.dir[player] = action.dir;
      const own = state.players[player];
      if (own !== undefined) {
        own.taps += 1;
      }
    },
    tick: (state, dt, { random }) => {
      state.public.ticks += 1;
      state.public.dts.push(dt);
      if (state.public.countdown > 0) {
        state.public.countdown -= 1;
      }
      for (const player of Object.keys(state.public.x)) {
        state.public.x[player] = (state.public.x[player] ?? 0) + (state.public.dir[player] ?? 0);
      }
      state.secret.bag = random.shuffle(state.secret.bag);
    },
    result: (state) => (state.public.ticks >= 10 ? { winners: Object.keys(state.public.x) } : undefined),
    ...overrides,
  });
}

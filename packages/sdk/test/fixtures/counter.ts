import { cloneJson, defineGame, type GameDefinition, type GameState } from "../../src/platform";

export type CounterState = GameState<{ count: number; rolls: number[]; log: string[] }, { turns: number }, { note: string }>;
export type CounterAction = { type: "step"; by: number } | { type: "roll" };

export function counterGame(overrides: Partial<GameDefinition<CounterState, CounterAction>> = {}) {
  return defineGame<CounterState, CounterAction>({
    setup: ({ players }) => ({
      public: { count: 0, rolls: [], log: [] },
      players: Object.fromEntries(players.map((player) => [player, { turns: 0 }])),
      secret: { note: "geheim" },
    }),
    legalMoves: (state, player) => {
      const turn = state.public.log.length % Object.keys(state.players).length;
      const current = Object.keys(state.players)[turn];
      return player === current
        ? [
            { type: "step", by: 1 },
            { type: "step", by: 2 },
            { type: "roll" },
          ]
        : [];
    },
    apply: (state, action, { player, random, now }) => {
      const next = cloneJson(state);
      if (action.type === "step") {
        next.public.count += action.by;
      } else {
        next.public.rolls.push(random.int(1, 6));
      }
      next.public.log.push(`${player}@${now}`);
      const own = next.players[player];
      if (own !== undefined) {
        own.turns += 1;
      }
      return next;
    },
    result: (state) => (state.public.count >= 5 ? { winners: [state.public.log.at(-1)?.split("@")[0] ?? ""] } : undefined),
    ...overrides,
  });
}

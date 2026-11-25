import { defineGame, type GameDefinition, type GameState, type PlayerId } from "@gamehearth/sdk";

export type CountingState = GameState<{ count: number; current: PlayerId; last: PlayerId | null }, { secretNumber: number }, { pile: number[] }>;
export type CountingAction = { type: "add"; amount: number };

export function countingGame(overrides: Partial<GameDefinition<CountingState, CountingAction>> = {}) {
  return defineGame<CountingState, CountingAction>({
    setup({ players, random }) {
      const pile = random.shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      return {
        public: { count: 0, current: players[0] ?? "p1", last: null },
        players: Object.fromEntries(players.map((player) => [player, { secretNumber: pile.pop() ?? 0 }])),
        secret: { pile },
      };
    },
    legalMoves(state, player) {
      return player === state.public.current
        ? [
            { type: "add", amount: 1 },
            { type: "add", amount: 2 },
          ]
        : [];
    },
    apply(state, action, { player, players }) {
      state.public.count += action.amount;
      state.public.last = player;
      state.public.current = players[(players.indexOf(player) + 1) % players.length] ?? player;
    },
    result(state) {
      return state.public.count >= 10 && state.public.last !== null ? { winners: [state.public.last] } : undefined;
    },
    ...overrides,
  });
}

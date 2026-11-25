import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type State = GameState<{ count: number; ziel: number; current: PlayerId; last: PlayerId | null }, Record<string, never>, null>;
type Action = { type: "add"; amount: number };
interface Options {
  ziel: number;
  gross: boolean;
}

export default defineGame<State, Action, Options>({
  setup({ players, options }) {
    return {
      public: { count: 0, ziel: options.ziel, current: players[0] ?? "p1", last: null },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: null,
    };
  },
  legalMoves(state, player, ctx) {
    if (player !== state.public.current) {
      return [];
    }
    const amounts = ctx.options.gross ? [1, 2, 3] : [1, 2];
    return amounts.map((amount) => ({ type: "add", amount }));
  },
  apply(state, action, { player, players, options }) {
    if (options.ziel === 30 && state.public.count > 25) {
      throw new Error("broken at target 30");
    }
    state.public.count += action.amount;
    state.public.last = player;
    state.public.current = players[(players.indexOf(player) + 1) % players.length] ?? player;
  },
  result(state) {
    return state.public.count >= state.public.ziel && state.public.last !== null ? { winners: [state.public.last] } : undefined;
  },
});

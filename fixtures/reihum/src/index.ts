import { defineGame, type GameState } from "@gamehearth/sdk";

export const goal = 20;
export const turnTicks = 3 * 20;
export const limitTicks = 120 * 20;

export type TurnPublic = { turn: string; left: number; presses: Record<string, number>; skipped: string[]; ticks: number };
export type TurnState = GameState<TurnPublic, Record<string, never>, Record<string, never>>;
export type TurnAction = { type: "press" };

function next(state: TurnState, players: readonly string[]): void {
  const index = players.indexOf(state.public.turn);
  state.public.turn = players[(index + 1) % players.length] as string;
  state.public.left = turnTicks;
}

export default defineGame<TurnState, TurnAction>({
  setup({ players }) {
    return {
      public: { turn: players[0] as string, left: turnTicks, presses: Object.fromEntries(players.map((player) => [player, 0])), skipped: [], ticks: 0 },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: {},
    };
  },
  legalMoves(state, player) {
    return state.public.turn === player ? [{ type: "press" }] : [];
  },
  apply(state, _action, { player, players }) {
    state.public.presses[player] = (state.public.presses[player] ?? 0) + 1;
    next(state, players);
  },
  tick(state, _dt, { players, away }) {
    state.public.ticks += 1;
    state.public.left -= 1;
    if (away.includes(state.public.turn)) {
      state.public.skipped = [...state.public.skipped.slice(-9), state.public.turn];
      next(state, players);
    } else if (state.public.left <= 0) {
      next(state, players);
    }
  },
  bot(state, player, moves) {
    return state.public.turn === player && state.public.left < turnTicks - 10 ? moves[0] : undefined;
  },
  result(state) {
    const total = Object.values(state.public.presses).reduce((sum, count) => sum + count, 0);
    if (total < goal && state.public.ticks < limitTicks) {
      return undefined;
    }
    const best = Math.max(...Object.values(state.public.presses));
    return { winners: Object.keys(state.public.presses).filter((seat) => state.public.presses[seat] === best) };
  },
});

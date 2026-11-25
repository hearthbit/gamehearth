import { defineGame, type GameState } from "@gamehearth/sdk";

type Public = { turn: number; ticks: number; presses: Record<string, number>; skipped: string[] };
type Action = { type: "press" };

function current(state: GameState<Public, Record<string, never>, Record<string, never>>): string {
  const seats = Object.keys(state.players);
  return seats[state.public.turn % seats.length] as string;
}

export default defineGame<GameState<Public, Record<string, never>, Record<string, never>>, Action>({
  setup({ players }) {
    return {
      public: { turn: 0, ticks: 0, presses: Object.fromEntries(players.map((player) => [player, 0])), skipped: [] },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: {},
    };
  },
  legalMoves() {
    return [{ type: "press" }];
  },
  apply(state, _action, { player }) {
    if (current(state) === player) {
      state.public.presses[player] = (state.public.presses[player] ?? 0) + 1;
      state.public.turn += 1;
    }
  },
  tick(state, _dt, { away }) {
    state.public.ticks += 1;
    const seat = current(state);
    if (away.includes(seat)) {
      state.public.skipped.push(seat);
      state.public.turn += 1;
    }
  },
  bot(state, player, moves) {
    return current(state) === player ? moves[0] : undefined;
  },
  result(state) {
    return state.public.ticks >= 2000 ? { winners: [] } : undefined;
  },
});

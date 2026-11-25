import { defineGame, type GameState } from "@gamehearth/sdk";

type Public = { drawing: string; ticks: number; taps: number[] };
type Seat = { taps: number };
type Action = { type: "tap" };
type Ids = { items: never; stats: "taps"; ranked: never; flags: never };

const sketch = "M120,80C10,20,30,40".padEnd(40, ".").repeat(250);

export default defineGame<GameState<Public, Seat, Record<string, never>>, Action, Record<string, never>, Ids>({
  setup({ players }) {
    return { public: { drawing: sketch, ticks: 0, taps: [] }, players: Object.fromEntries(players.map((player) => [player, { taps: 0 }])), secret: {} };
  },
  legalMoves() {
    return [{ type: "tap" }];
  },
  apply(state, _action, { player, profile }) {
    const seat = state.players[player];
    if (seat !== undefined) {
      seat.taps += 1;
    }
    state.public.taps.push(state.public.ticks);
    profile.stat(player, "taps", 1);
  },
  tick(state) {
    state.public.ticks += 1;
    state.public.drawing += `L${state.public.ticks % 360},${(state.public.ticks * 7) % 240}`.padEnd(40, ".");
  },
  result(state) {
    return state.public.ticks >= 1200 ? { winners: [] } : undefined;
  },
});

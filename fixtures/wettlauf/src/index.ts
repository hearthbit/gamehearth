import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

export const goal = 100;
export const limitTicks = 60 * 20;

export type RacePublic = {
  pos: Record<PlayerId, number>;
  running: Record<PlayerId, boolean>;
  ticks: number;
};
export type RaceState = GameState<RacePublic, { presses: number }, Record<string, never>>;
export type RaceAction = { type: "run" } | { type: "stop" };

function leaders(state: RaceState): PlayerId[] {
  const best = Math.max(...Object.values(state.public.pos));
  return Object.keys(state.public.pos).filter((player) => state.public.pos[player] === best);
}

export default defineGame<RaceState, RaceAction>({
  setup({ players }) {
    return {
      public: {
        pos: Object.fromEntries(players.map((player) => [player, 0])),
        running: Object.fromEntries(players.map((player) => [player, false])),
        ticks: 0,
      },
      players: Object.fromEntries(players.map((player) => [player, { presses: 0 }])),
      secret: {},
    };
  },

  legalMoves(state, player) {
    return state.public.running[player] === true ? [{ type: "stop" }] : [{ type: "run" }];
  },

  apply(state, action, { player }) {
    state.public.running[player] = action.type === "run";
    const own = state.players[player];
    if (own !== undefined && action.type === "run") {
      own.presses += 1;
    }
  },

  tick(state) {
    state.public.ticks += 1;
    for (const player of Object.keys(state.public.pos)) {
      if (state.public.running[player] === true) {
        state.public.pos[player] = Math.min(goal, (state.public.pos[player] ?? 0) + 1);
      }
    }
  },

  result(state) {
    const finished = Object.values(state.public.pos).some((pos) => pos >= goal);
    return finished || state.public.ticks >= limitTicks ? { winners: leaders(state) } : undefined;
  },
});

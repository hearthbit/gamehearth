import { defineGame, text, type GameState } from "@gamehearth/sdk";

export const inkChars = "0123456789abcdef";
export const maxNote = 30;
export const maxInk = 20_000;
export const limitTicks = 120 * 20;

export type PadPublic = { notes: { by: string; text: string }[]; ink: string; ticks: number; finished: boolean };
export type PadState = GameState<PadPublic, { written: number }, Record<string, never>>;
export type PadAction = { type: "note"; text: string } | { type: "ink"; points: string } | { type: "finish" };

export default defineGame<PadState, PadAction>({
  setup({ players }) {
    return {
      public: { notes: [], ink: "", ticks: 0, finished: false },
      players: Object.fromEntries(players.map((player) => [player, { written: 0 }])),
      secret: {},
    };
  },
  legalMoves(state) {
    if (state.public.finished) {
      return [];
    }
    return [
      { type: "note", text: text({ min: 1, max: maxNote }) },
      { type: "ink", points: text({ min: 1, max: 400, chars: inkChars }) },
      { type: "finish" },
    ];
  },
  apply(state, action, { player }) {
    if (action.type === "note") {
      state.public.notes.push({ by: player, text: action.text });
      if (state.public.notes.length > 20) {
        state.public.notes.shift();
      }
      const own = state.players[player];
      if (own !== undefined) {
        own.written += 1;
      }
    } else if (action.type === "ink") {
      state.public.ink = (state.public.ink + action.points).slice(0, maxInk);
    } else {
      state.public.finished = true;
    }
  },
  tick(state) {
    state.public.ticks += 1;
  },
  result(state) {
    return state.public.finished || state.public.ticks >= limitTicks ? { winners: [] } : undefined;
  },
});

import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

export interface Options {
  runden: 2 | 3 | 5;
  joker: boolean;
}

export const segments = [
  { id: "eins", points: 1, weight: 6 },
  { id: "drei", points: 3, weight: 3 },
  { id: "zehn", points: 10, weight: 1 },
] as const;

export type SegmentId = (typeof segments)[number]["id"];

export type WheelPublic = {
  current: PlayerId;
  round: number;
  lastRound: number;
  points: Record<PlayerId, number>;
  jokerUsed: Record<PlayerId, boolean>;
  last: { player: PlayerId; segment: SegmentId; points: number } | null;
};
export type WheelState = GameState<WheelPublic, Record<string, never>, Record<string, never>>;
export type WheelAction = { type: "spin" } | { type: "joker" };

export default defineGame<WheelState, WheelAction, Options>({
  setup({ players, options }) {
    return {
      public: {
        current: players[0] ?? "p1",
        round: 1,
        lastRound: options.runden,
        points: Object.fromEntries(players.map((player) => [player, 0])),
        jokerUsed: Object.fromEntries(players.map((player) => [player, false])),
        last: null,
      },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: {},
    };
  },

  legalMoves(state, player, { options }) {
    if (player !== state.public.current) {
      return [];
    }
    return options.joker && state.public.jokerUsed[player] !== true ? [{ type: "spin" }, { type: "joker" }] : [{ type: "spin" }];
  },

  apply(state, action, { player, players, random }) {
    const segment = random.weighted(segments);
    const points = action.type === "joker" ? segment.points * 2 : segment.points;
    state.public.points[player] = (state.public.points[player] ?? 0) + points;
    if (action.type === "joker") {
      state.public.jokerUsed[player] = true;
    }
    state.public.last = { player, segment: segment.id, points };
    const index = players.indexOf(player);
    const next = players[(index + 1) % players.length] ?? player;
    if (index === players.length - 1) {
      state.public.round += 1;
    }
    state.public.current = next;
  },

  result(state) {
    if (state.public.round <= state.public.lastRound) {
      return undefined;
    }
    const best = Math.max(...Object.values(state.public.points));
    return { winners: Object.keys(state.public.points).filter((player) => state.public.points[player] === best) };
  },
});

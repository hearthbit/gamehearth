import { defineGame, type CatalogOf, type GameState, type PlayerId } from "@gamehearth/sdk";
import manifest from "../manifest.json";

export type Ids = CatalogOf<typeof manifest>;

export interface Options {
  runden: 2 | 3 | 5;
}

export const preise = { lohn: 2, apfel: 3 } as const;

export type ShopPublic = {
  current: PlayerId;
  round: number;
  lastRound: number;
  points: Record<PlayerId, number>;
  last: { player: PlayerId; action: ShopAction["type"] } | null;
  startedAt: number | null;
};
export type ShopState = GameState<ShopPublic, Record<string, never>, Record<string, never>>;
export type ShopAction = { type: "arbeiten" } | { type: "kaufen" } | { type: "essen" };

export default defineGame<ShopState, ShopAction, Options, Ids>({
  setup({ players, options }) {
    return {
      public: {
        current: players[0] ?? "p1",
        round: 1,
        lastRound: options.runden,
        points: Object.fromEntries(players.map((player) => [player, 0])),
        last: null,
        startedAt: null,
      },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: {},
    };
  },

  legalMoves(state, player, { profiles }) {
    if (player !== state.public.current || state.public.round > state.public.lastRound) {
      return [];
    }
    const own = profiles[player];
    const moves: ShopAction[] = [{ type: "arbeiten" }];
    if ((own?.items.muenze ?? 0) >= preise.apfel) {
      moves.push({ type: "kaufen" });
    }
    if ((own?.items.apfel ?? 0) > 0) {
      moves.push({ type: "essen" });
    }
    return moves;
  },

  apply(state, action, { player, players, now, profile }) {
    state.public.startedAt ??= now;
    if (action.type === "arbeiten") {
      profile.add(player, "muenze", preise.lohn);
      state.public.points[player] = (state.public.points[player] ?? 0) + 1;
    } else if (action.type === "kaufen") {
      profile.use(player, "muenze", preise.apfel);
      profile.add(player, "apfel", 1);
    } else {
      profile.use(player, "apfel", 1);
      profile.flag(player, "gegessen", true);
      state.public.points[player] = (state.public.points[player] ?? 0) + 3;
    }
    state.public.last = { player, action: action.type };
    const index = players.indexOf(player);
    state.public.current = players[(index + 1) % players.length] ?? player;
    if (index === players.length - 1) {
      state.public.round += 1;
    }
    if (state.public.round <= state.public.lastRound) {
      return;
    }
    const best = Math.max(...Object.values(state.public.points));
    for (const seat of players) {
      const points = state.public.points[seat] ?? 0;
      profile.stat(seat, "partien", 1);
      profile.record(seat, "bestwert", points);
      if (points === best) {
        profile.stat(seat, "siege", 1);
        profile.record(seat, "kuerzeste", now - (state.public.startedAt ?? now));
        profile.flag(seat, "titel", "Ladenkönig");
      }
    }
  },

  result(state) {
    if (state.public.round <= state.public.lastRound) {
      return undefined;
    }
    const best = Math.max(...Object.values(state.public.points));
    return { winners: Object.keys(state.public.points).filter((player) => state.public.points[player] === best) };
  },
});

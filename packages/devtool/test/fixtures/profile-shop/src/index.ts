import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type Ids = { items: "muenze" | "trank"; stats: "siege" | "zuege"; ranked: "siege"; flags: "held" };
type State = GameState<{ current: PlayerId; turns: number; drunk: Record<PlayerId, number> }, Record<string, never>, null>;
type Action = { type: "arbeiten" } | { type: "kaufen" } | { type: "trinken" };

const maxTurns = 12;

export default defineGame<State, Action, Record<string, never>, Ids>({
  setup({ players }) {
    return {
      public: { current: players[0] ?? "p1", turns: 0, drunk: Object.fromEntries(players.map((player) => [player, 0])) },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: null,
    };
  },
  legalMoves(state, player, { profiles }) {
    if (player !== state.public.current || state.public.turns >= maxTurns) {
      return [];
    }
    const moves: Action[] = [{ type: "arbeiten" }];
    if ((profiles[player]?.items.muenze ?? 0) >= 3) {
      moves.push({ type: "kaufen" });
    }
    if ((profiles[player]?.items.trank ?? 0) > 0) {
      moves.push({ type: "trinken" });
    }
    return moves;
  },
  apply(state, action, { player, players, profile }) {
    if (action.type === "arbeiten") {
      profile.add(player, "muenze", 2);
    } else if (action.type === "kaufen") {
      profile.use(player, "muenze", 3);
      profile.add(player, "trank", 1);
    } else {
      profile.use(player, "trank", 1);
      profile.stat(player, "zuege", 1);
      profile.flag(player, "held", true);
      state.public.drunk[player] = (state.public.drunk[player] ?? 0) + 1;
    }
    state.public.turns += 1;
    state.public.current = players[(players.indexOf(player) + 1) % players.length] ?? player;
    if (state.public.turns >= maxTurns) {
      const best = Math.max(...Object.values(state.public.drunk));
      for (const seat of players) {
        if (best > 0 && state.public.drunk[seat] === best) {
          profile.stat(seat, "siege", 1);
        }
      }
    }
  },
  result(state) {
    if (state.public.turns < maxTurns) {
      return undefined;
    }
    const best = Math.max(...Object.values(state.public.drunk));
    return { winners: best === 0 ? [] : Object.keys(state.public.drunk).filter((seat) => state.public.drunk[seat] === best) };
  },
});

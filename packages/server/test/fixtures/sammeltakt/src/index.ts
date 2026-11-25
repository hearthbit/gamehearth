import { defineGame, type GameState } from "@gamehearth/sdk";

type Ids = { items: "stern"; stats: "takte" | "rekord"; ranked: "rekord"; flags: never };
type Public = { ticks: number; sterne: number };
type Action = { type: "sammle" } | { type: "tausche" };

export default defineGame<GameState<Public, Record<string, never>, Record<string, never>>, Action, Record<string, never>, Ids>({
  setup({ players }) {
    return { public: { ticks: 0, sterne: 0 }, players: Object.fromEntries(players.map((player) => [player, {}])), secret: {} };
  },
  legalMoves(state, player, { profiles }) {
    return (profiles[player]?.items.stern ?? 0) > 0 ? [{ type: "sammle" }, { type: "tausche" }] : [{ type: "sammle" }];
  },
  apply(state, action, { player, profile }) {
    if (action.type === "sammle") {
      profile.add(player, "stern", 1);
      state.public.sterne += 1;
    } else {
      profile.use(player, "stern", 1);
    }
  },
  tick(state, _dt, { players, profile }) {
    state.public.ticks += 1;
    if (state.public.ticks % 10 === 0) {
      for (const player of players) {
        profile.stat(player, "takte", 10);
      }
    }
    if (state.public.ticks >= 30) {
      for (const player of players) {
        profile.record(player, "rekord", state.public.sterne);
      }
    }
  },
  result(state) {
    return state.public.ticks >= 30 ? { winners: [] } : undefined;
  },
});

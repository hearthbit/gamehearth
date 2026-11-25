import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type Public = { current: PlayerId };
type Secret = { top: string };
type Action = { type: "aufdecken" };

export default defineGame<GameState<Public, { hand: string }, Secret>, Action>({
  setup({ players, random }) {
    return {
      public: { current: players[0] ?? "p1" },
      players: Object.fromEntries(players.map((player) => [player, { hand: "herz-dame" }])),
      secret: { top: random.pick(["pik-zehn-geheim", "kreuz-bube-geheim"]) },
    };
  },
  legalMoves(state, player) {
    return player === state.public.current ? [{ type: "aufdecken" }] : [];
  },
  apply(state) {
    const tables = {} as Record<string, Record<string, string>>;
    const table = tables["karten"];
    if (table === undefined) {
      throw new Error(`Keine Kartentabelle für ${state.secret.top}`);
    }
    state.public.current = table[state.secret.top] ?? "p1";
  },
  result: () => undefined,
});

import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type Public = { current: PlayerId; count: number; last: PlayerId | null };
type Action = { type: "add"; amount: number } | { type: "double" };

export const game = defineGame<GameState<Public, Record<string, never>, Record<string, never>>, Action>({
  setup({ players }) {
    return { public: { current: players[0]!, count: 1, last: null }, players: Object.fromEntries(players.map((p) => [p, {}])), secret: {} };
  },
  legalMoves(state, player) {
    return player === state.public.current ? [{ type: "add", amount: 1 }, { type: "double" }] : [];
  },
  apply(state, action, { player, players }) {
    switch (action.type) {
      case "add":
        state.public.count += action.amount;
        state.public.last = player;
        state.public.current = players[(players.indexOf(player) + 1) % players.length]!;
        break;
    }
  },
  result(state) {
    return state.public.count >= 10 && state.public.last !== null ? { winners: [state.public.last] } : undefined;
  },
});

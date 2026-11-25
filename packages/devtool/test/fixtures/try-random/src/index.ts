import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type Public = { current: PlayerId; count: number; last: number };
type Action = { type: "roll" };

function roll(): number {
  try {
    return 1 + Math.floor(Math.random() * 6);
  } catch {
    return 1;
  }
}

export default defineGame<GameState<Public, Record<string, never>, Record<string, never>>, Action>({
  setup({ players }) {
    return {
      public: { current: players[0]!, count: 0, last: 0 },
      players: Object.fromEntries(players.map((p) => [p, {}])),
      secret: {},
    };
  },
  legalMoves(state, player) {
    return player === state.public.current ? [{ type: "roll" }] : [];
  },
  apply(state, _action, { player, players }) {
    state.public.last = roll();
    state.public.count += state.public.last;
    state.public.current = players[(players.indexOf(player) + 1) % players.length]!;
  },
  result(state) {
    return state.public.count >= 20 ? { winners: [state.public.current] } : undefined;
  },
});

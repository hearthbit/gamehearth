import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type Public = { round: number; current: PlayerId; value: number };

export default defineGame<GameState<Public, Record<string, never>, Record<string, never>>, { type: "weiter" }>({
  setup({ players }) {
    return {
      public: { round: 0, current: players[0] ?? "p1", value: 0 },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: {},
    };
  },
  legalMoves(state, player) {
    return player === state.public.current ? [{ type: "weiter" }] : [];
  },
  apply(state, _action, { random, players, player }) {
    for (let i = 0; i < 8; i++) {
      state.public.value += Math.hypot(random.next() * 10, random.next() * 10) + Math.tanh(random.next());
    }
    state.public.round += 1;
    state.public.current = players[(players.indexOf(player) + 1) % players.length] ?? player;
  },
  result(state) {
    return state.public.round >= 10 ? { winners: [state.public.current] } : undefined;
  },
});

import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type State = GameState<{ order: PlayerId[]; turn: number }, Record<string, never>, Record<string, never>>;
type Action = { type: "weiter" };

export default defineGame<State, Action>({
  setup({ players, random }) {
    const order = players.length > 1 ? random.shuffle(players) : [...players];
    return { public: { order, turn: 0 }, players: Object.fromEntries(players.map((player) => [player, {}])), secret: {} };
  },
  legalMoves(state, player) {
    return state.public.order[state.public.turn % state.public.order.length] === player ? [{ type: "weiter" }] : [];
  },
  apply(state) {
    state.public.turn += 1;
  },
  result(state) {
    return state.public.turn >= 4 ? { winners: [state.public.order[0] ?? "p1"] } : undefined;
  },
});

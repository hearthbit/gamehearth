import { defineGame, type GameState, type PlayerId, type Random } from "@gamehearth/sdk";

type Public = { current: PlayerId; count: number; pile: number };
type Mine = { hand: number[] };
type Secret = { deck: number[] };
type Action = { type: "take" } | { type: "pass" };

let seats: PlayerId[] = [];
let rng: Random | undefined;

export default defineGame<GameState<Public, Mine, Secret>, Action>({
  setup({ players, random }) {
    seats = [...players];
    rng = random;
    const deck = random.shuffle(Array.from({ length: 20 }, (_, i) => i));
    return {
      public: { current: players[0]!, count: 0, pile: 0 },
      players: Object.fromEntries(players.map((p) => [p, { hand: [] }])),
      secret: { deck },
    };
  },
  legalMoves(state, player) {
    return player === state.public.current ? [{ type: "take" }, { type: "pass" }] : [];
  },
  apply(state, action, { player }) {
    if (action.type === "take") {
      if (state.secret.deck.length === 0) {
        state.secret.deck = rng!.shuffle(Array.from({ length: 20 }, (_, i) => i));
      }
      state.players[player]!.hand.push(state.secret.deck.pop()!);
    }
    state.public.count += 1;
    state.public.current = seats[(seats.indexOf(player) + 1) % seats.length]!;
  },
  result(state) {
    return state.public.count >= 60 ? { winners: [state.public.current] } : undefined;
  },
});

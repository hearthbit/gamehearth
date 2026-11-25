import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type Public = { revealed: Record<PlayerId, number> };
type PerPlayer = { card: number };
type Secret = { deck: number[] };
type Action = { type: "reveal" };

export default defineGame<GameState<Public, PerPlayer, Secret>, Action>({
  setup({ players, random }) {
    const deck = random.shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const hands: Record<PlayerId, PerPlayer> = {};
    for (const player of players) {
      hands[player] = { card: deck.pop() ?? 0 };
    }
    return { public: { revealed: {} }, players: hands, secret: { deck } };
  },

  legalMoves(state, player) {
    return Object.hasOwn(state.public.revealed, player) ? [] : [{ type: "reveal" }];
  },

  apply(state, action, { player }) {
    state.public.revealed[player] = state.players[player]!.card;
  },

  result(state) {
    const revealed = Object.entries(state.public.revealed);
    if (revealed.length < Object.keys(state.players).length) {
      return undefined;
    }
    const best = Math.max(...revealed.map(([, card]) => card));
    return { winners: revealed.filter(([, card]) => card === best).map(([player]) => player) };
  },
});

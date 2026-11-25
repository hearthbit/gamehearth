import { defineGame, type GameState, type PlayerId } from "../../src/platform";

type Public = { revealed: Record<PlayerId, number> };
type PerPlayer = { card: number };
type Secret = { deck: number[] };
export type HighCardAction = { type: "reveal" };

export type HighCardState = GameState<Public, PerPlayer, Secret>;

export const highCard = defineGame<HighCardState, HighCardAction>({
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

  apply(state, _action, { player }) {
    state.public.revealed[player] = state.players[player]?.card ?? 0;
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

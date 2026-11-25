import { countingGame } from "./counting";

export default countingGame({
  bot(state, _player, moves) {
    const best = state.public.count >= 8 ? moves.find((move) => move.amount === 2) : undefined;
    return best ?? moves[moves.length - 1];
  },
});

import { countingGame } from "./counting";

export default countingGame({
  bot(state, _player, moves) {
    let at = 0;
    while (state.public.count >= 0) {
      at = (at + 1) % moves.length;
    }
    return moves[at];
  },
});

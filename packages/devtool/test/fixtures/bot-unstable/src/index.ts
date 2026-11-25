import { countingGame } from "./counting";

let calls = 0;

export default countingGame({
  bot(_state, _player, moves) {
    calls += 1;
    return calls <= 3 ? moves[0] : moves[moves.length - 1];
  },
});

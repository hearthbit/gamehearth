import { countingGame } from "./counting";

export default countingGame({
  bot(_state, _player, moves) {
    const first = ["Zebra", "Äpfel"].sort((a, b) => a.localeCompare(b))[0];
    return first === "Äpfel" ? moves[0] : moves[moves.length - 1];
  },
});

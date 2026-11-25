import { countingGame } from "./counting";

export default countingGame({
  legalMoves(state, player) {
    if (Object.keys(state.players).length === 3 && state.public.count >= 4) {
      throw new Error("With three players the rule for the fourth move is missing");
    }
    return player === state.public.current ? [{ type: "add", amount: 1 }] : [];
  },
});

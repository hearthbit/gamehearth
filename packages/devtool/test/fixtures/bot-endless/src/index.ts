import { countingGame, type CountingAction } from "./counting";

export default countingGame({
  legalMoves(state, player) {
    return player === state.public.current
      ? ([
          { type: "add", amount: 0 },
          { type: "add", amount: 1 },
          { type: "add", amount: 2 },
        ] as CountingAction[])
      : [];
  },
  bot(_state, _player, moves) {
    return moves.find((move) => move.amount === 0);
  },
});

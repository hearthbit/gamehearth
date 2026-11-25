import { dotsGame } from "./dots";

export default dotsGame({
  result(state) {
    return state.public.ticks >= 60 && Object.values(state.public.dir).some((dir) => dir === -1) ? { winners: [] } : undefined;
  },
  bot(state, player, moves) {
    return state.public.dir[player] === 1 ? undefined : moves.find((move) => move.dir === 1);
  },
});

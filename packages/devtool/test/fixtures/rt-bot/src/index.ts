import { dotsGame } from "./dots";

export default dotsGame({
  bot(state, player, moves) {
    const wanted = state.public.ticks % 20 < 10 ? 1 : -1;
    return state.public.dir[player] === wanted ? undefined : moves.find((move) => move.dir === wanted);
  },
});

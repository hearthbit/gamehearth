import { countingGame } from "./counting";

const base = countingGame();

export default countingGame({
  apply(state, action, ctx) {
    while (state.public.count >= 4) {
      state.public.last = ctx.player;
    }
    base.apply(state, action, ctx);
  },
});

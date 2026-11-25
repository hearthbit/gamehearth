import { countingGame } from "./counting";

const base = countingGame();

export default countingGame({
  apply(state, action, ctx) {
    if (new Date(ctx.now).getHours() > 30) {
      state.public.count += 0;
    }
    base.apply(state, action, ctx);
  },
});

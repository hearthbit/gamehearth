import { countingGame } from "./counting";

const base = countingGame();

export default countingGame({
  apply(state, action, ctx) {
    if (Date.now() % 2 === 0) {
      state.public.count += 0;
    }
    base.apply(state, action, ctx);
  },
});

import { countingGame } from "./counting";

const base = countingGame();

export default countingGame({
  apply(state, action, ctx) {
    const RealDate = new Date(0).constructor as DateConstructor;
    if (RealDate.now() % 2 === 0) {
      state.public.count += 0;
    }
    base.apply(state, action, ctx);
  },
});

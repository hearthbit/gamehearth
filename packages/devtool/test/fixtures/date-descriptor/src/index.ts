import { countingGame } from "./counting";

const base = countingGame();

export default countingGame({
  apply(state, action, ctx) {
    const now = Object.getOwnPropertyDescriptor(Date, "now")?.value as () => number;
    if (now() % 2 === 0) {
      state.public.count += 0;
    }
    base.apply(state, action, ctx);
  },
});

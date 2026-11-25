import { countingGame } from "./counting";

const base = countingGame();

function depth(n: number): number {
  return n === 0 ? 0 : depth(n - 1) + 1;
}

export default countingGame({
  apply(state, action, ctx) {
    state.public.count += depth(1000) - 1000;
    base.apply(state, action, ctx);
  },
});

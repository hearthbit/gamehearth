import { countingGame } from "./counting";

const base = countingGame();

export default countingGame({
  apply(state, action, ctx) {
    const before = structuredClone(state.public);
    base.apply(state, action, ctx);
    state.public.last = before.last === null ? ctx.player : state.public.last;
  },
});

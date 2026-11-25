import { dotsGame } from "./dots";

let sink = 0;

export default dotsGame({
  tick(state) {
    state.public.ticks += 1;
    let sum = 0;
    for (let i = 0; i < 800_000; i++) {
      sum += i % 7;
    }
    sink = sum;
    if (sink < 0) {
      state.public.ticks = 0;
    }
  },
  result: (state) => (state.public.ticks >= 15 ? { winners: [] } : undefined),
});

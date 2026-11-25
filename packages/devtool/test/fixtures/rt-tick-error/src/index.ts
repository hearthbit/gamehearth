import { dotsGame } from "./dots";

export default dotsGame({
  tick(state) {
    state.public.ticks += 1;
    if (state.public.ticks === 30) {
      throw new Error("wall at tick 30");
    }
  },
});

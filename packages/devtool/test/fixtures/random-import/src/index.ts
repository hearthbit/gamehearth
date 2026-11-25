import { countingGame } from "./counting";

const salt = Math.random();

export default countingGame({
  result: (state) => (state.public.count >= 10 + salt ? { winners: [] } : undefined),
});

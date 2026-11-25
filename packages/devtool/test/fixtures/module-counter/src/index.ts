import { countingGame } from "./counting";

let calls = 0;

export default countingGame({
  apply(state, action, { player, players }) {
    calls += 1;
    state.public.count += calls % 7 === 0 ? 2 : action.amount;
    state.public.last = player;
    state.public.current = players[(players.indexOf(player) + 1) % players.length] ?? player;
  },
});

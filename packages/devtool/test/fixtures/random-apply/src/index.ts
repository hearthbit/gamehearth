import { countingGame } from "./counting";

export default countingGame({
  apply(state, action, { player, players }) {
    state.public.count += action.amount + (Math.random() < 0.5 ? 0 : 1);
    state.public.last = player;
    state.public.current = players[(players.indexOf(player) + 1) % players.length] ?? player;
  },
});

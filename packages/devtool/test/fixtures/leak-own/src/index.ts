import { cardsGame } from "./cards";

const base = cardsGame();

export default cardsGame({
  setup(ctx) {
    const state = base.setup(ctx);
    ctx.players.forEach((player, index) => {
      const neighbour = ctx.players[(index + 1) % ctx.players.length] ?? player;
      const own = state.players[player];
      if (own !== undefined) {
        own.peek = state.players[neighbour]?.hand[0] ?? null;
      }
    });
    return state;
  },
});

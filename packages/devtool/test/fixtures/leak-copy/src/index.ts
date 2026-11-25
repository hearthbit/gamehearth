import { cardsGame } from "./cards";

const base = cardsGame();

export default cardsGame({
  apply(state, action, ctx) {
    base.apply(state, action, ctx);
    state.public.next = state.secret.deck.at(-1) ?? null;
  },
});

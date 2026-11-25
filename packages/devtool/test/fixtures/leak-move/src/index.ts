import { cardsGame } from "./cards";

export default cardsGame({
  legalMoves(state, player) {
    const top = state.secret.deck.at(-1);
    return player === state.public.current && top !== undefined ? [{ type: "draw", card: top }, { type: "keep" }] : player === state.public.current ? [{ type: "keep" }] : [];
  },
});

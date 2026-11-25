import { dotsGame, type DotsAction } from "./dots";

export default dotsGame({
  bot(state, player) {
    if (player === "p1") {
      return { type: "dir", dir: 5 } as unknown as DotsAction;
    }
    if (state.public.ticks > 20) {
      throw new Error(`no idea what ${player} should do`);
    }
    return undefined;
  },
});

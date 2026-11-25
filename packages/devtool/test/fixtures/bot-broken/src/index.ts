import { countingGame, type CountingAction } from "./counting";

export default countingGame({
  bot(state, player, moves, ctx) {
    if (player === "p1") {
      throw new Error("the bot is confused");
    }
    if (player === "p2") {
      return { type: "add", amount: 3 } as CountingAction;
    }
    if (player === "p3") {
      state.public.count = 99;
      return moves[0];
    }
    (ctx as unknown as { profile: { add(seat: string, id: string, value: number): void } }).profile.add(player, "coin", 1);
    return moves[0];
  },
});

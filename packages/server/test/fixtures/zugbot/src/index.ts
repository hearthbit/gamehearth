import { defineGame, type GameState } from "@gamehearth/sdk";

type Public = { turn: number; total: number; log: string[] };
type Action = { type: "pick"; n: number };
interface Options {
  bot: "gut" | "kaputt" | "falsch" | "absturz";
}

export default defineGame<GameState<Public, Record<string, never>, Record<string, never>>, Action, Options>({
  setup({ players }) {
    return { public: { turn: 0, total: 0, log: [] }, players: Object.fromEntries(players.map((player) => [player, {}])), secret: {} };
  },
  legalMoves(state, player) {
    const seats = Object.keys(state.players);
    return seats[state.public.turn % seats.length] === player ? [1, 2, 3].map((n) => ({ type: "pick" as const, n })) : [];
  },
  apply(state, action, { player, options }) {
    if (options.bot === "absturz" && action.n === 3 && state.public.turn === 2) {
      throw new Error("3 is broken on turn 2");
    }
    state.public.total += action.n;
    state.public.log.push(`${player}:${action.n}`);
    state.public.turn += 1;
  },
  bot(_state, _player, moves, { options }) {
    if (options.bot === "kaputt") {
      throw new Error("bot kaputt");
    }
    if (options.bot === "falsch") {
      return { type: "pick", n: 9 };
    }
    return moves.at(-1);
  },
  result(state) {
    return state.public.total >= 20 ? { winners: [] } : undefined;
  },
});

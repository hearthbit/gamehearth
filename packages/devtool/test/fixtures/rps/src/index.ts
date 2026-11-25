import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";
type Choice = "rock" | "paper" | "scissors";
type Public = { round: number; revealed: Record<PlayerId, Choice>; score: Record<PlayerId, number> };
type Mine = { choice: Choice | null };
type Action = { type: "choose"; choice: Choice };
const choices: Choice[] = ["rock", "paper", "scissors"];
const beats: Record<Choice, Choice> = { rock: "scissors", paper: "rock", scissors: "paper" };
export default defineGame<GameState<Public, Mine, Record<string, never>>, Action>({
  setup({ players }) {
    return {
      public: { round: 0, revealed: {}, score: Object.fromEntries(players.map((p) => [p, 0])) },
      players: Object.fromEntries(players.map((p) => [p, { choice: null }])),
      secret: {},
    };
  },
  legalMoves(state, player) {
    return state.players[player]?.choice === null ? choices.map((choice) => ({ type: "choose" as const, choice })) : [];
  },
  apply(state, action, { player, players }) {
    state.players[player]!.choice = action.choice;
    if (players.every((p) => state.players[p]!.choice !== null)) {
      state.public.revealed = {};
      for (const p of players) state.public.revealed[p] = state.players[p]!.choice!;
      for (const p of players) {
        const mine = state.players[p]!.choice!;
        if (players.some((o) => o !== p && beats[mine] === state.players[o]!.choice)) state.public.score[p]! += 1;
      }
      for (const p of players) state.players[p]!.choice = null;
      state.public.round += 1;
    }
  },
  result(state) {
    if (state.public.round < 3) return undefined;
    const best = Math.max(...Object.values(state.public.score));
    return { winners: Object.keys(state.public.score).filter((p) => state.public.score[p] === best) };
  },
});

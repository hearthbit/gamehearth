import { defineGame, type GameState } from "@gamehearth/sdk";

export default defineGame<GameState<Record<string, never>, Record<string, never>, Record<string, never>>, { type: "nix" }>({
  setup() {
    throw new Error("Startfehler im Spiel");
  },
  legalMoves: () => [],
  apply: () => undefined,
  result: () => undefined,
});

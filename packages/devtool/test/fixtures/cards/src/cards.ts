import { defineGame, type GameDefinition, type GameState, type PlayerId } from "@gamehearth/sdk";

export type CardsState = GameState<
  { current: PlayerId; turns: number; next: string | null },
  { hand: string[]; peek: string | null },
  { deck: string[] }
>;
export type CardsAction = { type: "draw"; card?: string } | { type: "keep" };

export const rounds = 3;

export function cardsGame(overrides: Partial<GameDefinition<CardsState, CardsAction>> = {}) {
  return defineGame<CardsState, CardsAction>({
    setup({ players, random }) {
      const deck = random.shuffle(Array.from({ length: 30 }, (_, index) => `karte-${String(index + 1).padStart(2, "0")}`));
      return {
        public: { current: players[0] ?? "p1", turns: 0, next: null },
        players: Object.fromEntries(players.map((player) => [player, { hand: [deck.pop() ?? "leer"], peek: null }])),
        secret: { deck },
      };
    },
    legalMoves(state, player) {
      return player === state.public.current ? [{ type: "draw" }, { type: "keep" }] : [];
    },
    apply(state, action, { player, players }) {
      if (action.type === "draw") {
        const card = state.secret.deck.pop();
        if (card !== undefined) {
          state.players[player]?.hand.push(card);
        }
      }
      state.public.turns += 1;
      state.public.current = players[(players.indexOf(player) + 1) % players.length] ?? player;
    },
    result(state) {
      const seats = Object.keys(state.players);
      if (state.public.turns < rounds * seats.length) {
        return undefined;
      }
      const best = (player: string) => [...(state.players[player]?.hand ?? [])].sort().at(-1) ?? "";
      const top = seats.map(best).sort().at(-1);
      return { winners: seats.filter((player) => best(player) === top) };
    },
    ...overrides,
  });
}

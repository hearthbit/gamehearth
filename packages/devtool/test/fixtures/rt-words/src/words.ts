import { defineGame, int, text, type GameState } from "@gamehearth/sdk";

export type WordsState = GameState<{ feed: string[]; dots: string; ticks: number }, { chat: string[] }, Record<string, never>>;
export type WordsAction = { type: "say"; text: string } | { type: "dot"; x: number; pts: string };

export function wordsGame(options: { strict?: boolean } = {}) {
  return defineGame<WordsState, WordsAction>({
    setup({ players }) {
      return {
        public: { feed: [], dots: "", ticks: 0 },
        players: Object.fromEntries(players.map((player) => [player, { chat: [] as string[] }])),
        secret: {},
      };
    },
    legalMoves() {
      return [
        { type: "say", text: text({ min: 1, max: 20 }) },
        { type: "dot", x: int({ min: 0, max: 9 }), pts: text({ max: 6, chars: "0123456789" }) },
      ];
    },
    apply(state, action) {
      if (action.type === "say") {
        if (options.strict === true && /[^a-z ]/i.test(action.text)) {
          throw new Error(`unexpected character in ${JSON.stringify(action.text)}`);
        }
        if ([...action.text].length % 2 === 0) {
          for (const area of Object.values(state.players)) {
            area.chat.push(action.text);
          }
        } else {
          state.public.feed.push(action.text);
        }
      } else {
        state.public.dots += `${action.x}${action.pts}`;
      }
    },
    tick(state) {
      state.public.ticks += 1;
    },
    result(state) {
      return state.public.ticks >= 60 ? { winners: [] } : undefined;
    },
  });
}

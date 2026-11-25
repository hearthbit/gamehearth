import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

const suspects = ["Gatow", "Porz", "Weiss", "Gloria", "Bloom", "Orchidee"];
const weapons = ["Seil", "Dolch", "Rohr", "Leuchter", "Pistole", "Gift"];

type Public = { current: PlayerId; turns: number; out: PlayerId[] };
type Mine = { cards: string[] };
type Secret = { suspect: string; weapon: string };
type Action = { type: "accuse"; suspect: string; weapon: string } | { type: "pass" };

export default defineGame<GameState<Public, Mine, Secret>, Action>({
  setup({ players, random }) {
    const s = random.shuffle(suspects);
    const w = random.shuffle(weapons);
    const rest = random.shuffle([...s.slice(1), ...w.slice(1)]);
    const hands: Record<PlayerId, Mine> = Object.fromEntries(players.map((p) => [p, { cards: [] as string[] }]));
    rest.forEach((card, i) => hands[players[i % players.length]!]!.cards.push(card));
    return { public: { current: players[0]!, turns: 0, out: [] }, players: hands, secret: { suspect: s[0]!, weapon: w[0]! } };
  },
  legalMoves(state, player) {
    if (player !== state.public.current) return [];
    return [
      ...suspects.flatMap((suspect) => weapons.map((weapon) => ({ type: "accuse" as const, suspect, weapon }))),
      { type: "pass" as const },
    ];
  },
  apply(state, action, { player, players }) {
    if (action.type === "accuse" && (action.suspect !== state.secret.suspect || action.weapon !== state.secret.weapon)) {
      state.public.out.push(player);
    }
    if (action.type === "accuse" && !state.public.out.includes(player)) state.public.out = players.filter((p) => p !== player);
    state.public.turns += 1;
    state.public.current = players[(players.indexOf(player) + 1) % players.length]!;
  },
  result(state) {
    const seats = Object.keys(state.players);
    if (state.public.out.length >= seats.length - 1 || state.public.turns >= 30) {
      return { winners: seats.filter((p) => !state.public.out.includes(p)) };
    }
    return undefined;
  },
});

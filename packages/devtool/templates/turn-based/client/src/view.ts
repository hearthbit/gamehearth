import type { PlayerId, PlayerInfo, PlayerSnapshot, Profile, SoundName } from "@gamehearth/sdk/client";
import { cardValue, type DuelAction, type Hand, type Ids, type Options, type Public } from "../../src/index";
import type { Texts } from "./texts";

export type Snapshot = PlayerSnapshot<Public, Hand, DuelAction>;
export type Players = Record<PlayerId, PlayerInfo>;
export type OwnProfile = Profile<Ids>;

export function jokerCount(profile: OwnProfile): number {
  return profile.items.joker ?? 0;
}

export function profileLine(t: Texts, profile: OwnProfile): string {
  return t.profile(jokerCount(profile), profile.stats.wins ?? 0);
}

export function canUseJoker(snapshot: Snapshot): boolean {
  return snapshot.moves.some((move) => move.joker === true);
}

export function nameOf(t: Texts, seat: PlayerId, players: Players): string {
  const info = players[seat];
  if (info === undefined) {
    return seat;
  }
  return info.you ? t.you : info.name;
}

export function opponents(snapshot: Snapshot): PlayerId[] {
  const seats = snapshot.players;
  const own = seats.indexOf(snapshot.player);
  return [...seats.slice(own + 1), ...seats.slice(0, own)];
}

export function joinNames(t: Texts, names: readonly string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} ${t.and} ${names.at(-1)}`;
}

export function statusLine(t: Texts, snapshot: Snapshot, players: Players, options: Options): string {
  if (snapshot.result !== undefined) {
    const winners = snapshot.result.winners;
    if (winners.length === 1 && winners[0] === snapshot.player) {
      return t.youWin;
    }
    if (winners.length === 1) {
      return t.wins(nameOf(t, winners[0] as PlayerId, players));
    }
    return t.tie(joinNames(t, winners.map((seat) => nameOf(t, seat, players))));
  }
  const round = t.round(snapshot.public.round, options.rounds);
  if (snapshot.moves.length > 0) {
    return `${round}: ${t.chooseCard}`;
  }
  const waiting = joinNames(t, snapshot.players.filter((seat) => !snapshot.public.played[seat]).map((seat) => nameOf(t, seat, players)));
  if (snapshot.me.chosen !== null) {
    return `${round}: ${t.youPlayed(snapshot.me.chosen, waiting)}`;
  }
  return `${round}: ${t.waitingFor(waiting)}`;
}

export function revealLine(t: Texts, snapshot: Snapshot, players: Players): string {
  const reveal = snapshot.public.lastReveal;
  if (reveal === null) {
    return t.intro;
  }
  const cards = snapshot.players
    .map((seat) => {
      const name = nameOf(t, seat, players);
      const card = reveal.cards[seat];
      if (card === undefined) {
        return `${name} ?`;
      }
      return reveal.jokers.includes(seat) ? t.cardWithJoker(name, card, cardValue(card, true)) : `${name} ${card}`;
    })
    .join(", ");
  const winners = joinNames(t, reveal.winners.map((seat) => (seat === snapshot.player ? t.youAsObject : nameOf(t, seat, players))));
  return t.revealed(cards, winners);
}

export function scoreLine(t: Texts, seat: PlayerId, snapshot: Snapshot): string {
  return t.points(snapshot.public.scores[seat] ?? 0);
}

export function seatState(t: Texts, seat: PlayerId, snapshot: Snapshot): string {
  if (snapshot.result !== undefined) {
    return "";
  }
  return snapshot.public.played[seat] ? t.hasPlayed : t.thinking;
}

export function sortedHand(snapshot: Snapshot): number[] {
  return [...snapshot.me.cards].sort((a, b) => a - b);
}

export function playable(snapshot: Snapshot): Set<number> {
  return new Set(snapshot.moves.map((move) => move.card));
}

export function moveFor(snapshot: Snapshot, card: number, joker = false): DuelAction | undefined {
  return snapshot.moves.find((move) => move.card === card && (move.joker === true) === joker);
}

export function rowPositions(count: number, width: number, itemWidth: number, gap: number): number[] {
  if (count === 0) {
    return [];
  }
  const step = Math.min(itemWidth + gap, (width - itemWidth) / Math.max(count - 1, 1));
  const total = step * (count - 1);
  const start = width / 2 - total / 2;
  return Array.from({ length: count }, (_, index) => start + index * step);
}

export function soundFor(previous: Snapshot | undefined, next: Snapshot): SoundName | undefined {
  if (previous === undefined) {
    return undefined;
  }
  if (previous.result === undefined && next.result !== undefined) {
    return next.result.winners.includes(next.player) ? "win" : "lose";
  }
  const reveal = next.public.lastReveal;
  if (reveal !== null && JSON.stringify(reveal) !== JSON.stringify(previous.public.lastReveal)) {
    return reveal.winners.includes(next.player) ? "coin" : "pop";
  }
  if (previous.me.chosen === null && next.me.chosen !== null) {
    return "select";
  }
  return undefined;
}

export function describeMove(t: Texts, move: DuelAction): string {
  return move.joker === true ? t.playCardWithJoker(move.card) : t.playCard(move.card);
}

export function describeTable(t: Texts, snapshot: Snapshot, players: Players): string {
  const scores = snapshot.players.map((seat) => `${nameOf(t, seat, players)}: ${scoreLine(t, seat, snapshot)}`).join(", ");
  const hand = sortedHand(snapshot).join(", ");
  return t.table(revealLine(t, snapshot, players), scores, hand === "" ? t.none : hand);
}

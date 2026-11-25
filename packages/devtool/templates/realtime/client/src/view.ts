import type { PlayerInfo, PlayerSnapshot, ScreenSnapshot, SoundName } from "@gamehearth/sdk/client";
import type { Direction, Point, Public, TagAction } from "../../src/index";
import type { Texts } from "./texts";

export type Snapshot = PlayerSnapshot<Public, Record<string, never>, TagAction>;
export type Screen = ScreenSnapshot<Public>;

export const seatColors = [0xf2b84b, 0x5fb3e8, 0x8bcf6a, 0xe8738f, 0xb48ef0, 0xf09a5b];

export function seatColor(seat: string): number {
  return seatColors[(Number(seat.slice(1)) - 1) % seatColors.length] ?? 0xffffff;
}

export function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function nameOf(seat: string, players: Record<string, PlayerInfo>): string {
  return players[seat]?.name ?? seat;
}

export function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

export function blendPositions(from: Public, to: Public, alpha: number): Record<string, Point> {
  const result: Record<string, Point> = {};
  for (const [seat, target] of Object.entries(to.pos)) {
    const start = from.pos[seat] ?? target;
    const jump = Math.abs(target.x - start.x) + Math.abs(target.y - start.y) > 60;
    result[seat] = jump ? target : { x: lerp(start.x, target.x, alpha), y: lerp(start.y, target.y, alpha) };
  }
  return result;
}

export interface Fit {
  scale: number;
  left: number;
  top: number;
}

export function fitField(fieldWidth: number, fieldHeight: number, width: number, height: number, margin: number): Fit {
  const scale = Math.max(0.01, Math.min((width - 2 * margin) / fieldWidth, (height - 2 * margin) / fieldHeight));
  return { scale, left: (width - fieldWidth * scale) / 2, top: (height - fieldHeight * scale) / 2 };
}

export function clock(ticksLeft: number): string {
  const seconds = Math.max(0, Math.ceil(ticksLeft / 20));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ranking(t: Texts, view: Public, players: Record<string, PlayerInfo>): { seat: string; name: string; time: string }[] {
  return Object.entries(view.caught)
    .sort(([seatA, a], [seatB, b]) => a - b || (seatA < seatB ? -1 : 1))
    .map(([seat, ticks]) => ({ seat, name: nameOf(seat, players), time: t.seconds(ticks / 20) }));
}

export function resultLine(t: Texts, winners: readonly string[], players: Record<string, PlayerInfo>): string {
  if (winners.length === 0) {
    return t.nobodyWins;
  }
  const names = winners.map((seat) => nameOf(seat, players));
  return names.length === 1 ? t.wins(names[0] as string) : t.tie(names.join(", "));
}

export function controllerLine(t: Texts, snapshot: Snapshot, players: Record<string, PlayerInfo>): string {
  if (snapshot.result !== undefined) {
    return resultLine(t, snapshot.result.winners, players);
  }
  const view = snapshot.public;
  if (view.catcher === snapshot.player) {
    return view.frozen > 0 ? t.youCatchSoon : t.youCatch;
  }
  return t.runFrom(nameOf(view.catcher, players));
}

export const countdownSeconds = 5;

export function screenSound(previous: Screen | undefined, next: Screen): SoundName | undefined {
  if (previous === undefined) {
    return undefined;
  }
  if (previous.result === undefined && next.result !== undefined) {
    return "win";
  }
  if (previous.tick === 0 && (next.tick ?? 0) > 0) {
    return "start";
  }
  if (previous.public.catcher !== next.public.catcher) {
    return "hit";
  }
  const before = Math.ceil(previous.public.ticksLeft / 20);
  const now = Math.ceil(next.public.ticksLeft / 20);
  return now < before && now > 0 && now <= countdownSeconds ? "tick" : undefined;
}

export function controllerSound(previous: Snapshot | undefined, next: Snapshot): SoundName | undefined {
  if (previous === undefined || next.result !== undefined) {
    return undefined;
  }
  const me = next.player;
  if (previous.public.catcher !== me && next.public.catcher === me) {
    return "error";
  }
  if (previous.public.catcher === me && next.public.catcher !== me) {
    return "coin";
  }
  return undefined;
}

export function padDirection(dx: number, dy: number, deadZone: number): Direction {
  if (dx * dx + dy * dy < deadZone * deadZone) {
    return "none";
  }
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx < 0 ? "left" : "right";
  }
  return dy < 0 ? "up" : "down";
}

export const keyDirections: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
};

export function steer(dir: Direction): TagAction {
  return { type: "steer", dir };
}

export function pressKey(keys: readonly Direction[], dir: Direction): Direction[] {
  return [...keys.filter((key) => key !== dir), dir];
}

export function releaseKey(keys: readonly Direction[], dir: Direction): Direction[] {
  return keys.filter((key) => key !== dir);
}

export function topKey(keys: readonly Direction[]): Direction {
  return keys.at(-1) ?? "none";
}

export function needsResend(snapshot: Snapshot, held: Direction, pending: number): boolean {
  return (
    pending === 0 &&
    snapshot.result === undefined &&
    snapshot.public.dir[snapshot.player] !== held &&
    snapshot.moves.some((move) => move.type === "steer" && move.dir === held)
  );
}

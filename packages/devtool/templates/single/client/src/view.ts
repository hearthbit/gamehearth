import type { SoundName } from "@gamehearth/sdk/client";
import { levelCount, type Finished, type Save } from "../../src/rules";
import type { Texts } from "./texts";

export type Direction = "up" | "down" | "left" | "right" | "none";

export const cell = 32;
export const hudHeight = 44;
export const speed = 130;

export interface MenuEntry {
  id: string;
  label: string;
  enabled: boolean;
  level: number;
}

export function formatTime(t: Texts, ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}${t.decimal}${tenths % 10}`;
}

export function menuEntries(t: Texts, save: Save): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (save.run !== null) {
    entries.push({ id: "continue", label: t.resume(save.run.level + 1, formatTime(t, save.run.elapsedMs + save.run.levelMs)), enabled: true, level: save.run.level });
  }
  entries.push({ id: "new", label: save.run === null ? t.start : t.startOver, enabled: true, level: 0 });
  for (let level = 1; level < levelCount; level++) {
    const open = level < save.unlocked;
    entries.push({ id: `level-${level + 1}`, label: open ? t.practice(level + 1) : t.locked(level + 1), enabled: open, level });
  }
  return entries;
}

export function recordLine(t: Texts, best: number | undefined): string {
  return best === undefined ? t.noBest : t.best(formatTime(t, best));
}

export function finishLine(t: Texts, totalMs: number, ranked: boolean, best: number | undefined): string {
  if (!ranked) {
    return t.doneUnranked(formatTime(t, totalMs));
  }
  return best !== undefined && best === totalMs ? t.newBest(formatTime(t, totalMs)) : t.done(formatTime(t, totalMs));
}

export function finishSound(finished: Finished | undefined): SoundName {
  return finished === undefined ? "coin" : "win";
}

export function hudLine(t: Texts, level: number, elapsedMs: number, found: number, total: number): string {
  return t.hud(level + 1, levelCount, formatTime(t, elapsedMs), found, total);
}

export function velocity(dir: Direction): { x: number; y: number } {
  switch (dir) {
    case "up":
      return { x: 0, y: -speed };
    case "down":
      return { x: 0, y: speed };
    case "left":
      return { x: -speed, y: 0 };
    case "right":
      return { x: speed, y: 0 };
    default:
      return { x: 0, y: 0 };
  }
}

export function steerTowardLane(position: number, top: number): number {
  const center = top + (Math.floor((position - top) / cell) + 0.5) * cell;
  return Math.max(-speed, Math.min(speed, (center - position) * 8));
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

export function directionOfKey(key: string): Direction | undefined {
  const name = key.length === 1 ? key.toLowerCase() : key;
  return Object.hasOwn(keyDirections, name) ? keyDirections[name] : undefined;
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

export function sharpness(devicePixelRatio: number | undefined): number {
  return Math.min(3, Math.max(1, Math.round(devicePixelRatio ?? 1)));
}

export function frameMs(deltaMs: number): number {
  return Math.min(Math.max(deltaMs, 0), 250);
}

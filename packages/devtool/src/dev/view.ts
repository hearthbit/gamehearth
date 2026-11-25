import {
  bridgeVersion,
  soundNotes,
  tickMs,
  type GameOptions,
  type Localized,
  type OptionsSpec,
  type PlayerInfo,
  type ProfileData,
  type Sound,
  type SoundWave,
  type StatSpec,
} from "@gamehearth/sdk/platform";

export interface DevProblem {
  source: "rules" | "ui" | "build" | "manifest";
  title: string;
  message: string;
  stack?: string;
  seat?: string;
  move?: unknown;
}

export interface DevMove {
  number: number;
  seat: string;
  action: unknown;
  bot: boolean;
}

export interface SeatView {
  seat: string;
  name: string;
  bot: boolean;
  paused: boolean;
  away: boolean;
  snapshot: unknown;
  profile: ProfileData;
  guest: boolean;
}

export interface RealtimeView {
  tick: number;
  running: boolean;
  speed: number;
  inputs: number;
}

export interface SessionView {
  playerCount: number;
  seed: string;
  options: GameOptions;
  version: number | undefined;
  result: unknown;
  realtime?: RealtimeView;
  screen: unknown;
  seats: SeatView[];
  state: unknown;
  moves: DevMove[];
  problem: DevProblem | undefined;
  botProblems: DevProblem[];
  note: string | undefined;
}

export interface DevLog {
  seat: string;
  level: "log" | "info" | "warn" | "error";
  text: string;
}

export interface SoloDevView {
  file: string;
  saved: unknown;
  best: Record<string, number>;
  stats: Record<string, StatSpec>;
  screen: "small" | "medium" | "large";
  problem: string | undefined;
}

export interface DevView {
  game:
    | { id: string; name: Localized; languages?: string[]; counts: number[]; mode: string; away?: "pause" | "play-on"; roles: string[]; options?: OptionsSpec; profiles: boolean }
    | undefined;
  language?: string;
  solo?: SoloDevView;
  session: SessionView;
  client: { version: number; ready: boolean; note: string | undefined };
  problems: DevProblem[];
  logs: DevLog[];
}

const sourceNames: Record<DevProblem["source"], string> = {
  rules: "Rules",
  ui: "UI",
  build: "Build",
  manifest: "manifest.json",
};

export function formatProblem(problem: DevProblem): string {
  const lines = [`ERROR (${sourceNames[problem.source]}): ${problem.title}`, problem.message];
  if (problem.stack !== undefined && problem.stack.trim() !== "") {
    lines.push(problem.stack.replace(/\s+$/, ""));
  }
  if (problem.move !== undefined) {
    lines.push(`Move by ${problem.seat ?? "?"}: ${JSON.stringify(problem.move)}`);
  }
  return lines.join("\n");
}

export const screenSeat = "tv";

function seatRole(current: DevView): "player" | "controller" {
  const roles = current.game?.roles ?? [];
  return roles.includes("player") || !roles.includes("controller") ? "player" : "controller";
}

function players(seat: string, seats: SeatView[]): Record<string, PlayerInfo> {
  const result: Record<string, PlayerInfo> = {};
  for (const entry of seats) {
    result[entry.seat] = entry.bot
      ? { name: `${entry.name} (Bot)`, connected: true, you: entry.seat === seat, bot: true }
      : { name: entry.name, connected: true, you: entry.seat === seat };
  }
  return result;
}

export function frameSnapshot(current: DevView, seat: string): unknown {
  if (seat === screenSeat) {
    return current.session.screen;
  }
  return current.session.seats.find((entry) => entry.seat === seat)?.snapshot;
}

export function frameUpdate(current: DevView, seat: string): Record<string, unknown> | undefined {
  const snapshot = frameSnapshot(current, seat);
  if (current.solo !== undefined || snapshot === undefined) {
    return undefined;
  }
  const speed = current.session.realtime?.speed ?? 1;
  const extra = {
    online: true,
    ...(speed === 1 ? {} : { tickMs: tickMs / speed }),
    ...(current.language === undefined ? {} : { language: current.language }),
  };
  if (seat === screenSeat) {
    return { gamehearth: bridgeVersion, type: "update", seat: null, role: "screen", snapshot, players: players("", current.session.seats), options: current.session.options, ...extra };
  }
  const profile = current.session.seats.find((entry) => entry.seat === seat)?.profile;
  return {
    gamehearth: bridgeVersion,
    type: "update",
    seat,
    role: seatRole(current),
    snapshot,
    players: players(seat, current.session.seats),
    options: current.session.options,
    ...(profile === undefined ? {} : { profile }),
    ...extra,
  };
}

export function settingsMessage(sound: boolean): Record<string, unknown> {
  return { gamehearth: bridgeVersion, type: "settings", sound };
}

export const soundPeakGain = 0.12;
export const maxSoundsPerSecond = 12;

export interface Tone {
  wave: SoundWave;
  from: number;
  to?: number;
  begin: number;
  end: number;
  peak: number;
}

export function soundPlan(sound: Sound, start: number): Tone[] {
  return soundNotes(sound)
    .filter((note) => (note.volume ?? 0.5) > 0)
    .map((note) => {
      const begin = start + (note.at ?? 0);
      return {
        wave: note.wave ?? "square",
        from: note.freq,
        ...(note.to === undefined ? {} : { to: note.to }),
        begin,
        end: begin + note.length,
        peak: (note.volume ?? 0.5) * soundPeakGain,
      };
    });
}

export function admitSound(recent: number[], now: number): boolean {
  while (recent.length > 0 && now - (recent[0] ?? 0) >= 1000) {
    recent.shift();
  }
  if (recent.length >= maxSoundsPerSecond) {
    return false;
  }
  recent.push(now);
  return true;
}

export function soundLabel(sound: Sound): string {
  if (typeof sound === "string") {
    return sound;
  }
  return `own sound with ${sound.notes.length} ${sound.notes.length === 1 ? "note" : "notes"}`;
}

export function soloMessage(language: string | undefined, saved: unknown, best: Record<string, number>): Record<string, unknown> {
  return { gamehearth: bridgeVersion, type: "solo", saved: saved ?? null, best, ...(language === undefined ? {} : { language }) };
}

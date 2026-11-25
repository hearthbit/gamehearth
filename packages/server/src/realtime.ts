import { maxActionLength, tickMs, type AnyGameState, type InputResult, type Match, type ProfileChange, type ProfileData } from "@gamehearth/sdk/platform";
import type { GameBuild } from "./games";
import type { HostResult, SandboxHost } from "./sandbox/host";
import { requiresScreen } from "./screens";

type AnyMatch = Match<AnyGameState, unknown>;

export type LiveState = "countdown" | "running" | "paused" | "halted";

export interface LiveView {
  state: LiveState;
  remainingMs?: number;
  missingSeats: string[];
  awaySeats?: string[];
  screenMissing: boolean;
  byHost: boolean;
  incident?: string;
}

export interface Presence {
  seats: ReadonlySet<string>;
  screens: number;
}

export interface RealtimeOptions {
  graceMs: number;
  countdownMs: number;
  saveEveryMs: number;
  maxInputsPerSeat: number;
  maxInputsPerTick: number;
  clock: () => number;
  timers: boolean;
  log: (message: string) => void;
}

export const realtimeDefaults: RealtimeOptions = {
  graceMs: 2000,
  countdownMs: 3000,
  saveEveryMs: 10_000,
  maxInputsPerSeat: 4,
  maxInputsPerTick: 64,
  clock: Date.now,
  timers: true,
  log: (message) => console.error(message),
};

export interface ProfileRead {
  profiles: Record<string, ProfileData>;
  revisions: Record<string, number>;
  users: Record<string, number | null>;
  tracked: boolean;
}

export const maxProfileRetries = 3;

export interface RealtimeHooks {
  profiles?(code: string, build: GameBuild): ProfileRead;
  commit?(code: string, round: number, build: GameBuild, match: AnyMatch, changes: readonly ProfileChange[], read: ProfileRead): "ok" | "conflict" | string;
  frame(code: string): void;
  changed(code: string): void;
  save(code: string, round: number, match: AnyMatch): void;
  finished(code: string, round: number, build: GameBuild, match: AnyMatch): void;
  failed(code: string, build: GameBuild, result: HostResult): string;
}

export type InputOutcome = InputResult | { ok: false; code: "paused" | "not-running" | "too-many-inputs"; message: string };

interface Pending {
  seat: string;
  action: unknown;
  resolve: (result: InputOutcome) => void;
}

interface Live {
  code: string;
  round: number;
  build: GameBuild;
  match: AnyMatch;
  needsScreen: boolean;
  playOn: boolean;
  bots: Set<string>;
  awaySince: Map<string, number>;
  away: string[];
  botNotes: Set<string>;
  queue: Pending[];
  deferred: Map<string, unknown>;
  state: LiveState;
  countdownUntil: number;
  nextTickAt: number;
  missingSince: number | undefined;
  missingKey: string;
  byHost: boolean;
  incident: string | undefined;
  stepping: boolean;
  savedAt: number;
}

const emptyPresence: Presence = { seats: new Set(), screens: 0 };

const retryKinds = ["timeout", "memory"] as const;

function retryable(result: HostResult): boolean {
  return !result.ok && (retryKinds as readonly string[]).includes(result.failure.kind);
}
const timerMs = 10;
const maxLagMs = 200;

export class RealtimeRooms {
  readonly #sandbox: SandboxHost;
  readonly #hooks: RealtimeHooks;
  readonly #options: RealtimeOptions;
  readonly #live = new Map<string, Live>();
  readonly #presence = new Map<string, Presence>();
  #timer: NodeJS.Timeout | undefined;

  constructor(sandbox: SandboxHost, hooks: RealtimeHooks, options: Partial<RealtimeOptions> = {}) {
    this.#sandbox = sandbox;
    this.#hooks = hooks;
    this.#options = { ...realtimeDefaults, ...options };
  }

  get size(): number {
    return this.#live.size;
  }

  get presenceEntries(): number {
    return this.#presence.size;
  }

  has(code: string): boolean {
    return this.#live.has(code);
  }

  match(code: string): AnyMatch | undefined {
    return this.#live.get(code)?.match;
  }

  build(code: string): GameBuild | undefined {
    return this.#live.get(code)?.build;
  }

  attach(code: string, round: number, build: GameBuild, match: AnyMatch, state: "countdown" | "paused", bots: Iterable<string> = []): void {
    this.detach(code);
    const now = this.#options.clock();
    this.#live.set(code, {
      code,
      round,
      build,
      match,
      needsScreen: requiresScreen(build.manifest),
      playOn: build.manifest.away === "play-on",
      bots: new Set([...bots].filter((seat) => match.players.includes(seat))),
      awaySince: new Map(),
      away: [],
      botNotes: new Set(),
      queue: [],
      deferred: new Map(),
      state,
      countdownUntil: now + this.#options.countdownMs,
      nextTickAt: now + this.#options.countdownMs,
      missingSince: undefined,
      missingKey: "",
      byHost: false,
      incident: undefined,
      stepping: false,
      savedAt: now,
    });
    this.#ensureTimer();
  }

  setBots(code: string, seats: Iterable<string>): void {
    const live = this.#live.get(code);
    if (live === undefined) {
      return;
    }
    live.bots = new Set([...seats].filter((seat) => live.match.players.includes(seat)));
    this.#evaluate(live, this.#options.clock());
    this.#hooks.changed(code);
  }

  detach(code: string): void {
    const live = this.#live.get(code);
    if (live === undefined) {
      return;
    }
    this.#live.delete(code);
    this.#reject(live.queue.splice(0), "not-running", "No match is running in this room right now");
    if (this.#live.size === 0) {
      this.#stopTimer();
    }
  }

  presence(code: string, presence: Presence): void {
    const live = this.#live.get(code);
    if (live === undefined && presence.seats.size === 0 && presence.screens === 0) {
      this.#presence.delete(code);
      return;
    }
    this.#presence.set(code, presence);
    if (live !== undefined) {
      this.#evaluate(live, this.#options.clock());
    }
  }

  forgetPresence(code: string): void {
    this.#presence.delete(code);
  }

  screens(code: string): number {
    return (this.#presence.get(code) ?? emptyPresence).screens;
  }

  view(code: string): LiveView | undefined {
    const live = this.#live.get(code);
    if (live === undefined) {
      return undefined;
    }
    const missing = this.#missing(live);
    const view: LiveView = { state: live.state, missingSeats: live.playOn && !this.#allAway(live, missing.seats) ? [] : missing.seats, screenMissing: missing.screen, byHost: live.byHost };
    if (live.playOn && live.away.length > 0) {
      view.awaySeats = [...live.away];
    }
    if (live.state === "countdown") {
      view.remainingMs = Math.max(0, live.countdownUntil - this.#options.clock());
    }
    if (live.incident !== undefined) {
      view.incident = live.incident;
    }
    return view;
  }

  input(code: string, seat: string, action: unknown): Promise<InputOutcome> {
    const live = this.#live.get(code);
    if (live === undefined) {
      return Promise.resolve({ ok: false, code: "not-running", message: "No match is running in this room right now" });
    }
    let length: number;
    try {
      length = JSON.stringify(action)?.length ?? Number.POSITIVE_INFINITY;
    } catch {
      length = Number.POSITIVE_INFINITY;
    }
    if (length > maxActionLength) {
      return Promise.resolve({ ok: false, code: "illegal-move", message: `the move is larger than ${maxActionLength} characters or not a JSON value` });
    }
    if (live.state === "paused" || live.state === "halted") {
      live.deferred.delete(seat);
      live.deferred.set(seat, action);
      return Promise.resolve({ ok: true });
    }
    const waiting = live.queue.filter((pending) => pending.seat === seat);
    if (waiting.length >= this.#options.maxInputsPerSeat) {
      const oldest = waiting[0] as Pending;
      live.queue.splice(live.queue.indexOf(oldest), 1);
      oldest.resolve({ ok: false, code: "too-many-inputs", message: "Too many inputs at once; the oldest one was dropped" });
    }
    return new Promise((resolve) => live.queue.push({ seat, action, resolve }));
  }

  pause(code: string): boolean {
    const live = this.#live.get(code);
    if (live === undefined || live.byHost) {
      return false;
    }
    live.byHost = true;
    this.#evaluate(live, this.#options.clock());
    this.#hooks.changed(code);
    return true;
  }

  resume(code: string): boolean {
    const live = this.#live.get(code);
    if (live === undefined || (!live.byHost && live.state !== "halted")) {
      return false;
    }
    live.byHost = false;
    if (live.state === "halted") {
      live.state = "paused";
      live.incident = undefined;
    }
    this.#evaluate(live, this.#options.clock());
    this.#hooks.changed(code);
    return true;
  }

  async tickAll(): Promise<void> {
    const now = this.#options.clock();
    const steps: Promise<void>[] = [];
    for (const live of [...this.#live.values()]) {
      this.#evaluate(live, now);
      if (live.state === "running" && !live.stepping && now >= live.nextTickAt) {
        live.nextTickAt = Math.max(live.nextTickAt + tickMs, now - maxLagMs + tickMs);
        steps.push(this.#step(live, now));
      }
    }
    await Promise.all(steps);
  }

  close(): void {
    this.#stopTimer();
    for (const code of [...this.#live.keys()]) {
      this.detach(code);
    }
  }

  #evaluate(live: Live, now: number): void {
    if (live.state === "halted") {
      return;
    }
    const missing = this.#missing(live);
    if (live.playOn && this.#trackAway(live, missing.seats, now)) {
      this.#hooks.changed(live.code);
    }
    const absent = (live.playOn ? this.#allAway(live, missing.seats) : missing.seats.length > 0) || missing.screen;
    const key = `${missing.seats.join(",")}|${missing.screen}|${live.byHost}`;
    if (!absent) {
      live.missingSince = undefined;
    } else if (live.missingSince === undefined) {
      live.missingSince = now;
    }
    if (live.state === "paused") {
      if (!absent && !live.byHost) {
        live.state = "countdown";
        live.countdownUntil = now + this.#options.countdownMs;
        live.missingKey = key;
        this.#release(live);
        this.#hooks.changed(live.code);
      } else if (key !== live.missingKey) {
        live.missingKey = key;
        this.#hooks.changed(live.code);
      }
      return;
    }
    const overdue = absent && now - (live.missingSince ?? now) >= this.#options.graceMs;
    if (live.byHost || overdue) {
      live.state = "paused";
      live.missingKey = key;
      this.#defer(live);
      this.#save(live, now);
      this.#hooks.changed(live.code);
      return;
    }
    if (live.state === "countdown" && now >= live.countdownUntil) {
      live.state = "running";
      live.nextTickAt = now;
      this.#hooks.changed(live.code);
    }
  }

  async #step(live: Live, now: number): Promise<void> {
    live.stepping = true;
    const pending = live.queue.splice(0, this.#options.maxInputsPerTick);
    const match = live.match;
    const bots = match.players.filter((seat) => live.bots.has(seat));
    const step = {
      inputs: pending.map((entry) => ({ player: entry.seat, action: entry.action })),
      now,
      dt: tickMs,
      ...(live.playOn && live.away.length > 0 ? { away: [...live.away] } : {}),
      ...(bots.length > 0 ? { bots } : {}),
    };
    const expected = {
      seed: match.seed,
      players: match.players,
      ...(match.options === undefined ? {} : { options: match.options }),
      version: match.version + 1,
      tick: (match.tick ?? 0) + 1,
      inputs: pending.length,
      ...(bots.length > 0 ? { bots: bots.length } : {}),
    };
    let result: HostResult | undefined;
    let committed: "ok" | "conflict" | string | undefined;
    try {
      for (let attempt = 0; ; attempt++) {
        let read: ProfileRead | undefined;
        try {
          read = this.#hooks.profiles?.(live.code, live.build);
        } catch (error) {
          committed = `The profiles could not be read: ${error instanceof Error ? error.message : String(error)}`;
          break;
        }
        const input = `{"match":${JSON.stringify(match)},"step":${JSON.stringify(step)}${read === undefined ? "" : `,"profiles":${JSON.stringify(read.profiles)}`}}`;
        result = await this.#sandbox.run(live.code, live.build.build, "stepMatch", input, expected, { tolerate: retryKinds });
        if (retryable(result) && this.#live.get(live.code) === live) {
          result = await this.#sandbox.run(live.code, live.build.build, "stepMatch", input, expected);
        }
        const changes = result.ok && result.outcome.ok ? (result.outcome.changes ?? []) : [];
        if (changes.length === 0 || read === undefined || this.#hooks.commit === undefined || this.#live.get(live.code) !== live) {
          committed = undefined;
          break;
        }
        committed = this.#hooks.commit(live.code, live.round, live.build, result.ok && result.outcome.ok ? (result.outcome.match as unknown as AnyMatch) : match, changes, read);
        if (committed !== "conflict" || attempt >= maxProfileRetries) {
          break;
        }
      }
    } finally {
      live.stepping = false;
    }
    if (this.#live.get(live.code) !== live) {
      this.#reject(pending, "not-running", "No match is running in this room right now");
      return;
    }
    if (committed !== undefined && committed !== "ok") {
      live.state = "halted";
      live.incident = this.#hooks.failed(live.code, live.build, {
        ok: false,
        failure: { kind: "error", message: committed === "conflict" ? "Profiles changed on every attempt before the tick was saved" : committed },
      });
      this.#reject(pending, "game-error", `An error occurred in the game (incident ${live.incident})`);
      this.#defer(live);
      this.#save(live, now);
      this.#hooks.changed(live.code);
      return;
    }
    if (result === undefined || !result.ok || !result.outcome.ok) {
      live.state = "halted";
      live.incident = this.#hooks.failed(live.code, live.build, result ?? { ok: false, failure: { kind: "error", message: "The tick returned no result" } });
      this.#reject(pending, "game-error", `An error occurred in the game (incident ${live.incident})`);
      this.#defer(live);
      this.#save(live, now);
      this.#hooks.changed(live.code);
      return;
    }
    const outcome = result.outcome;
    live.match = outcome.match as unknown as AnyMatch;
    for (const note of outcome.bots ?? []) {
      const key = `${note.player}|${note.message}`;
      if (!live.botNotes.has(key) && live.botNotes.size < 20) {
        live.botNotes.add(key);
        this.#options.log(`[Bots] Room ${live.code}, ${live.build.build}, seat ${note.player}: ${note.message}`);
      }
    }
    if (committed === "ok") {
      live.savedAt = now;
    }
    const results = outcome.results ?? [];
    pending.forEach((entry, index) => entry.resolve(results[index] ?? { ok: false, code: "game-error", message: "The input got no result" }));
    if (live.match.result !== undefined) {
      this.detach(live.code);
      this.#hooks.finished(live.code, live.round, live.build, live.match);
      return;
    }
    if (now - live.savedAt >= this.#options.saveEveryMs) {
      this.#save(live, now);
    }
    if (committed === "ok") {
      this.#hooks.changed(live.code);
    } else {
      this.#hooks.frame(live.code);
    }
  }

  #defer(live: Live): void {
    for (const entry of live.queue.splice(0)) {
      live.deferred.delete(entry.seat);
      live.deferred.set(entry.seat, entry.action);
      entry.resolve({ ok: true });
    }
  }

  #release(live: Live): void {
    for (const [seat, action] of live.deferred) {
      live.queue.push({ seat, action, resolve: () => undefined });
    }
    live.deferred.clear();
  }

  #missing(live: Live): { seats: string[]; screen: boolean } {
    const presence = this.#presence.get(live.code) ?? emptyPresence;
    return {
      seats: live.match.players.filter((seat) => !presence.seats.has(seat) && !live.bots.has(seat)),
      screen: live.needsScreen && presence.screens === 0,
    };
  }

  #allAway(live: Live, missing: readonly string[]): boolean {
    const people = live.match.players.filter((seat) => !live.bots.has(seat));
    return people.length > 0 && people.every((seat) => missing.includes(seat));
  }

  #trackAway(live: Live, missing: readonly string[], now: number): boolean {
    for (const seat of missing) {
      if (!live.awaySince.has(seat)) {
        live.awaySince.set(seat, now);
      }
    }
    for (const seat of [...live.awaySince.keys()]) {
      if (!missing.includes(seat)) {
        live.awaySince.delete(seat);
      }
    }
    const away = live.match.players.filter((seat) => now - (live.awaySince.get(seat) ?? now) >= this.#options.graceMs && live.awaySince.has(seat));
    if (away.join(",") === live.away.join(",")) {
      return false;
    }
    live.away = away;
    return true;
  }

  #save(live: Live, now: number): void {
    live.savedAt = now;
    this.#hooks.save(live.code, live.round, live.match);
  }

  #reject(entries: readonly Pending[], code: "paused" | "not-running" | "game-error", message: string): void {
    for (const entry of entries) {
      entry.resolve({ ok: false, code, message } as InputOutcome);
    }
  }

  #ensureTimer(): void {
    if (this.#timer !== undefined || !this.#options.timers) {
      return;
    }
    this.#timer = setInterval(() => {
      this.tickAll().catch((error: unknown) => this.#options.log(`[Realtime] Error in the tick loop: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`));
    }, timerMs);
    this.#timer.unref();
  }

  #stopTimer(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}

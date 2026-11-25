import { randomBytes } from "node:crypto";
import {
  applyChange,
  canonicalJson,
  cloneProfile,
  emptyProfile,
  legalMoveFor,
  playerSnapshot,
  profileProblem,
  readProfile,
  sampleMove,
  screenSnapshot,
  seatIds,
  tickMs,
  type AnyGameState,
  type CatalogSpec,
  type GameOptions,
  type InputResult,
  type Match,
  type MoveResult,
  type Move,
  type ProfileChange,
  type ProfileData,
} from "@gamehearth/sdk/platform";
import type { Expected } from "../sandbox/outcome";
import type { GuestFunction, SandboxResult } from "../sandbox/sandbox";
import { devProfilesFile } from "./profiles-file";
import type { DevProblem, SessionView } from "./view";

export interface SandboxCaller {
  call(fn: GuestFunction, input: string, expected: Expected): Promise<SandboxResult>;
}

export type { DevProblem } from "./view";

export interface SessionOptions {
  engine: SandboxCaller;
  mapStack?: (stack: string) => string;
  botDelayMs?: number;
  now?: () => number;
  pick?: (count: number) => number;
  onChange?: () => void;
  log?: (problem: DevProblem) => void;
  catalog?: () => CatalogSpec | undefined;
  profiles?: ProfileStore;
  realtime?: boolean;
  playOn?: boolean;
  timers?: boolean;
}

export interface ProfileStore {
  readonly problem: string | undefined;
  profile(seat: string): ProfileData;
  guests(): string[];
  save(profiles: Readonly<Record<string, ProfileData>>, guests: readonly string[]): { ok: true } | { ok: false; code: string; message: string };
  setGuest(seat: string, guest: boolean): { ok: true } | { ok: false; code: string; message: string };
}

export const speeds = [1, 0.5, 0.25] as const;
export const maxLagMs = 200;

export function nextDue(due: number, now: number, intervalMs: number): number {
  return Math.max(due + intervalMs, now - maxLagMs + intervalMs);
}
export const maxInputsPerSeat = 4;
export const inputsPerSecond = 30;
export const realtimeMovesShown = 40;
const botInputOdds = 5;

type AnyMatch = Match<AnyGameState, unknown>;
type Profiles = Record<string, ProfileData>;
type BotNote = { player: string; message: string };
type Step = { ok: true; match: AnyMatch; results?: InputResult[]; bots?: BotNote[]; profiles: Profiles } | { ok: false; code: string; message: string; problem?: DevProblem };
type Pending = { seat: string; action: unknown; legal: boolean; resolve: (result: MoveResult) => void };
type Deferred = { action: unknown; legal: boolean };
type Retryable = "timeout" | "memory" | "crash";

const retryable: readonly string[] = ["timeout", "memory", "crash"] satisfies Retryable[];

function isLegal(legal: readonly unknown[], action: unknown): boolean {
  try {
    return legalMoveFor(legal, action) !== undefined;
  } catch {
    return false;
  }
}

export const seatNames = ["Anna", "Ben", "Clara", "Dario", "Elif", "Finn", "Greta", "Hamid", "Ida", "Jonas", "Kim", "Lea"];

export function seatName(seat: string): string {
  const index = Number(seat.slice(1)) - 1;
  return seatNames[index] ?? `Player ${index + 1}`;
}

export function randomSeed(): string {
  return `dev-${randomBytes(8).toString("hex")}`;
}

function cloneProfiles(profiles: Profiles): Profiles {
  return Object.fromEntries(Object.entries(profiles).map(([seat, profile]) => [seat, cloneProfile(profile)]));
}

function unknownIds(profile: ProfileData, catalog: CatalogSpec | undefined): string | undefined {
  const unknown: string[] = [];
  const known: string[] = [];
  for (const area of ["items", "stats", "flags"] as const) {
    const ids = Object.keys(catalog?.[area] ?? {});
    unknown.push(...Object.keys(profile[area]).filter((id) => !ids.includes(id)).map((id) => `${area}.${id}`));
    if (ids.length > 0) {
      known.push(`${area}: ${ids.join(", ")}`);
    }
  }
  if (unknown.length === 0) {
    return undefined;
  }
  return `${unknown.join(", ")}. Known: ${known.length === 0 ? "none" : known.join("; ")}`;
}

function withOptions(options: GameOptions | undefined): { options?: GameOptions } {
  return options === undefined || Object.keys(options).length === 0 ? {} : { options };
}

export class DevSession {
  readonly #engine: SandboxCaller;
  readonly #mapStack: (stack: string) => string;
  readonly #botDelayMs: number;
  readonly #now: () => number;
  readonly #pick: (count: number) => number;
  readonly #onChange: () => void;
  readonly #log: (problem: DevProblem) => void;
  readonly #catalog: () => CatalogSpec | undefined;
  readonly #store: ProfileStore | undefined;
  #profiles: Profiles = {};
  #startProfiles: Profiles = {};
  #guests: string[] = [];
  #edits: { at: number; seat: string; profile: ProfileData }[] = [];
  #persistable = true;
  #saveProblem: string | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #playerCount = 0;
  #seed = "";
  #options: GameOptions = {};
  #moves: { move: Move<unknown>; bot: boolean }[] = [];
  #match: AnyMatch | undefined;
  #problem: DevProblem | undefined;
  #note: string | undefined;
  #bots = new Set<string>();
  #paused = new Set<string>();
  #away = new Set<string>();
  #playOn: boolean;
  #hasBot: boolean | undefined;
  #botProblems = new Map<string, DevProblem>();
  #botLogged = new Map<string, string>();
  #botBusy = false;
  #botTimer: NodeJS.Timeout | undefined;
  #closed = false;
  #realtime: boolean;
  readonly #timers: boolean;
  #running = true;
  #speed: number = 1;
  #ticker: NodeJS.Timeout | undefined;
  #inputs: Pending[] = [];
  #deferred = new Map<string, Deferred>();
  #rate = new Map<string, number[]>();
  #holds = 0;
  #inputCount = 0;

  constructor(options: SessionOptions) {
    this.#engine = options.engine;
    this.#mapStack = options.mapStack ?? ((stack) => stack);
    this.#botDelayMs = options.botDelayMs ?? 700;
    this.#now = options.now ?? Date.now;
    this.#pick = options.pick ?? ((count) => Math.floor(Math.random() * count));
    this.#onChange = options.onChange ?? (() => {});
    this.#log = options.log ?? (() => {});
    this.#catalog = options.catalog ?? (() => undefined);
    this.#store = options.profiles;
    this.#realtime = options.realtime === true;
    this.#playOn = options.playOn === true;
    this.#timers = options.timers !== false;
  }

  get playOn(): boolean {
    return this.#playOn;
  }

  setPlayOn(on: boolean): void {
    this.#playOn = on;
    this.#changed();
  }

  get realtime(): boolean {
    return this.#realtime;
  }

  setRealtime(on: boolean): void {
    this.#realtime = on;
    if (!on) {
      this.#stopTicker();
    }
  }

  get match(): AnyMatch | undefined {
    return this.#match;
  }

  get problem(): DevProblem | undefined {
    return this.#problem;
  }

  get options(): GameOptions {
    return this.#options;
  }

  get profilesProblem(): string | undefined {
    if (this.#store === undefined) {
      return undefined;
    }
    return (
      this.#store.problem ??
      (this.#persistable
        ? this.#saveProblem
        : `${devProfilesFile} was faulty when this match started. This match does not save its profiles; start a new match after repairing the file.`)
    );
  }

  newMatch(playerCount: number, seed: string = randomSeed(), options: GameOptions = this.#options): Promise<void> {
    return this.#serial(() => this.#startMatch(playerCount, seed, options));
  }

  async #startMatch(playerCount: number, seed: string, options: GameOptions): Promise<void> {
    this.#playerCount = playerCount;
    this.#seed = seed;
    this.#options = options;
    this.#moves = [];
    this.#inputCount = 0;
    this.#rejectInputs("no-match", "A new match has started");
    this.#deferred.clear();
    this.#bots = new Set([...this.#bots].filter((seat) => seatIds(playerCount).includes(seat)));
    this.#away = new Set([...this.#away].filter((seat) => seatIds(playerCount).includes(seat)));
    this.#paused.clear();
    this.#forgetBots();
    this.#note = undefined;
    this.#problem = undefined;
    const seats = seatIds(playerCount);
    this.#guests = (this.#store?.guests() ?? []).filter((seat) => seats.includes(seat));
    this.#startProfiles = Object.fromEntries(seats.map((seat) => [seat, this.#guests.includes(seat) || this.#store === undefined ? emptyProfile() : this.#store.profile(seat)]));
    this.#persistable = this.#store?.problem === undefined;
    this.#saveProblem = undefined;
    this.#edits = [];
    const created = await this.#create(this.#startProfiles);
    this.#match = created.ok ? created.match : undefined;
    this.#profiles = created.ok ? created.profiles : cloneProfiles(this.#startProfiles);
    this.#problem = created.ok ? undefined : created.problem;
    if (this.#problem !== undefined) {
      this.#log(this.#problem);
    }
    this.#syncTicker();
    this.#changed();
  }

  reload(note?: string): Promise<void> {
    if (this.#realtime) {
      return this.newMatch(this.#playerCount, this.#seed).then(() => {
        this.#note = note ?? "Rules reloaded, new match with the same seats and bots.";
        this.#changed();
      });
    }
    return this.#serial(async () => {
      const recorded = this.#moves;
      const edits = this.#edits;
      this.#problem = undefined;
      this.#paused.clear();
      this.#forgetBots();
      const created = await this.#create(this.#startProfiles);
      if (!created.ok) {
        this.#match = undefined;
        this.#moves = [];
        this.#edits = [];
        this.#startProfiles = cloneProfiles(this.#profiles);
        this.#problem = created.problem;
        this.#note = "The new rules already fail while setting up the match.";
        if (this.#problem !== undefined) {
          this.#log(this.#problem);
        }
        this.#changed();
        return;
      }
      let match = created.match;
      let profiles = created.profiles;
      const kept: typeof recorded = [];
      const keptEdits: typeof edits = [];
      const replayEdits = async (at: number): Promise<boolean> => {
        for (const change of edits.filter((entry) => entry.at === at)) {
          profiles = { ...profiles, [change.seat]: cloneProfile(change.profile) };
          keptEdits.push(change);
          if (match.result === undefined) {
            const refreshed = await this.#refreshMoves(match, profiles);
            if (!refreshed.ok) {
              this.#problem = refreshed.problem ?? { source: "rules", title: "Replay stopped", message: refreshed.message };
              return false;
            }
            match = refreshed.match;
          }
        }
        return true;
      };
      for (const entry of [...recorded, undefined]) {
        if (!(await replayEdits(kept.length)) || entry === undefined) {
          break;
        }
        const step = await this.#apply(match, entry.move, profiles);
        if (!step.ok) {
          const what = `move ${kept.length + 1} (${entry.move.player}: ${JSON.stringify(entry.move.action)})`;
          this.#problem =
            step.problem === undefined
              ? {
                  source: "rules",
                  title: `Replay stopped at ${what}`,
                  message: `With the new rules this move is no longer possible: ${step.message}. The match now stands just before it; "New match" starts over.`,
                  seat: entry.move.player,
                  move: entry.move.action,
                }
              : { ...step.problem, title: `Replay stopped at ${what}: ${step.problem.title}` };
          break;
        }
        kept.push(entry);
        match = step.match;
        profiles = step.profiles;
      }
      const late = edits.filter((change) => !keptEdits.includes(change));
      for (const change of late) {
        profiles = { ...profiles, [change.seat]: cloneProfile(change.profile) };
        keptEdits.push({ ...change, at: kept.length });
      }
      if (late.length > 0 && match.result === undefined) {
        const refreshed = await this.#refreshMoves(match, profiles);
        if (refreshed.ok) {
          match = refreshed.match;
        } else {
          this.#problem ??= refreshed.problem ?? { source: "rules", title: "Replay stopped", message: refreshed.message };
        }
      }
      this.#match = match;
      this.#profiles = profiles;
      this.#moves = kept;
      this.#edits = keptEdits;
      this.#persist();
      const dropped = recorded.length - kept.length;
      this.#note =
        note ??
        (recorded.length === 0
          ? "Rules reloaded."
          : dropped === 0
            ? `Rules reloaded, ${kept.length} ${kept.length === 1 ? "move" : "moves"} replayed.`
            : `Rules reloaded, ${kept.length} of ${recorded.length} moves replayed${
                late.length === 0 ? "" : `; ${late.length === 1 ? "the later edit of a profile applies" : `${late.length} later edits of profiles apply`} from there on`
              }.`);
      if (this.#problem !== undefined) {
        this.#log(this.#problem);
      }
      this.#changed();
    });
  }

  move(seat: string, action: unknown, options: { expectedVersion?: number; bot?: boolean } = {}): Promise<MoveResult> {
    if (this.#realtime) {
      return this.#input(seat, action);
    }
    return this.#serial(async () => {
      const match = this.#match;
      if (match === undefined) {
        return { ok: false, code: "no-match", message: "No match is running" };
      }
      const move: Move<unknown> = { player: seat, action, now: this.#now(), ...(options.expectedVersion === undefined ? {} : { expectedVersion: options.expectedVersion }) };
      const step = await this.#apply(match, move, this.#profiles);
      if (!step.ok) {
        if (step.problem !== undefined) {
          this.#problem = step.problem;
          if (options.bot === true) {
            this.#paused.add(seat);
            this.#problem = {
              ...step.problem,
              title: `${step.problem.title}; bot of ${seat} paused`,
              message: `${step.problem.message}\nThe bot of ${seat} only moves again once the rules are reloaded, a new match starts or it is switched on again.`,
            };
          }
          this.#log(this.#problem);
          this.#changed();
        } else if (step.code === "illegal-move" || step.code === "not-your-turn") {
          const problem: DevProblem = {
            source: "ui",
            title: `The UI of ${seat} sent a move that is not legal`,
            message: `${step.message}. A UI only sends moves from snapshot.moves.`,
            seat,
            move: action,
          };
          this.#log(problem);
        }
        return { ok: false, code: step.code, message: step.message };
      }
      const { expectedVersion: _ignored, ...recorded } = move;
      this.#moves.push({ move: recorded, bot: options.bot === true });
      this.#match = step.match;
      this.#profiles = step.profiles;
      this.#persist();
      if (options.bot !== true) {
        this.#problem = undefined;
        this.#note = undefined;
      }
      this.#changed();
      return { ok: true };
    });
  }

  pause(paused: boolean): void {
    this.#running = !paused;
    if (!paused && this.#problem?.source === "rules") {
      this.#problem = undefined;
    }
    if (this.#accepting()) {
      this.#release();
    } else {
      this.#defer();
    }
    this.#syncTicker();
    this.#changed();
  }

  async hold(): Promise<void> {
    this.#holds += 1;
    this.#stopTicker();
    await this.#queue;
  }

  unhold(): void {
    this.#holds = Math.max(0, this.#holds - 1);
    this.#syncTicker();
  }

  setSpeed(speed: number): void {
    if (!(speeds as readonly number[]).includes(speed)) {
      return;
    }
    this.#speed = speed;
    this.#stopTicker();
    this.#syncTicker();
    this.#changed();
  }

  step(): Promise<void> {
    return this.#serial(() => {
      this.#release();
      return this.#tick();
    });
  }

  #fill(template: unknown): unknown {
    return sampleMove(template, { next: () => this.#pick(1_000_000) / 1_000_000 });
  }

  setBot(seat: string, on: boolean): void {
    if (on) {
      this.#bots.add(seat);
    } else {
      this.#bots.delete(seat);
    }
    this.#paused.delete(seat);
    this.#botProblems.delete(seat);
    this.#botLogged.delete(seat);
    this.#changed();
  }

  setAway(seat: string, on: boolean): void {
    if (on) {
      this.#away.add(seat);
    } else {
      this.#away.delete(seat);
    }
    this.#changed();
  }

  #forgetBots(): void {
    this.#hasBot = undefined;
    this.#botProblems.clear();
    this.#botLogged.clear();
  }

  #botTrouble(seat: string, problem: string): void {
    const instead = this.#realtime
      ? "In this tick the seat sends no input, as on the platform."
      : "dev played a random legal move for the seat instead, as the platform does.";
    const entry: DevProblem = {
      source: "rules",
      title: `Problem in bot for ${seat}`,
      message: `${problem}\n${instead} bot returns one of the moves it gets (or undefined) and must not change the state, the moves or the profiles; check reports the same.`,
      seat,
    };
    this.#botProblems.set(seat, entry);
    const key = problem.replace(/\d+/g, "#");
    if (this.#botLogged.get(seat) !== key) {
      this.#botLogged.set(seat, key);
      this.#log(entry);
    }
  }

  #botExpected(match: AnyMatch): Expected {
    return { seed: match.seed, players: match.players, ...withOptions(match.options), version: match.version, ...(match.tick === undefined ? {} : { tick: match.tick }) };
  }

  async #askBot(match: AnyMatch, seat: string): Promise<SandboxResult | undefined> {
    try {
      const result = await this.#engine.call("botMove", JSON.stringify({ match, player: seat, now: this.#now(), profiles: this.#profiles }), this.#botExpected(match));
      if (result.ok && result.outcome.ok) {
        this.#hasBot = result.outcome.hasBot === true;
      }
      return result;
    } catch {
      this.#hasBot = false;
      return undefined;
    }
  }

  async #botAction(match: AnyMatch, seat: string): Promise<unknown> {
    const moves = match.moves[seat] ?? [];
    const random = () => this.#fill(moves[this.#pick(moves.length)]);
    if (this.#hasBot === false) {
      return random();
    }
    const result = await this.#askBot(match, seat);
    if (result === undefined) {
      return random();
    }
    if (!result.ok) {
      this.#botTrouble(seat, `Asking bot for ${seat} failed: ${result.failure.message}`);
      return random();
    }
    const choice = result.outcome.ok ? result.outcome.bot : undefined;
    if (choice?.problem !== undefined) {
      this.#botTrouble(seat, choice.problem);
    }
    return choice?.chosen === "bot" && choice.action !== undefined ? choice.action : random();
  }

  view(): SessionView {
    const match = this.#match;
    const seats = match?.players ?? seatIds(Math.max(this.#playerCount, 0));
    const moves = this.#moves.map((entry, index) => ({ number: index + 1, seat: entry.move.player, action: entry.move.action, bot: entry.bot }));
    return {
      playerCount: this.#playerCount,
      seed: this.#seed,
      options: this.#options,
      version: match?.version,
      result: match?.result,
      ...(this.#realtime
        ? {
            realtime: {
              tick: match?.tick ?? 0,
              running: this.#running && this.#problem === undefined && match !== undefined && match.result === undefined,
              speed: this.#speed,
              inputs: this.#inputCount,
            },
          }
        : {}),
      screen: match === undefined ? undefined : screenSnapshot(match),
      seats: seats.map((seat) => ({
        seat,
        name: seatName(seat),
        bot: this.#bots.has(seat),
        paused: this.#paused.has(seat),
        away: this.#playOn && this.#away.has(seat) && !this.#bots.has(seat),
        snapshot: match === undefined ? undefined : playerSnapshot(match, seat),
        profile: this.#profiles[seat] ?? emptyProfile(),
        guest: this.#guests.includes(seat),
      })),
      state: match?.state,
      moves: this.#realtime ? moves.slice(-realtimeMovesShown) : moves,
      problem: this.#problem,
      botProblems: [...this.#botProblems.values()],
      note: this.#note,
    };
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#botTimer);
    this.#stopTicker();
    this.#rejectInputs("no-match", "dev is shutting down");
  }

  async idle(): Promise<void> {
    await this.#queue;
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #changed(): void {
    this.#onChange();
    this.#scheduleBot();
  }

  #input(seat: string, action: unknown): Promise<MoveResult> {
    const match = this.#match;
    if (match === undefined || match.result !== undefined) {
      return Promise.resolve({ ok: false, code: match === undefined ? "no-match" : "game-over", message: "No match is running" });
    }
    if (!this.#allow(seat)) {
      return Promise.resolve({ ok: false, code: "rate-limited", message: `More than ${inputsPerSecond} inputs per second; the platform rejects them the same way` });
    }
    const legal = isLegal(match.moves[seat] ?? [], action);
    if (!this.#accepting()) {
      this.#deferred.delete(seat);
      this.#deferred.set(seat, { action, legal });
      return Promise.resolve({ ok: true });
    }
    const waiting = this.#inputs.filter((entry) => entry.seat === seat);
    if (waiting.length >= maxInputsPerSeat) {
      const oldest = waiting[0] as Pending;
      this.#inputs.splice(this.#inputs.indexOf(oldest), 1);
      oldest.resolve({ ok: false, code: "too-many-inputs", message: "Too many inputs at once; the oldest one expired" });
    }
    return new Promise((resolve) => this.#inputs.push({ seat, action, legal, resolve }));
  }

  #accepting(): boolean {
    return this.#running && this.#problem === undefined;
  }

  #allow(seat: string): boolean {
    const now = this.#now();
    const recent = (this.#rate.get(seat) ?? []).filter((at) => now - at < 1000);
    if (recent.length >= inputsPerSecond) {
      this.#rate.set(seat, recent);
      return false;
    }
    recent.push(now);
    this.#rate.set(seat, recent);
    return true;
  }

  #defer(): void {
    for (const entry of this.#inputs.splice(0)) {
      this.#deferred.delete(entry.seat);
      this.#deferred.set(entry.seat, { action: entry.action, legal: entry.legal });
      entry.resolve({ ok: true });
    }
  }

  #release(): void {
    for (const [seat, entry] of this.#deferred) {
      this.#inputs.push({ seat, action: entry.action, legal: entry.legal, resolve: () => undefined });
    }
    this.#deferred.clear();
  }

  async #run(fn: "stepMatch", input: string, expected: Expected): Promise<SandboxResult> {
    const result = await this.#engine.call(fn, input, expected);
    if (!result.ok && retryable.includes(result.failure.kind)) {
      return this.#engine.call(fn, input, expected);
    }
    return result;
  }

  async #tick(): Promise<void> {
    const match = this.#match;
    if (match === undefined || match.result !== undefined || match.tick === undefined) {
      return;
    }
    const botSeats = match.players.filter((seat) => this.#bots.has(seat));
    if (botSeats.length > 0 && this.#hasBot === undefined) {
      await this.#askBot(match, botSeats[0] as string);
      this.#hasBot ??= false;
    }
    const gameBots = this.#hasBot === true ? botSeats : [];
    const pending = this.#inputs.splice(0);
    const inputs = pending.map((entry) => ({ player: entry.seat, action: entry.action, bot: false, legal: entry.legal }));
    for (const seat of match.players) {
      const legal = match.moves[seat] ?? [];
      if (this.#bots.has(seat) && !gameBots.includes(seat) && legal.length > 0 && this.#pick(botInputOdds) === 0) {
        inputs.push({ player: seat, action: this.#fill(legal[this.#pick(legal.length)]), bot: true, legal: true });
      }
    }
    const away = this.#playOn ? match.players.filter((seat) => this.#away.has(seat) && !this.#bots.has(seat)) : [];
    const step = {
      inputs: inputs.map(({ player, action }) => ({ player, action })),
      now: this.#now(),
      dt: tickMs,
      ...(away.length === 0 ? {} : { away }),
      ...(gameBots.length === 0 ? {} : { bots: gameBots }),
    };
    const before = this.#profiles;
    const result = await this.#run("stepMatch", JSON.stringify({ match, step, profiles: before }), {
      seed: match.seed,
      players: match.players,
      ...withOptions(match.options),
      version: match.version + 1,
      tick: match.tick + 1,
      inputs: inputs.length,
    });
    if (this.#match !== match) {
      for (const entry of pending) {
        entry.resolve({ ok: false, code: "no-match", message: "A new match has started" });
      }
      return;
    }
    const outcome = this.#step(result, { tick: match.tick + 1 }, before);
    if (!outcome.ok) {
      this.#problem = outcome.problem ?? { source: "rules", title: `Tick ${match.tick + 1} failed`, message: outcome.message };
      this.#problem = { ...this.#problem, title: `${this.#problem.title}; the match is paused` };
      this.#log(this.#problem);
      for (const entry of pending) {
        entry.resolve({ ok: false, code: outcome.code, message: outcome.message });
      }
      this.#defer();
      this.#stopTicker();
      this.#changed();
      return;
    }
    for (const note of outcome.bots ?? []) {
      this.#botTrouble(note.player, note.message);
    }
    const results = outcome.results ?? [];
    inputs.forEach((input, index) => {
      const answer = results[index] ?? { ok: false, code: "game-error", message: "no answer to the input" };
      if (answer.ok) {
        this.#inputCount += 1;
        this.#moves.push({ move: { player: input.player, action: input.action, now: step.now }, bot: input.bot });
      } else if (!input.bot && !input.legal && (answer.code === "illegal-move" || answer.code === "not-your-turn")) {
        this.#log({
          source: "ui",
          title: `The UI of ${input.player} sent an input that is not legal`,
          message: `${answer.message}. A UI only sends inputs from snapshot.moves.`,
          seat: input.player,
          move: input.action,
        });
      }
    });
    if (this.#moves.length > realtimeMovesShown * 4) {
      this.#moves.splice(0, this.#moves.length - realtimeMovesShown);
    }
    pending.forEach((entry, index) => {
      const answer = results[index];
      entry.resolve(answer === undefined ? { ok: false, code: "game-error", message: "no answer to the input" } : answer.ok ? { ok: true } : { ok: false, code: answer.code, message: answer.message });
    });
    this.#match = outcome.match;
    if (outcome.profiles !== this.#profiles) {
      this.#profiles = outcome.profiles;
      this.#persist();
    }
    if (outcome.match.result !== undefined) {
      this.#stopTicker();
    }
    this.#onChange();
  }

  #syncTicker(): void {
    const match = this.#match;
    const wanted =
      this.#realtime && this.#timers && this.#running && this.#holds === 0 && !this.#closed && match !== undefined && match.result === undefined && this.#problem === undefined;
    if (!wanted) {
      this.#stopTicker();
      return;
    }
    if (this.#ticker !== undefined) {
      return;
    }
    let busy = false;
    const interval = tickMs / this.#speed;
    let due = performance.now();
    this.#ticker = setInterval(() => {
      const now = performance.now();
      if (busy || now < due) {
        return;
      }
      due = nextDue(due, now, interval);
      busy = true;
      void this.#serial(() => this.#tick()).finally(() => {
        busy = false;
      });
    }, 10);
    this.#ticker.unref?.();
  }

  #stopTicker(): void {
    if (this.#ticker !== undefined) {
      clearInterval(this.#ticker);
      this.#ticker = undefined;
    }
  }

  #rejectInputs(code: string, message: string): void {
    for (const entry of this.#inputs.splice(0)) {
      entry.resolve({ ok: false, code, message });
    }
  }

  #scheduleBot(): void {
    if (this.#botTimer !== undefined || this.#botBusy || this.#closed || this.#realtime) {
      return;
    }
    const match = this.#match;
    if (match === undefined || match.result !== undefined) {
      return;
    }
    const seat = match.players.find((player) => this.#bots.has(player) && !this.#paused.has(player) && (match.moves[player] ?? []).length > 0);
    if (seat === undefined) {
      return;
    }
    this.#botTimer = setTimeout(() => {
      this.#botTimer = undefined;
      const current = this.#match;
      const moves = current?.moves[seat] ?? [];
      if (current === undefined || !this.#bots.has(seat) || this.#paused.has(seat) || moves.length === 0) {
        this.#scheduleBot();
        return;
      }
      this.#botBusy = true;
      void this.#botAction(current, seat)
        .then((action) => this.move(seat, action, { expectedVersion: current.version, bot: true }))
        .finally(() => {
          this.#botBusy = false;
          this.#scheduleBot();
        });
    }, this.#botDelayMs);
  }

  editProfile(seat: string, raw: unknown): Promise<MoveResult> {
    return this.#serial(async () => {
      if (!seatIds(this.#playerCount).includes(seat)) {
        return { ok: false, code: "unknown-player", message: `The seat ${seat} does not exist` };
      }
      const problem = profileProblem(raw);
      if (problem !== undefined) {
        return { ok: false, code: "invalid-profile", message: `The profile of ${seat} does not fit: ${problem}. It has the form { "items": { "id": 2 }, "stats": { "name": 5 }, "flags": { "name": true } }.` };
      }
      const profile = readProfile(raw);
      const unknown = unknownIds(profile, this.#catalog());
      if (unknown !== undefined) {
        return { ok: false, code: "unknown-id", message: `The profile of ${seat} contains IDs that are not in manifest.json: ${unknown}.` };
      }
      this.#profiles = { ...this.#profiles, [seat]: profile };
      const match = this.#match;
      if (match === undefined) {
        this.#startProfiles = { ...this.#startProfiles, [seat]: cloneProfile(profile) };
      }
      if (!this.#realtime && match !== undefined) {
        this.#edits.push({ at: this.#moves.length, seat, profile: cloneProfile(profile) });
        if (match.result === undefined) {
          const refreshed = await this.#refreshMoves(match, this.#profiles);
          if (refreshed.ok) {
            this.#match = refreshed.match;
          } else {
            this.#problem = refreshed.problem ?? { source: "rules", title: "Recomputing the moves failed", message: refreshed.message, seat };
            this.#log(this.#problem);
          }
        }
      }
      this.#persist();
      this.#changed();
      return { ok: true };
    });
  }

  setGuest(seat: string, guest: boolean): Promise<MoveResult> {
    return this.#serial(async (): Promise<MoveResult> => {
      if (!seatIds(this.#playerCount).includes(seat)) {
        return { ok: false, code: "unknown-player", message: `The seat ${seat} does not exist` };
      }
      const saved = this.#store?.setGuest(seat, guest) ?? { ok: true };
      if (!saved.ok) {
        return saved;
      }
      if (this.#store === undefined) {
        this.#guests = guest ? [...new Set([...this.#guests, seat])] : this.#guests.filter((entry) => entry !== seat);
      }
      await this.#startMatch(this.#playerCount, randomSeed(), this.#options);
      return { ok: true };
    });
  }

  #persist(): void {
    if (this.#store === undefined || !this.#persistable) {
      return;
    }
    const saved = this.#store.save(this.#profiles, this.#guests);
    this.#saveProblem = saved.ok ? undefined : saved.message;
  }

  async #refreshMoves(match: AnyMatch, profiles: Profiles): Promise<Step> {
    const result = await this.#engine.call("refreshMatch", JSON.stringify({ match, profiles }), {
      seed: match.seed,
      players: match.players,
      ...withOptions(match.options),
      version: match.version + 1,
    });
    const refreshed = this.#step(result, { refresh: true }, profiles);
    return refreshed.ok && canonicalJson(refreshed.match.moves) === canonicalJson(match.moves) ? { ...refreshed, match } : refreshed;
  }

  async #create(start: Profiles): Promise<Step> {
    const players = seatIds(this.#playerCount);
    const options = withOptions(this.#options);
    const profiles: Profiles = Object.fromEntries(players.map((seat) => [seat, cloneProfile(start[seat] ?? emptyProfile())]));
    const result = await this.#engine.call("createMatch", JSON.stringify({ playerCount: this.#playerCount, seed: this.#seed, ...options, profiles }), {
      seed: this.#seed,
      players,
      ...options,
      version: 0,
      ...(this.#realtime ? { tick: 0 } : {}),
    });
    return this.#step(result, {}, profiles);
  }

  async #apply(match: AnyMatch, move: Move<unknown>, profiles: Profiles): Promise<Step> {
    const result = await this.#engine.call("applyMove", JSON.stringify({ match, move, profiles }), {
      seed: match.seed,
      players: match.players,
      ...withOptions(match.options),
      version: match.version + 1,
    });
    return this.#step(result, { move }, profiles);
  }

  #afterChanges(profiles: Profiles, changes: readonly ProfileChange[] | undefined): Profiles | string {
    if (changes === undefined || changes.length === 0) {
      return profiles;
    }
    const next: Profiles = Object.fromEntries(Object.entries(profiles).map(([seat, profile]) => [seat, cloneProfile(profile)]));
    for (const change of changes) {
      const profile = next[change.player] ?? emptyProfile();
      next[change.player] = profile;
      const problem = applyChange(profile, change, this.#catalog());
      if (problem !== undefined) {
        return problem.message;
      }
    }
    return next;
  }

  #step(result: SandboxResult, during: { move?: Move<unknown>; tick?: number; refresh?: boolean }, profiles: Profiles): Step {
    const move = during.move;
    if (!result.ok) {
      const problem: DevProblem = {
        source: "rules",
        title:
          during.tick !== undefined
            ? `Tick ${during.tick} failed`
            : during.refresh === true
              ? "The moves cannot be recomputed with the changed profile"
              : move === undefined
              ? "Cannot create the match"
              : `The move of ${move.player} failed`,
        message: result.failure.message,
        ...(result.failure.stack === undefined ? {} : { stack: this.#mapStack(result.failure.stack) }),
        ...(move === undefined ? {} : { seat: move.player, move: move.action }),
      };
      return { ok: false, code: "game-error", message: result.failure.message, problem };
    }
    const outcome = result.outcome;
    if (outcome.ok) {
      const next = this.#afterChanges(profiles, outcome.changes);
      if (typeof next === "string") {
        const problem: DevProblem = { source: "rules", title: "A profile change cannot be applied", message: next };
        return { ok: false, code: "game-error", message: next, problem };
      }
      return {
        ok: true,
        match: outcome.match as unknown as AnyMatch,
        ...(outcome.results === undefined ? {} : { results: outcome.results }),
        ...(outcome.bots === undefined ? {} : { bots: outcome.bots }),
        profiles: next,
      };
    }
    const error = outcome.error;
    if (error.code !== "game-error") {
      return { ok: false, code: error.code, message: error.message };
    }
    const problem: DevProblem = {
      source: "rules",
      title: `Error in ${error.phase ?? "the rules"}${error.player === undefined ? "" : ` for ${error.player}`}${during.tick === undefined ? "" : ` (tick ${during.tick})`}`,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: this.#mapStack(error.stack) }),
      ...(move === undefined ? {} : { seat: move.player, move: move.action }),
    };
    return { ok: false, code: error.code, message: error.message, problem };
  }
}

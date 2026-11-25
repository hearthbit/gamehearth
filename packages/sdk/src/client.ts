import { bridgeVersion, parsePlatformMessage, type MoveResult, type PlayerInfo } from "./bridge";
import type { PlayerSnapshot, ScreenSnapshot } from "./snapshot";
import type { AnyGameState, PerPlayerOf, PlayerId, PublicOf } from "./state";
import { tickMs } from "./match";
import type { GameOptions, OptionsShape } from "./options";
import { emptyProfile, type AnyCatalog, type CatalogIds, type Profile, type ProfileData } from "./profile";
import { isLanguage, primaryLanguage } from "./i18n";
import { soundProblem, type Sound } from "./sound";

export type { MoveResult, PlayerInfo, Role } from "./bridge";
export { connectSolo } from "./solo";
export { isPlaceholder } from "./placeholder";
export type { IntSpec, Placeholder, TextSpec } from "./placeholder";
export { defineTexts, localize } from "./i18n";
export type { Localized, Texts } from "./i18n";
export type { SoloGame, SoloOptions } from "./solo";
export { maxSaveBytes } from "./bridge";
export type { GameResult } from "./game";
export type { GameOptions, OptionValue } from "./options";
export type { AnyCatalog, CatalogIds, CatalogOf, Profile } from "./profile";
export type { GameState, PlayerId } from "./state";
export type { PlayerSnapshot, ScreenSnapshot } from "./snapshot";
export { soundNames } from "./sound";
export type { Note, Sound, SoundName, SoundNotes, SoundWave } from "./sound";

export interface SoundControl {
  readonly soundOn: boolean;
  sound(sound: Sound): boolean;
  onSound(listener: (on: boolean) => void): () => void;
}

interface SoundState {
  on: boolean;
  listeners: Set<(on: boolean) => void>;
}

export function soundChannel(post: (message: unknown) => void): { state: SoundState; control: SoundControl; receive(on: boolean): void } {
  const state: SoundState = { on: false, listeners: new Set() };
  return {
    state,
    receive(on) {
      if (state.on === on) {
        return;
      }
      state.on = on;
      for (const listener of [...state.listeners]) {
        listener(on);
      }
    },
    control: {
      get soundOn() {
        return state.on;
      },
      sound(sound) {
        const problem = soundProblem(sound);
        if (problem !== undefined) {
          (globalThis as { console?: { error(message: string): void } }).console?.error(`game.sound: ${problem}`);
          return false;
        }
        if (!state.on) {
          return false;
        }
        try {
          post({ gamehearth: bridgeVersion, type: "sound", sound });
        } catch {
          return false;
        }
        return true;
      },
      onSound(listener) {
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      },
    },
  };
}

export interface GameUpdate<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog> {
  snapshot: PlayerSnapshot<PublicOf<S>, PerPlayerOf<S>, A>;
  players: Record<PlayerId, PlayerInfo>;
  options: O;
  profile: Profile<C>;
  online: boolean;
  tickMs?: number;
}

export interface ScreenUpdate<S extends AnyGameState, O extends OptionsShape<O> = GameOptions> {
  snapshot: ScreenSnapshot<PublicOf<S>>;
  players: Record<PlayerId, PlayerInfo>;
  options: O;
  online: boolean;
  tickMs?: number;
}

export interface GameConnection<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog> extends SoundControl {
  readonly role: "player" | "controller";
  readonly seat: PlayerId;
  readonly language: string;
  readonly current: GameUpdate<S, A, O, C>;
  onUpdate(listener: (update: GameUpdate<S, A, O, C>) => void): () => void;
  move(action: A): Promise<MoveResult>;
}

export interface ScreenConnection<S extends AnyGameState, O extends OptionsShape<O> = GameOptions> extends SoundControl {
  readonly role: "screen";
  readonly language: string;
  readonly current: ScreenUpdate<S, O>;
  onUpdate(listener: (update: ScreenUpdate<S, O>) => void): () => void;
}

export interface MessageEventLike {
  data: unknown;
  source: unknown;
}

export interface ConnectOptions {
  parent?: { postMessage(message: unknown, targetOrigin: string): void };
  events?: {
    addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
    removeEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  };
  connectTimeoutMs?: number;
  moveTimeoutMs?: number;
  screen?: boolean;
}

interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function connect<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog>(
  options?: ConnectOptions & { screen?: false },
): Promise<GameConnection<S, A, O, C>>;
export function connect<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog>(
  options: ConnectOptions & { screen: true },
): Promise<GameConnection<S, A, O, C> | ScreenConnection<S, O>>;
export function connect<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog>(
  options: ConnectOptions = {},
): Promise<GameConnection<S, A, O, C> | ScreenConnection<S, O>> {
  const global = globalThis as unknown as { parent?: ConnectOptions["parent"] } & ConnectOptions["events"] & Timers;
  const embedder = options.parent ?? global.parent;
  const events = options.events ?? global;
  const timers: Timers = global;
  if (embedder === undefined || events === undefined || embedder === (globalThis as unknown)) {
    return Promise.reject(new Error("The game is not running in Gamehearth: there is no platform window that embedded it."));
  }
  const parent = embedder;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const moveTimeoutMs = options.moveTimeoutMs ?? 15_000;
  const allowScreen = options.screen === true;

  type Update = GameUpdate<S, A, O, C> | ScreenUpdate<S, O>;
  type Connection = { role: "player" | "controller" | "screen"; seat: PlayerId | null; language: string; current: Update };

  return new Promise((resolve, reject) => {
    let connection: Connection | undefined;
    let settled = false;
    const listeners = new Set<(update: Update) => void>();
    const pending = new Map<number, { resolve: (result: MoveResult) => void; timer: unknown }>();
    let nextId = 1;
    const sounds = soundChannel((message) => parent.postMessage(message, "*"));

    const fail = (error: Error) => {
      settled = true;
      timers.clearTimeout(timeout);
      events.removeEventListener("message", receive);
      reject(error);
    };

    const timeout = timers.setTimeout(() => {
      if (!settled) {
        fail(new Error(`The platform did not get in touch within ${connectTimeoutMs} ms.`));
      }
    }, connectTimeoutMs);

    function receive(event: MessageEventLike): void {
      if (event.source !== parent) {
        return;
      }
      const message = parsePlatformMessage(event.data);
      if (message === undefined || message.type === "solo") {
        return;
      }
      if (message.type === "settings") {
        sounds.receive(message.sound);
        return;
      }
      if (message.type === "refused") {
        if (connection === undefined) {
          fail(new Error(message.message));
        }
        return;
      }
      if (message.type === "result") {
        const waiting = pending.get(message.id);
        if (waiting !== undefined) {
          pending.delete(message.id);
          timers.clearTimeout(waiting.timer);
          waiting.resolve(message.ok ? { ok: true } : { ok: false, code: message.code, message: message.message });
        }
        return;
      }
      const base = {
        snapshot: message.snapshot,
        players: message.players,
        options: message.options,
        ...(message.role === "screen" ? {} : { profile: frozenProfile(message.profile) }),
        online: message.online,
      };
      const update = (message.tickMs === undefined ? base : { ...base, tickMs: message.tickMs }) as unknown as Update;
      if (connection === undefined) {
        if (message.role === "screen" && !allowScreen) {
          fail(
            new Error(
              "The platform opened the game as a TV (role screen). Games with a TV call connect({ screen: true }) and then branch on game.role.",
            ),
          );
          return;
        }
        settled = true;
        timers.clearTimeout(timeout);
        connection = { role: message.role, seat: message.seat, language: message.language ?? browserLanguage(), current: update };
        resolve(message.role === "screen" ? screenApi(connection) : gameApi(connection));
        return;
      }
      if (message.role !== connection.role || message.seat !== connection.seat) {
        return;
      }
      connection.current = update;
      for (const listener of [...listeners]) {
        listener(update);
      }
    }

    function subscribe<U extends Update>(state: Connection, listener: (update: U) => void): () => void {
      const wrapped = listener as (update: Update) => void;
      listeners.add(wrapped);
      wrapped(state.current);
      return () => {
        listeners.delete(wrapped);
      };
    }

    function screenApi(state: Connection): ScreenConnection<S, O> {
      return {
        role: "screen",
        language: state.language,
        get soundOn() {
          return sounds.control.soundOn;
        },
        sound: sounds.control.sound,
        onSound: sounds.control.onSound,
        get current() {
          return state.current as ScreenUpdate<S, O>;
        },
        onUpdate(listener) {
          return subscribe(state, listener);
        },
      };
    }

    function gameApi(state: Connection): GameConnection<S, A, O, C> {
      return {
        get role() {
          return state.role as "player" | "controller";
        },
        get seat() {
          return state.seat as PlayerId;
        },
        language: state.language,
        get soundOn() {
          return sounds.control.soundOn;
        },
        sound: sounds.control.sound,
        onSound: sounds.control.onSound,
        get current() {
          return state.current as GameUpdate<S, A, O, C>;
        },
        onUpdate(listener) {
          return subscribe(state, listener);
        },
        move(action) {
          const id = nextId++;
          const expectedVersion = (state.current as GameUpdate<S, A, O, C>).snapshot.version;
          return new Promise<MoveResult>((done) => {
            const timer = timers.setTimeout(() => {
              pending.delete(id);
              done({ ok: false, code: "timeout", message: `The platform did not confirm the move within ${moveTimeoutMs} ms.` });
            }, moveTimeoutMs);
            pending.set(id, { resolve: done, timer });
            try {
              parent.postMessage({ gamehearth: bridgeVersion, type: "move", id, action, expectedVersion }, "*");
            } catch (error) {
              pending.delete(id);
              timers.clearTimeout(timer);
              done({ ok: false, code: "illegal-move", message: `The move cannot be sent: ${error instanceof Error ? error.message : String(error)}` });
            }
          });
        },
      };
    }

    events.addEventListener("message", receive);
    parent.postMessage({ gamehearth: bridgeVersion, type: "ready" }, "*");
  });
}

export function browserLanguage(): string {
  const language = (globalThis as { navigator?: { language?: unknown } }).navigator?.language;
  if (typeof language === "string") {
    const base = primaryLanguage(language);
    if (isLanguage(base)) {
      return base;
    }
  }
  return "en";
}

function frozenProfile(profile: ProfileData | undefined): Profile {
  const source = profile ?? emptyProfile();
  return Object.freeze({ items: Object.freeze(source.items), stats: Object.freeze(source.stats), flags: Object.freeze(source.flags) });
}

export interface Frame<T> {
  from: T;
  to: T;
  alpha: number;
}

export interface Timeline<T> {
  readonly latest: T | undefined;
  frame(now?: number): Frame<T> | undefined;
  dispose(): void;
}

export interface TimelineSource<T> {
  onUpdate(listener: (update: { snapshot: T; tickMs?: number }) => void): () => void;
}

export interface TimelineOptions {
  delayMs?: number;
  now?: () => number;
}

const keepMs = 1000;
const rebaseAfterMs = 250;
const drift = 0.02;

export function createTimeline<T extends { tick?: number }>(source: TimelineSource<T>, options: TimelineOptions = {}): Timeline<T> {
  const clock = options.now ?? (() => (globalThis as unknown as { performance: { now(): number } }).performance.now());
  let entries: { tick: number; snapshot: T }[] = [];
  let latest: T | undefined;
  let offset: number | undefined;
  let pace = tickMs;
  const delay = () => options.delayMs ?? 2 * pace;

  const receive = (snapshot: T, updatePace: number | undefined) => {
    latest = snapshot;
    const nextPace = updatePace ?? tickMs;
    if (nextPace !== pace) {
      pace = nextPace;
      offset = undefined;
    }
    const tick = snapshot.tick;
    if (typeof tick !== "number") {
      entries = [];
      offset = undefined;
      return;
    }
    const last = entries.at(-1);
    if (last !== undefined && tick < last.tick) {
      entries = [];
      offset = undefined;
    }
    if (last !== undefined && tick === last.tick) {
      last.snapshot = snapshot;
      return;
    }
    const sample = clock() - tick * pace;
    if (offset === undefined || sample < offset || sample - offset > rebaseAfterMs) {
      offset = sample;
    } else {
      offset += (sample - offset) * drift;
    }
    entries.push({ tick, snapshot });
    const oldest = tick - Math.max(keepMs, 10 * pace) / pace;
    while (entries.length > 2 && (entries[0] as { tick: number }).tick < oldest) {
      entries.shift();
    }
  };

  const unsubscribe = source.onUpdate((update) => receive(update.snapshot, update.tickMs));

  return {
    get latest() {
      return latest;
    },
    frame(now = clock()) {
      if (latest === undefined) {
        return undefined;
      }
      const newest = entries.at(-1);
      const oldest = entries[0];
      if (newest === undefined || oldest === undefined || offset === undefined) {
        return { from: latest, to: latest, alpha: 1 };
      }
      const target = (now - delay() - offset) / pace;
      if (target >= newest.tick) {
        return { from: newest.snapshot, to: newest.snapshot, alpha: 1 };
      }
      if (target <= oldest.tick) {
        return { from: oldest.snapshot, to: oldest.snapshot, alpha: 1 };
      }
      for (let index = entries.length - 1; index > 0; index--) {
        const from = entries[index - 1] as { tick: number; snapshot: T };
        const to = entries[index] as { tick: number; snapshot: T };
        if (target >= from.tick) {
          return { from: from.snapshot, to: to.snapshot, alpha: (target - from.tick) / (to.tick - from.tick) };
        }
      }
      return { from: oldest.snapshot, to: oldest.snapshot, alpha: 1 };
    },
    dispose() {
      unsubscribe();
    },
  };
}

export function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

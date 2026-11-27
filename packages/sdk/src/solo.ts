import { bridgeVersion, parsePlatformMessage, recordProblem, saveProblem } from "./bridge";
import { browserLanguage, soundChannel, type ConnectOptions, type MessageEventLike, type MusicControl, type SoundControl } from "./client";

export interface SoloGame<Save, Stat extends string = string> extends SoundControl, MusicControl {
  readonly language: string;
  readonly saved: Save | undefined;
  readonly best: Readonly<Partial<Record<Stat, number>>>;
  save(data: Save): Promise<void>;
  record(stat: Stat, value: number): Promise<void>;
}

export type SoloOptions = Pick<ConnectOptions, "parent" | "events" | "connectTimeoutMs"> & { requestTimeoutMs?: number };

interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function connectSolo<Save = unknown, Stat extends string = string>(options: SoloOptions = {}): Promise<SoloGame<Save, Stat>> {
  const global = globalThis as unknown as { parent?: ConnectOptions["parent"] } & ConnectOptions["events"] & Timers;
  const embedder = options.parent ?? global.parent;
  const events = options.events ?? global;
  const timers: Timers = global;
  if (embedder === undefined || events === undefined || embedder === (globalThis as unknown)) {
    return Promise.reject(new Error("The game is not running in Gamehearth: there is no platform window that embedded it."));
  }
  const parent = embedder;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;

  return new Promise((resolve, reject) => {
    let state: { saved: string | undefined; best: Partial<Record<Stat, number>> } | undefined;
    let settled = false;
    let nextId = 1;
    const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: unknown; saved?: string }>();
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
      if (message === undefined) {
        return;
      }
      if (message.type === "settings") {
        sounds.receive(message.sound, message.music);
        return;
      }
      if (message.type === "refused") {
        if (state === undefined && !settled) {
          fail(new Error(message.message));
        }
        return;
      }
      if (message.type === "update") {
        if (state === undefined && !settled) {
          fail(
            new Error(
              "The platform opened the game in a room. connectSolo() is only for single-player games without a reducer (mode \"single\", server false); games with a reducer call connect().",
            ),
          );
        }
        return;
      }
      if (message.type === "solo") {
        const best = Object.freeze(Object.assign(Object.create(null) as object, message.best)) as Partial<Record<Stat, number>>;
        if (state === undefined) {
          if (settled) {
            return;
          }
          settled = true;
          timers.clearTimeout(timeout);
          state = { saved: message.saved === null ? undefined : JSON.stringify(message.saved), best };
          resolve(api(state, message.language ?? browserLanguage()));
          return;
        }
        state.best = best;
        return;
      }
      const waiting = pending.get(message.id);
      if (waiting === undefined) {
        return;
      }
      pending.delete(message.id);
      timers.clearTimeout(waiting.timer);
      if (message.ok) {
        if (state !== undefined && "saved" in waiting) {
          state.saved = waiting.saved;
        }
        waiting.resolve();
      } else {
        waiting.reject(new Error(message.message));
      }
    }

    function request(message: Record<string, unknown>, saved?: { value: string }): Promise<void> {
      const id = nextId++;
      return new Promise<void>((done, refuse) => {
        const timer = timers.setTimeout(() => {
          pending.delete(id);
          refuse(new Error(`The platform did not answer within ${requestTimeoutMs} ms.`));
        }, requestTimeoutMs);
        pending.set(id, saved === undefined ? { resolve: done, reject: refuse, timer } : { resolve: done, reject: refuse, timer, saved: saved.value });
        try {
          parent.postMessage({ gamehearth: bridgeVersion, id, ...message }, "*");
        } catch (error) {
          pending.delete(id);
          timers.clearTimeout(timer);
          refuse(new Error(`The message to the platform cannot be sent: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    }

    function api(current: { saved: string | undefined; best: Partial<Record<Stat, number>> }, language: string): SoloGame<Save, Stat> {
      return {
        language,
        get soundOn() {
          return sounds.control.soundOn;
        },
        sound: sounds.control.sound,
        onSound: sounds.control.onSound,
        get musicOn() {
          return sounds.control.musicOn;
        },
        music: sounds.control.music,
        onMusic: sounds.control.onMusic,
        get saved() {
          return current.saved === undefined ? undefined : (JSON.parse(current.saved) as Save);
        },
        get best() {
          return current.best;
        },
        save(data) {
          const problem = saveProblem(data);
          if (problem !== undefined) {
            return Promise.reject(new Error(problem));
          }
          const text = JSON.stringify(data);
          return request({ type: "save", data: JSON.parse(text) as unknown }, { value: text });
        },
        record(stat, value) {
          const problem = recordProblem(stat, value);
          if (problem !== undefined) {
            return Promise.reject(new Error(problem));
          }
          return request({ type: "record", stat, value });
        },
      };
    }

    events.addEventListener("message", receive);
    parent.postMessage({ gamehearth: bridgeVersion, type: "solo-ready" }, "*");
  });
}

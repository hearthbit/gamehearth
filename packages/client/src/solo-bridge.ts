import { bridgeVersion, parseGameMessage, type MusicTrack, type PlatformMessage, type Sound } from "@gamehearth/sdk/platform";
import type { StatSpec } from "./protocol";

export interface SoloBridgeOptions {
  post: (message: PlatformMessage) => void;
  stats: Record<string, StatSpec>;
  saved: () => unknown;
  best: () => Record<string, number>;
  save: (data: unknown) => void;
  record: (stat: string, value: number) => void;
  onReady?: (saved: unknown) => void;
  language?: string;
  sound?: (sound: Sound) => void;
  soundOn?: boolean;
  music?: (track: MusicTrack | null) => void;
  musicOn?: boolean;
}

export const soloTexts = {
  useConnectSolo: "This game is a single-player game without a reducer and runs without a room. It calls connectSolo() from @gamehearth/sdk/client, not connect().",
  noMoves: "Single-player games without a reducer have no moves; the save and best scores go through game.save() and game.record().",
  unknownStat: (stat: string, known: string[]) =>
    `The best score "${stat}" does not exist. ${known.length === 0 ? "The manifest has none under stats yet." : `The manifest lists under stats: ${known.join(", ")}.`}`,
};

export class SoloBridge {
  readonly #options: SoloBridgeOptions;
  #ready = false;
  #soundOn: boolean;
  #musicOn: boolean;
  #track: MusicTrack | null = null;

  constructor(options: SoloBridgeOptions) {
    this.#options = options;
    this.#soundOn = options.soundOn ?? false;
    this.#musicOn = this.#soundOn && (options.musicOn ?? false);
  }

  setAudio(sound: boolean, music: boolean): void {
    const musicOn = sound && music;
    if (sound === this.#soundOn && musicOn === this.#musicOn) {
      return;
    }
    const musicChanged = musicOn !== this.#musicOn;
    this.#soundOn = sound;
    this.#musicOn = musicOn;
    if (this.#ready) {
      this.#postSettings();
    }
    if (musicChanged) {
      this.#options.music?.(musicOn ? this.#track : null);
    }
  }

  #postSettings(): void {
    this.#options.post({ gamehearth: bridgeVersion, type: "settings", sound: this.#soundOn, music: this.#musicOn });
  }

  get ready(): boolean {
    return this.#ready;
  }

  receive(data: unknown): void {
    const message = parseGameMessage(data);
    if (message === undefined) {
      return;
    }
    const post = this.#options.post;
    if (message.type === "ready") {
      post({ gamehearth: bridgeVersion, type: "refused", message: soloTexts.useConnectSolo });
      return;
    }
    if (message.type === "sound") {
      if (this.#soundOn) {
        this.#options.sound?.(message.sound);
      }
      return;
    }
    if (message.type === "music") {
      this.#track = message.track;
      if (this.#musicOn) {
        this.#options.music?.(message.track);
      }
      return;
    }
    if (message.type === "solo-ready") {
      this.#ready = true;
      this.#track = null;
      this.#options.music?.(null);
      this.#postSettings();
      const saved = this.#state();
      this.#options.onReady?.(saved);
      return;
    }
    if (message.type === "move") {
      post({ gamehearth: bridgeVersion, type: "result", id: message.id, ok: false, code: "solo-game", message: soloTexts.noMoves });
      return;
    }
    if (message.problem !== undefined) {
      post({ gamehearth: bridgeVersion, type: "result", id: message.id, ok: false, code: message.type === "save" ? "invalid-save" : "invalid-stat", message: message.problem });
      return;
    }
    try {
      if (message.type === "save") {
        this.#options.save(message.data);
      } else {
        const stats = this.#options.stats;
        if (!Object.hasOwn(stats, message.stat)) {
          post({ gamehearth: bridgeVersion, type: "result", id: message.id, ok: false, code: "invalid-stat", message: soloTexts.unknownStat(message.stat, Object.keys(stats)) });
          return;
        }
        this.#options.record(message.stat, message.value);
        this.#state();
      }
    } catch (error) {
      post({ gamehearth: bridgeVersion, type: "result", id: message.id, ok: false, code: "platform-error", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    post({ gamehearth: bridgeVersion, type: "result", id: message.id, ok: true });
  }

  #state(): unknown {
    const saved = this.#options.saved();
    const language = this.#options.language;
    this.#options.post({
      gamehearth: bridgeVersion,
      type: "solo",
      saved: saved === undefined ? null : saved,
      best: this.#options.best(),
      ...(language === undefined ? {} : { language }),
    });
    return saved;
  }
}

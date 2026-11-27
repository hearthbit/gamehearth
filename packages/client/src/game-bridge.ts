import { bridgeVersion, parseGameMessage, type BridgeUpdate, type MoveResult, type MusicTrack, type PlatformMessage, type PlayerInfo, type Sound } from "@gamehearth/sdk/platform";
import { gameLanguage, seatName } from "./language";
import type { MemberView, RoomGame, RoomView, ScreenView } from "./protocol";

export const roomTexts = {
  noSolo: "This game runs in a room. connectSolo() exists only for single-player games without a reducer (mode \"single\", server false); games with a reducer call connect().",
};

export interface BridgeOptions {
  post: (message: PlatformMessage) => void;
  move: (action: unknown, expectedVersion: number) => Promise<MoveResult>;
  sound?: (sound: Sound) => void;
  soundOn?: boolean;
  music?: (track: MusicTrack | null) => void;
  musicOn?: boolean;
}

function seatedPlayers(members: readonly MemberView[]): Record<string, PlayerInfo> {
  const players: Record<string, PlayerInfo> = {};
  for (const member of members) {
    if (member.seat === null) {
      continue;
    }
    players[member.seat] =
      member.bot !== undefined || member.autopilot === true
        ? { name: seatName(member), connected: true, you: member.you, bot: true }
        : { name: seatName(member), connected: member.connected, you: member.you };
  }
  return players;
}

export function seatRole(game: RoomGame): "player" | "controller" {
  return game.roles === undefined || game.roles.includes("player") || !game.roles.includes("controller") ? "player" : "controller";
}

export function bridgeUpdate(room: RoomView | ScreenView, online: boolean): BridgeUpdate | undefined {
  if (room.snapshot === undefined) {
    return undefined;
  }
  const language = gameLanguage(room.game.languages);
  const spoken = language === undefined ? {} : { language };
  if (!("you" in room)) {
    return { seat: null, role: "screen", snapshot: room.snapshot, players: seatedPlayers(room.members), options: room.options?.values ?? {}, online, ...spoken };
  }
  const seat = room.you.seat;
  if (seat === null) {
    return undefined;
  }
  return {
    seat,
    role: seatRole(room.game),
    snapshot: room.snapshot,
    players: seatedPlayers(room.members),
    options: room.options?.values ?? {},
    ...(room.profile === undefined ? {} : { profile: room.profile }),
    online,
    ...spoken,
  };
}

export class GameBridge {
  readonly #options: BridgeOptions;
  #ready = false;
  #latest: BridgeUpdate | undefined;
  #sent: string | undefined;
  #soundOn: boolean;
  #musicOn: boolean;
  #track: MusicTrack | null = null;

  constructor(options: BridgeOptions) {
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

  update(room: RoomView | ScreenView, online: boolean): void {
    this.#latest = bridgeUpdate(room, online);
    this.#flush();
  }

  receive(data: unknown): void {
    const message = parseGameMessage(data);
    if (message === undefined) {
      return;
    }
    if (message.type === "ready") {
      this.#ready = true;
      this.#sent = undefined;
      this.#track = null;
      this.#options.music?.(null);
      this.#postSettings();
      this.#flush();
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
      this.#options.post({ gamehearth: bridgeVersion, type: "refused", message: roomTexts.noSolo });
      return;
    }
    if (message.type !== "move") {
      this.#options.post({ gamehearth: bridgeVersion, type: "result", id: message.id, ok: false, code: "not-solo", message: roomTexts.noSolo });
      return;
    }
    const id = message.id;
    void this.#options.move(message.action, message.expectedVersion).then(
      (result) => this.#options.post({ gamehearth: bridgeVersion, type: "result", id, ...result }),
      (error: unknown) =>
        this.#options.post({ gamehearth: bridgeVersion, type: "result", id, ok: false, code: "platform-error", message: error instanceof Error ? error.message : String(error) }),
    );
  }

  #flush(): void {
    if (!this.#ready || this.#latest === undefined) {
      return;
    }
    const serialized = JSON.stringify(this.#latest);
    if (serialized === this.#sent) {
      return;
    }
    this.#sent = serialized;
    this.#options.post({ gamehearth: bridgeVersion, type: "update", ...this.#latest });
  }
}

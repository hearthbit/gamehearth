import { applyJsonDelta, type PlayerSnapshot, type ScreenSnapshot } from "@gamehearth/sdk/platform";
import { parseServerMessage, type Command, type CommandResult, type Pairing, type RoomView, type ScreenView } from "./protocol";

export type ConnectionStatus = "connecting" | "online" | "offline";

export interface ConnectionState {
  status: ConnectionStatus;
  room: RoomView | undefined;
  fatal: { code: string; message: string } | undefined;
  screen?: ScreenView | undefined;
  pairing?: Pairing | undefined;
}

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ConnectionOptions {
  code: string;
  url: string;
  createSocket?: (url: string) => SocketLike;
  timers?: Timers;
  commandTimeoutMs?: number;
  visible?: () => boolean;
  screen?: boolean;
  onState: (state: ConnectionState) => void;
  onNotice: (code: string, message: string) => void;
}

const fatalCodes = new Set(["removed", "room-closed", "unknown-room", "not-member", "not-signed-in", "signed-out", "no-device"]);
const backoffMs = [500, 1000, 2000, 4000, 8000, 15000];
const probeMs = 5000;
const openState = 1;

function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export function socketUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

export class RoomConnection {
  readonly #options: ConnectionOptions;
  readonly #timers: Timers;
  readonly #pending = new Map<number, { resolve: (result: CommandResult) => void; timer: unknown }>();
  #socket: SocketLike | undefined;
  #state: ConnectionState = { status: "connecting", room: undefined, fatal: undefined };
  #attempt = 0;
  #retry: unknown;
  #probe: unknown;
  #nextId = 1;
  #disposed = false;
  #resyncing = false;

  constructor(options: ConnectionOptions) {
    this.#options = options;
    this.#timers = options.timers ?? (globalThis as unknown as Timers);
  }

  get state(): ConnectionState {
    return this.#state;
  }

  start(): void {
    this.#open();
  }

  reconnectNow(): void {
    if (this.#disposed || this.#state.fatal !== undefined) {
      return;
    }
    const socket = this.#socket;
    if (socket !== undefined) {
      if (socket.readyState === openState && this.#probe === undefined) {
        socket.send(this.#hello());
        this.#probe = this.#timers.setTimeout(() => {
          this.#probe = undefined;
          this.#lost(socket);
        }, probeMs);
      }
      return;
    }
    this.#timers.clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#attempt = 0;
    this.#open();
  }

  reportVisibility(): void {
    const socket = this.#socket;
    if (socket !== undefined && socket.readyState === openState && !this.#disposed && this.#options.screen !== true) {
      socket.send(JSON.stringify({ type: "visibility", visible: this.#visible() }));
    }
  }

  command(command: Command): Promise<CommandResult> {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== openState || this.#state.status !== "online") {
      return Promise.resolve({ ok: false, code: "offline", message: "No connection to the server." });
    }
    const id = this.#nextId++;
    return new Promise((resolve) => {
      const timer = this.#timers.setTimeout(() => {
        this.#pending.delete(id);
        resolve({ ok: false, code: "timeout", message: "Der Server hat nicht rechtzeitig geantwortet." });
        this.#lost(socket);
      }, this.#options.commandTimeoutMs ?? 15_000);
      this.#pending.set(id, { resolve, timer });
      socket.send(JSON.stringify({ ...command, id }));
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#timers.clearTimeout(this.#retry);
    this.#timers.clearTimeout(this.#probe);
    this.#failPending();
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close(1000, "verlassen");
  }

  #open(): void {
    const socket = (this.#options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike))(this.#options.url);
    this.#socket = socket;
    this.#resyncing = false;
    this.#update({ status: this.#state.room === undefined ? "connecting" : "offline" });
    socket.onopen = () => {
      socket.send(this.#hello());
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket) {
        return;
      }
      this.#timers.clearTimeout(this.#probe);
      this.#probe = undefined;
      this.#receive(event.data);
    };
    socket.onerror = () => undefined;
    socket.onclose = () => this.#lost(socket);
  }

  #visible(): boolean {
    return (this.#options.visible ?? pageVisible)();
  }

  #hello(): string {
    if (this.#options.screen === true) {
      return JSON.stringify({ type: "screen", deltas: true });
    }
    return JSON.stringify({ type: "hello", room: this.#options.code, visible: this.#visible(), deltas: true });
  }

  #lost(socket: SocketLike): void {
    if (this.#socket !== socket) {
      return;
    }
    this.#socket = undefined;
    this.#timers.clearTimeout(this.#probe);
    this.#probe = undefined;
    if (socket.readyState !== 3) {
      socket.close(4002, "keine Antwort");
    }
    this.#failPending();
    if (this.#disposed || this.#state.fatal !== undefined) {
      return;
    }
    this.#update({ status: "offline" });
    const delay = backoffMs[Math.min(this.#attempt, backoffMs.length - 1)] as number;
    this.#attempt++;
    this.#retry = this.#timers.setTimeout(() => {
      this.#retry = undefined;
      if (!this.#disposed) {
        this.#open();
      }
    }, delay);
  }

  #receive(data: unknown): void {
    const message = parseServerMessage(data);
    if (message === undefined) {
      return;
    }
    if (message.type === "room") {
      this.#attempt = 0;
      this.#resyncing = false;
      this.#update({ status: "online", room: message.room });
      return;
    }
    if (message.type === "screen-room") {
      this.#attempt = 0;
      this.#resyncing = false;
      this.#update({ status: "online", screen: message.room, pairing: undefined });
      return;
    }
    if (message.type === "pairing") {
      this.#attempt = 0;
      this.#update({
        status: "online",
        screen: undefined,
        pairing: message.expiresInMs === undefined ? { code: message.code, expiresAt: message.expiresAt } : { code: message.code, expiresAt: message.expiresAt, expiresInMs: message.expiresInMs },
      });
      return;
    }
    if (message.type === "frame") {
      if ("delta" in message) {
        this.#delta(message.base, message.delta);
      } else {
        this.#resyncing = false;
        this.#frame(message.snapshot);
      }
      return;
    }
    if (message.type === "ack") {
      this.#settle(message.id, { ok: true });
      return;
    }
    if (message.id !== undefined && this.#pending.has(message.id)) {
      this.#settle(message.id, { ok: false, code: message.code, message: message.message });
      return;
    }
    if (fatalCodes.has(message.code)) {
      this.#update({ status: "offline", fatal: { code: message.code, message: message.message } });
      const socket = this.#socket;
      this.#socket = undefined;
      this.#failPending();
      socket?.close(1000, message.code);
      return;
    }
    this.#options.onNotice(message.code, message.message);
  }

  #frame(snapshot: PlayerSnapshot<unknown, unknown, unknown> | ScreenSnapshot<unknown>): boolean {
    const { room, screen } = this.#state;
    if (room !== undefined && room.status === "running" && "player" in snapshot) {
      this.#update({ room: { ...room, snapshot } });
      return true;
    }
    if (screen !== undefined && screen.status === "running" && !("player" in snapshot)) {
      this.#update({ screen: { ...screen, snapshot } });
      return true;
    }
    return false;
  }

  #delta(base: number, delta: unknown[]): void {
    const current = this.#state.room?.snapshot ?? this.#state.screen?.snapshot;
    const applied = current?.version === base ? applyJsonDelta(current, delta) : undefined;
    const snapshot = applied?.ok === true ? applied.value : undefined;
    if (snapshot === null || typeof snapshot !== "object" || typeof (snapshot as { version?: unknown }).version !== "number" || !this.#frame(snapshot as ScreenSnapshot<unknown>)) {
      this.#resync();
    }
  }

  #resync(): void {
    const socket = this.#socket;
    if (!this.#resyncing && socket !== undefined && socket.readyState === openState) {
      this.#resyncing = true;
      socket.send(JSON.stringify({ type: "resync" }));
    }
  }

  #settle(id: number, result: CommandResult): void {
    const waiting = this.#pending.get(id);
    if (waiting !== undefined) {
      this.#pending.delete(id);
      this.#timers.clearTimeout(waiting.timer);
      waiting.resolve(result);
    }
  }

  #failPending(): void {
    for (const [id, waiting] of [...this.#pending]) {
      this.#pending.delete(id);
      this.#timers.clearTimeout(waiting.timer);
      waiting.resolve({ ok: false, code: "offline", message: "Die Verbindung zum Server ist abgebrochen." });
    }
  }

  #update(change: Partial<ConnectionState>): void {
    this.#state = { ...this.#state, ...change };
    this.#options.onState(this.#state);
  }
}

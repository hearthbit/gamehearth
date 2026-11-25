import { WebSocket, type ClientOptions } from "ws";
import type { ServerMessage } from "../src/protocol";
import type { RoomView } from "../src/rooms";

export interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  cookie: string | undefined;
}

export function sessionFrom(setCookie: string | null | undefined): string | undefined {
  const match = /(?:^|\s)(?:__Host-)?gh-session=([^;]*)/.exec(setCookie ?? "");
  return match === null ? undefined : match[1];
}

export async function postJson(base: string, path: string, body: unknown, token?: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { cookie: `gh-session=${token}` }), ...headers },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, cookie: sessionFrom(response.headers.get("set-cookie")) };
}

export async function getJson(base: string, path: string, token?: string): Promise<JsonResponse> {
  const response = await fetch(`${base}${path}`, { headers: token === undefined ? {} : { cookie: `gh-session=${token}` } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, cookie: sessionFrom(response.headers.get("set-cookie")) };
}

export class Client {
  readonly socket: WebSocket;
  readonly received: ServerMessage[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  #waiters: { match: (message: ServerMessage) => boolean; resolve: (message: ServerMessage) => void }[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.closed = new Promise((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      this.received.push(message);
      for (const waiter of [...this.#waiters]) {
        if (waiter.match(message)) {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
  }

  static async connect(port: number, options: ClientOptions & { token?: string } = {}): Promise<Client> {
    const { token, ...rest } = options;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      ...rest,
      headers: { ...rest.headers, ...(token === undefined ? {} : { cookie: `gh-session=${token}` }) },
    });
    const client = new Client(socket);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return client;
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  next(match: (message: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage> {
    const existing = this.received.find(match);
    if (existing !== undefined) {
      this.received.splice(this.received.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no matching message received")), timeoutMs);
      this.#waiters.push({
        match,
        resolve: (message) => {
          clearTimeout(timer);
          this.received.splice(this.received.indexOf(message), 1);
          resolve(message);
        },
      });
    });
  }

  async room(match: (room: RoomView) => boolean = () => true): Promise<RoomView> {
    const message = await this.next((candidate) => candidate.type === "room" && match(candidate.room));
    return (message as { type: "room"; room: RoomView }).room;
  }

  async error(): Promise<{ code: string; message: string }> {
    return (await this.next((message) => message.type === "error")) as { code: string; message: string };
  }

  close(): void {
    this.socket.close();
  }
}

export function settle(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

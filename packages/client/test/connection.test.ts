import { describe, expect, it } from "vitest";
import { RoomConnection, socketUrl, type ConnectionState, type SocketLike, type Timers } from "../src/connection";
import type { RoomView } from "../src/protocol";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed: { code: number | undefined; reason: string | undefined } | undefined;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

class FakeTimers implements Timers {
  now = 0;
  #next = 1;
  readonly scheduled = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.scheduled.set(id, { at: this.now + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.scheduled.delete(handle as number);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, entry] of [...this.scheduled].sort((a, b) => a[1].at - b[1].at)) {
      if (entry.at <= this.now && this.scheduled.has(id)) {
        this.scheduled.delete(id);
        entry.callback();
      }
    }
  }
}

const room = (status: RoomView["status"] = "lobby") => ({ code: "ABC234", status, round: 1, game: { name: "Mau-Mau" } }) as unknown as RoomView;

function setup() {
  const sockets: FakeSocket[] = [];
  const states: ConnectionState[] = [];
  const notices: [string, string][] = [];
  const timers = new FakeTimers();
  const connection = new RoomConnection({
    code: "ABC234",
    url: "ws://test/ws",
    timers,
    commandTimeoutMs: 1000,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onState: (state) => states.push(state),
    onNotice: (code, message) => notices.push([code, message]),
  });
  connection.start();
  return { connection, sockets, states, notices, timers, socket: () => sockets[sockets.length - 1] as FakeSocket };
}

describe("RoomConnection", () => {
  it("signs in with hello and takes over the snapshot", () => {
    const { connection, socket } = setup();
    expect(connection.state.status).toBe("connecting");
    socket().open();
    expect(socket().sent).toEqual([{ type: "hello", room: "ABC234", visible: true, deltas: true }]);
    socket().receive({ type: "room", room: room() });
    expect(connection.state).toMatchObject({ status: "online", room: { code: "ABC234" } });
  });

  it("matches replies by id", async () => {
    const { connection, socket } = setup();
    socket().open();
    socket().receive({ type: "room", room: room("running") });
    const first = connection.command({ type: "move", action: { type: "draw" }, expectedVersion: 3 });
    const second = connection.command({ type: "start" });
    expect(socket().sent.slice(1)).toEqual([
      { type: "move", action: { type: "draw" }, expectedVersion: 3, id: 1 },
      { type: "start", id: 2 },
    ]);
    socket().receive({ type: "error", code: "not-host", message: "nein", id: 2 });
    socket().receive({ type: "ack", id: 1 });
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: false, code: "not-host", message: "nein" });
  });

  it("answers offline right away instead of waiting", async () => {
    const { connection } = setup();
    await expect(connection.command({ type: "start" })).resolves.toMatchObject({ ok: false, code: "offline" });
  });

  it("reconnects after a drop with a growing pause and keeps the last snapshot", async () => {
    const { connection, sockets, socket, timers } = setup();
    socket().open();
    socket().receive({ type: "room", room: room() });
    const pending = connection.command({ type: "start" });
    socket().drop();
    await expect(pending).resolves.toMatchObject({ ok: false, code: "offline" });
    expect(connection.state).toMatchObject({ status: "offline", room: { code: "ABC234" } });
    timers.advance(499);
    expect(sockets).toHaveLength(1);
    timers.advance(1);
    expect(sockets).toHaveLength(2);
    socket().drop();
    timers.advance(999);
    expect(sockets).toHaveLength(2);
    timers.advance(1);
    expect(sockets).toHaveLength(3);
    socket().open();
    expect(socket().sent).toEqual([{ type: "hello", room: "ABC234", visible: true, deltas: true }]);
    socket().receive({ type: "room", room: room() });
    socket().drop();
    timers.advance(500);
    expect(sockets).toHaveLength(4);
  });

  it("reconnects at once on request, but not twice", () => {
    const { connection, sockets, socket } = setup();
    socket().open();
    socket().drop();
    connection.reconnectNow();
    connection.reconnectNow();
    expect(sockets).toHaveLength(2);
  });

  it("stops on fatal errors and reports them", () => {
    const { connection, sockets, socket, timers } = setup();
    socket().open();
    socket().receive({ type: "error", code: "removed", message: "Du bist nicht mehr Mitglied" });
    expect(connection.state.fatal).toEqual({ code: "removed", message: "Du bist nicht mehr Mitglied" });
    socket().drop();
    timers.advance(60_000);
    connection.reconnectNow();
    expect(sockets).toHaveLength(1);
  });

  it("passes other errors without id on as notices", () => {
    const { socket, notices } = setup();
    socket().open();
    socket().receive({ type: "error", code: "rate-limited", message: "langsam" });
    expect(notices).toEqual([["rate-limited", "langsam"]]);
  });

  it("reports a missing reply after the deadline as timeout", async () => {
    const { connection, socket, timers } = setup();
    socket().open();
    socket().receive({ type: "room", room: room() });
    const pending = connection.command({ type: "start" });
    timers.advance(1000);
    await expect(pending).resolves.toMatchObject({ ok: false, code: "timeout" });
  });

  it("gives up a connection on which a command gets no reply, and reconnects", async () => {
    const { connection, sockets, socket, timers } = setup();
    socket().open();
    socket().receive({ type: "room", room: room() });
    const first = socket();
    const pending = connection.command({ type: "start" });
    timers.advance(1000);
    await expect(pending).resolves.toMatchObject({ ok: false, code: "timeout" });
    expect(first.closed).toBeDefined();
    expect(connection.state.status).toBe("offline");
    timers.advance(500);
    expect(sockets).toHaveLength(2);
  });

  it("on wake-up checks a seemingly open connection with hello and gives it up without a reply", () => {
    const { connection, sockets, socket, timers } = setup();
    socket().open();
    socket().receive({ type: "room", room: room() });
    const first = socket();
    connection.reconnectNow();
    expect(first.sent.at(-1)).toEqual({ type: "hello", room: "ABC234", visible: true, deltas: true });
    timers.advance(4999);
    expect(sockets).toHaveLength(1);
    timers.advance(1);
    expect(first.closed).toBeDefined();
    expect(connection.state.status).toBe("offline");
    timers.advance(500);
    expect(sockets).toHaveLength(2);
  });

  it("keeps a connection that answers the check", () => {
    const { connection, sockets, socket, timers } = setup();
    socket().open();
    socket().receive({ type: "room", room: room() });
    connection.reconnectNow();
    socket().receive({ type: "room", room: room() });
    timers.advance(10_000);
    expect(sockets).toHaveLength(1);
    expect(connection.state.status).toBe("online");
  });

  it("closes on dispose and does not reconnect afterwards", () => {
    const { connection, sockets, socket, timers } = setup();
    socket().open();
    connection.dispose();
    expect(socket().closed).toEqual({ code: 1000, reason: "verlassen" });
    socket().drop();
    timers.advance(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("builds the address to match the page's scheme", () => {
    expect(socketUrl({ protocol: "https:", host: "games.example" })).toBe("wss://games.example/ws");
    expect(socketUrl({ protocol: "http:", host: "localhost:8080" })).toBe("ws://localhost:8080/ws");
  });
});

describe("Visibility", () => {
  it("names it in hello and reports changes while the connection is open", () => {
    let visible = false;
    const sockets: FakeSocket[] = [];
    const connection = new RoomConnection({
      code: "ABC234",
      url: "ws://test/ws",
      timers: new FakeTimers(),
      visible: () => visible,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onState: () => undefined,
      onNotice: () => undefined,
    });
    connection.start();
    const socket = sockets[0] as FakeSocket;
    connection.reportVisibility();
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent).toEqual([{ type: "hello", room: "ABC234", visible: false, deltas: true }]);
    visible = true;
    connection.reportVisibility();
    expect(socket.sent.at(-1)).toEqual({ type: "visibility", visible: true });
    connection.dispose();
    connection.reportVisibility();
    expect(socket.sent).toHaveLength(2);
  });
});

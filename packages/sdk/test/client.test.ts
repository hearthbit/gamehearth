import { describe, expect, it, vi } from "vitest";
import { connect, type MessageEventLike } from "../src/client";
import { parseGameMessage, parsePlatformMessage } from "../src/platform";

type Listener = (event: MessageEventLike) => void;

function fakePlatform() {
  const sent: unknown[] = [];
  const listeners = new Set<Listener>();
  const parent = {
    postMessage(message: unknown) {
      sent.push((globalThis as unknown as { structuredClone(value: unknown): unknown }).structuredClone(message));
    },
  };
  const events = {
    addEventListener: (_type: "message", listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: "message", listener: Listener) => listeners.delete(listener),
  };
  const deliver = (data: unknown, source: unknown = parent) => {
    for (const listener of [...listeners]) {
      listener({ data, source });
    }
  };
  return { parent, events, sent, listeners, deliver };
}

const players = { p1: { name: "Anna", connected: true, you: true }, p2: { name: "Ben", connected: false, you: false } };

function update(version: number, extra: Record<string, unknown> = {}) {
  return {
    gamehearth: 1,
    type: "update",
    seat: "p1",
    role: "player",
    snapshot: { player: "p1", players: ["p1", "p2"], public: { n: version }, me: {}, moves: [{ type: "go" }], version },
    players,
    online: true,
    ...extra,
  };
}

describe("connect", () => {
  it("registers with the platform and returns seat, update and names", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events });
    expect(platform.sent).toEqual([{ gamehearth: 1, type: "ready" }]);
    platform.deliver(update(3));
    const game = await pending;
    expect(game.seat).toBe("p1");
    expect(game.current.snapshot.version).toBe(3);
    expect(game.current.players["p1"]).toEqual({ name: "Anna", connected: true, you: true });
  });

  it("calls onUpdate right away with the current update and then on every change", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events });
    platform.deliver(update(1));
    const game = await pending;
    const seen: number[] = [];
    const stop = game.onUpdate((next) => seen.push(next.snapshot.version));
    platform.deliver(update(2));
    stop();
    platform.deliver(update(3));
    expect(seen).toEqual([1, 2]);
    expect(game.current.snapshot.version).toBe(3);
  });

  it("sends moves with the version of the last shown update and matches the answer to them", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events });
    platform.deliver(update(4));
    const game = await pending;
    const first = game.move({ type: "go" });
    platform.deliver(update(5));
    const second = game.move({ type: "go" });
    expect(platform.sent.slice(1)).toEqual([
      { gamehearth: 1, type: "move", id: 1, action: { type: "go" }, expectedVersion: 4 },
      { gamehearth: 1, type: "move", id: 2, action: { type: "go" }, expectedVersion: 5 },
    ]);
    platform.deliver({ gamehearth: 1, type: "result", id: 2, ok: false, code: "stale", message: "alt" });
    platform.deliver({ gamehearth: 1, type: "result", id: 1, ok: true });
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: false, code: "stale", message: "alt" });
  });

  it("ignores messages from other windows and in a foreign shape", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events, connectTimeoutMs: 50 });
    platform.deliver(update(1), {});
    platform.deliver({ ...update(1), gamehearth: 2 });
    platform.deliver({ ...update(1), players: { p1: { name: 7 } } });
    platform.deliver("hallo");
    await expect(pending).rejects.toThrow("did not get in touch within 50 ms");
    expect(platform.listeners.size).toBe(0);
  });

  it("rejects when the game is not embedded", async () => {
    await expect(connect({ parent: globalThis as never, events: fakePlatform().events })).rejects.toThrow("not running in Gamehearth");
  });

  it("reports a move without an answer after the deadline as timeout", async () => {
    vi.useFakeTimers();
    try {
      const platform = fakePlatform();
      const pending = connect({ parent: platform.parent, events: platform.events, moveTimeoutMs: 1000 });
      platform.deliver(update(1));
      const game = await pending;
      const result = game.move({ type: "go" });
      vi.advanceTimersByTime(1000);
      await expect(result).resolves.toMatchObject({ ok: false, code: "timeout" });
      platform.deliver({ gamehearth: 1, type: "result", id: 1, ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a move that cannot be sent instead of throwing", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events });
    platform.deliver(update(1));
    const game = await pending;
    await expect(game.move({ type: "go", f: () => 1 } as never)).resolves.toMatchObject({ ok: false, code: "illegal-move" });
  });
});

describe("parseGameMessage", () => {
  it("accepts ready and valid moves and copies the move", () => {
    expect(parseGameMessage({ gamehearth: 1, type: "ready" })).toEqual({ gamehearth: 1, type: "ready" });
    const action = { type: "play", card: "herz-7" };
    const parsed = parseGameMessage({ gamehearth: 1, type: "move", id: 3, action, expectedVersion: 9 });
    expect(parsed).toEqual({ gamehearth: 1, type: "move", id: 3, action, expectedVersion: 9 });
    expect(parsed?.type === "move" && parsed.action).not.toBe(action);
  });

  it.each([
    ["not an object", "move"],
    ["wrong protocol version", { gamehearth: 2, type: "ready" }],
    ["unknown type", { gamehearth: 1, type: "cheat" }],
    ["missing id", { gamehearth: 1, type: "move", action: {}, expectedVersion: 0 }],
    ["negative version", { gamehearth: 1, type: "move", id: 1, action: {}, expectedVersion: -1 }],
    ["move missing", { gamehearth: 1, type: "move", id: 1, expectedVersion: 0 }],
    ["move with a Map", { gamehearth: 1, type: "move", id: 1, action: new Map(), expectedVersion: 0 }],
    ["move too large", { gamehearth: 1, type: "move", id: 1, action: "x".repeat(17_000), expectedVersion: 0 }],
    ["move too deep", { gamehearth: 1, type: "move", id: 1, action: nest(40), expectedVersion: 0 }],
  ])("discards %s", (_label, data) => {
    expect(parseGameMessage(data)).toBeUndefined();
  });
});

describe("parsePlatformMessage", () => {
  it("reads updates and results", () => {
    expect(parsePlatformMessage(update(2))).toMatchObject({ type: "update", seat: "p1", online: true });
    expect(parsePlatformMessage({ gamehearth: 1, type: "result", id: 1, ok: false, code: "x", message: "y" })).toEqual({
      gamehearth: 1,
      type: "result",
      id: 1,
      ok: false,
      code: "x",
      message: "y",
    });
  });

  it("discards updates without a version and names in the wrong shape", () => {
    expect(parsePlatformMessage({ ...update(1), snapshot: {} })).toBeUndefined();
    expect(parsePlatformMessage({ ...update(1), players: { p1: { name: "A", connected: "ja", you: true } } })).toBeUndefined();
    expect(parsePlatformMessage({ gamehearth: 1, type: "result", id: 1, ok: "vielleicht" })).toBeUndefined();
  });

  it("reads the match options and sets an empty object without options", () => {
    expect(parsePlatformMessage(update(1, { options: { runden: 5, doppelt: true, farbe: "rot" } }))).toMatchObject({
      options: { runden: 5, doppelt: true, farbe: "rot" },
    });
    expect(parsePlatformMessage(update(1))).toMatchObject({ options: {} });
  });

  it("discards updates with options in the wrong shape", () => {
    expect(parsePlatformMessage(update(1, { options: { runden: { wert: 5 } } }))).toBeUndefined();
    expect(parsePlatformMessage(update(1, { options: [1] }))).toBeUndefined();
    expect(parsePlatformMessage(update(1, { options: null }))).toMatchObject({ options: {} });
  });
});

describe("connect with options", () => {
  it("gives the client the options with every update", async () => {
    const platform = fakePlatform();
    const pending = connect<{ public: unknown; players: Record<string, unknown>; secret: unknown }, unknown, { runden: number }>({
      parent: platform.parent,
      events: platform.events,
    });
    platform.deliver(update(1, { options: { runden: 5 } }));
    const game = await pending;
    expect(game.current.options.runden).toBe(5);
    const seen: number[] = [];
    game.onUpdate((next) => seen.push(next.options.runden));
    platform.deliver(update(2, { options: { runden: 7 } }));
    expect(seen).toEqual([5, 7]);
    expect(Object.isFrozen(game.current.options)).toBe(true);
  });
});

function nest(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) {
    value = [value];
  }
  return value;
}

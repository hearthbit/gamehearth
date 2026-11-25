import { describe, expect, it, vi } from "vitest";
import { connect, connectSolo, type MessageEventLike } from "../src/client";
import { maxSaveBytes, parseGameMessage, parsePlatformMessage } from "../src/platform";
import { utf8Length } from "../src/bridge";

type Listener = (event: MessageEventLike) => void;

function fakePlatform() {
  const sent: Record<string, unknown>[] = [];
  const listeners = new Set<Listener>();
  const parent = {
    postMessage(message: unknown) {
      sent.push((globalThis as unknown as { structuredClone(value: unknown): unknown }).structuredClone(message) as Record<string, unknown>);
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

const solo = (saved: unknown, best: Record<string, number> = {}) => ({ gamehearth: 1, type: "solo", saved, best });

describe("connectSolo", () => {
  it("registers as a single-player game and returns the save and best scores", async () => {
    const platform = fakePlatform();
    const pending = connectSolo<{ level: number }, "punkte">({ parent: platform.parent, events: platform.events });
    expect(platform.sent).toEqual([{ gamehearth: 1, type: "solo-ready" }]);
    platform.deliver(solo({ level: 3 }, { punkte: 1200 }));
    const game = await pending;
    expect(game.saved).toEqual({ level: 3 });
    expect(game.best.punkte).toBe(1200);
  });

  it("Review 9: returns best scores without inherited keys", async () => {
    const platform = fakePlatform();
    const pending = connectSolo<unknown, "constructor" | "punkte">({ parent: platform.parent, events: platform.events });
    platform.deliver(solo(null, { punkte: 3 }));
    const game = await pending;
    expect(game.best.constructor).toBeUndefined();
    expect(game.best.punkte).toBe(3);
  });

  it("returns undefined without a save", async () => {
    const platform = fakePlatform();
    const pending = connectSolo({ parent: platform.parent, events: platform.events });
    platform.deliver(solo(null));
    const game = await pending;
    expect(game.saved).toBeUndefined();
    expect(game.best).toEqual({});
  });

  it("returns a separate copy of the save on every read, which the game may change", async () => {
    const platform = fakePlatform();
    const pending = connectSolo<{ level: number }>({ parent: platform.parent, events: platform.events });
    platform.deliver(solo({ level: 3 }));
    const game = await pending;
    const copy = game.saved as { level: number };
    copy.level = 99;
    expect(game.saved).toEqual({ level: 3 });
  });

  it("saves, waits for the confirmation and then shows the new save", async () => {
    const platform = fakePlatform();
    const pending = connectSolo<{ level: number }>({ parent: platform.parent, events: platform.events });
    platform.deliver(solo({ level: 1 }));
    const game = await pending;
    const data = { level: 2 };
    const saving = game.save(data);
    data.level = 5;
    expect(platform.sent[1]).toEqual({ gamehearth: 1, id: 1, type: "save", data: { level: 2 } });
    expect(game.saved).toEqual({ level: 1 });
    platform.deliver({ gamehearth: 1, type: "result", id: 1, ok: true });
    await saving;
    expect(game.saved).toEqual({ level: 2 });
  });

  it("rejects a refused save loudly and keeps the old one", async () => {
    const platform = fakePlatform();
    const pending = connectSolo<{ level: number }>({ parent: platform.parent, events: platform.events });
    platform.deliver(solo({ level: 1 }));
    const game = await pending;
    const saving = game.save({ level: 2 });
    platform.deliver({ gamehearth: 1, type: "result", id: 1, ok: false, code: "invalid-save", message: "broken" });
    await expect(saving).rejects.toThrow("broken");
    expect(game.saved).toEqual({ level: 1 });
  });

  it("checks saves already in the game: not JSON, too large, null", async () => {
    const platform = fakePlatform();
    const pending = connectSolo<unknown>({ parent: platform.parent, events: platform.events });
    platform.deliver(solo(null));
    const game = await pending;
    await expect(game.save({ wann: new Date(0) })).rejects.toThrow("not plain JSON");
    await expect(game.save({ text: "x".repeat(maxSaveBytes) })).rejects.toThrow("at most 64 KB");
    await expect(game.save(null)).rejects.toThrow("null stands for");
    expect(platform.sent).toHaveLength(1);
  });

  it("reports best scores and takes the best scores the platform sends afterwards", async () => {
    const platform = fakePlatform();
    const pending = connectSolo<unknown, "punkte">({ parent: platform.parent, events: platform.events });
    platform.deliver(solo(null, { punkte: 100 }));
    const game = await pending;
    const recording = game.record("punkte", 250);
    expect(platform.sent[1]).toEqual({ gamehearth: 1, id: 1, type: "record", stat: "punkte", value: 250 });
    platform.deliver(solo(null, { punkte: 250 }));
    platform.deliver({ gamehearth: 1, type: "result", id: 1, ok: true });
    await recording;
    expect(game.best.punkte).toBe(250);
  });

  it("rejects invalid best scores before sending", async () => {
    const platform = fakePlatform();
    const pending = connectSolo<unknown, string>({ parent: platform.parent, events: platform.events });
    platform.deliver(solo(null));
    const game = await pending;
    await expect(game.record("Punkte", 1)).rejects.toThrow("not the name of a best score");
    await expect(game.record("punkte", Number.NaN)).rejects.toThrow("finite number");
    await expect(game.record("punkte", 1e16)).rejects.toThrow("finite number");
    expect(platform.sent).toHaveLength(1);
  });

  it("fails with an explanation when the platform opens the game in a room", async () => {
    const platform = fakePlatform();
    const pending = connectSolo({ parent: platform.parent, events: platform.events });
    platform.deliver({
      gamehearth: 1,
      type: "update",
      seat: "p1",
      role: "player",
      snapshot: { version: 0 },
      players: { p1: { name: "Anna", connected: true, you: true } },
      online: true,
    });
    await expect(pending).rejects.toThrow("connectSolo() is only for single-player games without a reducer");
  });

  it("fails with the platform's reason", async () => {
    const platform = fakePlatform();
    const pending = connectSolo({ parent: platform.parent, events: platform.events });
    platform.deliver({ gamehearth: 1, type: "refused", message: "Only for single-player games" });
    await expect(pending).rejects.toThrow("Only for single-player games");
  });

  it("ignores messages from other windows", async () => {
    vi.useFakeTimers();
    try {
      const platform = fakePlatform();
      const pending = connectSolo({ parent: platform.parent, events: platform.events, connectTimeoutMs: 100 });
      platform.deliver(solo({ level: 9 }), {});
      vi.advanceTimersByTime(150);
      await expect(pending).rejects.toThrow("within 100 ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after a while without an answer", async () => {
    vi.useFakeTimers();
    try {
      const platform = fakePlatform();
      const pending = connectSolo({ parent: platform.parent, events: platform.events, requestTimeoutMs: 200 });
      platform.deliver(solo(null));
      const game = await pending;
      const saving = game.save({ level: 1 });
      vi.advanceTimersByTime(250);
      await expect(saving).rejects.toThrow("within 200 ms");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("connect in a single-player game", () => {
  it("fails with the platform's reason instead of after 10 seconds", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events });
    platform.deliver({ gamehearth: 1, type: "refused", message: "Single-player games call connectSolo()" });
    await expect(pending).rejects.toThrow("connectSolo()");
  });
});

describe("Bridge for single-player games", () => {
  it("reads saves as plain JSON and reports problems instead of dropping them", () => {
    const proto = JSON.parse('{"__proto__": {"x": 1}, "level": 2}') as unknown;
    const parsed = parseGameMessage({ gamehearth: 1, type: "save", id: 3, data: proto });
    expect(parsed).toMatchObject({ type: "save", id: 3 });
    expect(Object.getPrototypeOf((parsed as { data: object }).data)).toBe(Object.prototype);
    expect(parseGameMessage({ gamehearth: 1, type: "save", id: 4, data: { a: Number.POSITIVE_INFINITY } })).toMatchObject({ type: "save", id: 4, problem: expect.stringContaining("not plain JSON") });
    expect(parseGameMessage({ gamehearth: 1, type: "save", id: 5 })).toMatchObject({ problem: expect.stringContaining("missing") });
    expect(parseGameMessage({ gamehearth: 1, type: "save", id: -1, data: {} })).toBeUndefined();
  });

  it("reads best scores and reports invalid names and numbers", () => {
    expect(parseGameMessage({ gamehearth: 1, type: "record", id: 1, stat: "punkte", value: 3 })).toEqual({ gamehearth: 1, type: "record", id: 1, stat: "punkte", value: 3 });
    expect(parseGameMessage({ gamehearth: 1, type: "record", id: 2, stat: "../x", value: 3 })).toMatchObject({ problem: expect.stringContaining("not the name") });
    expect(parseGameMessage({ gamehearth: 1, type: "record", id: 2, stat: "punkte", value: "3" })).toMatchObject({ problem: expect.stringContaining("finite number") });
  });

  it("reads the platform's answers", () => {
    expect(parsePlatformMessage(solo({ level: 1 }, { punkte: 3 }))).toEqual({ gamehearth: 1, type: "solo", saved: { level: 1 }, best: { punkte: 3 } });
    expect(parsePlatformMessage(solo(null, { punkte: Number.NaN }))).toBeUndefined();
    expect(parsePlatformMessage(solo(null, { "Böse Zahl": 1 }))).toBeUndefined();
    expect(parsePlatformMessage({ gamehearth: 1, type: "solo", best: {} })).toBeUndefined();
    expect(parsePlatformMessage({ gamehearth: 1, type: "refused", message: "x".repeat(800) })).toEqual({ gamehearth: 1, type: "refused", message: "x".repeat(500) });
  });
});

describe("Size in UTF-8", () => {
  it("counts bytes like the server, also for umlauts, emoji and lone surrogates", () => {
    const cases: [string, number][] = [["", 0], ["abc", 3], ["Grüße", 7], ["\u{1F600} Stern", 10], ["\ud800x", 4], ["x\udc00", 4], ["€", 3]];
    for (const [text, bytes] of cases) {
      expect(utf8Length(text)).toBe(bytes);
    }
  });
});

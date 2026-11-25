import { describe, expect, it, vi } from "vitest";
import { connect, connectSolo, type MessageEventLike } from "../src/client";

type Listener = (event: MessageEventLike) => void;

function fakePlatform() {
  const sent: unknown[] = [];
  const listeners = new Set<Listener>();
  const parent = {
    postMessage(message: unknown) {
      sent.push(JSON.parse(JSON.stringify(message)));
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
  return { parent, events, sent, deliver };
}

const update = {
  gamehearth: 1,
  type: "update",
  seat: "p1",
  role: "player",
  snapshot: { player: "p1", players: ["p1"], public: {}, me: {}, moves: [], version: 1 },
  players: { p1: { name: "Anna", connected: true, you: true }, p2: { name: "Robo-Rita", connected: true, you: false, bot: true } },
  online: true,
};

describe("game.sound", () => {
  it("is off until the platform says the switch is on, and sends only then", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events });
    platform.deliver(update);
    const game = await pending;
    expect(game.current.players["p2"]).toEqual({ name: "Robo-Rita", connected: true, you: false, bot: true });
    expect(game.soundOn).toBe(false);
    expect(game.sound("coin")).toBe(false);
    const seen: boolean[] = [];
    game.onSound((on) => seen.push(on));
    platform.deliver({ gamehearth: 1, type: "settings", sound: true });
    platform.deliver({ gamehearth: 1, type: "settings", sound: true });
    expect(game.soundOn).toBe(true);
    expect(seen).toEqual([true]);
    expect(game.sound("coin")).toBe(true);
    expect(game.sound({ notes: [{ freq: 440, length: 0.1 }] })).toBe(true);
    expect(platform.sent.slice(1)).toEqual([
      { gamehearth: 1, type: "sound", sound: "coin" },
      { gamehearth: 1, type: "sound", sound: { notes: [{ freq: 440, length: 0.1 }] } },
    ]);
  });

  it("ignores settings from other windows", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events });
    platform.deliver(update);
    const game = await pending;
    platform.deliver({ gamehearth: 1, type: "settings", sound: true }, {});
    expect(game.soundOn).toBe(false);
  });

  it("reports an invalid sound on the console instead of sending it", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events });
    platform.deliver({ gamehearth: 1, type: "settings", sound: true });
    platform.deliver(update);
    const game = await pending;
    const error = vi.spyOn((globalThis as unknown as { console: { error(message: string): void } }).console, "error").mockImplementation(() => undefined);
    expect(game.sound("boing" as never)).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^game\.sound: "boing" is not a sound/));
    error.mockRestore();
    expect(platform.sent).toEqual([{ gamehearth: 1, type: "ready" }]);
  });

  it("works the same for single-player games", async () => {
    const platform = fakePlatform();
    const pending = connectSolo({ parent: platform.parent, events: platform.events });
    platform.deliver({ gamehearth: 1, type: "solo", saved: null, best: {} });
    const game = await pending;
    expect(game.sound("win")).toBe(false);
    platform.deliver({ gamehearth: 1, type: "settings", sound: true });
    expect(game.sound("win")).toBe(true);
    expect(platform.sent.at(-1)).toEqual({ gamehearth: 1, type: "sound", sound: "win" });
  });
});

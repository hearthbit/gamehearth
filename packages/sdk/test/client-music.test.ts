import { describe, expect, it, vi } from "vitest";
import { connect, connectSolo, type MessageEventLike, type MusicTrack } from "../src/client";

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
  players: { p1: { name: "Anna", connected: true, you: true } },
  online: true,
};

const loop: MusicTrack = { name: "Forest", bpm: 100, beats: 4, voices: [{ instrument: "musicbox", notes: [{ freq: 523.25, at: 0, length: 1 }] }] };

const musicMessages = (sent: unknown[]) => sent.filter((message) => (message as { type?: string }).type === "music");

describe("game.music", () => {
  it("sends the track to the platform at once, and says whether it plays", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events });
    platform.deliver(update);
    const game = await pending;
    expect(game.musicOn).toBe(false);
    expect(game.music(loop)).toBe(false);
    expect(musicMessages(platform.sent)).toEqual([{ gamehearth: 1, type: "music", track: loop }]);
    const seen: boolean[] = [];
    game.onMusic((on) => seen.push(on));
    platform.deliver({ gamehearth: 1, type: "settings", sound: true, music: true });
    expect(game.musicOn).toBe(true);
    expect(game.soundOn).toBe(true);
    expect(game.music(loop)).toBe(true);
    expect(game.music(JSON.parse(JSON.stringify({ voices: loop.voices, beats: 4, bpm: 100, name: "Forest" })) as MusicTrack)).toBe(true);
    expect(musicMessages(platform.sent)).toHaveLength(1);
    expect(game.music(null)).toBe(false);
    expect(musicMessages(platform.sent).at(-1)).toEqual({ gamehearth: 1, type: "music", track: null });
    platform.deliver({ gamehearth: 1, type: "settings", sound: true, music: false });
    platform.deliver({ gamehearth: 1, type: "settings", sound: false, music: true });
    platform.deliver({ gamehearth: 1, type: "settings", sound: true, music: true });
    expect(seen).toEqual([true, false, true]);
  });

  it("plays music only when the platform says both switches are on; an older platform never does", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events });
    platform.deliver(update);
    const game = await pending;
    platform.deliver({ gamehearth: 1, type: "settings", sound: true });
    expect(game.soundOn).toBe(true);
    expect(game.musicOn).toBe(false);
    expect(game.music(loop)).toBe(false);
    platform.deliver({ gamehearth: 1, type: "settings", sound: false, music: true });
    expect(game.musicOn).toBe(false);
  });

  it("reports an invalid track on the console instead of sending it", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events });
    platform.deliver({ gamehearth: 1, type: "settings", sound: true, music: true });
    platform.deliver(update);
    const game = await pending;
    const error = vi.spyOn((globalThis as unknown as { console: { error(message: string): void } }).console, "error").mockImplementation(() => undefined);
    expect(game.music({ ...loop, bpm: 300 })).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^game\.music: bpm must be/));
    error.mockRestore();
    expect(musicMessages(platform.sent)).toEqual([]);
  });

  it("works the same for a TV and for single-player games", async () => {
    const tv = fakePlatform();
    const pendingTv = connect({ parent: tv.parent, events: tv.events, screen: true });
    tv.deliver({ ...update, seat: null, role: "screen", snapshot: { players: ["p1"], public: {}, version: 1 } });
    const screen = await pendingTv;
    tv.deliver({ gamehearth: 1, type: "settings", sound: true, music: true });
    expect(screen.music(loop)).toBe(true);
    expect(musicMessages(tv.sent)).toEqual([{ gamehearth: 1, type: "music", track: loop }]);

    const solo = fakePlatform();
    const pendingSolo = connectSolo({ parent: solo.parent, events: solo.events });
    solo.deliver({ gamehearth: 1, type: "solo", saved: null, best: {} });
    const game = await pendingSolo;
    expect(game.music(loop)).toBe(false);
    solo.deliver({ gamehearth: 1, type: "settings", sound: true, music: true });
    expect(game.musicOn).toBe(true);
    expect(game.music(loop)).toBe(true);
    expect(musicMessages(solo.sent)).toHaveLength(1);
  });
});

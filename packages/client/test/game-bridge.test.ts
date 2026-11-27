import type { MoveResult, PlatformMessage } from "@gamehearth/sdk/platform";
import { describe, expect, it } from "vitest";
import { GameBridge, bridgeUpdate } from "../src/game-bridge";
import type { RoomView } from "../src/protocol";

function room(version: number, seat: string | null = "p1"): RoomView {
  return {
    code: "ABC234",
    game: { id: "mau-mau", name: "Mau-Mau", version: "0.1.0", client: "/games/mau-mau/0.1.0+abcdefabcdef/" },
    status: "running",
    round: 1,
    players: { min: 2, max: 6 },
    maxMembers: 6,
    members: [
      { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false, you: true, connected: true },
      { id: 2, name: "Ben", seat: "p2", host: false, guest: false, deleted: false, you: false, connected: false },
      { id: 3, name: "Zuschauer", seat: null, host: false, guest: false, deleted: false, you: false, connected: true },
    ],
    you: { id: 1, name: "Anna", seat, host: true, guest: false, deleted: false },
    canStart: false,
    ...(seat === null ? {} : { snapshot: { player: seat, players: ["p1", "p2"], public: {}, me: {}, moves: [], version } }),
  };
}

function setup(result: MoveResult = { ok: true }) {
  const posted: PlatformMessage[] = [];
  const moves: [unknown, number][] = [];
  const bridge = new GameBridge({
    post: (message) => posted.push(message),
    move: async (action, expectedVersion) => {
      moves.push([action, expectedVersion]);
      return result;
    },
  });
  return { bridge, posted, moves };
}

describe("bridgeUpdate", () => {
  it("names your own seat, and names only for seats", () => {
    expect(bridgeUpdate(room(4), true)).toEqual({
      seat: "p1",
      role: "player",
      snapshot: expect.objectContaining({ version: 4 }),
      players: { p1: { name: "Anna", connected: true, you: true }, p2: { name: "Ben", connected: false, you: false } },
      options: {},
      online: true,
    });
  });

  it("returns nothing without a seat", () => {
    expect(bridgeUpdate(room(1, null), true)).toBeUndefined();
  });
});

describe("GameBridge", () => {
  it("sends snapshots only after ready and then exactly once per change", () => {
    const { bridge, posted } = setup();
    bridge.update(room(1), true);
    expect(posted).toEqual([]);
    bridge.receive({ gamehearth: 1, type: "ready" });
    expect(posted).toEqual([{ gamehearth: 1, type: "settings", sound: false, music: false }, expect.objectContaining({ type: "update", seat: "p1" })]);
    bridge.update(room(1), true);
    expect(posted).toHaveLength(2);
    bridge.update(room(1), false);
    bridge.update(room(2), false);
    expect(posted.map((message) => (message.type === "update" ? [message.snapshot, message.online] : undefined))).toEqual([
      undefined,
      [expect.objectContaining({ version: 1 }), true],
      [expect.objectContaining({ version: 1 }), false],
      [expect.objectContaining({ version: 2 }), false],
    ]);
  });

  it("sends the snapshot again after another ready, e.g. after the game reloads", () => {
    const { bridge, posted } = setup();
    bridge.update(room(1), true);
    bridge.receive({ gamehearth: 1, type: "ready" });
    bridge.receive({ gamehearth: 1, type: "ready" });
    expect(posted.filter((message) => message.type === "update")).toHaveLength(2);
  });

  it("tells the game whether sound is on, plays its sounds only then and reports changes", () => {
    const played: unknown[] = [];
    const posted: PlatformMessage[] = [];
    const bridge = new GameBridge({ post: (message) => posted.push(message), move: async () => ({ ok: true }), sound: (sound) => played.push(sound) });
    bridge.receive({ gamehearth: 1, type: "sound", sound: "coin" });
    bridge.setAudio(true, false);
    expect(posted).toEqual([]);
    bridge.receive({ gamehearth: 1, type: "ready" });
    expect(posted).toEqual([{ gamehearth: 1, type: "settings", sound: true, music: false }]);
    bridge.receive({ gamehearth: 1, type: "sound", sound: "coin" });
    bridge.receive({ gamehearth: 1, type: "sound", sound: "boing" });
    bridge.setAudio(false, false);
    bridge.setAudio(false, false);
    bridge.receive({ gamehearth: 1, type: "sound", sound: "win" });
    expect(played).toEqual(["coin"]);
    expect(posted).toEqual([
      { gamehearth: 1, type: "settings", sound: true, music: false },
      { gamehearth: 1, type: "settings", sound: false, music: false },
    ]);
  });

  it("keeps the game's track and hands it on only while sound and music are on; a new ready forgets it", () => {
    const tracks: unknown[] = [];
    const posted: PlatformMessage[] = [];
    const bridge = new GameBridge({ post: (message) => posted.push(message), move: async () => ({ ok: true }), music: (track) => tracks.push(track), musicOn: true });
    const loop = { bpm: 120, beats: 4, voices: [{ instrument: "organ", notes: [{ freq: 262, at: 0, length: 4 }] }] };
    const played = { bpm: 120, beats: 4, voices: [{ instrument: "organ", volume: 0.5, notes: [{ freq: 262, at: 0, length: 4, volume: 1 }] }] };
    bridge.receive({ gamehearth: 1, type: "ready" });
    expect(posted).toEqual([{ gamehearth: 1, type: "settings", sound: false, music: false }]);
    bridge.receive({ gamehearth: 1, type: "music", track: loop });
    expect(tracks).toEqual([null]);
    bridge.setAudio(true, true);
    expect(posted.at(-1)).toEqual({ gamehearth: 1, type: "settings", sound: true, music: true });
    expect(tracks).toEqual([null, played]);
    bridge.setAudio(true, false);
    expect(posted.at(-1)).toEqual({ gamehearth: 1, type: "settings", sound: true, music: false });
    bridge.setAudio(false, true);
    expect(tracks).toEqual([null, played, null]);
    bridge.setAudio(true, true);
    bridge.receive({ gamehearth: 1, type: "music", track: { ...loop, bpm: 500 } });
    bridge.receive({ gamehearth: 1, type: "music", track: null });
    expect(tracks).toEqual([null, played, null, played, null]);
    bridge.receive({ gamehearth: 1, type: "music", track: loop });
    bridge.receive({ gamehearth: 1, type: "ready" });
    expect(tracks).toEqual([null, played, null, played, null, played, null]);
    bridge.setAudio(false, true);
    bridge.setAudio(true, true);
    expect(tracks.at(-1)).toBeNull();
  });

  it("forwards moves and sends the result back with the same id", async () => {
    const { bridge, posted, moves } = setup({ ok: false, code: "stale", message: "alt" });
    bridge.receive({ gamehearth: 1, type: "move", id: 7, action: { type: "draw" }, expectedVersion: 3 });
    await Promise.resolve();
    await Promise.resolve();
    expect(moves).toEqual([[{ type: "draw" }, 3]]);
    expect(posted).toEqual([{ gamehearth: 1, type: "result", id: 7, ok: false, code: "stale", message: "alt" }]);
  });

  it("ignores invalid messages from the game", () => {
    const { bridge, posted, moves } = setup();
    bridge.receive({ gamehearth: 1, type: "move", id: "x", action: {}, expectedVersion: 0 });
    bridge.receive({ type: "ready" });
    bridge.receive("ready");
    expect(posted).toEqual([]);
    expect(moves).toEqual([]);
    expect(bridge.ready).toBe(false);
  });
});

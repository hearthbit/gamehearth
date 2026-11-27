import { describe, expect, it, vi } from "vitest";
import { roomTexts, GameBridge } from "../src/game-bridge";
import { buildUrls, preloadFiles, preloadPath, type PreloadDom } from "../src/preload";
import type { SoloView, StatSpec } from "../src/protocol";
import { parseRoute, soloPath } from "../src/router";
import { formatStat } from "../src/screens/solo";
import { SoloBridge, soloTexts } from "../src/solo-bridge";
import { clientPath } from "../src/solo-service";
import { lastUser, SoloStore } from "../src/solo-store";
import { SoloSync } from "../src/solo-sync";
import type { KeyValueStore } from "../src/storage";

const stats: Record<string, StatSpec> = { punkte: { label: "Punkte", better: "higher" }, zeit: { label: "Zeit", better: "lower", format: "time" } };
const game = { id: "sammler", name: "Sammler", version: "0.1.0", mode: "single", players: { min: 1, max: 1 }, solo: true as const, build: "sammler@0.1.0+abcdefabcdef", stats };

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) };
}

function view(changes: Partial<SoloView> = {}): SoloView {
  return { game: "sammler", save: null, savedAt: null, best: {}, generations: {}, boards: {}, ignored: [], ...changes };
}

describe("Device storage for single-player games", () => {
  it("remembers account, games, save and best scores across a restart", () => {
    const store = memory();
    const solo = new SoloStore({ id: 7, name: "Anna" }, store);
    solo.remember();
    solo.setGames([game]);
    solo.save("sammler", { level: 2 }, 1000);
    solo.record("sammler", "punkte", 50, stats["punkte"] as StatSpec, 1000);
    expect(lastUser(store)).toEqual({ id: 7, name: "Anna" });
    const again = new SoloStore({ id: 7, name: "Anna" }, store);
    expect(again.games()).toEqual([game]);
    expect(again.saved("sammler")).toEqual({ level: 2 });
    expect(again.best("sammler")).toEqual({ punkte: 50 });
    expect(new SoloStore({ id: 8, name: "Ben" }, store).saved("sammler")).toBeUndefined();
  });

  it("keeps only better values when recording, depending on the direction", () => {
    const solo = new SoloStore({ id: 1, name: "A" }, memory());
    expect(solo.record("sammler", "punkte", 50, stats["punkte"] as StatSpec, 1)).toBe(true);
    expect(solo.record("sammler", "punkte", 40, stats["punkte"] as StatSpec, 2)).toBe(false);
    expect(solo.record("sammler", "zeit", 9000, stats["zeit"] as StatSpec, 3)).toBe(true);
    expect(solo.record("sammler", "zeit", 9500, stats["zeit"] as StatSpec, 4)).toBe(false);
    expect(solo.record("sammler", "zeit", 8000, stats["zeit"] as StatSpec, 5)).toBe(true);
    expect(solo.best("sammler")).toEqual({ punkte: 50, zeit: 8000 });
  });

  it("lists pending changes and then takes over the server's answer", () => {
    const solo = new SoloStore({ id: 1, name: "A" }, memory());
    solo.save("sammler", { level: 3 }, 5000);
    solo.record("sammler", "punkte", 70, stats["punkte"] as StatSpec, 5000);
    expect(solo.pending("sammler")).toEqual({ save: { data: { level: 3 }, savedAt: 5000 }, best: { punkte: { value: 70, at: 5000, generation: 0 } } });
    solo.apply("sammler", view({ save: { data: { level: 3 }, savedAt: 5000 }, savedAt: 5000, best: { punkte: 90 }, boards: { punkte: [{ rank: 1, name: "A", value: 90, you: true }] } }), stats);
    expect(solo.pending("sammler")).toBeUndefined();
    expect(solo.best("sammler")).toEqual({ punkte: 90 });
    expect(solo.boards("sammler")["punkte"]).toHaveLength(1);
  });

  it("takes a newer save from the server and keeps a newer own one", () => {
    const solo = new SoloStore({ id: 1, name: "A" }, memory());
    solo.save("sammler", { level: 3 }, 5000);
    solo.apply("sammler", view({ save: { data: { level: 6 }, savedAt: 6000 }, savedAt: 6000 }), stats);
    expect(solo.saved("sammler")).toEqual({ level: 6 });
    solo.save("sammler", { level: 7 }, 9000);
    solo.apply("sammler", view({ save: { data: { level: 6 }, savedAt: 6000 }, savedAt: 6000 }), stats);
    expect(solo.saved("sammler")).toEqual({ level: 7 });
    expect(solo.pending("sammler")?.save).toEqual({ data: { level: 7 }, savedAt: 9000 });
  });

  it("counts as synced when the server holds the same state with an earlier time (device clock runs fast)", () => {
    const solo = new SoloStore({ id: 1, name: "A" }, memory());
    solo.save("sammler", { level: 3 }, 99_000);
    solo.apply("sammler", view({ save: { data: { level: 3 }, savedAt: 50_000 }, savedAt: 50_000 }), stats);
    expect(solo.pending("sammler")).toBeUndefined();
  });

  it("after a save with a wrong time, still stores every new state as newer", () => {
    const solo = new SoloStore({ id: 1, name: "A" }, memory());
    solo.save("sammler", { level: 1 }, 10_000);
    solo.save("sammler", { level: 2 }, 5000);
    expect(solo.pending("sammler")?.save).toEqual({ data: { level: 2 }, savedAt: 10_001 });
  });

  it("takes over deletions from the server: save gone, best scores from before the deletion gone", () => {
    const solo = new SoloStore({ id: 1, name: "A" }, memory());
    solo.save("sammler", { level: 3 }, 5000);
    solo.apply("sammler", view({ save: { data: { level: 3 }, savedAt: 5000 }, savedAt: 5000 }), stats);
    solo.record("sammler", "punkte", 70, stats["punkte"] as StatSpec, 5000);
    solo.apply("sammler", view({ save: null, savedAt: 8000, generations: { punkte: 1, zeit: 1 } }), stats);
    expect(solo.saved("sammler")).toBeUndefined();
    expect({ ...solo.best("sammler") }).toEqual({});
    expect(solo.pending("sammler")).toBeUndefined();
    solo.record("sammler", "zeit", 7000, stats["zeit"] as StatSpec, 1);
    expect(solo.pending("sammler")?.best).toEqual({ zeit: { value: 7000, at: 1, generation: 1 } });
  });

  it("Review 9: an old, already synced best score makes room for new values after a deletion on another device", () => {
    const solo = new SoloStore({ id: 1, name: "A" }, memory());
    solo.record("sammler", "punkte", 500, stats["punkte"] as StatSpec, 1000);
    solo.apply("sammler", view({ best: { punkte: 500 } }), stats);
    solo.apply("sammler", view({ best: { punkte: 300 }, generations: { punkte: 1 } }), stats);
    expect({ ...solo.best("sammler") }).toEqual({ punkte: 300 });
    expect(solo.record("sammler", "punkte", 400, stats["punkte"] as StatSpec, 900)).toBe(true);
    expect(solo.pending("sammler")?.best).toEqual({ punkte: { value: 400, at: 900, generation: 1 } });
  });

  it("Review 9: a not yet synced value from before the deletion no longer counts, whatever the clock says", () => {
    const solo = new SoloStore({ id: 1, name: "A" }, memory());
    solo.record("sammler", "punkte", 500, stats["punkte"] as StatSpec, 99_999_999);
    solo.apply("sammler", view({ best: {}, generations: { punkte: 1 } }), stats);
    expect({ ...solo.best("sammler") }).toEqual({});
    expect(solo.record("sammler", "punkte", 300, stats["punkte"] as StatSpec, 1)).toBe(true);
  });

  it("Review 9: a deleted, never synced save is no longer pending after the sync", () => {
    const solo = new SoloStore({ id: 1, name: "A" }, memory());
    solo.save("sammler", { level: 3 }, 5000);
    solo.deleteSave("sammler", 6000);
    expect(solo.pending("sammler")).toEqual({ save: { deleted: true, savedAt: 6000 } });
    solo.apply("sammler", view({ save: null, savedAt: 6000 }), stats);
    expect(solo.hasPending()).toBe(false);
  });

  it("Review 9b: an unchanged save gets no new timestamp and does not push out a newer one from the other device", () => {
    const solo = new SoloStore({ id: 1, name: "A" }, memory());
    solo.save("sammler", { level: 2 }, 1000);
    solo.apply("sammler", view({ save: { data: { level: 2 }, savedAt: 1000 }, savedAt: 1000 }), stats);
    solo.save("sammler", { level: 2 }, 9000);
    expect(solo.pending("sammler")).toBeUndefined();
    solo.apply("sammler", view({ save: { data: { level: 5 }, savedAt: 5000 }, savedAt: 5000 }), stats);
    expect(solo.saved("sammler")).toEqual({ level: 5 });
  });

  it("Review 9: two tabs with the same storage do not overwrite each other", () => {
    const store = memory();
    const tabA = new SoloStore({ id: 1, name: "A" }, store);
    const tabB = new SoloStore({ id: 1, name: "A" }, store);
    tabB.save("sammler", { level: 7 }, 5000);
    tabA.remember();
    tabA.setReady("sammler@0.1.0+abcdefabcdef", true);
    expect(new SoloStore({ id: 1, name: "A" }, store).saved("sammler")).toEqual({ level: 7 });
    expect(tabA.saved("sammler")).toEqual({ level: 7 });
    tabA.record("sammler", "punkte", 5, stats["punkte"] as StatSpec, 1);
    expect(tabB.pending("sammler")).toEqual({ save: { data: { level: 7 }, savedAt: 5000 }, best: { punkte: { value: 5, at: 1, generation: 0 } } });
  });

  it("Review 9: reports full storage also for best scores and deletion, and keeps the old state", () => {
    const store = memory();
    const solo = new SoloStore({ id: 1, name: "A" }, store);
    solo.save("sammler", { level: 1 }, 1000);
    solo.record("sammler", "punkte", 10, stats["punkte"] as StatSpec, 1000);
    store.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => solo.record("sammler", "punkte", 20, stats["punkte"] as StatSpec, 2000)).toThrow("The storage of this device is full; the best score could not be stored.");
    expect(() => solo.deleteSave("sammler", 2000)).toThrow("The storage of this device is full; deleting the save");
    expect({ ...solo.best("sammler") }).toEqual({ punkte: 10 });
    expect(solo.saved("sammler")).toEqual({ level: 1 });
  });

  it("Review 9: returns best scores without inherited keys, also for a stat named constructor", () => {
    const solo = new SoloStore({ id: 1, name: "A" }, memory());
    expect(solo.best("sammler")["constructor"]).toBeUndefined();
  });

  it("deletes the save offline too and sends it later as a deletion", () => {
    const solo = new SoloStore({ id: 1, name: "A" }, memory());
    solo.save("sammler", { level: 3 }, 5000);
    solo.deleteSave("sammler", 6000);
    expect(solo.saved("sammler")).toBeUndefined();
    expect(solo.pending("sammler")).toEqual({ save: { deleted: true, savedAt: 6000 } });
  });

  it("forgets everything of this account on sign-out and writes nothing afterwards", () => {
    const store = memory();
    const solo = new SoloStore({ id: 7, name: "Anna" }, store);
    solo.remember();
    solo.save("sammler", { level: 2 }, 1000);
    solo.apply("sammler", view({ save: { data: { level: 2 }, savedAt: 1000 }, savedAt: 1000 }), stats);
    solo.release();
    expect(store.data.size).toBe(0);
    expect(lastUser(store)).toBeUndefined();
    solo.apply("sammler", view({ save: { data: { level: 2 }, savedAt: 1000 }, savedAt: 1000 }), stats);
    expect(store.data.size).toBe(0);
  });

  it("Review 9: keeps pending changes on sign-out, but not as the account for offline", () => {
    const store = memory();
    const solo = new SoloStore({ id: 7, name: "Anna" }, store);
    solo.remember();
    solo.save("sammler", { level: 2 }, 1000);
    solo.release();
    expect(lastUser(store)).toBeUndefined();
    expect(new SoloStore({ id: 7, name: "Anna" }, store).saved("sammler")).toEqual({ level: 2 });
  });

  it("reports full storage instead of silently saving nothing, and keeps the old state", () => {
    const store = memory();
    const solo = new SoloStore({ id: 1, name: "A" }, store);
    solo.save("sammler", { level: 1 }, 1000);
    store.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => solo.save("sammler", { level: 2 }, 2000)).toThrow("The storage of this device is full; the save");
    expect(solo.saved("sammler")).toEqual({ level: 1 });
  });

  it("cleans up file lists and preload marks of old builds", () => {
    const solo = new SoloStore({ id: 1, name: "A" }, memory());
    solo.setGames([game]);
    solo.setFiles({ build: game.build, client: "/games/sammler/x/", files: ["index.html"] });
    solo.setReady(game.build, true);
    solo.setGames([{ ...game, build: "sammler@0.2.0+111111111111" }]);
    expect(solo.files(game.build)).toBeUndefined();
    expect(solo.isReady(game.build)).toBe(false);
  });
});

describe("Sync with the server", () => {
  it("bundles changes and sends them once after the delay", async () => {
    vi.useFakeTimers();
    try {
      const solo = new SoloStore({ id: 1, name: "A" }, memory());
      solo.setGames([game]);
      const sync = vi.fn(async () => view({ best: { punkte: 3 } }));
      const syncer = new SoloSync(solo, { sync }, (id) => solo.game(id)?.stats);
      solo.record("sammler", "punkte", 3, stats["punkte"] as StatSpec, 1);
      syncer.schedule("sammler");
      syncer.schedule("sammler");
      await vi.advanceTimersByTimeAsync(2500);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledWith("sammler", { best: { punkte: { value: 3, at: 1, generation: 0 } } });
      expect(solo.pending("sammler")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps changes on an error and sends them again next time", async () => {
    const solo = new SoloStore({ id: 1, name: "A" }, memory());
    solo.setGames([game]);
    const sync = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(view({ save: { data: { a: 1 }, savedAt: 1 }, savedAt: 1 }));
    const syncer = new SoloSync(solo, { sync }, (id) => solo.game(id)?.stats);
    solo.save("sammler", { a: 1 }, 1);
    expect(await syncer.sync("sammler")).toBe(false);
    expect(solo.pending("sammler")).toBeDefined();
    await syncer.flush();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(solo.pending("sammler")).toBeUndefined();
  });

  it("loses no state that arises during a sync", async () => {
    const solo = new SoloStore({ id: 1, name: "A" }, memory());
    solo.setGames([game]);
    let answer: (value: SoloView) => void = () => undefined;
    const sync = vi.fn(() => new Promise<SoloView>((resolve) => (answer = resolve)));
    const syncer = new SoloSync(solo, { sync }, (id) => solo.game(id)?.stats);
    solo.save("sammler", { level: 1 }, 1000);
    const first = syncer.sync("sammler");
    solo.save("sammler", { level: 2 }, 2000);
    void syncer.sync("sammler");
    answer(view({ save: { data: { level: 1 }, savedAt: 1000 }, savedAt: 1000 }));
    await first;
    expect(solo.saved("sammler")).toEqual({ level: 2 });
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    expect(sync).toHaveBeenLastCalledWith("sammler", { save: { data: { level: 2 }, savedAt: 2000 } });
  });
});

describe("Bridge of the single-player page", () => {
  function bridge() {
    const posted: Record<string, unknown>[] = [];
    let saved: unknown;
    const best: Record<string, number> = {};
    const solo = new SoloBridge({
      post: (message) => posted.push(message as unknown as Record<string, unknown>),
      stats,
      saved: () => saved,
      best: () => ({ ...best }),
      save: (data) => {
        saved = data;
      },
      record: (stat, value) => {
        best[stat] = Math.max(best[stat] ?? -Infinity, value);
      },
    });
    return { solo, posted };
  }

  it("answers solo-ready with save and best scores", () => {
    const { solo, posted } = bridge();
    solo.receive({ gamehearth: 1, type: "solo-ready" });
    expect(posted).toEqual([
      { gamehearth: 1, type: "settings", sound: false, music: false },
      { gamehearth: 1, type: "solo", saved: null, best: {} },
    ]);
    expect(solo.ready).toBe(true);
  });

  it("saves, records best scores and then sends the new state before the reply", () => {
    const { solo, posted } = bridge();
    solo.receive({ gamehearth: 1, type: "save", id: 1, data: { level: 2 } });
    solo.receive({ gamehearth: 1, type: "record", id: 2, stat: "punkte", value: 40 });
    expect(posted).toEqual([
      { gamehearth: 1, type: "result", id: 1, ok: true },
      { gamehearth: 1, type: "solo", saved: { level: 2 }, best: { punkte: 40 } },
      { gamehearth: 1, type: "result", id: 2, ok: true },
    ]);
  });

  it("rejects unknown best scores, broken saves, moves and connect() with an explanation", () => {
    const { solo, posted } = bridge();
    solo.receive({ gamehearth: 1, type: "record", id: 1, stat: "sterne", value: 1 });
    solo.receive({ gamehearth: 1, type: "record", id: 2, stat: "constructor", value: 1 });
    solo.receive({ gamehearth: 1, type: "save", id: 3, data: { x: Number.NaN } });
    solo.receive({ gamehearth: 1, type: "move", id: 4, action: {}, expectedVersion: 0 });
    solo.receive({ gamehearth: 1, type: "ready" });
    expect(posted).toEqual([
      { gamehearth: 1, type: "result", id: 1, ok: false, code: "invalid-stat", message: soloTexts.unknownStat("sterne", ["punkte", "zeit"]) },
      { gamehearth: 1, type: "result", id: 2, ok: false, code: "invalid-stat", message: soloTexts.unknownStat("constructor", ["punkte", "zeit"]) },
      expect.objectContaining({ id: 3, ok: false, code: "invalid-save" }),
      expect.objectContaining({ id: 4, ok: false, code: "solo-game" }),
      { gamehearth: 1, type: "refused", message: soloTexts.useConnectSolo },
    ]);
  });

  it("reports errors when saving on the device to the game", () => {
    const posted: unknown[] = [];
    const solo = new SoloBridge({
      post: (message) => posted.push(message),
      stats,
      saved: () => undefined,
      best: () => ({}),
      save: () => {
        throw new Error("The storage of this device is full");
      },
      record: () => undefined,
    });
    solo.receive({ gamehearth: 1, type: "save", id: 9, data: { a: 1 } });
    expect(posted).toEqual([{ gamehearth: 1, type: "result", id: 9, ok: false, code: "platform-error", message: "The storage of this device is full" }]);
  });

  it("rejects connectSolo in a room", () => {
    const posted: unknown[] = [];
    const room = new GameBridge({ post: (message) => posted.push(message), move: async () => ({ ok: true }) });
    room.receive({ gamehearth: 1, type: "solo-ready" });
    room.receive({ gamehearth: 1, type: "save", id: 1, data: {} });
    expect(posted).toEqual([
      { gamehearth: 1, type: "refused", message: roomTexts.noSolo },
      { gamehearth: 1, type: "result", id: 1, ok: false, code: "not-solo", message: roomTexts.noSolo },
    ]);
  });
});

describe("Preload", () => {
  function fakeDom(answer: (urls: string[]) => string[] | undefined) {
    const listeners = new Set<(event: { source: unknown; data: unknown }) => void>();
    const frames: { src: string; removed: boolean }[] = [];
    const dom: PreloadDom = {
      createFrame(src) {
        const record = { src, removed: false };
        frames.push(record);
        const target = {
          postMessage(message: unknown) {
            const data = message as { id: number; urls: string[] };
            const failed = answer(data.urls);
            if (failed !== undefined) {
              queueMicrotask(() => listeners.forEach((listener) => listener({ source: target, data: { gamehearth: 1, type: "preloaded", id: data.id, total: data.urls.length, failed } })));
            }
          },
        };
        queueMicrotask(() => listeners.forEach((listener) => listener({ source: target, data: { gamehearth: 1, type: "preload-ready" } })));
        queueMicrotask(() => listeners.forEach((listener) => listener({ source: {}, data: { gamehearth: 1, type: "preloaded", id: 1, failed: [] } })));
        return { window: () => target, remove: () => void (record.removed = true) };
      },
      listen(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    return { dom, frames };
  }

  it("loads all files through the isolated page and removes the frame", async () => {
    const { dom, frames } = fakeDom(() => []);
    const urls = buildUrls("/games/sammler/0.1.0+abcdefabcdef/", ["index.html", "assets/a b.js"]);
    expect(urls).toEqual(["/games/sammler/0.1.0+abcdefabcdef/", "/games/sammler/0.1.0+abcdefabcdef/index.html", "/games/sammler/0.1.0+abcdefabcdef/assets/a%20b.js"]);
    expect(await preloadFiles(urls, dom)).toEqual({ total: 3, failed: [] });
    expect(frames).toEqual([{ src: preloadPath, removed: true }]);
  });

  it("Review 9: builds addresses like the browser, also with @, + and parentheses in the file name", () => {
    const client = "/games/x/1.0.0+aaaaaaaaaaaa/";
    const files = ["assets/sheet@2x.png", "font+bold.woff2", "x~(1).png", "a b.js"];
    expect(buildUrls(client, files)).toEqual([client, ...files.map((file) => new URL(file, `http://games.example${client}`).pathname)]);
    expect(buildUrls(client, files)).toContain("/games/x/1.0.0+aaaaaaaaaaaa/assets/sheet@2x.png");
  });

  it("names missing files and gives up when the page does not respond", async () => {
    vi.useFakeTimers();
    try {
      const { dom } = fakeDom((urls) => urls.slice(0, 1));
      expect(await preloadFiles(["/games/a/1.0.0+aaaaaaaaaaaa/x.js"], dom)).toEqual({ total: 1, failed: ["/games/a/1.0.0+aaaaaaaaaaaa/x.js"] });
      const silent = fakeDom(() => undefined);
      const pending = preloadFiles(["/games/a/1.0.0+aaaaaaaaaaaa/y.js"], silent.dom);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await pending).toEqual({ total: 1, failed: ["/games/a/1.0.0+aaaaaaaaaaaa/y.js"] });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Small things", () => {
  it("knows the address of the single-player page", () => {
    expect(parseRoute("/play/sammler")).toEqual({ name: "solo", game: "sammler" });
    expect(parseRoute("/play/Sammler")).toEqual({ name: "home" });
    expect(soloPath("mauer-brecher")).toBe("/play/mauer-brecher");
    expect(clientPath("sammler@0.1.0+abcdefabcdef")).toBe("/games/sammler/0.1.0+abcdefabcdef/");
  });

  it("shows numbers in German format and times as minutes, seconds and tenths", () => {
    expect(formatStat(12345, stats["punkte"])).toBe("12.345");
    expect(formatStat(83_456, stats["zeit"])).toBe("1:23,5");
    expect(formatStat(5_000, stats["zeit"])).toBe("0:05,0");
    expect(formatStat(3_723_400, stats["zeit"])).toBe("1:02:03,4");
  });
});

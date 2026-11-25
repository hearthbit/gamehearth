import { describe, expect, it } from "vitest";
import { DeviceStorage, maxLegacyTokens, type KeyValueStore } from "../src/storage";

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) };
}

const legacy = (code: string, token: unknown) => ({ code, token, name: "Anna", game: "Mau-Mau", savedAt: 1 });

describe("DeviceStorage", () => {
  it("reads the room tokens from step 5 for the exchange and forgets them afterwards", () => {
    const store = memory();
    store.data.set("gamehearth.rooms", JSON.stringify([legacy("AAAAAA", "t-a"), legacy("BBBBBB", "t-b"), legacy("CCCCCC", "t-a")]));
    const storage = new DeviceStorage(store);
    expect(storage.hasLegacy()).toBe(true);
    expect(storage.legacyTokens()).toEqual(["t-a", "t-b"]);
    storage.clearLegacy();
    expect(storage.hasLegacy()).toBe(false);
    expect(storage.legacyTokens()).toEqual([]);
  });

  it("survives broken, foreign and too many entries", () => {
    const store = memory();
    store.data.set("gamehearth.rooms", "{kaputt");
    expect(new DeviceStorage(store).legacyTokens()).toEqual([]);
    store.data.set("gamehearth.rooms", JSON.stringify([legacy("AAAAAA", "t-a"), { code: 5 }, null, legacy("B", 7), legacy("C", "x".repeat(101)), legacy("D", "")]));
    expect(new DeviceStorage(store).legacyTokens()).toEqual(["t-a"]);
    store.data.set("gamehearth.rooms", JSON.stringify({ rooms: [] }));
    expect(new DeviceStorage(store).legacyTokens()).toEqual([]);
    store.data.set("gamehearth.rooms", JSON.stringify(Array.from({ length: maxLegacyTokens + 5 }, (_, index) => legacy(`R${index}`, `t-${index}`))));
    expect(new DeviceStorage(store).legacyTokens()).toHaveLength(maxLegacyTokens);
  });

  it("remembers the name and also works without usable storage", () => {
    const storage = new DeviceStorage(memory());
    storage.saveName("Clara");
    expect(storage.name()).toBe("Clara");
    const locked: KeyValueStore = {
      getItem: () => {
        throw new Error("gesperrt");
      },
      setItem: () => {
        throw new Error("gesperrt");
      },
      removeItem: () => {
        throw new Error("gesperrt");
      },
    };
    const lockedStorage = new DeviceStorage(locked);
    expect(lockedStorage.legacyTokens()).toEqual([]);
    expect(lockedStorage.hasLegacy()).toBe(false);
    lockedStorage.saveName("x");
    lockedStorage.clearLegacy();
    expect(lockedStorage.name()).toBe("");
    expect(new DeviceStorage(undefined).name()).toBe("");
  });
});

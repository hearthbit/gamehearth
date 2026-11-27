// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { bridgeUpdate } from "../src/game-bridge";
import { gameLanguage, lacksLanguage, languageNames, LanguageContext, memberName, startLanguage, storedLanguage, storeLanguage, tr } from "../src/language";
import type { RoomView } from "../src/protocol";
import { SoloBridge } from "../src/solo-bridge";
import { errorText, language, setLanguage, texts } from "../src/texts";
import { de } from "../src/texts/de";
import { en } from "../src/texts/en";
import { formatStat } from "../src/ui/boards";
import { LanguageSwitch } from "../src/ui/language-switch";
import { LiveOverlay } from "../src/ui/live";
import { profileLines } from "../src/ui/boards";
import { DeviceStorage, type KeyValueStore } from "../src/storage";

function memory(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map<string, string>(Object.entries(initial));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) };
}

function running(languages?: string[]): RoomView {
  return {
    code: "ABC234",
    game: { id: "dorfladen", name: { de: "Dorfladen", en: "Village shop" }, version: "0.1.0", client: "/games/dorfladen/0.1.0+abcdefabcdef/", ...(languages === undefined ? {} : { languages }) },
    status: "running",
    round: 1,
    players: { min: 1, max: 4 },
    maxMembers: 4,
    members: [
      { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false, you: true, connected: true },
      { id: 2, name: "Gelöscht", seat: "p2", host: false, guest: false, deleted: true, you: false, connected: false },
    ],
    you: { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false },
    canStart: false,
    snapshot: { player: "p1", players: ["p1", "p2"], public: {}, me: {}, moves: [], version: 1 },
  };
}

function keysOf(value: object, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, entry]) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry) ? keysOf(entry as object, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

afterEach(() => {
  setLanguage("de");
  localStorage.clear();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("UI texts per language", () => {
  it("has the same keys in German and English", () => {
    expect(keysOf(en)).toEqual(keysOf(de));
  });

  it("switches all texts, the error texts and the page language at once", () => {
    setLanguage("en");
    expect(language).toBe("en");
    expect(texts.yourTurn).toBe("Your turn");
    expect(errorText("not-your-turn", "x")).not.toBe(de.errors["not-your-turn"]);
    expect(errorText("game-error", "An error occurred in the game (incident 3fa2c91b).")).toContain("3fa2c91b");
    expect(document.documentElement.lang).toBe("en");
    setLanguage("de");
    expect(texts.yourTurn).toBe("Du bist dran");
    expect(document.documentElement.lang).toBe("de");
  });

  it("formats best times with the decimal separator of the language", () => {
    expect(formatStat(83_400, { format: "time" })).toBe("1:23,4");
    setLanguage("en");
    expect(formatStat(83_400, { format: "time" })).toBe("1:23.4");
    expect(formatStat(1234567, undefined)).toBe("1,234,567");
  });
});

describe("Choosing the language", () => {
  it("takes the choice stored on the device first", () => {
    expect(startLanguage(memory({ "gamehearth.language": "en" }))).toBe("en");
    expect(texts.yourTurn).toBe("Your turn");
  });

  it("otherwise takes the first German or English browser language, else English", () => {
    vi.stubGlobal("navigator", { languages: ["fr-FR", "de-AT", "en"] });
    expect(startLanguage(memory())).toBe("de");
    vi.stubGlobal("navigator", { languages: ["fr-FR", "es"] });
    expect(startLanguage(memory())).toBe("en");
  });

  it("stores and forgets the choice and ignores unknown values", () => {
    const store = memory({ "gamehearth.language": "fr" });
    expect(storedLanguage(store)).toBeUndefined();
    storeLanguage("en", store);
    expect(storedLanguage(store)).toBe("en");
    storeLanguage(undefined, store);
    expect(storedLanguage(store)).toBeUndefined();
  });

  it("offers a switch that marks the current language and reports the choice", () => {
    const choose = vi.fn();
    const root = document.createElement("div");
    document.body.append(root);
    act(() => {
      render(
        <LanguageContext.Provider value={{ language: "de", choose }}>
          <LanguageSwitch />
        </LanguageContext.Provider>,
        root,
      );
    });
    const buttons = [...root.querySelectorAll("button")];
    expect(buttons.map((button) => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([
      ["DE", "true"],
      ["EN", "false"],
    ]);
    act(() => buttons[1]?.click());
    expect(choose).toHaveBeenCalledWith("en");
  });
});

describe("Texts from manifests and the server", () => {
  it("shows names and labels in the language of the device", () => {
    expect(tr({ de: "Dorfladen", en: "Village shop" })).toBe("Dorfladen");
    setLanguage("en");
    expect(tr({ de: "Dorfladen", en: "Village shop" })).toBe("Village shop");
    expect(tr("Mau-Mau")).toBe("Mau-Mau");
  });

  it("names a deleted seat in the language of the device, not in the server's German", () => {
    setLanguage("en");
    expect(memberName({ name: "Gelöscht", deleted: true })).toBe(en.deletedMember);
    expect(memberName({ name: "Anna", deleted: false })).toBe("Anna");
  });

  it("Review 12a: falls back to the game's own default language, not to the first text of the object", () => {
    const name = { en: "Card Duel", fr: "Duel de cartes" };
    expect(tr(name, ["fr", "en"])).toBe("Duel de cartes");
    expect(tr(name)).toBe("Card Duel");
    const lines = profileLines({ items: {}, stats: { wins: 2 }, flags: {} }, { languages: ["fr", "en"], items: {}, stats: { wins: { label: { en: "Wins", fr: "Victoires" } } }, flags: {} });
    expect(lines.map((line) => line.label)).toEqual(["Victoires"]);
  });

  it("Review 12a: counts aborts of a quarantined build without a wrong German plural", () => {
    expect(texts.quarantineCounts(3, 0, 10)).toBe("Abbrüche in 10 Minuten: 3 hart, 0 weich");
    setLanguage("en");
    expect(texts.quarantineCounts(1, 2, 10)).toBe("Aborts in 10 minutes: 1 hard, 2 soft");
  });

  it("Review 12a: names a deleted seat in the pause overlay instead of an empty name", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const members = [
      { id: 1, name: "", seat: "p1", host: false, guest: false, deleted: true, you: false, connected: false },
      { id: 2, name: "", seat: "p2", host: false, guest: false, deleted: true, you: false, connected: false },
    ];
    act(() => {
      render(<LiveOverlay live={{ state: "paused", missingSeats: ["p1", "p2"], screenMissing: false, byHost: false }} members={members} />, root);
    });
    expect([...root.querySelectorAll("span")].map((span) => span.textContent)).toEqual(["Warte auf Gelöscht", "Warte auf Gelöscht"]);
    render(null, root);
  });

  it("names devices from the browser and system the server recognised, in both languages", () => {
    expect(texts.deviceName("Firefox", "Linux")).toBe("Firefox auf Linux");
    expect(texts.deviceName(undefined, undefined)).toBe("Unbekanntes Gerät");
    setLanguage("en");
    expect(texts.deviceName("Safari", "iOS")).toBe("Safari on iOS");
    expect(texts.deviceName(undefined, "Android")).toBe("Android device");
    expect(texts.deviceName(undefined, undefined)).toBe("Unknown device");
  });

  it("marks games that do not have the language of the device", () => {
    expect(lacksLanguage(["de"])).toBe(false);
    expect(lacksLanguage(undefined)).toBe(false);
    setLanguage("en");
    expect(lacksLanguage(["de"])).toBe(true);
    expect(texts.onlyIn(languageNames(["de"]))).toBe("only in German");
  });
});

describe("Language for games", () => {
  it("picks the device language if the game has it, otherwise the game's default", () => {
    vi.stubGlobal("navigator", { languages: ["fr"] });
    expect(gameLanguage(["de", "en"])).toBe("de");
    setLanguage("en");
    expect(gameLanguage(["de", "en"])).toBe("en");
    expect(gameLanguage(["fr", "de"])).toBe("fr");
    expect(gameLanguage(undefined)).toBeUndefined();
  });

  it("sends the language with every update of a room, and none for games without languages", () => {
    setLanguage("en");
    expect(bridgeUpdate(running(["de", "en"]), true)).toMatchObject({ language: "en", players: { p2: { name: en.deletedMember } } });
    expect(bridgeUpdate(running(), true)).not.toHaveProperty("language");
  });

  it("sends the language to single-player games", () => {
    const posted: unknown[] = [];
    const bridge = new SoloBridge({
      post: (message) => posted.push(message),
      stats: {},
      saved: () => undefined,
      best: () => ({}),
      save: () => undefined,
      record: () => undefined,
      language: "en",
    });
    bridge.receive({ gamehearth: 1, type: "solo-ready" });
    expect(posted).toEqual([
      { gamehearth: 1, type: "settings", sound: false, music: false },
      { gamehearth: 1, type: "solo", saved: null, best: {}, language: "en" },
    ]);
  });
});

describe("Language of the account", () => {
  async function settle(): Promise<void> {
    for (let round = 0; round < 5; round++) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }
  }

  function serve(calls: { path: string; body: unknown }[]) {
    vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
      calls.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const body = path === "/api/games" ? { games: [] } : path === "/api/me/rooms" ? { rooms: [] } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
  }

  function button(root: HTMLElement, text: string): HTMLButtonElement {
    return [...root.querySelectorAll("button")].find((candidate) => candidate.textContent === text) as HTMLButtonElement;
  }

  function serveLogin(calls: { path: string; body: unknown }[], user: object) {
    let signedIn = false;
    vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
      calls.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      signedIn ||= path === "/api/login";
      const body =
        path === "/api/games" ? { games: [] } : path === "/api/me/rooms" ? { rooms: [] } : path === "/api/login" || (path === "/api/me" && signedIn) ? { user } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
  }

  it("applies the language stored with the account and saves a new choice there", async () => {
    const calls: { path: string; body: unknown }[] = [];
    serve(calls);
    const root = document.createElement("div");
    document.body.append(root);
    const user = { id: 7, kind: "account" as const, name: "Anna", role: "player" as const, language: "en" as const };
    act(() => {
      render(<App storage={new DeviceStorage(memory())} loadMe={async () => ({ user })} />, root);
    });
    await settle();
    expect(language).toBe("en");
    expect(localStorage.getItem("gamehearth.account-language")).toBe("en");
    expect(localStorage.getItem("gamehearth.language")).toBeNull();
    act(() => button(root, "DE").click());
    await settle();
    expect(language).toBe("de");
    expect(calls).toContainEqual({ path: "/api/me/language", body: { language: "de" } });
    render(null, root);
  });

  it("Review 12a: on a shared device another account's language is neither shown to nor saved for a user without one", async () => {
    vi.stubGlobal("navigator", { languages: ["de-DE"] });
    localStorage.setItem("gamehearth.account-language", "en");
    const calls: { path: string; body: unknown }[] = [];
    serve(calls);
    const root = document.createElement("div");
    document.body.append(root);
    const user = { id: 9, kind: "account" as const, name: "Opa", role: "player" as const, language: null };
    act(() => {
      render(<App storage={new DeviceStorage(memory())} loadMe={async () => ({ user })} />, root);
    });
    await settle();
    expect(language).toBe("de");
    expect(calls.filter((call) => call.path === "/api/me/language")).toEqual([]);
    expect(localStorage.getItem("gamehearth.account-language")).toBeNull();
    render(null, root);
  });

  it("Review 12a: a choice stored on the device earlier is not handed to the next account", async () => {
    localStorage.setItem("gamehearth.language", "en");
    const calls: { path: string; body: unknown }[] = [];
    serve(calls);
    const root = document.createElement("div");
    document.body.append(root);
    const user = { id: 8, kind: "guest" as const, name: "Ben", role: "player" as const, language: null };
    act(() => {
      render(<App storage={new DeviceStorage(memory())} loadMe={async () => ({ user })} />, root);
    });
    await settle();
    expect(language).toBe("en");
    expect(calls.filter((call) => call.path === "/api/me/language")).toEqual([]);
    render(null, root);
  });

  it("hands a choice made while logged out to the account that logs in next, if it has none", async () => {
    const user = { id: 10, kind: "account" as const, name: "Cem", role: "player" as const, language: null };
    const calls: { path: string; body: unknown }[] = [];
    serveLogin(calls, user);
    const root = document.createElement("div");
    document.body.append(root);
    act(() => {
      render(<App storage={new DeviceStorage(memory())} loadMe={async () => ({})} />, root);
    });
    await settle();
    act(() => button(root, "EN").click());
    await settle();
    const username = root.querySelector("#login-username") as HTMLInputElement;
    const password = root.querySelector("#login-password") as HTMLInputElement;
    const form = username.closest("form") as HTMLFormElement;
    act(() => {
      username.value = "cem";
      username.dispatchEvent(new Event("input", { bubbles: true }));
      password.value = "secret-password";
      password.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(calls).toContainEqual({ path: "/api/me/language", body: { language: "en" } });
    render(null, root);
  });

  it("Review 11: an account with its own language drops a choice made while logged out, so a later account does not get it", async () => {
    const first = { id: 12, kind: "account" as const, name: "Anna", role: "player" as const, language: "de" as const };
    const second = { id: 13, kind: "account" as const, name: "Opa", role: "player" as const, language: null };
    const calls: { path: string; body: unknown }[] = [];
    let current: object | undefined;
    const logins = [first, second];
    vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
      calls.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (path === "/api/login") {
        current = logins.shift();
      }
      if (path === "/api/logout") {
        current = undefined;
      }
      const body =
        path === "/api/games" ? { games: [] } : path === "/api/me/rooms" ? { rooms: [] } : path === "/api/login" || path === "/api/me" ? (current === undefined ? {} : { user: current }) : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const root = document.createElement("div");
    document.body.append(root);
    act(() => {
      render(<App storage={new DeviceStorage(memory())} loadMe={async () => ({})} />, root);
    });
    await settle();
    act(() => button(root, "EN").click());
    await settle();
    const logIn = async () => {
      const username = root.querySelector("#login-username") as HTMLInputElement;
      const password = root.querySelector("#login-password") as HTMLInputElement;
      act(() => {
        username.value = "someone";
        username.dispatchEvent(new Event("input", { bubbles: true }));
        password.value = "secret-password";
        password.dispatchEvent(new Event("input", { bubbles: true }));
      });
      act(() => {
        (username.closest("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      await settle();
    };
    await logIn();
    expect(language).toBe("de");
    act(() => button(root, "Abmelden").click());
    await settle();
    await logIn();
    expect(calls.filter((call) => call.path === "/api/me/language")).toEqual([]);
    render(null, root);
  });

  it("Review 12a: logging out drops the account's language and goes back to the device's", async () => {
    vi.stubGlobal("navigator", { languages: ["de-DE"] });
    const calls: { path: string; body: unknown }[] = [];
    serve(calls);
    const root = document.createElement("div");
    document.body.append(root);
    const user = { id: 11, kind: "account" as const, name: "Anna", role: "player" as const, language: "en" as const };
    act(() => {
      render(<App storage={new DeviceStorage(memory())} loadMe={async () => ({ user })} />, root);
    });
    await settle();
    expect(language).toBe("en");
    act(() => button(root, "Log out").click());
    await settle();
    expect(calls.map((call) => call.path)).toContain("/api/logout");
    expect(language).toBe("de");
    expect(localStorage.getItem("gamehearth.account-language")).toBeNull();
    render(null, root);
  });
});

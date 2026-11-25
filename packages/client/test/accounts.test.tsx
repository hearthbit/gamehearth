// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../src/protocol";
import { AccountScreen } from "../src/screens/account";
import { AdminScreen } from "../src/screens/admin";
import { Home, expiryNote } from "../src/screens/home";
import { InviteScreen } from "../src/screens/links";
import { AdoptDialog } from "../src/ui/adopt";
import { SessionContext, loadMe, type SessionValue } from "../src/session";
import { DeviceStorage, type KeyValueStore } from "../src/storage";

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) };
}

type Route = (body: unknown) => unknown;
let routes: Record<string, Route>;
let calls: { path: string; body: unknown }[];

beforeEach(() => {
  routes = {};
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ path, body });
      const route = routes[`${init?.method ?? "GET"} ${path}`];
      if (route === undefined) {
        return new Response(JSON.stringify({ code: "not-found", message: "nicht da" }), { status: 404 });
      }
      const result = route(body);
      return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
    }),
  );
});

let container: HTMLElement | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  if (container !== undefined) {
    act(() => render(null, container as HTMLElement));
    container.remove();
    container = undefined;
  }
});

function session(user: Me | undefined, overrides: Partial<SessionValue> = {}): SessionValue {
  return { me: { state: "ready", user }, user, refresh: async () => undefined, setUser: () => undefined, reload: () => undefined, ...overrides };
}

async function mount(element: preact.JSX.Element, value: SessionValue): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    render(<SessionContext.Provider value={value}>{element}</SessionContext.Provider>, container as HTMLElement);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

const anna: Me = { id: 1, kind: "account", username: "anna", name: "Anna", role: "admin" };
const guest: Me = { id: 2, kind: "guest", name: "Ben", role: "player" };

describe("Session at startup", () => {
  it("exchanges stored room tokens once and forgets them", async () => {
    const store = memory();
    store.data.set("gamehearth.rooms", JSON.stringify([{ code: "AAAAAA", token: "alt", name: "Ben", game: "Mau-Mau", savedAt: 1 }]));
    routes["GET /api/me"] = () => ({});
    routes["POST /api/claim"] = () => ({ claimed: ["AAAAAA"], user: guest });
    expect(await loadMe(new DeviceStorage(store))).toEqual({ user: guest });
    expect(calls.find((call) => call.path === "/api/claim")?.body).toEqual({ tokens: ["alt"] });
    expect(store.data.has("gamehearth.rooms")).toBe(false);
  });

  it("keeps the tokens when the exchange fails", async () => {
    const store = memory();
    store.data.set("gamehearth.rooms", JSON.stringify([{ code: "AAAAAA", token: "alt", name: "Ben", game: "Mau-Mau", savedAt: 1 }]));
    routes["GET /api/me"] = () => ({ user: anna });
    routes["POST /api/claim"] = () => new Response("kaputt", { status: 502 });
    await expect(loadMe(new DeviceStorage(store))).rejects.toThrow();
    expect(store.data.has("gamehearth.rooms")).toBe(true);
  });
});

describe("Home page", () => {
  it("shows sign-in and joining by code without a session, but no games", async () => {
    const root = await mount(<Home notify={() => {}} />, session(undefined));
    expect(root.querySelector("#login-username")).not.toBeNull();
    expect(root.textContent).toContain("Accounts gibt es auf Einladung");
    expect(root.textContent).toContain("Mit Code beitreten");
    expect(root.textContent).not.toContain("Neues Spiel");
    expect(calls).toEqual([]);
  });

  it("shows an account its rooms, the games and sign-out", async () => {
    routes["GET /api/me/rooms"] = () => ({
      rooms: [{ code: "AAAAAA", game: "Mau-Mau", status: "running", round: 2, members: 3, host: true, yourTurn: true, updatedAt: 1 }],
    });
    routes["GET /api/games"] = () => [{ id: "mau-mau", name: "Mau-Mau", version: "0.1.0", mode: "turn-based", players: { min: 2, max: 6 } }];
    routes["POST /api/logout"] = () => ({});
    const setUser = vi.fn();
    const root = await mount(<Home notify={() => {}} />, session(anna, { setUser }));
    expect(root.textContent).toContain("Angemeldet als Anna");
    expect(root.textContent).toContain("Raumcode AAAAAA · 3 Mitglieder");
    expect(root.querySelector(".room-card .chip.turn")?.textContent).toBe("Du bist dran");
    expect(root.textContent).toContain("Raum anlegen");
    expect(root.querySelector("#login-username")).toBeNull();
    const signOut = [...root.querySelectorAll("button")].find((button) => button.textContent === "Abmelden");
    await act(async () => {
      signOut?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(setUser).toHaveBeenCalledWith(undefined);
  });

  it("reloads My rooms when the session is refreshed, e.g. after an adoption", async () => {
    let list: unknown[] = [];
    routes["GET /api/me/rooms"] = () => ({ rooms: list });
    routes["GET /api/games"] = () => [];
    const root = await mount(<Home notify={() => {}} />, session(anna));
    expect(root.textContent).not.toContain("Meine Räume");
    list = [{ code: "BBBBBB", game: "Mau-Mau", status: "lobby", round: 1, members: 2, host: false, yourTurn: false, updatedAt: 1 }];
    await act(async () => {
      render(<SessionContext.Provider value={session(anna)}>{<Home notify={() => {}} />}</SessionContext.Provider>, container as HTMLElement);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(root.textContent).toContain("Raumcode BBBBBB");
  });

  it("shows guests their rooms, the note about accounts, and sign-in only on request", async () => {
    routes["GET /api/me/rooms"] = () => ({ rooms: [] });
    const root = await mount(<Home notify={() => {}} />, session(guest));
    expect(root.textContent).toContain("Du spielst als Gast ohne Passwort.");
    expect(root.textContent).not.toContain("Raum anlegen");
    expect(root.querySelector("#login-username")).toBeNull();
    const show = [...root.querySelectorAll("button")].find((button) => button.textContent === "Ich habe einen Account");
    await act(async () => show?.click());
    expect(root.querySelector("#login-username")).not.toBeNull();
  });
});

describe("Invite", () => {
  it("reads the link from the fragment, fills in suggestions and checks the repetition", async () => {
    history.replaceState(null, "", "/invite#abc_DEF-123");
    routes["POST /api/links/inspect"] = () => ({ kind: "invite", role: "player", expiresAt: Date.UTC(2026, 10, 24, 12), username: "oma", name: "Oma Gerda" });
    const notices: string[] = [];
    const root = await mount(<InviteScreen kind="invite" notify={(text) => notices.push(text)} />, session(undefined));
    expect(calls[0]).toEqual({ path: "/api/links/inspect", body: { token: "abc_DEF-123", kind: "invite" } });
    expect(root.textContent).not.toContain("für Oma");
    expect(root.querySelector<HTMLInputElement>("#invite-username")?.value).toBe("oma");
    expect(root.querySelector<HTMLInputElement>("#invite-name")?.value).toBe("Oma Gerda");
    const input = (id: string, value: string) => {
      const element = root.querySelector<HTMLInputElement>(id) as HTMLInputElement;
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      input("#invite-password", "geheim-geheim");
      input("#invite-repeat", "geheim-anders");
    });
    await act(async () => {
      root.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(notices).toEqual(["Die beiden Passwörter sind nicht gleich."]);
    expect(calls.filter((call) => call.path === "/api/invites/accept")).toEqual([]);
  });

  it("asks a signed-in account to sign out first", async () => {
    history.replaceState(null, "", "/invite#abc");
    routes["POST /api/links/inspect"] = () => ({ kind: "invite", role: "player", expiresAt: 1 });
    const root = await mount(<InviteScreen kind="invite" notify={() => {}} />, session(anna));
    expect(root.textContent).toContain("Du bist schon als Anna angemeldet.");
  });

  it("reports an incomplete or invalid link", async () => {
    history.replaceState(null, "", "/setup");
    const root = await mount(<InviteScreen kind="setup" notify={() => {}} />, session(undefined));
    expect(root.textContent).toContain("Dieser Link ist unvollständig.");
    history.replaceState(null, "", "/setup#falsch");
    routes["POST /api/links/inspect"] = () => new Response(JSON.stringify({ code: "unknown-link", message: "x" }), { status: 404 });
    act(() => render(null, container as HTMLElement));
    const again = await mount(<InviteScreen kind="setup" notify={() => {}} />, session(undefined));
    expect(again.textContent).toContain("Dieser Link ist ungültig, abgelaufen oder wurde schon benutzt.");
  });
});

describe("Admin view", () => {
  it("shows non-admins only a note and loads nothing", async () => {
    const root = await mount(<AdminScreen notify={() => {}} />, session({ ...anna, role: "player" }));
    expect(root.textContent).toContain("Das dürfen nur Admins.");
    expect(calls).toEqual([]);
  });

  it("loads invites, users, rooms, quarantines and backups for admins, each on its own tab with counters", async () => {
    routes["GET /api/admin/invites"] = () => ({ invites: [{ id: 1, role: "player", note: "für Oma", createdAt: 1, expiresAt: 2, createdBy: "anna" }] });
    routes["GET /api/admin/users"] = () => ({ users: [{ id: 1, username: "anna", name: "Anna", role: "admin", locked: false, createdAt: 1, activeAt: 2, rooms: 3 }] });
    routes["GET /api/admin/rooms"] = () => ({ rooms: [] });
    routes["GET /api/admin/builds"] = () => ({ quarantined: [{ build: "kaputt/1+abc", since: 1, reason: "3 harte" }] });
    routes["GET /api/admin/backups"] = () => ({ backups: [], enabled: false });
    const users = await mount(<AdminScreen tab="users" notify={() => {}} />, session(anna));
    expect(users.textContent).toContain("für Oma");
    expect(users.textContent).toContain("@anna");
    expect(users.textContent).toContain("3 Räume");
    expect(users.textContent).not.toContain("kaputt/1+abc");
    const tabs = [...users.querySelectorAll(".admin-tabs a")].map((tab) => [tab.textContent, tab.getAttribute("href"), tab.getAttribute("aria-current")]);
    expect(tabs).toEqual([
      ["Spiele", "/admin/games", null],
      ["Nutzer & Einladungen1, 1 offene Einladung", "/admin/users", "page"],
      ["Räume", "/admin/rooms", null],
      ["System1, 1 gesperrte Spielfassung", "/admin/system", null],
    ]);
    act(() => render(null, users));
    users.remove();
    const rooms = await mount(<AdminScreen tab="rooms" notify={() => {}} />, session(anna));
    expect(rooms.textContent).toContain("Keine Räume.");
    act(() => render(null, rooms));
    rooms.remove();
    const system = await mount(<AdminScreen tab="system" notify={() => {}} />, session(anna));
    expect(system.textContent).toContain("kaputt/1+abc");
    expect(system.textContent).toContain("Sicherungen sind auf diesem Server nicht eingerichtet.");
    expect(system.textContent).not.toContain("für Oma");
  });
});

describe("Adopting guest seats", () => {
  it("asks after login and sends the answer", async () => {
    routes["POST /api/me/adopt"] = () => ({ moved: ["AAAAAA"] });
    const refresh = vi.fn(async () => undefined);
    const value: SessionValue = {
      me: { state: "ready", user: anna, adopt: { name: "Anna am Handy", rooms: [{ code: "AAAAAA", game: "Mau-Mau", status: "lobby", round: 1, members: 2, host: false, yourTurn: false, updatedAt: 1 }] } },
      user: anna,
      refresh,
      setUser: () => undefined,
      reload: () => undefined,
    };
    const root = await mount(<AdoptDialog notify={() => {}} />, value);
    expect(root.textContent).toContain("als Gast „Anna am Handy“ in einem Raum");
    const take = [...root.querySelectorAll("button")].find((button) => button.textContent === "Übernehmen");
    await act(async () => {
      take?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(calls).toEqual([{ path: "/api/me/adopt", body: { take: true } }]);
    expect(refresh).toHaveBeenCalled();
  });

  it("shows nothing without an open question", async () => {
    const root = await mount(<AdoptDialog notify={() => {}} />, session(anna));
    expect(root.textContent).toBe("");
  });
});

describe("Announcing cleanup", () => {
  it("mentions only the last seven days before cleanup", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(expiryNote(undefined, 0)).toBe("");
    expect(expiryNote(8 * day, 0)).toBe("");
    expect(expiryNote(7 * day, 0)).toBe(" · wird in 7 Tagen aufgeräumt");
    expect(expiryNote(day + 5, 0)).toBe(" · wird morgen aufgeräumt");
    expect(expiryNote(5, 0)).toBe(" · wird heute aufgeräumt");
  });
});

describe("Review: without network", () => {
  it("reports on the account page that the devices could not be loaded, and retries", async () => {
    routes["GET /api/me/sessions"] = () => new Response("weg", { status: 502 });
    const root = await mount(<AccountScreen notify={() => {}} />, session(anna));
    expect(root.textContent).toContain("Keine Verbindung zum Server.");
    routes["GET /api/me/sessions"] = () => ({ sessions: [{ id: 1, browser: "Firefox", system: "Linux", createdAt: 1, seenAt: 2, current: true }] });
    const retry = [...root.querySelectorAll("button")].find((button) => button.textContent === "Erneut versuchen");
    await act(async () => {
      retry?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(root.textContent).toContain("Firefox auf Linux");
  });

  it("offers a retry for a link without network and loads by itself after reconnecting", async () => {
    history.replaceState(null, "", "/invite#abc");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    const root = await mount(<InviteScreen kind="invite" notify={() => {}} />, session(undefined));
    expect(root.textContent).toContain("Keine Verbindung zum Server.");
    expect([...root.querySelectorAll("button")].some((button) => button.textContent === "Erneut versuchen")).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ kind: "invite", role: "player", expiresAt: 1, name: "Oma" }), { status: 200 })));
    await act(async () => {
      dispatchEvent(new Event("online"));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(root.querySelector<HTMLInputElement>("#invite-name")?.value).toBe("Oma");
  });
});

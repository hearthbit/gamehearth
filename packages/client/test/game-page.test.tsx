// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeUpdate } from "../src/game-bridge";
import { savedPage, savePage } from "../src/page-store";
import type { GamePage, Me, RoomView } from "../src/protocol";
import { parseRoute } from "../src/router";
import { Games } from "../src/screens/admin-games";
import { GameScreen } from "../src/screens/game";
import { SessionContext, type SessionValue } from "../src/session";
import { forgetSoloSessions } from "../src/solo-service";
import { profileLines } from "../src/ui/boards";

type Route = (body: unknown) => unknown;
let routes: Record<string, Route>;
let calls: { path: string; body: unknown }[];
let container: HTMLElement | undefined;
let notes: string[];

const anna: Me = { id: 7, kind: "account", username: "anna", name: "Anna", role: "player" };
const gast: Me = { id: 9, kind: "guest", name: "Gast", role: "player" };

const catalog = {
  items: { muenze: { label: "Münze" }, apfel: { label: "Apfel" }, "alte-muenze": { label: "Alte Münze", deprecated: true } },
  stats: {
    siege: { label: "Siege", better: "higher" as const },
    partien: { label: "Gespielte Partien" },
    kuerzeste: { label: "Kürzeste Partie", better: "lower" as const, format: "time" as const },
  },
  flags: { gegessen: { label: "Hat schon einen Apfel gegessen" }, titel: { label: "Titel" } },
};

function page(profile: GamePage["profile"], extra: Partial<GamePage> = {}): GamePage {
  return {
    game: { id: "dorfladen", name: "Dorfladen", version: "0.1.0", description: "Münzen verdienen, Äpfel essen", mode: "turn-based", players: { min: 1, max: 4 }, roles: ["player"], solo: false, ...catalog },
    profile,
    boards: { siege: [{ rank: 1, name: "Anna", value: 3, you: true }, { rank: 2, name: "Ben", value: 1, you: false }], kuerzeste: [{ rank: 1, name: "Ben", value: 83_400, you: false }] },
    source: "server",
    ...extra,
  };
}

const full = { items: { muenze: 4, "alte-muenze": 1, unbekannt: 2 }, stats: { siege: 3, partien: 5, kuerzeste: 83_400 }, flags: { gegessen: true as const, titel: "Ladenkönig" } };

beforeEach(() => {
  localStorage.clear();
  forgetSoloSessions();
  routes = {};
  calls = [];
  notes = [];
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

afterEach(() => {
  vi.unstubAllGlobals();
  if (container !== undefined) {
    act(() => render(null, container as HTMLElement));
    container.remove();
    container = undefined;
  }
});

function session(value: Partial<SessionValue>): SessionValue {
  return { me: { state: "ready", user: anna }, user: anna, refresh: async () => undefined, setUser: () => undefined, reload: () => undefined, ...value };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(node: preact.ComponentChildren, value: SessionValue): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    render(<SessionContext.Provider value={value}>{node}</SessionContext.Provider>, container as HTMLElement);
  });
  await settle();
  return container;
}

function click(element: Element | null | undefined): Promise<void> {
  return act(async () => {
    (element as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
}

describe("Game page", () => {
  it("is reached at /game/<id>", () => {
    expect(parseRoute("/game/dorfladen")).toEqual({ name: "game", game: "dorfladen" });
    expect(parseRoute("/game/Dorf")).toEqual({ name: "home" });
  });

  it("shows the description, your own profile with display names and leaderboards of the ranked stats", async () => {
    routes["GET /api/games/dorfladen"] = () => page(full);
    const root = await mount(<GameScreen gameId="dorfladen" notify={(text) => notes.push(text)} />, session({}));
    expect(root.querySelector("h1")?.textContent).toBe("Dorfladen");
    expect(root.textContent).toContain("Münzen verdienen, Äpfel essen");
    const entries = [...root.querySelectorAll(".profile-list > div")].map((entry) => entry.textContent);
    expect(entries).toEqual(["Münze4", "Alte Münze (veraltet)1", "Siege3", "Gespielte Partien5", "Kürzeste Partie1:23,4", "Hat schon einen Apfel gegessenja", "TitelLadenkönig"]);
    expect(root.textContent).not.toContain("unbekannt");
    const boards = [...root.querySelectorAll(".game-board")].map((board) => board.getAttribute("data-stat"));
    expect(boards).toEqual(["siege", "kuerzeste"]);
    expect(root.querySelector('[data-stat="kuerzeste"] .value')?.textContent).toBe("1:23,4");
    expect(root.querySelector('[data-stat="siege"] li.you')?.textContent).toContain("Anna");
    expect(button(root, "Raum anlegen")).toBeDefined();
    expect(savedPage(anna.id, "dorfladen")?.profile?.items).toEqual(full.items);
  });

  it("resets your own profile only after confirmation", async () => {
    routes["GET /api/games/dorfladen"] = () => page(full);
    routes["POST /api/games/dorfladen/reset"] = () => page({ items: {}, stats: {}, flags: {} }, { boards: {} });
    const root = await mount(<GameScreen gameId="dorfladen" notify={(text) => notes.push(text)} />, session({}));
    await click(button(root, "Profil zurücksetzen"));
    expect(document.querySelector('[role=alertdialog]')?.textContent).toContain("Dein Profil in Dorfladen wirklich zurücksetzen?");
    expect(calls.some((call) => call.path.endsWith("/reset"))).toBe(false);
    await click([...document.querySelectorAll('[role=alertdialog] button')].find((candidate) => candidate.textContent === "Profil zurücksetzen"));
    expect(calls.filter((call) => call.path === "/api/games/dorfladen/reset")).toHaveLength(1);
    expect(root.textContent).toContain("Noch nichts gesammelt");
    expect(notes).toContain("Profil zurückgesetzt.");
    expect(savedPage(anna.id, "dorfladen")?.profile).toEqual({ items: {}, stats: {}, flags: {} });
  });

  it("shows the last state offline and does not allow a reset", async () => {
    savePage(anna.id, page(full));
    localStorage.setItem("gamehearth.solo.last", JSON.stringify({ id: anna.id, name: "Anna" }));
    const root = await mount(<GameScreen gameId="dorfladen" notify={(text) => notes.push(text)} />, session({ me: { state: "offline" }, user: undefined }));
    expect(calls).toEqual([]);
    expect(root.textContent).toContain("Stand der letzten Verbindung.");
    expect(root.textContent).toContain("Ladenkönig");
    expect(button(root, "Profil zurücksetzen")).toBeUndefined();
    const other = await mount(<GameScreen gameId="anderes" notify={() => {}} />, session({ me: { state: "offline" }, user: undefined }));
    expect(other.textContent).toContain("noch keinen gespeicherten Stand");
  });

  it("shows guests the leaderboard, but no profile and no room to create", async () => {
    routes["GET /api/games/dorfladen"] = () => page(null);
    const root = await mount(<GameScreen gameId="dorfladen" notify={() => {}} />, session({ me: { state: "ready", user: gast }, user: gast }));
    expect(root.textContent).toContain("Als Gast hast du kein Profil");
    expect(button(root, "Raum anlegen")).toBeUndefined();
    expect(button(root, "Profil zurücksetzen")).toBeUndefined();
    expect(root.querySelectorAll(".game-board")).toHaveLength(2);
  });

  it("names the origin of the values for single-player games and leads to playing", async () => {
    routes["GET /api/games/sammler"] = () =>
      page({ items: {}, stats: { punkte: 9 }, flags: {} }, {
        game: { ...page(null).game, id: "sammler", name: "Sammler", solo: true, items: {}, flags: {}, stats: { punkte: { label: "Punkte", better: "higher" } } },
        boards: { punkte: [{ rank: 1, name: "Anna", value: 9, you: true }] },
        source: "client",
      });
    const root = await mount(<GameScreen gameId="sammler" notify={() => {}} />, session({}));
    expect(root.textContent).toContain("vom Gerät gemeldet");
    expect(button(root, "Spielen")).toBeDefined();
  });
});

describe("Profile in the game", () => {
  it("passes the profile to your own seat, never to the TV", () => {
    const view: RoomView = {
      code: "ABC234",
      game: { id: "dorfladen", name: "Dorfladen", version: "0.1.0", client: "/games/x/" },
      status: "running",
      round: 1,
      players: { min: 1, max: 4 },
      maxMembers: 4,
      members: [{ id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false, you: true, connected: true }],
      you: { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false },
      canStart: false,
      snapshot: { player: "p1", players: ["p1"], public: {}, me: {}, moves: [], version: 2 },
      profile: { items: { muenze: 2 }, stats: {}, flags: {} },
    };
    expect(bridgeUpdate(view, true)).toMatchObject({ seat: "p1", profile: { items: { muenze: 2 }, stats: {}, flags: {} } });
    const { you: _you, profile: _profile, ...screen } = view;
    expect(bridgeUpdate({ ...screen, screen: 1, screens: [] } as never, true)).not.toHaveProperty("profile");
  });

  it("lists only entries from the catalog, in its order", () => {
    expect(profileLines(full, catalog).map((line) => `${line.section}.${line.id}`)).toEqual([
      "items.muenze",
      "items.alte-muenze",
      "stats.siege",
      "stats.partien",
      "stats.kuerzeste",
      "flags.gegessen",
      "flags.titel",
    ]);
  });
});

describe("Profiles in the admin view", () => {
  const overview = {
    games: [
      {
        id: "dorfladen",
        name: "Dorfladen",
        version: "0.2.0",
        build: "dorfladen@0.2.0+abcdefabcdef",
        source: "local",
        broken: false,
        unknownIds: { items: ["apfel"], stats: [], flags: [] },
        rooms: { lobby: 0, running: 0, finished: 0 },
        bytes: 1000,
      },
    ],
    catalogs: [],
    offers: [],
    storage: { total: 1000, free: null },
    suggested: null,
    enabled: false,
  };
  const profiles = (items: Record<string, number>) => ({
    game: { id: "dorfladen", name: "Dorfladen", ...catalog },
    profiles: [{ user: 7, name: "Anna", profile: { items, stats: { siege: 3 }, flags: {} }, updatedAt: Date.UTC(2026, 10, 20) }],
    unknownIds: { items: [], stats: [], flags: [] },
  });

  it("names unknown IDs, deletes single entries and resets whole profiles, each after confirmation", async () => {
    routes["GET /api/admin/games"] = () => overview;
    routes["GET /api/admin/games/dorfladen/profiles"] = () => profiles({ muenze: 4, apfel: 1 });
    routes["POST /api/admin/games/dorfladen/profiles/7/delete"] = () => profiles({ muenze: 4 });
    routes["POST /api/admin/games/dorfladen/profiles/7/reset"] = () => ({ ...profiles({}), profiles: [] });
    const admin: Me = { ...anna, role: "admin" };
    const root = await mount(<Games notify={(text) => notes.push(text)} />, session({ me: { state: "ready", user: admin }, user: admin }));
    expect(root.textContent).toContain("Diese Fassung kennt IDs nicht mehr, die noch in Profilen stehen: items: apfel.");
    const details = [...root.querySelectorAll("details")].find((element) => element.querySelector("summary")?.textContent === "Profile") as HTMLDetailsElement;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const rows = [...details.querySelectorAll(".admin-profile li")].map((row) => row.querySelector("span")?.textContent);
    expect(rows).toEqual(["Münze: 4", "Apfel: 1", "Siege: 3"]);
    await click([...details.querySelectorAll(".admin-profile li")][1]?.querySelector("button"));
    expect(document.querySelector('[role=alertdialog]')?.textContent).toContain("„Apfel“ aus dem Profil von Anna in Dorfladen löschen?");
    await click([...document.querySelectorAll('[role=alertdialog] button')].find((candidate) => candidate.textContent === "Löschen"));
    expect(calls.find((call) => call.path.endsWith("/delete"))?.body).toEqual({ section: "items", id: "apfel" });
    expect([...details.querySelectorAll(".admin-profile li")].map((row) => row.querySelector("span")?.textContent)).toEqual(["Münze: 4", "Siege: 3"]);
    await click(button(details, "Ganzes Profil zurücksetzen"));
    await click([...document.querySelectorAll('[role=alertdialog] button')].find((candidate) => candidate.textContent === "Ganzes Profil zurücksetzen"));
    expect(details.textContent).toContain("Noch niemand hat in diesem Spiel etwas gesammelt.");
  });
});

describe("Review 10b: signing out on the invite page", () => {
  it("clears the saved game pages, as on the home page", async () => {
    const { InviteScreen } = await import("../src/screens/links");
    history.replaceState(null, "", "/invite#abc");
    routes["POST /api/links/inspect"] = () => ({ kind: "invite", role: "player", expiresAt: Date.now() + 60_000 });
    routes["POST /api/logout"] = () => ({});
    savePage(anna.id, page(full));
    let user: Me | undefined = anna;
    const root = await mount(<InviteScreen kind="invite" notify={() => {}} />, session({ setUser: (next) => (user = next) }));
    await click(button(root, "Abmelden"));
    expect(calls.some((call) => call.path === "/api/logout")).toBe(true);
    expect(user).toBeUndefined();
    expect(savedPage(anna.id, "dorfladen")).toBeUndefined();
  });
});

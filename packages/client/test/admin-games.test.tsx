// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GamesOverview } from "../src/api";
import type { Command, CommandResult, RoomView } from "../src/protocol";
import { Games } from "../src/screens/admin-games";
import { ProblemBox, ProblemContext, type Problem } from "../src/screens/admin-parts";
import { Play } from "../src/screens/play";

type Route = (body: unknown) => unknown;
let routes: Record<string, Route>;
let calls: { method: string; path: string; body: unknown }[];
let container: HTMLElement | undefined;

beforeEach(() => {
  routes = {};
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      const method = init?.method ?? "GET";
      calls.push({ method, path, body });
      const route = routes[`${method} ${path}`];
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

async function settle(): Promise<void> {
  await act(async () => {
    for (let round = 0; round < 5; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function mount(element: preact.JSX.Element): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    render(element, container as HTMLElement);
  });
  await settle();
  return container;
}

const button = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);

async function click(element: HTMLElement | undefined | null): Promise<void> {
  expect(element).toBeTruthy();
  await act(async () => element?.click());
  await settle();
}

const version = (number: string, compatible = true) => ({
  version: number,
  sdk: compatible ? "^0.1.0" : "^0.9.0",
  mode: "turn-based",
  players: { min: 2, max: 6 },
  license: { code: "MIT", assets: "CC0-1.0" },
  size: 812_345,
  compatible,
});

const empty: GamesOverview = {
  games: [],
  catalogs: [],
  offers: [],
  storage: { total: 0, free: 5 * 1024 * 1024 * 1024 },
  suggested: { name: "Gamehearth", url: "https://example.org/catalog.json" },
  enabled: true,
};

const withCatalog: GamesOverview = {
  games: [
    {
      id: "mau-mau",
      name: "Mau-Mau",
      version: "0.1.0",
      build: "mau-mau@0.1.0+abcdefabcdef",
      source: "catalog",
      catalogId: 1,
      catalogName: "Gamehearth-Katalog",
      broken: false,
      rooms: { lobby: 1, running: 1, finished: 0 },
      bytes: 1_400_000,
    },
  ],
  catalogs: [{ id: 1, url: "https://example.org/catalog.json", name: "Gamehearth-Katalog", addedAt: 1, fetchedAt: 2, checkedAt: 3, games: 2 }],
  offers: [
    {
      catalogId: 1,
      catalogName: "Gamehearth-Katalog",
      id: "mau-mau",
      name: "Mau-Mau",
      versions: [version("0.2.0"), version("0.1.0")],
      installed: { version: "0.1.0", build: "mau-mau@0.1.0+abcdefabcdef", fromThisCatalog: true, local: false },
      update: "0.2.0",
    },
    {
      catalogId: 1,
      catalogName: "Gamehearth-Katalog",
      id: "schach",
      name: "Schach",
      description: "Das Brettspiel",
      repository: "https://example.org/schach",
      versions: [version("2.0.0", false), version("1.0.0")],
    },
  ],
  storage: { total: 1_400_000, free: null },
  suggested: null,
  enabled: true,
};

describe("Games in the admin view", () => {
  it("suggests the Gamehearth catalog and adds it only after the trust question", async () => {
    routes["GET /api/admin/games"] = () => empty;
    routes["POST /api/admin/catalogs"] = () => ({ catalog: { id: 1, url: "https://example.org/catalog.json", name: "Gamehearth-Katalog", games: 2 } });
    const notes: string[] = [];
    const root = await mount(<Games notify={(message) => notes.push(message)} />);
    expect(root.textContent).toContain("Noch keine Spiele installiert");
    expect(root.textContent).toContain("frei sind 5.0 GB");
    await click(button(root, "Gamehearth-Katalog hinzufügen"));
    const dialog = root.querySelector("[role=alertdialog]");
    expect(dialog?.textContent).toContain("Diesem Katalog vertrauen? https://example.org/catalog.json");
    expect(dialog?.textContent).toContain("WebRTC");
    expect(dialog?.textContent).toContain("auch ihre Namen");
    await click(button(root, "Abbrechen"));
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    await click(button(root, "Gamehearth-Katalog hinzufügen"));
    await click(button(root, "Vertrauen und hinzufügen"));
    expect(calls.find((call) => call.method === "POST")).toEqual({
      method: "POST",
      path: "/api/admin/catalogs",
      body: { url: "https://example.org/catalog.json", trust: true },
    });
    expect(notes).toEqual(["Gamehearth-Katalog hinzugefügt, 2 Spiele."]);
  });

  it("shows installed games with rooms, update, version choice and removal", async () => {
    let loads = 0;
    routes["GET /api/admin/games"] = () => {
      loads += 1;
      return loads < 3 ? withCatalog : { ...withCatalog, games: [{ ...withCatalog.games[0], rooms: { lobby: 1, running: 2, finished: 0 } }] };
    };
    routes["POST /api/admin/games/install"] = () => ({ build: "mau-mau@0.2.0+111111111111" });
    routes["POST /api/admin/games/mau-mau/remove"] = () => ({ closed: 1, remaining: 2 });
    const notes: string[] = [];
    const root = await mount(<Games notify={(message) => notes.push(message)} />);
    expect(root.textContent).toContain("Mau-Mau 0.1.0");
    expect(root.textContent).toContain("aus Gamehearth-Katalog · 1 laufende Partie, 1 Lobby · 1.3 MB");
    await click(button(root, "Update auf 0.2.0"));
    expect(calls.find((call) => call.path === "/api/admin/games/install")?.body).toEqual({ catalog: 1, game: "mau-mau", version: "0.2.0" });
    expect(notes).toContain("Mau-Mau 0.2.0 ist installiert.");

    await click(button(root, "Entfernen"));
    const dialog = root.querySelector("[role=alertdialog]");
    expect(dialog?.textContent).toContain("Mau-Mau vom Server entfernen?");
    expect(dialog?.textContent).toContain("Betroffen: 2 laufende Partien, 1 Lobby.");
    expect(dialog?.textContent).toContain("Laufende Partien spielen zu Ende");
    const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent === "Entfernen");
    await click(confirm);
    expect(calls.some((call) => call.path === "/api/admin/games/mau-mau/remove")).toBe(true);
    expect(notes).toContain("Mau-Mau ist entfernt, 1 Lobby geschlossen.");
  });

  it("offers available games with a matching version and installs them", async () => {
    routes["GET /api/admin/games"] = () => withCatalog;
    routes["POST /api/admin/games/install"] = () => ({ build: "schach@1.0.0+222222222222" });
    const root = await mount(<Games notify={() => {}} />);
    expect(root.textContent).toContain("Das Brettspiel");
    expect(root.textContent).toContain("Code MIT, Grafik CC0-1.0");
    expect(root.querySelector<HTMLAnchorElement>("a[href='https://example.org/schach']")?.rel).toContain("noopener");
    const install = root.querySelector<HTMLButtonElement>("button[aria-label='Schach Installieren']");
    expect(install?.textContent).toBe("Installieren 1.0.0");
    await click(install);
    expect(calls.find((call) => call.path === "/api/admin/games/install")?.body).toEqual({ catalog: 1, game: "schach", version: "1.0.0" });
  });

  it("preselects a valid version again after installing another version", async () => {
    let installedVersion = "0.2.0";
    routes["GET /api/admin/games"] = () => ({
      ...withCatalog,
      games: [{ ...withCatalog.games[0], version: installedVersion }],
      offers: [
        {
          ...withCatalog.offers[0],
          versions: [version("0.3.0"), version("0.2.0"), version("0.1.0")],
          installed: { version: installedVersion, build: "b", fromThisCatalog: true, local: false },
          update: "0.3.0",
        },
      ],
    });
    routes["POST /api/admin/games/install"] = (body) => {
      installedVersion = (body as { version: string }).version;
      return { build: "x" };
    };
    const root = await mount(<Games notify={() => {}} />);
    const select = () => root.querySelector<HTMLSelectElement>("details select");
    const install = () => [...root.querySelectorAll<HTMLButtonElement>("details button")].find((candidate) => candidate.textContent?.trim() === "Installieren");
    await act(async () => {
      const element = select() as HTMLSelectElement;
      element.value = "0.1.0";
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(install());
    await settle();
    await settle();
    expect(root.querySelector("li strong")?.textContent).toBe("Mau-Mau 0.1.0");
    expect(installedVersion).toBe("0.1.0");
    expect([...(select()?.options ?? [])].map((option) => option.value)).toEqual(["0.3.0", "0.2.0"]);
    expect(select()?.value).toBe("0.3.0");
    await click(install());
    expect(calls.filter((call) => call.path === "/api/admin/games/install").map((call) => (call.body as { version: string }).version)).toEqual(["0.1.0", "0.3.0"]);
  });

  it("asks before replacing a game from another catalog", async () => {
    routes["GET /api/admin/games"] = () => ({
      ...withCatalog,
      offers: [{ ...withCatalog.offers[0], catalogId: 2, catalogName: "Fremd", installed: { version: "0.1.0", build: "x", fromThisCatalog: false, local: false }, update: undefined }],
    });
    routes["POST /api/admin/games/install"] = () => ({ build: "y" });
    const root = await mount(<Games notify={() => {}} />);
    expect(root.textContent).not.toContain("Update auf");
    await click(root.querySelector<HTMLButtonElement>("button[aria-label='Mau-Mau Installieren']"));
    expect(root.querySelector("[role=alertdialog]")?.textContent).toContain("schon aus einem anderen Katalog installiert");
    await click(button(root, "Ersetzen"));
    expect(calls.find((call) => call.path === "/api/admin/games/install")?.body).toEqual({ catalog: 2, game: "mau-mau", version: "0.2.0", replace: true });
  });

  it("shows errors when loading a catalog and when installing", async () => {
    routes["GET /api/admin/games"] = () => ({ ...withCatalog, catalogs: [{ ...withCatalog.catalogs[0], error: "https://example.org/catalog.json responds with 500" }] });
    routes["POST /api/admin/games/install"] = () =>
      new Response(JSON.stringify({ code: "probe-failed", message: "The trial match with schach@1.0.0+x failed: broken" }), { status: 400 });
    const notes: string[] = [];
    const root = await mount(<Games notify={(message) => notes.push(message)} />);
    expect(root.querySelector("[role=alert]")?.textContent).toBe("Letztes Laden gescheitert: https://example.org/catalog.json responds with 500");
    await click(root.querySelector<HTMLButtonElement>("button[aria-label='Schach Installieren']"));
    expect(notes).toEqual(["Das Spiel lässt sich auf dem Server nicht starten; die Probepartie ist gescheitert."]);
  });

  it("Review 12a: labels the install button of an offer with a translated name in the UI language", async () => {
    routes["GET /api/admin/games"] = () => ({
      ...withCatalog,
      offers: withCatalog.offers.map((offer) => (offer.name === "Schach" ? { ...offer, name: { de: "Schach", en: "Chess" } } : offer)),
    });
    const root = await mount(<Games notify={() => {}} />);
    expect(root.querySelector("button[aria-label='Schach Installieren']")).not.toBeNull();
    expect(root.innerHTML).not.toContain("[object Object]");
  });

  it("Step 12: shows a translated sentence per error code and the English message to expand", async () => {
    routes["GET /api/admin/games"] = () => ({
      ...withCatalog,
      catalogs: [{ ...withCatalog.catalogs[0], error: "https://example.org/catalog.json responds with 500", errorCode: "catalog-unavailable" }],
    });
    routes["POST /api/admin/games/install"] = () =>
      new Response(JSON.stringify({ code: "probe-failed", message: "The trial match with schach@1.0.0+x failed: broken" }), { status: 400 });
    const problems: Problem[] = [];
    const notes: string[] = [];
    const root = await mount(
      <ProblemContext.Provider value={(problem) => problems.push(problem)}>
        <Games notify={(message) => notes.push(message)} />
      </ProblemContext.Provider>,
    );
    const alert = root.querySelector("[role=alert]");
    expect(alert?.querySelector("p")?.textContent).toBe("Letztes Laden gescheitert: Der Katalog lässt sich gerade nicht laden.");
    expect(alert?.querySelector("details code")?.textContent).toBe("https://example.org/catalog.json responds with 500");
    await click(root.querySelector<HTMLButtonElement>("button[aria-label='Schach Installieren']"));
    expect(notes).toEqual([]);
    expect(problems).toEqual([{ code: "probe-failed", message: "The trial match with schach@1.0.0+x failed: broken" }]);
    const box = await mount(<ProblemBox problem={problems[0] as Problem} onClose={() => {}} />);
    expect(box.querySelector("p")?.textContent).toBe("Das Spiel lässt sich auf dem Server nicht starten; die Probepartie ist gescheitert.");
    expect(box.querySelector("details code")?.textContent).toBe("The trial match with schach@1.0.0+x failed: broken");
  });
});

function running(overrides: Partial<RoomView> = {}): RoomView {
  return {
    code: "ABC234",
    game: { id: "mau-mau", name: "Mau-Mau", version: "0.1.0", client: "/games/mau-mau/0.1.0+abcdefabcdef/" },
    status: "running",
    round: 1,
    players: { min: 2, max: 6 },
    maxMembers: 6,
    members: [
      { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false, you: true, connected: true },
      { id: 2, name: "Ben", seat: "p2", host: false, guest: false, deleted: false, you: false, connected: true },
    ],
    you: { id: 1, name: "Anna", seat: "p1", host: true, guest: false, deleted: false },
    canStart: false,
    snapshot: { player: "p1", players: ["p1", "p2"], public: {}, me: {}, moves: [], version: 3 },
    ...overrides,
  };
}

describe("Room of a removed game", () => {
  it("lets the match play to the end and then offers only leaving instead of a new round", async () => {
    const commands: Command[] = [];
    const command = async (next: Command): Promise<CommandResult> => (commands.push(next), { ok: true });
    const left: string[] = [];
    const root = await mount(<Play room={running({ installed: false })} online command={command} notify={() => {}} onLeave={async () => void left.push("weg")} />);
    expect(root.textContent).toContain("Ihr könnt die Partie zu Ende spielen");
    await click(root.querySelector<HTMLButtonElement>("button[aria-label=Menü]"));
    await click(button(root, "Partie abbrechen"));
    expect(root.querySelector("[role=alertdialog]")?.textContent).toContain("der Raum wird deshalb geschlossen");
    await click(button(root, "Abbrechen"));

    act(() => render(<Play room={running({ installed: false, status: "finished" })} online command={command} notify={() => {}} onLeave={async () => void left.push("weg")} />, container as HTMLElement));
    expect(root.textContent).toContain("Eine neue Runde gibt es nicht.");
    expect(button(root, "Neue Runde")).toBeUndefined();
    await click(root.querySelector<HTMLButtonElement>("footer button"));
    await click([...(root.querySelector("[role=alertdialog]")?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent === "Raum verlassen"));
    expect(left).toEqual(["weg"]);
    expect(commands).toEqual([]);
  });
});

// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../src/protocol";
import { Home } from "../src/screens/home";
import { SessionContext, type SessionValue } from "../src/session";
import { forgetSoloSessions, soloSession } from "../src/solo-service";
import { lastUser, SoloStore } from "../src/solo-store";

type Route = (body: unknown) => unknown;
let routes: Record<string, Route>;
let calls: { path: string; body: unknown }[];
let container: HTMLElement | undefined;

const anna: Me = { id: 1, kind: "account", username: "anna", name: "Anna", role: "player" };
const sammler = {
  id: "sammler",
  name: "Sammler",
  version: "0.1.0",
  mode: "single",
  players: { min: 1, max: 1 },
  solo: true,
  build: "sammler@0.1.0+abcdefabcdef",
  stats: { sterne: { label: "Sterne", better: "higher" } },
};
const mauMau = { id: "mau-mau", name: "Mau-Mau", version: "0.1.0", mode: "turn-based", players: { min: 2, max: 6 } };

beforeEach(() => {
  localStorage.clear();
  forgetSoloSessions();
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

async function mount(value: SessionValue): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    render(
      <SessionContext.Provider value={value}>
        <Home notify={() => {}} />
      </SessionContext.Provider>,
      container as HTMLElement,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

function rowOf(root: HTMLElement, name: string): HTMLElement | undefined {
  return [...root.querySelectorAll("li")].find((item) => item.textContent?.includes(name));
}

describe("Home page with single-player games", () => {
  it('offers single-player games "Play" ("Spielen") instead of "Create room" ("Raum anlegen") and remembers the games on the device', async () => {
    routes["GET /api/me/rooms"] = () => ({ rooms: [] });
    routes["GET /api/games"] = () => [mauMau, sammler];
    const root = await mount(session({}));
    const row = rowOf(root, "Sammler");
    expect(row?.textContent).toContain("allein");
    expect(row?.textContent).toContain("auch ohne Verbindung");
    expect(row?.textContent).toContain("Spielen");
    expect(row?.textContent).not.toContain("Raum anlegen");
    expect(rowOf(root, "Mau-Mau")?.textContent).toContain("Raum anlegen");
    expect(lastUser()).toEqual({ id: 1, name: "Anna" });
    expect(new SoloStore({ id: 1, name: "Anna" }).games().map((game) => game.id)).toEqual(["sammler"]);
    expect(calls.map((call) => call.path)).toContain("/api/solo/sammler/files");
  });

  it("shows the single-player games of the last signed-in account without connection", async () => {
    const store = new SoloStore({ id: 1, name: "Anna" });
    store.remember();
    store.setGames([sammler as never]);
    store.setReady(sammler.build, true);
    const root = await mount(session({ me: { state: "offline" }, user: undefined }));
    expect(root.textContent).toContain("Keine Verbindung zum Server.");
    expect(root.textContent).toContain("Offline spielbar");
    expect(root.textContent).toContain("Ohne Verbindung spielst du als Anna.");
    expect(rowOf(root, "Sammler")?.textContent).toContain("bereit");
  });

  it("shows no offline list without connection and without an earlier account", async () => {
    const root = await mount(session({ me: { state: "offline" }, user: undefined }));
    expect(root.textContent).not.toContain("Offline spielbar");
  });

  it("syncs on sign-out and then deletes the account's single-player data on the device", async () => {
    routes["GET /api/me/rooms"] = () => ({ rooms: [] });
    routes["GET /api/games"] = () => [sammler];
    routes["POST /api/logout"] = () => ({});
    routes["POST /api/solo/sammler/sync"] = () => ({ game: "sammler", save: { data: { a: 1 }, savedAt: 5 }, savedAt: 5, best: {}, generations: {}, boards: {}, ignored: [] });
    const root = await mount(session({}));
    soloSession({ id: 1, name: "Anna" }).store.save("sammler", { a: 1 }, 5);
    const signOut = [...root.querySelectorAll("button")].find((button) => button.textContent === "Abmelden");
    await act(async () => {
      signOut?.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(calls.map((call) => call.path)).toEqual(expect.arrayContaining(["/api/solo/sammler/sync", "/api/logout"]));
    expect(calls.findIndex((call) => call.path === "/api/solo/sammler/sync")).toBeLessThan(calls.findIndex((call) => call.path === "/api/logout"));
    expect(localStorage.getItem("gamehearth.solo.1")).toBeNull();
    expect(lastUser()).toBeUndefined();
  });

  it("keeps on sign-out what could not be synced", async () => {
    routes["GET /api/me/rooms"] = () => ({ rooms: [] });
    routes["GET /api/games"] = () => [sammler];
    routes["POST /api/logout"] = () => ({});
    routes["POST /api/solo/sammler/sync"] = () => new Response(JSON.stringify({ code: "server-error", message: "kaputt" }), { status: 500 });
    const root = await mount(session({}));
    soloSession({ id: 1, name: "Anna" }).store.save("sammler", { a: 1 }, 5);
    const signOut = [...root.querySelectorAll("button")].find((button) => button.textContent === "Abmelden");
    await act(async () => {
      signOut?.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(new SoloStore({ id: 1, name: "Anna" }).saved("sammler")).toEqual({ a: 1 });
  });
});

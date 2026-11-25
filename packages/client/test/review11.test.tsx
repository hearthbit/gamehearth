// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { endIntro, startIntro } from "../src/effects";
import type { Me } from "../src/protocol";
import { navigate } from "../src/router";
import { AdminScreen } from "../src/screens/admin";
import { Home } from "../src/screens/home";
import { RoomScreen } from "../src/screens/room";
import { SessionContext, type SessionValue } from "../src/session";
import { DeviceStorage, type KeyValueStore } from "../src/storage";
import { setLanguage } from "../src/texts";
import { Cabinet } from "../src/ui/cabinet";
import { gameColor } from "../src/ui/cover";

type Route = (body: unknown) => unknown;
let routes: Record<string, Route>;
let container: HTMLElement | undefined;

function memory(): KeyValueStore {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) };
}

function session(user: Me | undefined): SessionValue {
  return { me: { state: "ready", user }, user, refresh: async () => undefined, setUser: () => undefined, reload: () => undefined };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(element: preact.JSX.Element, user?: Me): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    render(<SessionContext.Provider value={session(user)}>{element}</SessionContext.Provider>, container as HTMLElement);
  });
  await settle();
  return container;
}

function css(name: string): string {
  const path = [`packages/client/src/styles/${name}`, `src/styles/${name}`].find((candidate) => existsSync(candidate)) as string;
  return readFileSync(path, "utf8");
}

function rules(text: string): { selector: string; body: string; start: number }[] {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: (match[1] ?? "").trim(), body: match[2] ?? "", start: match.index ?? 0 }));
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

const anna: Me = { id: 1, kind: "account", username: "anna", name: "Anna", role: "admin" };

beforeEach(() => {
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      const route = routes[`${init?.method ?? "GET"} ${path}`];
      if (route === undefined) {
        return new Response(JSON.stringify({ code: "not-found", message: "not here" }), { status: 404 });
      }
      const result = route(body);
      return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLanguage("de");
  endIntro();
  if (container !== undefined) {
    act(() => render(null, container as HTMLElement));
    container.remove();
    container = undefined;
  }
});

describe("Review 11", () => {
  it("shows the cover and color of the room's own game, also when two games share a name", async () => {
    setLanguage("en");
    const game = { version: "1.0.0", mode: "turn-based", players: { min: 2, max: 2 } };
    routes["GET /api/games"] = () => ({
      games: [
        { ...game, id: "schach", name: { de: "Schach", en: "Chess" }, languages: ["de", "en"], cover: "/games/schach/1/cover.svg" },
        { ...game, id: "chess-960", name: "Chess" },
      ],
    });
    routes["GET /api/me/rooms"] = () => ({
      rooms: [{ code: "ABC234", gameId: "chess-960", game: "Chess", status: "lobby", round: 1, members: 1, host: true, yourTurn: false, updatedAt: 1 }],
    });
    const root = await mount(<Home storage={new DeviceStorage(memory())} notify={() => {}} />, anna);
    const card = root.querySelector<HTMLElement>(".room-card");
    expect(card).not.toBeNull();
    expect(card?.querySelector("img")).toBeNull();
    expect(card?.style.getPropertyValue("--tone")).toBe(gameColor("chess-960"));
  });

  it("orders the join page for keyboard users as it looks: name, sign-in, join", async () => {
    const root = await mount(<RoomScreen code="XYZ789" storage={new DeviceStorage(memory())} notify={() => {}} createConnection={vi.fn()} />);
    const name = root.querySelector("#join-name") as Element;
    const buttons = [...root.querySelectorAll("button")];
    const signIn = buttons.find((button) => button.textContent === "Ich habe einen Account") as Element;
    const join = buttons.find((button) => button.textContent === "Als Gast beitreten") as HTMLButtonElement;
    expect(name.compareDocumentPosition(signIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(signIn.compareDocumentPosition(join) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(join.getAttribute("form")).toBe("join-form");
  });

  it("ends the intro on the first page change inside the app instead of playing it on the next page", async () => {
    routes["GET /api/me"] = () => ({});
    history.replaceState(null, "", "/");
    startIntro();
    container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      render(<App storage={new DeviceStorage(memory())} loadMe={async () => ({})} />, container as HTMLElement);
    });
    await settle();
    expect(document.documentElement.dataset["intro"]).toBe("");
    await act(async () => navigate("/account"));
    await settle();
    expect(document.documentElement.dataset["intro"]).toBeUndefined();
    history.replaceState(null, "", "/");
  });

  it("reloads the tab counters after an invite is created, and marks the admin view as a calm scene", async () => {
    const invites: unknown[] = [];
    routes["GET /api/admin/invites"] = () => ({ invites });
    routes["GET /api/admin/builds"] = () => ({ quarantined: [] });
    routes["POST /api/admin/invites"] = () => {
      const invite = { id: invites.length + 1, role: "player", createdAt: 1, expiresAt: 2, createdBy: "anna" };
      invites.push(invite);
      return { token: "t", invite };
    };
    const root = await mount(<AdminScreen tab="users" notify={() => {}} />, anna);
    expect(document.documentElement.dataset["scene"]).toBe("admin");
    expect(root.querySelector(".tab-count")).toBeNull();
    const form = [...root.querySelectorAll("form")].find((candidate) => candidate.textContent?.includes("Einladung erstellen")) as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(root.querySelector(".tab-count")?.textContent).toBe("1");
  });

  it("gives the full name of a game as a tooltip on its cabinet", async () => {
    const root = await mount(<Cabinet id="siedler" name="Die Siedler von Catan, Seefahrer-Erweiterung" />);
    expect(root.querySelector(".marquee-text")?.getAttribute("title")).toBe("Die Siedler von Catan, Seefahrer-Erweiterung");
  });

  it("lets long names wrap on the marquee, keeps the admin tabs unclipped and every bar button 44 px high", () => {
    const screens = rules(css("screens.css"));
    const marquee = screens.find((rule) => rule.selector === ".marquee-text");
    expect(marquee?.body).not.toContain("nowrap");
    expect(marquee?.body).toContain("line-clamp: 2");
    const tabs = screens.filter((rule) => rule.selector === ".admin-tabs");
    expect(tabs.length).toBeGreaterThan(0);
    for (const rule of tabs) {
      expect(rule.body).not.toMatch(/overflow/);
    }
    expect(screens.find((rule) => rule.selector === ".bar .button.small")?.body).toContain("min-height: var(--tap)");
  });

  it("gives text fields a border of at least 3:1 against the panels in every theme", () => {
    const tokens = css("tokens.css");
    const blocks = [...tokens.matchAll(/:root\[data-theme="(\w+)"\]\s*\{([^}]*)\}/g)];
    expect(blocks.map((block) => block[1])).toEqual(expect.arrayContaining(["neon", "crt", "front"]));
    for (const [, theme, body] of blocks) {
      const value = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(body ?? "")?.[1];
      const border = value("line-strong");
      const panel = value("surface-solid");
      expect(border, theme).toBeDefined();
      expect(panel, theme).toBeDefined();
      expect(contrast(border as string, panel as string), theme).toBeGreaterThanOrEqual(3);
    }
  });

  it("runs every animation only with motion allowed and effects on, in every theme", () => {
    for (const file of ["neon.css", "crt.css", "front.css"]) {
      const text = css(file);
      const motion = [...text.matchAll(/@media \(prefers-reduced-motion: no-preference\) \{/g)].map((match) => {
        let depth = 0;
        let index = (match.index ?? 0) + match[0].length - 1;
        for (; index < text.length; index++) {
          depth += text[index] === "{" ? 1 : text[index] === "}" ? -1 : 0;
          if (depth === 0) {
            break;
          }
        }
        return [match.index ?? 0, index] as const;
      });
      for (const rule of rules(text)) {
        if (!/(^|[;\s])animation(-name)?\s*:/.test(rule.body) || /animation\s*:\s*none/.test(rule.body)) {
          continue;
        }
        expect(
          motion.some(([from, to]) => rule.start > from && rule.start < to),
          `${file}: ${rule.selector}`,
        ).toBe(true);
        expect(rule.selector, file).toContain(':not([data-effects="off"])');
      }
    }
  });
});

describe("Sound", () => {
  it("stays silent before the first tap or key, even when it is switched on on this device", async () => {
    vi.resetModules();
    localStorage.setItem("gamehearth.sound", "on");
    const created = vi.fn();
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          created();
        }
      },
    );
    const fresh = await import("../src/sound");
    fresh.playCue("tap");
    fresh.playCue("start");
    expect(created).not.toHaveBeenCalled();
    localStorage.removeItem("gamehearth.sound");
  });
});

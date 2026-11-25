// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, RoomSummary } from "../src/protocol";
import { PushPlatformContext, type PushPlatform } from "../src/push";
import { AccountScreen } from "../src/screens/account";
import { Home } from "../src/screens/home";
import { SessionContext, type SessionValue } from "../src/session";
import { DeviceStorage, type KeyValueStore } from "../src/storage";
import { AdoptDialog } from "../src/ui/adopt";

type Route = (body: unknown) => unknown;
let routes: Record<string, Route>;
let calls: { path: string; body: unknown }[];

beforeEach(() => {
  localStorage.clear();
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

function memory(): KeyValueStore {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) };
}

const anna: Me = { id: 1, kind: "account", username: "anna", name: "Anna", role: "player" };
const admin: Me = { id: 3, kind: "account", username: "chef", name: "Chef", role: "admin" };
const iosPlatform: PushPlatform = {
  support: () => "ios-install",
  permission: () => "default",
  requestPermission: async () => "default",
  registration: async () => undefined,
};
const ben: Me = { id: 2, kind: "guest", name: "Ben", role: "player" };

function session(user: Me | undefined, overrides: Partial<SessionValue> = {}): SessionValue {
  return { me: { state: "ready", user }, user, refresh: async () => undefined, setUser: () => undefined, reload: () => undefined, ...overrides };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(element: preact.JSX.Element, value: SessionValue): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    render(<SessionContext.Provider value={value}>{element}</SessionContext.Provider>, container as HTMLElement);
  });
  await settle();
  return container;
}

const button = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);

async function click(element: HTMLElement | undefined): Promise<void> {
  if (element === undefined) {
    throw new Error("Knopf fehlt");
  }
  await act(async () => {
    element.click();
  });
  await settle();
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

const cards = (root: HTMLElement) => [...root.querySelectorAll("main > section, main > .card, .home-forms > section")].map((card) => card.querySelector("h2")?.textContent ?? "");

describe("Creating a code", () => {
  it("shows the code on the account page with its expiry time and copies it", async () => {
    routes["GET /api/me/sessions"] = () => ({ sessions: [] });
    const expiresAt = Date.now() + 10 * 60 * 1000;
    routes["POST /api/me/transfer"] = () => ({ code: "ABCD-EFGH", expiresAt });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const notes: string[] = [];
    const root = await mount(<AccountScreen notify={(text) => notes.push(text)} />, session(ben));
    await click(button(root, "Code erzeugen"));
    expect(root.querySelector("[data-testid=transfer-code]")?.textContent).toBe("ABCD-EFGH");
    expect(root.textContent).toContain(`gilt bis ${new Date(expiresAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr`);
    await click(button(root, "Kopieren"));
    expect(writeText).toHaveBeenCalledWith("ABCD-EFGH");
    expect(notes).toContain("Code kopiert");
  });
});

describe("Redeeming a code", () => {
  it("sits below sign-in in the browser and signs in with the code", async () => {
    routes["POST /api/transfer"] = () => ({ user: ben });
    const setUser = vi.fn();
    const notes: string[] = [];
    const root = await mount(<Home storage={new DeviceStorage(memory())} notify={(text) => notes.push(text)} />, session(undefined, { setUser }));
    const order = cards(root);
    expect(order.indexOf("Von einem anderen Gerät weiterspielen")).toBeGreaterThan(order.indexOf("Mit Account anmelden"));
    const card = root.querySelector("[data-testid=redeem-card]") as HTMLElement;
    await type(card.querySelector("input") as HTMLInputElement, "abcd-efgh");
    await submit(card.querySelector("form") as HTMLFormElement);
    expect(calls.at(-1)).toEqual({ path: "/api/transfer", body: { code: "ABCD-EFGH" } });
    expect(setUser).toHaveBeenCalledWith(ben);
    expect(notes).toEqual(["Angemeldet als Ben."]);
  });

  it("is missing for signed-in accounts and reports invalid codes clearly", async () => {
    routes["GET /api/me/rooms"] = () => ({ rooms: [] });
    routes["GET /api/games"] = () => [];
    const signedIn = await mount(<Home storage={new DeviceStorage(memory())} notify={() => undefined} />, session(anna));
    expect(signedIn.querySelector("[data-testid=redeem-card]")).toBeNull();
    act(() => render(null, signedIn));
    signedIn.remove();
    routes["POST /api/transfer"] = () => new Response(JSON.stringify({ code: "unknown-code", message: "x" }), { status: 404 });
    const notes: string[] = [];
    const root = await mount(<Home storage={new DeviceStorage(memory())} notify={(text) => notes.push(text)} />, session(undefined));
    const card = root.querySelector("[data-testid=redeem-card]") as HTMLElement;
    await type(card.querySelector("input") as HTMLInputElement, "ABCD-EFGH");
    await submit(card.querySelector("form") as HTMLFormElement);
    expect(notes).toEqual(["Dieser Code ist ungültig, abgelaufen oder schon benutzt."]);
  });
});

describe("Devices of a guest", () => {
  it("signs out only devices added after this one, never its own or older ones", async () => {
    routes["GET /api/me/sessions"] = () => ({
      sessions: [
        { id: 7, device: "Chrome auf Android", createdAt: 0, seenAt: 0, current: false },
        { id: 5, device: "Safari auf iPhone", createdAt: 0, seenAt: 0, current: true },
        { id: 3, device: "Firefox auf Windows", createdAt: 0, seenAt: 0, current: false },
      ],
    });
    const root = await mount(<AccountScreen notify={() => undefined} />, session(ben));
    const devices = root.querySelector("[aria-labelledby=devices-title]") as HTMLElement;
    expect([...devices.querySelectorAll("li")].map((item) => item.querySelector("button")?.textContent ?? "")).toEqual(["Abmelden", "", ""]);
    expect(button(devices, "Überall abmelden")).toBeUndefined();
    expect(button(devices, "Später hinzugekommene Geräte abmelden")).toBeDefined();
  });

  it("hides the bulk button when no device was added after this one", async () => {
    routes["GET /api/me/sessions"] = () => ({
      sessions: [
        { id: 5, device: "Safari auf iPhone", createdAt: 0, seenAt: 0, current: true },
        { id: 3, device: "Firefox auf Windows", createdAt: 0, seenAt: 0, current: false },
      ],
    });
    const root = await mount(<AccountScreen notify={() => undefined} />, session(ben));
    expect(button(root, "Später hinzugekommene Geräte abmelden")).toBeUndefined();
  });
});

describe("Review of the transfer", () => {
  it("offers admins no code", async () => {
    routes["GET /api/me/sessions"] = () => ({ sessions: [] });
    const root = await mount(<AccountScreen notify={() => undefined} />, session(admin));
    expect(button(root, "Code erzeugen")).toBeUndefined();
  });

  it('does not report "Code copied" ("Code kopiert") without a clipboard, but asks to type it', async () => {
    routes["GET /api/me/sessions"] = () => ({ sessions: [] });
    routes["POST /api/me/transfer"] = () => ({ code: "ABCD-EFGH", expiresAt: Date.now() + 600_000 });
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const notes: string[] = [];
    const root = await mount(<AccountScreen notify={(text) => notes.push(text)} />, session(ben));
    await click(button(root, "Code erzeugen"));
    await click(button(root, "Kopieren"));
    expect(notes).not.toContain("Code kopiert");
    expect(notes.at(-1)).toContain("abtippen");
  });

  it('moves the focus to "Copy" ("Kopieren") after creating and shows an expired code as expired', async () => {
    routes["GET /api/me/sessions"] = () => ({ sessions: [] });
    routes["POST /api/me/transfer"] = () => ({ code: "ABCD-EFGH", expiresAt: Date.now() + 400 });
    const root = await mount(<AccountScreen notify={() => undefined} />, session(ben));
    const create = button(root, "Code erzeugen") as HTMLElement;
    create.focus();
    await click(create);
    expect(document.activeElement?.textContent).toBe("Kopieren");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await settle();
    expect(root.textContent).toContain("abgelaufen");
    expect(button(root, "Kopieren")).toBeUndefined();
    expect(button(root, "Neuer Code")).toBeDefined();
  });

  it("has only one place on the account page on the iPhone that creates codes", async () => {
    routes["GET /api/me/sessions"] = () => ({ sessions: [] });
    container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      render(
        <SessionContext.Provider value={session(anna)}>
          <PushPlatformContext.Provider value={iosPlatform}>
            <AccountScreen notify={() => undefined} />
          </PushPlatformContext.Provider>
        </SessionContext.Provider>,
        container as HTMLElement,
      );
    });
    await settle();
    const generators = [...(container as HTMLElement).querySelectorAll("button")].filter((candidate) =>
      ["Code erzeugen", "Code für die App"].includes(candidate.textContent?.trim() ?? ""),
    );
    expect(generators).toHaveLength(1);
  });

  it("names separately in the confirmation what moves and what is dropped as a duplicate", async () => {
    const summary = (code: string, status: RoomSummary["status"]): RoomSummary => ({ code, game: "Mau-Mau", status, round: 1, members: 2, host: false, yourTurn: false, updatedAt: 0 });
    const pending = { name: "Ben am Handy", rooms: [summary("WANDER", "lobby")], duplicates: [summary("DOPPEL", "running")] };
    const root = await mount(<AdoptDialog notify={() => undefined} />, { ...session(ben), me: { state: "ready", user: ben, adopt: pending } });
    expect(root.textContent).toContain("WANDER");
    expect(root.textContent).toContain("DOPPEL");
    expect(root.textContent).toContain("Hier sitzt du schon");
    expect(root.textContent).toContain("„Gelöscht“");
  });

  it("puts the redeem card at the top in the app only when signed out", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(display-mode: standalone)" }));
    routes["GET /api/me/rooms"] = () => ({ rooms: [] });
    const signedOut = await mount(<Home storage={new DeviceStorage(memory())} notify={() => undefined} />, session(undefined));
    expect(cards(signedOut)[0]).toBe("Von einem anderen Gerät weiterspielen");
    act(() => render(null, signedOut));
    signedOut.remove();
    const asGuest = await mount(<Home storage={new DeviceStorage(memory())} notify={() => undefined} />, session(ben));
    const order = cards(asGuest);
    expect(order[0]).not.toBe("Von einem anderen Gerät weiterspielen");
    expect(order.at(-1)).toBe("Von einem anderen Gerät weiterspielen");
  });
});

describe("Confirmation after redeeming", () => {
  it("does not address a guest as an account", async () => {
    const pending = { name: "Ben am Handy", rooms: [] };
    const root = await mount(<AdoptDialog notify={() => undefined} />, { ...session(ben), me: { state: "ready", user: ben, adopt: pending } });
    expect(root.textContent).toContain("zu dir wandern");
    expect(root.textContent).not.toContain("Account");
  });
});

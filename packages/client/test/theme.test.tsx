// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { startIntro } from "../src/effects";
import type { Me } from "../src/protocol";
import { DeviceStorage, type KeyValueStore } from "../src/storage";
import { setLanguage } from "../src/texts";
import { applyTheme, startTheme, storedAccountTheme, storedTheme, storeTheme, ThemeContext, themeColors, useThemeChoice } from "../src/theme";
import { ThemeSwitch } from "../src/ui/theme-switch";

function memory(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map<string, string>(Object.entries(initial));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) };
}

let container: HTMLElement | undefined;
let calls: { path: string; body: unknown }[] = [];

function mount(element: preact.JSX.Element): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  act(() => render(element, container as HTMLElement));
  return container;
}

function serve(user?: () => object | undefined) {
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    calls.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const signedIn = user?.();
    const body =
      path === "/api/games" ? { games: [] } : path === "/api/me/rooms" ? { rooms: [] } : (path === "/api/login" || path === "/api/me") && signedIn !== undefined ? { user: signedIn } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

function themePosts(): unknown[] {
  return calls.filter((call) => call.path === "/api/me/theme").map((call) => call.body);
}

function radio(root: HTMLElement, name: string): HTMLInputElement {
  const label = [...root.querySelectorAll("label")].find((candidate) => candidate.textContent === name);
  return label?.querySelector("input") as HTMLInputElement;
}

function pick(root: HTMLElement, name: string): void {
  act(() => radio(root, name).click());
}

function Probe({ ready, user, deviceOnly = false }: { ready: boolean; user: Me | undefined; deviceOnly?: boolean }) {
  const value = useThemeChoice(ready, user, deviceOnly);
  return (
    <ThemeContext.Provider value={value}>
      <ThemeSwitch />
    </ThemeContext.Provider>
  );
}

function account(id: number, theme: "neon" | "crt" | "front" | null): Me {
  return { id, kind: "account", name: `User ${id}`, role: "player", theme };
}

function html(): HTMLElement {
  return document.documentElement;
}

beforeEach(() => {
  calls = [];
  localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#07030f"><meta name="color-scheme" content="dark">';
  html().dataset["theme"] = "neon";
  serve();
});

afterEach(() => {
  if (container !== undefined) {
    act(() => render(null, container as HTMLElement));
    container.remove();
    container = undefined;
  }
  setLanguage("de");
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  delete html().dataset["intro"];
});

describe("Choosing the theme", () => {
  it("starts with the neon hall, takes the choice stored on the device and ignores unknown values", () => {
    expect(startTheme(memory())).toBe("neon");
    expect(startTheme(memory({ "gamehearth.theme": "vaporwave" }))).toBe("neon");
    expect(startTheme(memory({ "gamehearth.theme": "crt" }))).toBe("crt");
    expect(html().dataset["theme"]).toBe("crt");
    expect(startTheme(memory({ "gamehearth.theme": "crt", "gamehearth.account-theme": "front" }))).toBe("front");
  });

  it("stores and forgets the choice", () => {
    const store = memory();
    storeTheme("front", store);
    expect(storedTheme(store)).toBe("front");
    storeTheme(undefined, store);
    expect(storedTheme(store)).toBeUndefined();
  });

  it("sets the theme on the page together with the colors of the browser bar and the form controls", () => {
    applyTheme("front");
    expect(html().dataset["theme"]).toBe("front");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(themeColors.front);
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe("light");
    applyTheme("crt");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#0b0b0d");
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe("dark");
  });
});

describe("Theme switch", () => {
  it("is a radio group with a preview swatch and the name of every theme", () => {
    const root = mount(
      <ThemeContext.Provider value={{ theme: "crt", choose: () => undefined }}>
        <ThemeSwitch />
      </ThemeContext.Provider>,
    );
    const group = root.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group.getAttribute("aria-label")).toBe("Aussehen wählen");
    const options = [...group.querySelectorAll("label")];
    expect(options.map((option) => option.textContent)).toEqual(["Neonhalle", "Röhrenbildschirm", "Automatenfront"]);
    expect(options.map((option) => (option.querySelector("input") as HTMLInputElement).checked)).toEqual([false, true, false]);
    expect(options.map((option) => option.querySelector(".theme-swatch")?.className)).toEqual(["theme-swatch swatch-neon", "theme-swatch swatch-crt", "theme-swatch swatch-front"]);
    expect(new Set(options.map((option) => option.querySelector("input")?.getAttribute("name"))).size).toBe(1);
    expect(root.querySelector(".theme-swatch")?.getAttribute("aria-hidden")).toBe("true");
    expect(root.innerHTML).not.toContain("style=");
  });

  it("reports the choice and names the themes in the language of the device", () => {
    setLanguage("en");
    const choose = vi.fn();
    const root = mount(
      <ThemeContext.Provider value={{ theme: "neon", choose }}>
        <ThemeSwitch compact />
      </ThemeContext.Provider>,
    );
    expect([...root.querySelectorAll("label")].map((option) => [option.textContent, option.getAttribute("title")])).toEqual([
      ["Neon hall", "Neon hall"],
      ["CRT monitor", "CRT monitor"],
      ["Arcade front", "Arcade front"],
    ]);
    expect(root.querySelector(".theme-name")?.classList.contains("visually-hidden")).toBe(true);
    pick(root, "Arcade front");
    expect(choose).toHaveBeenCalledWith("front");
  });
});

describe("Theme of the account", () => {
  it("applies the account's theme, keeps a copy only to start with it and saves a new choice there", async () => {
    const root = mount(<Probe ready user={account(7, "crt")} />);
    await settle();
    expect(html().dataset["theme"]).toBe("crt");
    expect(storedAccountTheme()).toBe("crt");
    expect(storedTheme()).toBeUndefined();
    pick(root, "Automatenfront");
    await settle();
    expect(html().dataset["theme"]).toBe("front");
    expect(storedAccountTheme()).toBe("front");
    expect(themePosts()).toEqual([{ theme: "front" }]);
  });

  it("changes at once without an intro", async () => {
    const root = mount(<Probe ready user={account(7, null)} />);
    await settle();
    startIntro();
    pick(root, "Röhrenbildschirm");
    expect(html().dataset["theme"]).toBe("crt");
    expect(html().hasAttribute("data-intro")).toBe(false);
  });

  it("on a shared device neither shows nor saves another account's theme for a user without one", async () => {
    localStorage.setItem("gamehearth.account-theme", "front");
    mount(<Probe ready user={account(9, null)} />);
    await settle();
    expect(html().dataset["theme"]).toBe("neon");
    expect(storedAccountTheme()).toBeUndefined();
    expect(themePosts()).toEqual([]);
  });

  it("does not hand a choice stored on the device earlier to the next account", async () => {
    localStorage.setItem("gamehearth.theme", "crt");
    mount(<Probe ready user={account(8, null)} />);
    await settle();
    expect(html().dataset["theme"]).toBe("crt");
    expect(themePosts()).toEqual([]);
  });

  it("hands a choice made while logged out to the account that logs in next, if it has none", async () => {
    const root = mount(<Probe ready user={undefined} />);
    pick(root, "Röhrenbildschirm");
    expect(storedTheme()).toBe("crt");
    act(() => render(<Probe ready user={account(10, null)} />, root));
    await settle();
    expect(themePosts()).toEqual([{ theme: "crt" }]);
    expect(html().dataset["theme"]).toBe("crt");
  });

  it("drops a choice made while logged out once an account with its own theme logs in", async () => {
    const root = mount(<Probe ready user={undefined} />);
    pick(root, "Röhrenbildschirm");
    act(() => render(<Probe ready user={account(12, "front")} />, root));
    await settle();
    expect(html().dataset["theme"]).toBe("front");
    act(() => render(<Probe ready user={undefined} />, root));
    act(() => render(<Probe ready user={account(13, null)} />, root));
    await settle();
    expect(themePosts()).toEqual([]);
  });

  it("goes back to the device's theme on logging out and forgets the account's copy", async () => {
    localStorage.setItem("gamehearth.theme", "crt");
    const root = mount(<Probe ready user={account(11, "front")} />);
    await settle();
    expect(html().dataset["theme"]).toBe("front");
    act(() => render(<Probe ready user={undefined} />, root));
    await settle();
    expect(html().dataset["theme"]).toBe("crt");
    expect(storedAccountTheme()).toBeUndefined();
  });

  it("keeps the choice of a TV on the device only", async () => {
    const root = mount(<Probe ready user={account(14, "front")} deviceOnly />);
    await settle();
    pick(root, "Röhrenbildschirm");
    await settle();
    expect(storedTheme()).toBe("crt");
    expect(storedAccountTheme()).toBeUndefined();
    expect(themePosts()).toEqual([]);
  });

  it("offers the switch in the header of the home page while logged out and saves nothing until a login", async () => {
    const root = mount(<App storage={new DeviceStorage(memory())} loadMe={async () => ({})} />);
    await settle();
    const header = root.querySelector(".home-header") as HTMLElement;
    expect(header.querySelector('.theme-switch.compact[role="radiogroup"]')).not.toBeNull();
    act(() => (header.querySelector('input[value="front"]') as HTMLInputElement).click());
    await settle();
    expect(html().dataset["theme"]).toBe("front");
    expect(themePosts()).toEqual([]);
  });

  it("applies the theme of the account in the app and shows no switch in the header when logged in", async () => {
    const user = account(15, "crt");
    serve(() => user);
    const root = mount(<App storage={new DeviceStorage(memory())} loadMe={async () => ({ user })} />);
    await settle();
    expect(html().dataset["theme"]).toBe("crt");
    expect(root.querySelector(".home-header .theme-switch")).toBeNull();
  });
});

describe("Cost of the themes", () => {
  it("runs no endless animation on large areas, only once in the intro", () => {
    for (const name of ["neon", "crt", "front"]) {
      const path = [`packages/client/src/styles/${name}.css`, `src/styles/${name}.css`].find((candidate) => existsSync(candidate)) as string;
      const css = readFileSync(path, "utf8");
      const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: (match[1] ?? "").trim(), body: match[2] ?? "" }));
      const large = rules.filter((rule) => /\.backdrop|\.glass|\.wall|\.horizon|\.floor|\.page\b|\.home\b/.test(rule.selector) && /animation(-name)?\s*:/.test(rule.body));
      for (const rule of large) {
        expect(rule.body, `${name}: ${rule.selector}`).not.toContain("infinite");
        expect(rule.selector, `${name}: ${rule.selector}`).toContain("[data-intro]");
      }
    }
  });

  it("pauses every endless animation when idle and runs none with reduced motion or effects off", () => {
    for (const name of ["crt", "front"]) {
      const path = [`packages/client/src/styles/${name}.css`, `src/styles/${name}.css`].find((candidate) => existsSync(candidate)) as string;
      const css = readFileSync(path, "utf8");
      const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: (match[1] ?? "").trim(), body: match[2] ?? "" }));
      const endless = rules.filter((rule) => /infinite/.test(rule.body));
      expect(endless.length, name).toBeGreaterThan(0);
      for (const rule of endless) {
        expect(rule.selector, `${name}: ${rule.selector}`).toContain(':not([data-effects="off"])');
      }
      const idle = rules.find((rule) => rule.selector.includes("[data-idle]") && rule.body.includes("animation-play-state: paused"));
      expect(idle, name).toBeDefined();
      const motion = css.indexOf("@media (prefers-reduced-motion: no-preference)");
      expect(motion, name).toBeGreaterThan(-1);
      for (const rule of endless) {
        expect(css.indexOf(rule.selector), `${name}: ${rule.selector}`).toBeGreaterThan(motion);
      }
    }
  });
});

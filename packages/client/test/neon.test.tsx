// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceSetting } from "../src/device-setting";
import { applyEffects, effects, endIntro, startIntro, watchIdle } from "../src/effects";
import { parseRoute } from "../src/router";
import { installSounds, playCue, sound } from "../src/sound";
import { Cover, gameColor, generatedCover } from "../src/ui/cover";
import { EffectsSwitch, SoundSwitch } from "../src/ui/switches";
import { existsSync, readFileSync } from "node:fs";

let container: HTMLElement | undefined;

function mount(element: preact.JSX.Element): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  act(() => render(element, container as HTMLElement));
  return container;
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset["effects"];
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (container !== undefined) {
    act(() => render(null, container as HTMLElement));
    container.remove();
    container = undefined;
  }
});

describe("Device settings", () => {
  it("store on and off per device and fall back to the default", () => {
    const setting = deviceSetting("gamehearth.test", true);
    expect(setting.get()).toBe(true);
    const seen: boolean[] = [];
    const stop = setting.subscribe((value) => seen.push(value));
    setting.set(false);
    stop();
    setting.set(true);
    expect(localStorage.getItem("gamehearth.test")).toBe("on");
    expect(seen).toEqual([false]);
    expect(deviceSetting("gamehearth.test", false).get()).toBe(true);
  });

  it("turn effects off on the root element, also from the switch", () => {
    const stop = applyEffects();
    expect(document.documentElement.dataset["effects"]).toBeUndefined();
    const root = mount(<EffectsSwitch />);
    const button = root.querySelector("button") as HTMLButtonElement;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    act(() => button.click());
    expect(document.documentElement.dataset["effects"]).toBe("off");
    expect(localStorage.getItem("gamehearth.effects")).toBe("off");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    act(() => effects.set(true));
    expect(document.documentElement.dataset["effects"]).toBeUndefined();
    stop();
  });

  it("marks the intro on the root element until it ends", () => {
    startIntro();
    expect(document.documentElement.hasAttribute("data-intro")).toBe(true);
    endIntro();
    expect(document.documentElement.hasAttribute("data-intro")).toBe(false);
  });
});

describe("Rest when idle", () => {
  it("pauses the endless animations after a while without input and wakes on the next one", () => {
    vi.useFakeTimers();
    try {
      const element = document.createElement("div");
      const target = new EventTarget();
      const stop = watchIdle(element, 1000, target);
      vi.advanceTimersByTime(999);
      expect(element.hasAttribute("data-idle")).toBe(false);
      vi.advanceTimersByTime(1);
      expect(element.hasAttribute("data-idle")).toBe(true);
      target.dispatchEvent(new Event("keydown"));
      expect(element.hasAttribute("data-idle")).toBe(false);
      stop();
      vi.advanceTimersByTime(5000);
      expect(element.hasAttribute("data-idle")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Sound", () => {
  function fakeAudio() {
    const started: number[] = [];
    class FakeContext {
      state = "running";
      currentTime = 0;
      destination = {};
      resume = async () => undefined;
      createOscillator() {
        return {
          type: "square",
          frequency: { setValueAtTime: (value: number) => started.push(value), exponentialRampToValueAtTime: () => undefined },
          connect: (target: unknown) => target,
          start: () => undefined,
          stop: () => undefined,
        };
      }
      createGain() {
        return { gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }, connect: (target: unknown) => target };
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);
    return started;
  }

  it("is off by default and plays only after it is switched on, on taps of main buttons", () => {
    const started = fakeAudio();
    expect(sound.get()).toBe(false);
    const stop = installSounds(document);
    const root = mount(
      <div>
        <SoundSwitch />
        <button type="button" class="button">
          Start
        </button>
        <button type="button" class="button secondary">
          Other
        </button>
      </div>,
    );
    const [toggle, main, secondary] = [...root.querySelectorAll("button")] as HTMLButtonElement[];
    act(() => main?.click());
    expect(started).toEqual([]);
    act(() => toggle?.click());
    expect(localStorage.getItem("gamehearth.sound")).toBe("on");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    const afterToggle = started.length;
    expect(afterToggle).toBeGreaterThan(0);
    act(() => secondary?.click());
    expect(started.length).toBe(afterToggle);
    act(() => main?.click());
    expect(started.length).toBeGreaterThan(afterToggle);
    const beforeJoin = started.length;
    playCue("join");
    expect(started.length - beforeJoin).toBe(4);
    act(() => toggle?.click());
    const silent = started.length;
    act(() => main?.click());
    playCue("start");
    expect(started.length).toBe(silent);
    stop();
  });
});

describe("Covers", () => {
  it("generate the same color, pattern and initial for the same game", () => {
    expect(generatedCover("mau-mau", "Mau-Mau")).toEqual(generatedCover("mau-mau", "Mau-Mau"));
    expect(generatedCover("mau-mau", "Mau-Mau").initial).toBe("M");
    expect(generatedCover("ölfeld", "ölfeld").initial).toBe("Ö");
    expect(gameColor("mau-mau")).toBe(gameColor("mau-mau"));
    expect(new Set(["mau-mau", "dorfladen", "gluecksrad", "sammler", "wettlauf"].map(gameColor)).size).toBe(5);
  });

  it("show the cover as an image and fall back to the generated one without styles in the markup", () => {
    const withImage = mount(<Cover id="dorfladen" name="Dorfladen" src="/games/dorfladen/1/cover.svg" />);
    expect(withImage.querySelector("img")?.getAttribute("src")).toBe("/games/dorfladen/1/cover.svg");
    act(() => render(null, withImage));
    withImage.remove();
    const generated = mount(<Cover id="schach" name="Schach" />);
    expect(generated.querySelector("img")).toBeNull();
    expect(generated.querySelector("svg rect")).not.toBeNull();
    expect(generated.querySelector(".cover-initial")?.textContent).toBe("S");
    expect(generated.innerHTML).not.toContain("style=");
  });
});

describe("Admin routes", () => {
  it("have one address per tab and show the games for /admin", () => {
    expect(parseRoute("/admin")).toEqual({ name: "admin", tab: "games" });
    expect(parseRoute("/admin/users")).toEqual({ name: "admin", tab: "users" });
    expect(parseRoute("/admin/system/")).toEqual({ name: "admin", tab: "system" });
    expect(parseRoute("/admin/unknown")).toEqual({ name: "home" });
  });
});

describe("Cost of the effects", () => {
  it("lets endless animations only flicker in steps, except the small pulsing chip and the buzzing logo letter, because smooth loops on glowing strips cost up to 94 % of a CPU core without a graphics card", () => {
    for (const file of ["neon.css", "crt.css", "front.css"]) {
      const path = [`packages/client/src/styles/${file}`, `src/styles/${file}`].find((candidate) => existsSync(candidate)) as string;
      const css = readFileSync(path, "utf8");
      for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = (match[1] ?? "").trim();
        const body = match[2] ?? "";
        const loops = [...body.matchAll(/animation:\s*([^;]+);/g)].map((entry) => entry[1] ?? "").flatMap((value) => value.split(/,(?![^(]*\))/)).filter((value) => value.includes("infinite"));
        for (const loop of loops) {
          const allowed = loop.includes("steps(") || /\.chip\.turn|\.logo span/.test(selector);
          expect(allowed, `${file}: ${selector} -> ${loop.trim()}`).toBe(true);
        }
      }
    }
  });


  it("runs no endless animation on the backdrop, because a moving floor cost about 12 % of a CPU core per page without a graphics card", () => {
    const path = ["packages/client/src/styles/neon.css", "src/styles/neon.css"].find((candidate) => existsSync(candidate)) as string;
    const css = readFileSync(path, "utf8");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: (match[1] ?? "").trim(), body: match[2] ?? "" }));
    const backdrop = rules.filter((rule) => rule.selector.includes(".backdrop") && /animation\s*:/.test(rule.body));
    expect(backdrop.length).toBeGreaterThan(0);
    for (const rule of backdrop) {
      expect(rule.body).not.toContain("infinite");
      expect(rule.selector).toContain("[data-intro]");
    }
  });
});

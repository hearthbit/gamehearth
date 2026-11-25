// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { startLanguage } from "../src/language";
import type { KeyValueStore } from "../src/storage";
import { language, setLanguage } from "../src/texts";
import { startTheme } from "../src/theme";

function memory(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map<string, string>(Object.entries(initial));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) };
}

function css(name: string): string {
  const path = [`packages/client/src/styles/${name}`, `src/styles/${name}`].find((candidate) => existsSync(candidate)) as string;
  return readFileSync(path, "utf8");
}

function rule(text: string, selector: string): string | undefined {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) => (match[1] ?? "").trim() === selector)?.[2];
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

afterEach(() => {
  setLanguage("de");
});

describe("Review 11b", () => {
  it("starts a TV with the theme and language chosen on it, not with the account's copy on the same device", () => {
    const store = memory({ "gamehearth.account-theme": "front", "gamehearth.theme": "crt", "gamehearth.account-language": "de", "gamehearth.language": "en" });
    expect(startTheme(store, true)).toBe("crt");
    expect(document.documentElement.dataset["theme"]).toBe("crt");
    expect(startLanguage(store, true)).toBe("en");
    expect(language).toBe("en");
    expect(startTheme(store)).toBe("front");
    expect(startLanguage(store)).toBe("de");
  });

  it("draws the focus ring in yellow on the dark surfaces of the arcade front, also on the code field", () => {
    const front = css("front.css");
    const yellow = /--yellow:\s*(#[0-9a-f]{6})/i.exec(css("tokens.css"))?.[1] as string;
    expect(rule(front, '[data-theme="front"] :is(.card.join, .overlay, .live)')).toContain("--focus: var(--yellow)");
    expect(rule(front, '[data-theme="front"] .input.code:focus')).toContain("var(--yellow)");
    for (const dark of ["#24164a", "#3a2a6a"]) {
      expect(contrast(yellow, dark)).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the admin view of the CRT monitor in the system font", () => {
    const body = rule(css("crt.css"), ':root[data-theme="crt"][data-scene="admin"]');
    expect(body).toContain("--font-display: var(--font-body)");
    expect(body).toContain("--font-pixel: var(--font-body)");
    expect(rule(css("crt.css"), '[data-theme="crt"][data-scene="admin"] :is(.button.small, .list.dense .button.small)')).toContain("font-size: 0.92rem");
  });

  it("dims the blinking Your turn chip of the CRT monitor only so far that it stays readable", () => {
    const dim = /@keyframes crt-dim\s*\{[^}]*opacity:\s*([0-9.]+)/.exec(css("crt.css"))?.[1];
    expect(Number(dim)).toBeGreaterThanOrEqual(0.75);
  });
});

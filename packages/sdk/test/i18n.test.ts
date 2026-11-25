import { describe, expect, it } from "vitest";
import { connect, connectSolo, defineTexts, localize, type MessageEventLike } from "../src/client";
import {
  localizedProblem,
  optionLabel,
  parsePlatformMessage,
  pickLanguage,
  supportsLanguage,
  validateCatalogSpec,
  validateLanguages,
  validateOptionsSpec,
  type OptionSpec,
} from "../src/platform";

type Listener = (event: MessageEventLike) => void;

function fakePlatform() {
  const listeners = new Set<Listener>();
  const parent = { postMessage() {} };
  const events = {
    addEventListener: (_type: "message", listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: "message", listener: Listener) => listeners.delete(listener),
  };
  const deliver = (data: unknown) => {
    for (const listener of [...listeners]) {
      listener({ data, source: parent });
    }
  };
  return { parent, events, deliver };
}

const update = (extra: Record<string, unknown> = {}) => ({
  gamehearth: 1,
  type: "update",
  seat: "p1",
  role: "player",
  snapshot: { player: "p1", players: ["p1"], public: {}, me: {}, moves: [], version: 1 },
  players: { p1: { name: "Anna", connected: true, you: true } },
  online: true,
  ...extra,
});

describe("validateLanguages", () => {
  it("accepts language codes with the default first", () => {
    expect(validateLanguages(["de", "en"])).toEqual([]);
    expect(validateLanguages(["pt-BR"])).toEqual([]);
  });

  it("rejects empty lists, bad codes and duplicates", () => {
    expect(validateLanguages([])[0]).toContain("1 to 20 language codes");
    expect(validateLanguages("de")[0]).toContain("list");
    expect(validateLanguages(["German"])[0]).toContain('not "German"');
    expect(validateLanguages(["de", "de"])[0]).toContain("more than once");
  });
});

describe("localizedProblem", () => {
  it("accepts a plain text in any game", () => {
    expect(localizedProblem("Mau-Mau", "name", 40, undefined)).toBeUndefined();
    expect(localizedProblem("Mau-Mau", "name", 40, ["de", "en"])).toBeUndefined();
  });

  it("needs languages for texts per language", () => {
    expect(localizedProblem({ de: "Siege", en: "Wins" }, "stats.siege.label", 40, undefined)).toContain('needs "languages"');
  });

  it("reports a missing language as an error", () => {
    expect(localizedProblem({ de: "Siege" }, "stats.siege.label", 40, ["de", "en"])).toBe(
      'stats.siege.label has no text for "en"; every language in languages needs one (or use a single text that applies to all languages)',
    );
  });

  it("reports a language that is not in languages", () => {
    expect(localizedProblem({ de: "Siege", fr: "Victoires" }, "x", 40, ["de"])).toContain('"fr" is not in languages');
  });

  it("checks the length of every text", () => {
    expect(localizedProblem({ de: "", en: "Wins" }, "x", 40, ["de", "en"])).toBe("x.de must be a text with 1 to 40 characters");
    expect(localizedProblem("x".repeat(41), "x", 40, undefined)).toContain("1 to 40");
    expect(localizedProblem({}, "x", 40, ["de"])).toContain("empty object");
  });
});

describe("localize and pickLanguage", () => {
  it("returns plain texts unchanged", () => {
    expect(localize("Mau-Mau", "en")).toBe("Mau-Mau");
  });

  it("picks the language, then its base, then fallbacks, then the first text", () => {
    const label = { de: "Siege", en: "Wins" };
    expect(localize(label, "en")).toBe("Wins");
    expect(localize(label, "en-GB")).toBe("Wins");
    expect(localize(label, "fr", ["en"])).toBe("Wins");
    expect(localize(label, "fr")).toBe("Siege");
    expect(localize(label)).toBe("Siege");
  });

  it("chooses the game language from the preferences, otherwise the game's default", () => {
    expect(pickLanguage(["de", "en"], ["en"])).toBe("en");
    expect(pickLanguage(["de", "en"], ["fr", "en-US"])).toBe("en");
    expect(pickLanguage(["de", "en"], ["fr"])).toBe("de");
    expect(pickLanguage(["pt-BR"], ["pt"])).toBe("pt-BR");
    expect(pickLanguage(undefined, ["de"])).toBeUndefined();
  });

  it("tells whether a game has a language", () => {
    expect(supportsLanguage(["de"], "de-AT")).toBe(true);
    expect(supportsLanguage(["de"], "en")).toBe(false);
    expect(supportsLanguage(undefined, "en")).toBe(false);
  });
});

describe("translated labels in the manifest", () => {
  it("accepts options with texts per language", () => {
    const options = {
      ace: {
        label: { de: "Ass", en: "Ace" },
        type: "choice",
        default: "again",
        choices: [
          { value: "again", label: { de: "Noch mal dran", en: "Go again" } },
          { value: "skip", label: { de: "Nächster setzt aus", en: "Next player skips" } },
        ],
      },
    };
    expect(validateOptionsSpec(options, ["de", "en"])).toEqual([]);
    expect(validateOptionsSpec(options, ["de", "en", "fr"])).toEqual([
      'options.ace.label has no text for "fr"; every language in languages needs one (or use a single text that applies to all languages)',
      'options.ace.choices[0].label has no text for "fr"; every language in languages needs one (or use a single text that applies to all languages)',
      'options.ace.choices[1].label has no text for "fr"; every language in languages needs one (or use a single text that applies to all languages)',
    ]);
  });

  it("accepts catalog labels per language and reports missing ones", () => {
    const catalog = { stats: { wins: { label: { de: "Siege", en: "Wins" }, better: "higher" } }, items: { joker: { label: "Joker" } } };
    expect(validateCatalogSpec(catalog, false, ["de", "en"])).toEqual([]);
    expect(validateCatalogSpec({ flags: { seen: { label: { de: "Gesehen" } } } }, false, ["de", "en"])[0]).toContain('flags.seen.label has no text for "en"');
  });

  it("shows the label of a choice in the wanted language", () => {
    const option: OptionSpec = {
      label: { de: "Spielzeit", en: "Play time" },
      type: "choice",
      default: 60,
      choices: [
        { value: 60, label: { de: "1 Minute", en: "1 minute" } },
        { value: 90, label: "90 s" },
      ],
    };
    expect(optionLabel(option, 60, "en")).toBe("1 minute");
    expect(optionLabel(option, 60, "de")).toBe("1 Minute");
    expect(optionLabel(option, 90, "en")).toBe("90 s");
    expect(optionLabel(option, 120, "en")).toBe("120");
  });
});

describe("defineTexts", () => {
  const texts = defineTexts({
    de: { yourTurn: "Du bist dran", cards: (n: number) => (n === 1 ? "1 Karte" : `${n} Karten`) },
    en: { yourTurn: "Your turn", cards: (n: number) => (n === 1 ? "1 card" : `${n} cards`) },
  });

  it("returns the texts of the language", () => {
    expect(texts("en").yourTurn).toBe("Your turn");
    expect(texts("en").cards(2)).toBe("2 cards");
    expect(texts("de").cards(1)).toBe("1 Karte");
  });

  it("falls back to the base language and then to the first language", () => {
    expect(texts("en-GB").yourTurn).toBe("Your turn");
    expect(texts("fr").yourTurn).toBe("Du bist dran");
    expect(texts().yourTurn).toBe("Du bist dran");
  });

  it("rejects keys that are no language codes and empty tables", () => {
    expect(() => defineTexts({ German: { a: "A" } })).toThrow('"German" is not a language code');
    expect(() => defineTexts({})).toThrow("at least one language");
  });
});

describe("game.language", () => {
  it("comes from the platform with the first update", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events });
    platform.deliver(update({ language: "en" }));
    expect((await pending).language).toBe("en");
  });

  it("falls back to the browser language when an older platform sends none", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events });
    platform.deliver(update());
    const language = (await pending).language;
    expect(language).toMatch(/^[a-z]{2,3}$/);
  });

  it("ignores invalid language codes", () => {
    const message = parsePlatformMessage(update({ language: "<script>" }));
    expect(message).toBeDefined();
    expect(message && "language" in message).toBe(false);
  });

  it("is passed to single-player games as well", async () => {
    const platform = fakePlatform();
    const pending = connectSolo({ parent: platform.parent, events: platform.events });
    platform.deliver({ gamehearth: 1, type: "solo", saved: null, best: {}, language: "de" });
    expect((await pending).language).toBe("de");
  });
});

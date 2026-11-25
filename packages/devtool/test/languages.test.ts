import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyProfile, parsePlatformMessage } from "@gamehearth/sdk/platform";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { addToCatalog, formatCatalog, parseCatalog, validateCatalog, versionEntry, type Catalog } from "../src/catalog";
import { checkGame } from "../src/check";
import { coverProblems, maxCoverBytes } from "../src/cover";
import { formatIdsLock } from "../src/ids-lock";
import { untranslatedTexts, validateManifest, type Manifest } from "../src/manifest";
import { buildPackage, PackageError, type GamePackage } from "../src/package";
import { hostHtml } from "../src/dev/page";
import { startDev, type DevServer } from "../src/dev/server";
import { frameUpdate, soloMessage, type DevView } from "../src/dev/view";

const devtool = fileURLToPath(new URL("..", import.meta.url));

const base = {
  id: "card-duel",
  name: { en: "Card Duel", de: "Kartenduell" },
  version: "0.1.0",
  description: { en: "Cards", de: "Karten" },
  languages: ["en", "de"],
  cover: "cover.svg",
  sdk: "^0.1.6",
  license: { code: "MIT", assets: "CC0-1.0" },
  mode: "turn-based",
  players: { min: 2, max: 4 },
  server: true,
  client: "dist/client",
  roles: { player: { inputs: ["touch"], screen: "small" } },
  options: {
    rounds: {
      label: { en: "Rounds", de: "Runden" },
      type: "choice",
      default: 3,
      choices: [
        { value: 3, label: { en: "3 rounds", de: "3 Runden" } },
        { value: 5, label: "5" },
      ],
    },
  },
  stats: { wins: { label: { en: "Wins", de: "Siege" }, better: "higher" } },
};

function problemsOf(changes: Record<string, unknown>): string[] {
  const checked = validateManifest({ ...base, ...changes });
  return checked.ok ? [] : checked.problems;
}

function png(width: number, height: number, size = 33): Buffer {
  const data = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data, 0);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "latin1");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function webp(chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Buffer {
  const data = Buffer.alloc(32);
  data.write("RIFF", 0, "latin1");
  data.writeUInt32LE(24, 4);
  data.write("WEBP", 8, "latin1");
  data.write(chunk, 12, "latin1");
  data.writeUInt32LE(12, 16);
  if (chunk === "VP8 ") {
    data[23] = 0x9d;
    data[24] = 0x01;
    data[25] = 0x2a;
    data.writeUInt16LE(width, 26);
    data.writeUInt16LE(height, 28);
  } else if (chunk === "VP8L") {
    data[20] = 0x2f;
    data.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21);
  } else {
    data.writeUIntLE(width - 1, 24, 3);
    data.writeUIntLE(height - 1, 27, 3);
  }
  return data;
}

function svg(attributes: string, prefix = ""): Buffer {
  return Buffer.from(`${prefix}<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><rect width="4" height="3"/></svg>\n`, "utf8");
}

describe("manifest: languages, translated texts and cover", () => {
  it("accepts languages, texts per language, plain texts and a cover with sdk ^0.1.6", () => {
    expect(problemsOf({})).toEqual([]);
    expect(problemsOf({ name: "Mau-Mau", languages: ["de"], description: "Kartenspiel", options: undefined, stats: undefined })).toEqual([]);
  });

  it("requires sdk ^0.1.6 for languages and for a cover", () => {
    expect(problemsOf({ sdk: "^0.1.5" })).toEqual(['with languages or cover, sdk must be at least "^0.1.6"; older servers do not know them']);
    const plain = { name: "Card Duel", description: undefined, languages: undefined, options: undefined, stats: undefined };
    expect(problemsOf({ ...plain, sdk: "^0.1.4" })).toEqual(['with languages or cover, sdk must be at least "^0.1.6"; older servers do not know them']);
    expect(problemsOf({ ...plain, cover: undefined, sdk: "^0.1.4" })).toEqual([]);
  });

  it("reports texts per language without languages, missing and unknown languages and invalid codes", () => {
    expect(problemsOf({ languages: undefined }).join("\n")).toContain('name has one text per language, so the manifest needs "languages"');
    expect(problemsOf({ name: { en: "Card Duel" } })).toEqual(['name has no text for "de"; every language in languages needs one (or use a single text that applies to all languages)']);
    expect(problemsOf({ stats: { wins: { label: { en: "Wins", de: "Siege", fr: "Victoires" }, better: "higher" } } }).join("\n")).toContain('"fr" is not in languages');
    expect(problemsOf({ languages: ["en", "German"] }).join("\n")).toContain('languages[1] must be a language code such as "en", "de" or "pt-BR"');
  });

  it("Review 12a: reports only the real problem when languages itself is invalid", () => {
    expect(problemsOf({ languages: ["de", "de"] })).toEqual(['languages lists "de" more than once']);
    expect(problemsOf({ languages: ["EN", "de"] })).toEqual(['languages[0] must be a language code such as "en", "de" or "pt-BR", not "EN"']);
    expect(problemsOf({ languages: "en" })).toEqual([`languages must be a list of 1 to 20 language codes, the game's default language first, e.g. ["de", "en"]`]);
  });

  it("Review 12a: keeps accepting names of up to 80 characters, as the catalog always did", () => {
    expect(problemsOf({ name: "x".repeat(80), languages: undefined, description: undefined, options: undefined, stats: undefined, cover: undefined, sdk: "^0.1.5" })).toEqual([]);
    expect(problemsOf({ name: "x".repeat(81), languages: undefined, description: undefined, options: undefined, stats: undefined, cover: undefined, sdk: "^0.1.5" })).toEqual([
      "name must be a text with 1 to 80 characters",
    ]);
  });

  it("only takes a cover inside the client folder as PNG, WebP or SVG", () => {
    expect(problemsOf({ cover: "../cover.svg" }).join("\n")).toContain("cover must be the path of an image inside the client folder");
    expect(problemsOf({ cover: "cover.gif" })).toEqual(['cover must end in .png, .webp, .svg; got "cover.gif"']);
    expect(problemsOf({ cover: "images/cover.PNG" })).toEqual([]);
  });

  it("lists plain texts of games with several languages, but not the name", () => {
    const checked = validateManifest({ ...base, name: "Card Duel", description: "Cards" });
    expect(checked.ok && untranslatedTexts(checked.manifest)).toEqual(["description", "options.rounds.choices[1].label"]);
    const single = validateManifest({ ...base, languages: ["en"], name: "Card Duel", description: "Cards", options: undefined, stats: undefined });
    expect(single.ok && untranslatedTexts(single.manifest)).toEqual([]);
  });
});

describe("cover", () => {
  it("accepts 4:3 images in all three formats, within 3 %", () => {
    expect(coverProblems("cover.png", png(640, 480), "dist/client")).toEqual([]);
    expect(coverProblems("cover.png", png(64, 49), "dist/client")).toEqual([]);
    expect(coverProblems("cover.webp", webp("VP8 ", 320, 240), "dist/client")).toEqual([]);
    expect(coverProblems("cover.webp", webp("VP8L", 128, 96), "dist/client")).toEqual([]);
    expect(coverProblems("cover.webp", webp("VP8X", 1024, 768), "dist/client")).toEqual([]);
    expect(coverProblems("cover.svg", svg('viewBox="0 0 64 48"', '<?xml version="1.0" encoding="UTF-8"?>\n<!-- pixel art -->\n'), "dist/client")).toEqual([]);
    expect(coverProblems("cover.svg", svg('width="640px" height="480" viewBox="0 0 10 10"'), "dist/client")).toEqual([]);
    expect(coverProblems("cover.svg", svg('width="100%" viewBox="0,0,400,300"'), "dist/client")).toEqual([]);
  });

  it("reports a wrong aspect ratio with the size it found", () => {
    expect(coverProblems("cover.png", png(64, 50), "dist/client")).toEqual([
      "cover: cover.png is 64×50 (PNG header), but a cover must have the aspect ratio 4:3 (width = height × 4/3, within 3 %), for example 640×480, 320×240, 128×96 pixels or an SVG with viewBox=\"0 0 64 48\".",
    ]);
    expect(coverProblems("cover.webp", webp("VP8L", 100, 100), "dist/client").join("\n")).toContain("is 100×100 (WebP header)");
    expect(coverProblems("cover.webp", webp("VP8 ", 480, 640), "dist/client").join("\n")).toContain("is 480×640 (WebP header)");
    expect(coverProblems("cover.svg", svg('viewBox="0 0 64 64"'), "dist/client").join("\n")).toContain("is 64×64 (viewBox of the <svg> element)");
    expect(coverProblems("cover.svg", svg('width="300" height="300" viewBox="0 0 64 48"'), "dist/client").join("\n")).toContain("is 300×300 (width and height of the <svg> element)");
  });

  it("reports a cover that is too large", () => {
    expect(coverProblems("cover.png", png(640, 480, maxCoverBytes), "dist/client")).toEqual([]);
    expect(coverProblems("cover.png", png(640, 480, maxCoverBytes + 1), "dist/client")).toEqual([
      "cover: cover.png has 257 KB, at most 256 KB are allowed. Make it smaller: fewer pixels or colors (pixel art stays small as PNG), or simpler shapes in an SVG.",
    ]);
  });

  it("reports content that does not match the file type", () => {
    expect(coverProblems("cover.png", svg('viewBox="0 0 64 48"'), "dist/client").join("\n")).toContain("cover: cover.png is not a real PNG file");
    expect(coverProblems("cover.webp", png(640, 480), "dist/client").join("\n")).toContain("cover: cover.webp is not a real WebP file");
    expect(coverProblems("cover.svg", png(640, 480), "dist/client").join("\n")).toContain("cover: cover.svg is not a real SVG file (it is not UTF-8 text)");
    expect(coverProblems("cover.svg", Buffer.from('<html><svg viewBox="0 0 64 48"></svg></html>'), "dist/client").join("\n")).toContain("the first element must be <svg …>");
    expect(coverProblems("cover.svg", svg(""), "dist/client")).toEqual([
      'cover: cover.svg gives no size, so its aspect ratio is unknown. Give the <svg> element a viewBox whose width and height are in the ratio 4:3, e.g. viewBox="0 0 64 48".',
    ]);
  });

  it("names the client folder when the file is missing", () => {
    expect(coverProblems("cover.svg", undefined, "dist/client")).toEqual([
      "cover: cover.svg is missing in the built client folder dist/client. Put the image where the build copies it into the client folder (with Vite: client/public/cover.svg) and build again.",
    ]);
  });

  it.each(["turn-based", "realtime", "single"])("the cover of the template %s passes", (template) => {
    const file = join(devtool, "templates", template, "client", "public", "cover.svg");
    expect(coverProblems("cover.svg", readFileSync(file), "dist/client")).toEqual([]);
  });
});

const soloManifest = {
  id: "language-probe",
  name: { de: "Sprachprobe", en: "Language probe" },
  version: "0.1.0",
  languages: ["de", "en"],
  sdk: "^0.1.6",
  license: { code: "MIT", assets: "CC0-1.0" },
  mode: "single",
  players: { min: 1, max: 1 },
  server: false,
  client: "dist/client",
  roles: { player: { inputs: ["touch"], screen: "small" } },
  stats: { punkte: { label: { de: "Punkte", en: "Points" }, better: "higher" } },
};

const dirs: string[] = [];

function soloGame(files: Record<string, string | Buffer>, changes: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "gamehearth-languages-"));
  dirs.push(dir);
  const all: Record<string, string | Buffer> = {
    "manifest.json": JSON.stringify({ ...soloManifest, ...changes }),
    "LICENSE": "MIT License\n",
    "ids.lock": formatIdsLock({ format: 1, items: [], stats: ["punkte"], flags: [] }),
    "dist/client/index.html": "<!doctype html><title>probe</title>",
    "client/src/main.ts": 'import { connectSolo } from "@gamehearth/sdk/client";\nconst game = await connectSolo<number, "punkte">();\nawait game.record("punkte", 1);\n',
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("check and pack: cover and untranslated texts", () => {
  it("is green with a 4:3 cover and every text translated", async () => {
    const report = await checkGame(soloGame({ "dist/client/cover.svg": svg('viewBox="0 0 64 48"') }, { cover: "cover.svg" }));
    expect(report.findings).toEqual([]);
  });

  it("warns once about plain texts in a game with several languages and says that equal texts are fine", async () => {
    const report = await checkGame(soloGame({}, { name: "Probe", description: "Ein Test", stats: { punkte: { label: "Punkte", better: "higher" } } }));
    expect(report.findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        kind: "manifest",
        message:
          'manifest.json: these texts are not translated, although the game has the languages de, en: description, stats.punkte.label. Give each one text per language, e.g. { "de": "…", "en": "…" }. A text that is the same in every language (a number, a proper name) is fine as it is.',
      }),
    ]);
  });

  it("reports a missing language in a text as an error from the manifest", async () => {
    const report = await checkGame(soloGame({}, { description: { de: "Ein Test" } }));
    expect(report.findings.map((finding) => [finding.severity, finding.message])).toEqual([
      ["error", 'manifest.json: description has no text for "en"; every language in languages needs one (or use a single text that applies to all languages)'],
    ]);
  });

  it("reports a missing cover, a wrong ratio and mismatched content as errors", async () => {
    const missing = await checkGame(soloGame({}, { cover: "cover.svg" }));
    expect(missing.findings).toEqual([expect.objectContaining({ severity: "error", kind: "cover", message: expect.stringContaining("cover.svg is missing in the built client folder dist/client") })]);
    const square = await checkGame(soloGame({ "dist/client/img/cover.png": png(100, 100) }, { cover: "img/cover.png" }));
    expect(square.findings).toEqual([expect.objectContaining({ severity: "error", kind: "cover", message: expect.stringContaining("img/cover.png is 100×100") })]);
    const fake = await checkGame(soloGame({ "dist/client/cover.webp": svg('viewBox="0 0 64 48"') }, { cover: "cover.webp" }));
    expect(fake.findings).toEqual([expect.objectContaining({ severity: "error", kind: "cover", message: expect.stringContaining("is not a real WebP file") })]);
  });

  it("does not check the cover while the client is not built", async () => {
    const dir = soloGame({}, { cover: "cover.svg" });
    rmSync(join(dir, "dist"), { recursive: true });
    const report = await checkGame(dir);
    expect(report.findings.map((finding) => finding.kind)).toEqual(["client"]);
  });

  it("packs a game with a good cover and refuses one with a bad cover like the server", async () => {
    const good = await buildPackage(soloGame({ "dist/client/cover.png": png(320, 240) }, { cover: "cover.png" }), { warnings: 0 });
    expect(good.pkg.client.map((file) => file.path)).toContain("cover.png");
    const bad = buildPackage(soloGame({ "dist/client/cover.png": png(320, 320) }, { cover: "cover.png" }), { warnings: 0 });
    await expect(bad).rejects.toBeInstanceOf(PackageError);
    await expect(bad).rejects.toThrow("cover: cover.png is 320×320");
    const missing = buildPackage(soloGame({}, { cover: "cover.png" }), { warnings: 0 });
    await expect(missing).rejects.toThrow("cover: cover.png is missing in the built client folder client/ of the package");
  });
});

describe("catalog with translated texts", () => {
  const manifest = validateManifest(base);
  const pkg: GamePackage = {
    manifest: (manifest.ok ? manifest.manifest : undefined) as Manifest,
    manifestText: "",
    code: "",
    client: [],
    license: "MIT",
    readme: undefined,
    info: { format: 1, sdk: "0.1.6", devtool: "0.8.0", warnings: 0 },
    build: "card-duel@0.1.0+000000000000",
  };
  const empty: Catalog = { format: 1, name: "Test", games: [] };

  it("Review 12a: writes name and description in the game's default language, so older servers can still read the catalog", () => {
    const catalog = addToCatalog(empty, pkg, versionEntry(pkg, Buffer.from("zip"), "https://example.org/card-duel-0.1.0.zip"));
    expect(catalog.games[0]).toMatchObject({ id: "card-duel", name: "Card Duel", description: "Cards" });
    expect(parseCatalog(formatCatalog(catalog))).toEqual({ ok: true, catalog });
    const game = catalog.games[0] as unknown as Record<string, unknown>;
    expect(typeof game["name"]).toBe("string");
    expect(typeof game["description"]).toBe("string");
  });

  it("accepts only language codes as keys and the usual lengths", () => {
    const catalog = addToCatalog(empty, pkg, versionEntry(pkg, Buffer.from("zip"), "https://example.org/card-duel-0.1.0.zip"));
    const game = catalog.games[0];
    const problems = (changes: Record<string, unknown>) => {
      const checked = validateCatalog({ ...catalog, games: [{ ...game, ...changes }] });
      return checked.ok ? [] : checked.problems;
    };
    expect(problems({ name: { German: "Kartenduell" } })).toEqual(['games[0] (card-duel).name: "German" is not a language code such as "en", "de" or "pt-BR"']);
    expect(problems({ name: {} })).toEqual(["games[0] (card-duel).name must have 1 to 20 languages"]);
    expect(problems({ description: { en: "x".repeat(201) } })).toEqual(["games[0] (card-duel).description.en must be a text with 1 to 200 characters"]);
    expect(problems({ name: { en: "x".repeat(80), de: 3 } })).toEqual(["games[0] (card-duel).name.de must be a text with 1 to 80 characters"]);
    expect(problems({ name: ["Card Duel"] }).join("\n")).toContain("or an object with one such text per language");
  });
});

describe("dev: language", () => {
  let server: DevServer;
  let dir: string;
  const lines: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "gamehearth-languages-dev-"));
    mkdirSync(join(dir, "dist", "client"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(soloManifest));
    writeFileSync(join(dir, "dist", "client", "index.html"), "<!doctype html><title>probe</title>");
    server = await startDev(dir, { port: 0, out: (line) => lines.push(line), pollMs: 50 });
  });
  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${server.port}/__dev/language`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${server.port}` },
      body: JSON.stringify(body),
    });

  it("starts with the first language of the manifest and shows a selector on the page", async () => {
    expect(server.view().language).toBe("de");
    expect(server.view().game?.languages).toEqual(["de", "en"]);
    expect(lines[0]).toBe("Gamehearth dev: Sprachprobe");
    expect(lines).toContain("  Languages:   de, en (switch at the top of the page)");
    expect(hostHtml).toContain('<select id="language" aria-label="Language" hidden></select>');
    expect(await (await fetch(`http://127.0.0.1:${server.port}/p1`)).text()).toContain('id="language"');
  });

  it("switches to another language of the manifest and refuses others", async () => {
    expect(await (await post({ language: "en" })).json()).toEqual({ ok: true });
    expect(server.view().language).toBe("en");
    expect(lines).toContain("Language en, reloading the frames.");
    const refused = await post({ language: "fr" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ ok: false, code: "invalid-language", message: "Allowed are the languages from manifest.json: de, en" });
    expect(server.view().language).toBe("en");
  });

  it("drops the language when the manifest no longer has languages", async () => {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...soloManifest, name: "Probe", languages: undefined, stats: { punkte: { label: "Punkte", better: "higher" } } }));
    await server.reloadRules();
    expect(server.view().language).toBeUndefined();
    expect(server.view().game?.languages).toBeUndefined();
    expect((await post({ language: "de" })).status).toBe(400);
  });
});

describe("dev: language in the bridge messages", () => {
  function view(language: string | undefined, roles: string[] = ["player"]): DevView {
    return {
      game: { id: "probe", name: { en: "Probe", de: "Probe" }, languages: ["en", "de"], counts: [2], mode: "turn-based", roles, profiles: false },
      ...(language === undefined ? {} : { language }),
      session: {
        playerCount: 2,
        seed: "seed",
        options: {},
        version: 3,
        result: undefined,
        screen: { players: ["p1"], public: {}, version: 3 },
        seats: [{ seat: "p1", name: "Anna", bot: false, paused: false, away: false, snapshot: { player: "p1", public: {}, me: {}, moves: [], version: 3 }, profile: emptyProfile(), guest: false }],
        state: undefined,
        moves: [],
        problem: undefined,
        botProblems: [],
        note: undefined,
      },
      client: { version: 1, ready: true, note: undefined },
      problems: [],
      logs: [],
    };
  }

  it("sends the chosen language to every seat and the TV", () => {
    const seat = frameUpdate(view("de"), "p1");
    expect(seat).toMatchObject({ type: "update", seat: "p1", role: "player", language: "de" });
    expect(parsePlatformMessage(seat)).toMatchObject({ type: "update", language: "de" });
    const tv = frameUpdate(view("de", ["screen", "controller"]), "tv");
    expect(tv).toMatchObject({ type: "update", seat: null, role: "screen", language: "de" });
    expect(parsePlatformMessage(tv)).toMatchObject({ language: "de" });
    expect(frameUpdate(view(undefined), "p1")).not.toHaveProperty("language");
  });

  it("sends the language to a single-player game", () => {
    expect(parsePlatformMessage(soloMessage("en", null, { punkte: 3 }))).toEqual({ gamehearth: 1, type: "solo", saved: null, best: { punkte: 3 }, language: "en" });
    expect(soloMessage(undefined, { level: 1 }, {})).not.toHaveProperty("language");
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkGame } from "../src/check";
import { formatIdsLock } from "../src/ids-lock";
import { buildPackage, contentHash, inspectPackage } from "../src/package";
import { readZip } from "../src/zip";

const manifest = {
  id: "solo-probe",
  name: "Solo-Probe",
  version: "0.1.0",
  sdk: "^0.1.2",
  license: { code: "MIT", assets: "CC0-1.0" },
  mode: "single",
  players: { min: 1, max: 1 },
  server: false,
  client: "dist/client",
  roles: { player: { inputs: ["touch", "keyboard"], screen: "small" } },
  stats: { punkte: { label: "Punkte", better: "higher" } },
};

const dirs: string[] = [];

function game(files: Record<string, string>, changes: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "gamehearth-solo-check-"));
  dirs.push(dir);
  const all: Record<string, string> = {
    "manifest.json": JSON.stringify({ ...manifest, ...changes }),
    "dist/client/index.html": "<!doctype html><script src=\"main.js\"></script>",
    "dist/client/main.js": "localStorage.getItem('phaser-intern');",
    "ids.lock": formatIdsLock({ format: 1, items: [], stats: ["punkte"], flags: [] }),
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const goodMain = `import { connectSolo } from "@gamehearth/sdk/client";
const game = await connectSolo<{ level: number }, "punkte">();
await game.record("punkte", 10);
`;

describe("check for single-player games without a reducer", () => {
  it("is green for a game that uses connectSolo; the built client (e.g. Phaser) does not count", async () => {
    const report = await checkGame(game({ "client/src/main.ts": goodMain }));
    expect(report.findings).toEqual([]);
    expect(report.notes.join("\n")).toContain("has no reducer");
  });

  it("warns about localStorage, indexedDB, cookies and foreign URLs in the source code, not in comments and tests", async () => {
    const report = await checkGame(
      game({
        "client/src/main.ts": goodMain,
        "client/src/store.ts": [
          "// localStorage would be convenient",
          "export const x = localStorage.getItem('x');",
          "export const y = indexedDB.open('y');",
          "export const z = document.cookie;",
          "this.load.image('stern', 'https://example.com/stern.png');",
          "const ws = new WebSocket('wss://example.com');",
        ].join("\n"),
        "test/store.test.ts": "localStorage.clear();",
        "client/src/store.test.ts": "localStorage.clear();",
      }),
    );
    const messages = report.findings.map((finding) => `${finding.severity} ${finding.kind} ${finding.message}`);
    expect(messages).toEqual([
      expect.stringMatching(/^warning sandbox client\/src\/store\.ts:2 uses localStorage/),
      expect.stringMatching(/^warning sandbox client\/src\/store\.ts:3 uses indexedDB/),
      expect.stringMatching(/^warning sandbox client\/src\/store\.ts:4 uses document\.cookie/),
      expect.stringMatching(/^warning sandbox client\/src\/store\.ts:5 loads something from a foreign URL/),
      expect.stringMatching(/^warning sandbox client\/src\/store\.ts:6 opens its own connection/),
    ]);
  });

  it("reports best scores that are not in the manifest as an error", async () => {
    const report = await checkGame(game({ "client/src/main.ts": `${goodMain}await game.record("punkt", 3);\n` }));
    expect(report.findings).toEqual([
      expect.objectContaining({ severity: "error", kind: "solo", message: expect.stringContaining('reports the best score "punkt", which is not listed under stats in manifest.json (known: punkte)') }),
    ]);
  });

  it("Review 9: checks record only on the game from connectSolo, not on own objects", async () => {
    const report = await checkGame(
      game({
        "client/src/main.ts": `${goodMain}const history = { record(_name: string) {} };\nhistory.record("move");\n`,
        "client/src/scene.ts": [
          'import type { SoloGame } from "@gamehearth/sdk/client";',
          "export class Scene {",
          "  #game: SoloGame<unknown, string>;",
          "  constructor(game: SoloGame<unknown, string>) { this.#game = game; }",
          '  end() { void this.#game.record("punkt", 1); }',
          "}",
        ].join("\n"),
      }),
    );
    expect(report.findings).toEqual([expect.objectContaining({ severity: "error", message: expect.stringContaining('client/src/scene.ts:5 reports the best score "punkt"') })]);
  });

  it("Review 9: only warns when the game object cannot be recognized", async () => {
    const report = await checkGame(game({ "client/src/main.ts": 'import { connectSolo } from "@gamehearth/sdk/client";\nvoid connectSolo().then((game) => game.record("punkt", 1));\n' }));
    expect(report.findings).toEqual([expect.objectContaining({ severity: "warning", message: expect.stringContaining('reports probably the best score "punkt"') })]);
  });

  it("reports connect instead of connectSolo as an error", async () => {
    const report = await checkGame(game({ "client/src/main.ts": `import { connect } from "@gamehearth/sdk/client";\nawait connect();\n` }));
    expect(report.findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining("imports connect from @gamehearth/sdk/client"),
      expect.stringContaining("No source file calls connectSolo()"),
    ]);
  });

  it("reports manifest errors in best scores", async () => {
    const report = await checkGame(game({ "client/src/main.ts": goodMain }, { stats: { punkte: { label: "Punkte", better: "mehr" } } }));
    expect(report.findings).toEqual([expect.objectContaining({ severity: "error", kind: "manifest", message: expect.stringContaining("stats.punkte.better") })]);
  });
});

describe("pack for single-player games without a reducer", () => {
  it("packs without game.mjs, and the hash covers manifest and client", async () => {
    const dir = game({ "client/src/main.ts": goodMain, LICENSE: "MIT" });
    const built = await buildPackage(dir, { warnings: 0 });
    const names = readZip(built.archive, { maxEntries: 100, maxBytes: 1_000_000 }).map((entry) => entry.path);
    expect(names).not.toContain("game.mjs");
    expect(names).toEqual(expect.arrayContaining(["manifest.json", "LICENSE", "pack.json", "client/index.html", "client/main.js"]));
    expect(built.pkg.code).toBe("");
    expect(built.pkg.manifest.stats).toEqual({ punkte: { label: "Punkte", better: "higher" } });
    expect(built.pkg.build).toBe(`solo-probe@0.1.0+${contentHash(built.pkg.manifestText, "", built.pkg.client)}`);
    expect(inspectPackage(built.archive).build).toBe(built.pkg.build);
  });
});

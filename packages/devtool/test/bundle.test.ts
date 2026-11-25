import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bundleGameModule } from "../src/bundle";

const sdk = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url)).replaceAll("\\", "/");
const mauMau = fileURLToPath(new URL("../../../fixtures/mau-mau", import.meta.url));
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

function game(files: Record<string, string>): string {
  const dir = tempDir("gamehearth-bundle-");
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return dir;
}

const counter = `import { defineGame } from ${JSON.stringify(sdk)};
export default defineGame({
  setup: ({ players }) => ({ public: { count: 0 }, players: Object.fromEntries(players.map((player) => [player, {}])), secret: {} }),
  legalMoves: () => [{ type: "add" }],
  apply: (state) => { state.public.count += 1; },
  result: (state) => (state.public.count >= 3 ? { winners: [] } : undefined),
});`;

describe("bundling stays inside the game folder", () => {
  it("bundles Mau-Mau with the SDK", async () => {
    expect(await bundleGameModule(mauMau)).toContain("kreuz");
  });

  it("allows data and code from the own folder", async () => {
    const dir = game({
      "src/index.ts": `import table from "./data/loot.json";\nimport { bonus } from "./rules";\nexport { table, bonus };\n${counter.replace("export default", "export const game =")}\nexport default game;`,
      "src/data/loot.json": JSON.stringify({ sword: 3 }),
      "src/rules.ts": "export const bonus = 2;",
    });
    expect(await bundleGameModule(dir)).toContain("sword");
  });

  it("rejects a JSON file outside the game folder via an absolute path", async () => {
    const secret = tempDir("gamehearth-secret-");
    writeFileSync(join(secret, "secret.json"), JSON.stringify({ password: "top-secret" }));
    const dir = game({ "src/index.ts": `import leak from ${JSON.stringify(join(secret, "secret.json").replaceAll("\\", "/"))};\nexport const value = leak;\n${counter}` });
    await expect(bundleGameModule(dir)).rejects.toThrow(/is outside the game folder/);
  });

  it("rejects files outside via ../ and via absolute paths", async () => {
    const outside = tempDir("gamehearth-neighbor-");
    writeFileSync(join(outside, "note.txt"), "top-secret");
    const nested = game({ "game/src/index.ts": `import text from "../../note.txt";\nexport const value = text;\n${counter}` });
    writeFileSync(join(nested, "note.txt"), "top-secret");
    await expect(bundleGameModule(join(nested, "game"))).rejects.toThrow(/is outside the game folder/);
    const absolute = game({ "src/index.ts": `import text from ${JSON.stringify(join(outside, "note.txt").replaceAll("\\", "/"))};\nexport const value = text;\n${counter}` });
    await expect(bundleGameModule(absolute)).rejects.toThrow(/is outside the game folder/);
  });

  it("rejects files outside also for glob imports with a placeholder", async () => {
    const outer = game({ "data/deep/access.json": JSON.stringify({ token: "top-secret-deep" }), "note.txt": "top-secret" });
    const viaRequire = "export const peek = (name: string) => require(`../../data/deep/${name}.json`);\n";
    const viaImport = "export const peek = (name: string) => import(`../../${name}.txt`);\n";
    for (const [folder, source] of [
      ["game-a", viaRequire],
      ["game-b", viaImport],
    ] as const) {
      mkdirSync(join(outer, folder, "src"), { recursive: true });
      writeFileSync(join(outer, folder, "src", "index.ts"), `${source}${counter}`);
      await expect(bundleGameModule(join(outer, folder))).rejects.toThrow(/is outside the game folder/);
    }
  });
});

describe("own SDK copy of the game", () => {
  it("bundles a game whose @gamehearth/sdk is in its own node_modules", async () => {
    const sdkPackage = fileURLToPath(new URL("../../sdk", import.meta.url));
    const dir = game({
      "src/index.ts": counter.replace(JSON.stringify(sdk), JSON.stringify("@gamehearth/sdk")),
    });
    const copy = join(dir, "node_modules", "@gamehearth", "sdk");
    mkdirSync(copy, { recursive: true });
    cpSync(join(sdkPackage, "package.json"), join(copy, "package.json"));
    cpSync(join(sdkPackage, "src"), join(copy, "src"), { recursive: true });
    const code = await bundleGameModule(dir);
    expect(code).toContain("defineGame");
  });
});

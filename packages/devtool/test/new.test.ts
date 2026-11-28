import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sdkVersion } from "@gamehearth/sdk/platform";
import { afterAll, describe, expect, it } from "vitest";
import { checkGame } from "../src/check";
import { createGame, idFromFolder, nameFromId, NewGameError, nextSteps, templateRoot, type CommandRunner } from "../src/new";
import { devtoolVersion } from "../src/package";

const devtool = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(devtool, "new-test-"));

afterAll(() => rmSync(work, { recursive: true, force: true }));

interface Call {
  command: string;
  cwd: string;
  inherit: boolean;
}

function fakeRunner(answers: Record<string, { code: number; output: string }> = {}): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = async (command, cwd, options) => {
    calls.push({ command, cwd, inherit: options?.inherit === true });
    return answers[command] ?? { code: 0, output: "" };
  };
  return { run, calls };
}

function read(dir: string, file: string): string {
  return readFileSync(join(dir, file), "utf8");
}

describe("new", () => {
  it("creates a complete game from the template and adjusts names, versions and license", async () => {
    const { run } = fakeRunner();
    const dir = join(work, "connect-four");
    const result = await createGame(dir, { name: "Connect four", install: false, git: false, owner: "Anna Example", year: 2031, run });
    expect(result).toEqual({ dir, id: "connect-four", name: "Connect four", installed: false, git: "off" });

    for (const file of [
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      "LICENSE",
      "manifest.json",
      "package.json",
      "tsconfig.json",
      ".gitignore",
      ".gitattributes",
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
      "src/game.ts",
      "src/index.ts",
      "client/index.html",
      "client/vite.config.ts",
      "client/tsconfig.json",
      "client/src/main.ts",
      "client/src/scene.ts",
      "client/src/view.ts",
      "client/src/access.ts",
      "client/src/texts.ts",
      "client/src/style.css",
      "client/public/cover.svg",
      "test/rules.test.ts",
      "test/view.test.ts",
    ]) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
    for (const file of ["gitignore", "gitattributes", "github", "dist", "node_modules", "vendor"]) {
      expect(existsSync(join(dir, file)), file).toBe(false);
    }

    const manifest = JSON.parse(read(dir, "manifest.json")) as Record<string, unknown>;
    expect(manifest["id"]).toBe("connect-four");
    expect(manifest["name"]).toBe("Connect four");
    expect(manifest["sdk"]).toBe(`^${sdkVersion}`);
    expect(manifest["version"]).toBe("0.1.0");
    expect(manifest["languages"]).toEqual(["en", "de"]);
    expect(manifest["cover"]).toBe("cover.svg");
    expect(read(dir, "client/public/cover.svg")).toBe(readFileSync(join(templateRoot("turn-based"), "client", "public", "cover.svg"), "utf8"));
    const texts = read(dir, "client/src/texts.ts");
    expect(texts.match(/name: "Connect four",/g)).toHaveLength(2);
    expect(texts).not.toContain("Card Duel");
    expect(texts).not.toContain("Kartenduell");

    const pkg = JSON.parse(read(dir, "package.json")) as { name: string; dependencies: Record<string, string>; devDependencies: Record<string, string>; overrides?: unknown };
    expect(pkg.name).toBe("connect-four");
    expect(pkg.dependencies["@gamehearth/sdk"]).toBe(`^${sdkVersion}`);
    expect(pkg.devDependencies["gamehearth"]).toBe(`^${devtoolVersion}`);
    expect(pkg.overrides).toBeUndefined();

    expect(read(dir, "LICENSE")).toContain("Copyright (c) 2031 Anna Example");
    expect(read(dir, "LICENSE")).not.toContain("{{");
    expect(read(dir, "client/index.html")).toContain("<title>Connect four</title>");
    expect(read(dir, "client/index.html")).not.toContain("Card Duel");
    expect(read(dir, "README.md").split("\n")[0]).toBe("# Connect four");
    expect(read(dir, "README.md")).toContain('still contains the example "Card Duel"');
    expect(read(dir, "CLAUDE.md").trim()).toBe("@AGENTS.md");
  });

  it("takes the id from the folder name and makes a name from it", async () => {
    expect(idFromFolder("Connect Four")).toBe("connect-four");
    expect(idFromFolder("Mäxchen & Söhne")).toBe("maexchen-soehne");
    expect(idFromFolder("café_crème 2")).toBe("cafe-creme-2");
    expect(nameFromId("old-maid")).toBe("Old maid");

    const dir = join(work, "Old Maid");
    const result = await createGame(dir, { install: false, git: false, owner: "x", run: fakeRunner().run });
    expect(result.id).toBe("old-maid");
    expect(result.name).toBe("Old maid");
  });

  it("refuses folders that give no id and folders with content", async () => {
    await expect(createGame(join(work, "!!!"), { install: false, git: false, run: fakeRunner().run })).rejects.toThrow(NewGameError);
    const full = join(work, "full");
    mkdirSync(full);
    writeFileSync(join(full, "note.txt"), "mine");
    await expect(createGame(full, { install: false, git: false, run: fakeRunner().run })).rejects.toThrow(/is not empty/);
    expect(read(full, "note.txt")).toBe("mine");
    const empty = join(work, "empty");
    mkdirSync(empty);
    await expect(createGame(empty, { install: false, git: false, owner: "x", run: fakeRunner().run })).resolves.toMatchObject({ id: "empty" });
  });

  it("rejects unknown templates and invalid names and accepts the old template names", async () => {
    await expect(createGame(join(work, "einzel"), { template: "einzel", install: false, git: false, run: fakeRunner().run })).rejects.toThrow(/The template einzel does not exist/);
    await expect(createGame(join(work, "langer-name"), { name: "x".repeat(61), install: false, git: false, run: fakeRunner().run })).rejects.toThrow(/1 to 60/);
    expect(templateRoot("rundenbasiert")).toBe(templateRoot("turn-based"));
    expect(templateRoot("echtzeit")).toBe(templateRoot("realtime"));
    expect(templateRoot("einzelspieler")).toBe(templateRoot("single"));
  });

  it("takes the holder from git and otherwise a generic one", async () => {
    const withGit = join(work, "with-git");
    await createGame(withGit, { install: false, git: false, run: fakeRunner({ "git config --get user.name": { code: 0, output: "Bea Git\n" } }).run });
    expect(read(withGit, "LICENSE")).toMatch(/Copyright \(c\) \d{4} Bea Git\n/);
    const withoutGit = join(work, "without-git");
    await createGame(withoutGit, { name: "Without Git", install: false, git: false, run: fakeRunner({ "git config --get user.name": { code: 1, output: "" } }).run });
    expect(read(withoutGit, "LICENSE")).toMatch(/Copyright \(c\) \d{4} the authors of Without Git\n/);
  });

  it("creates a Git repo, but not inside an existing one, and installs visibly", async () => {
    const fresh = fakeRunner({ "git rev-parse --is-inside-work-tree": { code: 128, output: "fatal: not a git repository" } });
    const dir = join(work, "fresh");
    const result = await createGame(dir, { owner: "x", run: fresh.run });
    expect(result.git).toBe("created");
    expect(result.installed).toBe(true);
    expect(fresh.calls.map((call) => call.command)).toEqual(["git rev-parse --is-inside-work-tree", "git init --quiet", "git symbolic-ref HEAD refs/heads/main", "npm install --no-audit --no-fund"]);
    expect(fresh.calls.at(-1)).toEqual({ command: "npm install --no-audit --no-fund", cwd: dir, inherit: true });

    const nested = fakeRunner({ "git rev-parse --is-inside-work-tree": { code: 0, output: "true\n" } });
    expect((await createGame(join(work, "nested"), { owner: "x", install: false, run: nested.run })).git).toBe("existing");
    expect(nested.calls.map((call) => call.command)).not.toContain("git init --quiet");

    const failing = fakeRunner({ "npm install --no-audit --no-fund": { code: 1, output: "" } });
    await expect(createGame(join(work, "offline"), { owner: "x", git: false, run: failing.run })).rejects.toThrow(/npm install failed/);
  });

  it("creates the Git repo with the branch main that the CI of the template listens to", async () => {
    const outside = mkdtempSync(join(tmpdir(), "gamehearth-new-git-"));
    try {
      const dir = join(outside, "branch-test");
      const result = await createGame(dir, { owner: "x", install: false });
      expect(result.git).toBe("created");
      expect(execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()).toBe("main");
      expect(read(dir, ".github/workflows/ci.yml")).toContain("branches: [main]");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("uses the tarballs from vendor/ with --local-packages", async () => {
    const tarballs = join(work, "tarballs");
    mkdirSync(tarballs);
    writeFileSync(join(tarballs, "gamehearth-sdk-0.1.0.tgz"), "sdk");
    writeFileSync(join(tarballs, "gamehearth-0.2.0.tgz"), "devtool");
    const dir = join(work, "local");
    await createGame(dir, { localPackages: tarballs, install: false, git: false, owner: "x", run: fakeRunner().run });
    const pkg = JSON.parse(read(dir, "package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string>; overrides: Record<string, string> };
    expect(pkg.dependencies["@gamehearth/sdk"]).toBe("file:vendor/gamehearth-sdk-0.1.0.tgz");
    expect(pkg.devDependencies["gamehearth"]).toBe("file:vendor/gamehearth-0.2.0.tgz");
    expect(pkg.overrides).toEqual({ "@gamehearth/sdk": "$@gamehearth/sdk" });
    expect(read(dir, "vendor/gamehearth-0.2.0.tgz")).toBe("devtool");

    await expect(createGame(join(work, "without-tarballs"), { localPackages: join(work, "does-not-exist"), install: false, git: false, run: fakeRunner().run })).rejects.toThrow(
      /are missing in/,
    );
    expect(existsSync(join(work, "without-tarballs"))).toBe(false);
  });

  it("Review 14: names the right folder, even if it starts with the name of the working folder", () => {
    const text = nextSteps({ dir: join(work, "game2"), id: "game2", name: "Game2", installed: true, git: "created" }, join(work, "game"));
    expect(text).toContain(`cd ${join("..", "game2")}`);
    expect(nextSteps({ dir: join(work, "game"), id: "game", name: "Game", installed: true, git: "created" }, join(work, "game"))).toContain("cd .");
  });

  it("Review 15: copies names with $ unchanged into LICENSE and README", async () => {
    const dir = join(work, "dollar");
    await createGame(dir, { name: "Cash $& Co $'", install: false, git: false, owner: "Max $' Muster $$", year: 2030, run: fakeRunner().run });
    expect(read(dir, "LICENSE")).toContain("Copyright (c) 2030 Max $' Muster $$\n");
    expect(read(dir, "LICENSE").match(/Permission is hereby granted/g)).toHaveLength(1);
    expect(read(dir, "README.md").split("\n")[0]).toBe("# Cash $& Co $'");
  });

  it("names the next steps relative to the working folder", () => {
    const text = nextSteps({ dir: join(work, "my game"), id: "my-game", name: "My game", installed: false, git: "created" }, work);
    expect(text).toContain('cd "my game"');
    expect(text).toContain("npm install");
    expect(text).toContain("npm run dev");
  });

  it("creates a realtime game from the template realtime with TV and controllers", async () => {
    const dir = join(work, "farbfelder");
    await createGame(dir, { name: "Farbfelder", template: "realtime", install: false, git: false, owner: "x", run: fakeRunner().run });
    const manifest = JSON.parse(read(dir, "manifest.json")) as { id: string; name: string; mode: string; sdk: string; roles: Record<string, unknown> };
    expect(manifest).toMatchObject({ id: "farbfelder", name: "Farbfelder", mode: "realtime", sdk: `^${sdkVersion}`, languages: ["en", "de"], cover: "cover.svg" });
    expect(Object.keys(manifest.roles)).toEqual(["screen", "controller"]);
    expect(read(dir, "client/src/texts.ts").match(/name: "Farbfelder",/g)).toHaveLength(2);
    for (const file of ["client/src/screen.ts", "client/src/controller.ts", "client/src/view.ts", "client/public/cover.svg", "test/rules.test.ts", ".github/workflows/ci.yml"]) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
    expect(read(dir, "client/index.html")).toContain("<title>Farbfelder</title>");
    expect(read(dir, "README.md").split("\n")[0]).toBe("# Farbfelder");
    expect(read(dir, "README.md")).toContain('still contains the example "Tag"');
    const report = await checkGame(dir, { games: 4, quickjsGames: 1 });
    expect(report.findings.filter((finding) => finding.kind !== "client")).toEqual([]);
  }, 120_000);

  it("creates a single-player game without a reducer from the template single that passes check", async () => {
    const dir = join(work, "mauerbrecher");
    await createGame(dir, { name: "Mauerbrecher", template: "single", install: false, git: false, owner: "x", run: fakeRunner().run });
    const manifest = JSON.parse(read(dir, "manifest.json")) as { id: string; name: string; mode: string; server: boolean; sdk: string; stats: Record<string, unknown> };
    expect(manifest).toMatchObject({ id: "mauerbrecher", name: "Mauerbrecher", mode: "single", server: false, sdk: `^${sdkVersion}`, languages: ["en", "de"], cover: "cover.svg" });
    expect(Object.keys(manifest.stats)).toEqual(["best-time"]);
    expect(read(dir, "client/src/texts.ts").match(/name: "Mauerbrecher",/g)).toHaveLength(2);
    for (const file of ["src/levels.ts", "src/rules.ts", "client/src/scene.ts", "client/src/controls.ts", "client/src/view.ts", "client/public/cover.svg", "test/levels.test.ts", ".github/workflows/ci.yml"]) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
    expect(read(dir, ".gitignore")).toContain(".gamehearth/");
    expect(read(dir, "client/index.html")).toContain("<title>Mauerbrecher</title>");
    expect(read(dir, "client/index.html")).toContain('<h1 id="title">Mauerbrecher</h1>');
    expect(read(dir, "README.md")).toContain('still contains the example "Mushroom Hunt"');
    expect(JSON.parse(read(dir, "ids.lock"))).toMatchObject({ format: 1, items: [], stats: ["best-time"], flags: [] });
    const report = await checkGame(dir, { idsLock: "verify" });
    expect(report.findings.filter((finding) => finding.kind !== "client")).toEqual([]);
    expect(report.notes.join("\n")).toContain("has no reducer");
  });

  it("creates a game that passes check without errors (except for the client that is not built yet)", async () => {
    const dir = join(work, "checked");
    await createGame(dir, { install: false, git: false, owner: "x", run: fakeRunner().run });
    const report = await checkGame(dir, { games: 20, quickjsGames: 2 });
    const problems = report.findings.filter((finding) => finding.kind !== "client");
    expect(problems).toEqual([]);
  }, 120_000);
});

describe.each(["turn-based", "realtime", "single"])("template %s", (name) => {
  const template = templateRoot(name);

  it("Acceptance 12: its UI tests still pass in a game with its own name", async () => {
    const vitest = join(devtool, "..", "..", "node_modules", "vitest", "vitest.mjs");
    const dir = join(work, `eigener-name-${name}`);
    await createGame(dir, { template: name, name: "Mäxchen", install: false, git: false, run: fakeRunner().run });
    expect(read(dir, "client/src/texts.ts")).not.toMatch(/Kartenduell|Card Duel|Fangen|"Tag"|Pilzsuche|Mushroom Hunt/);
    const output = execFileSync(process.execPath, [vitest, "run", "--root", dir, "test/view.test.ts"], { encoding: "utf8", stdio: "pipe" });
    expect(output.replace(/\u001b\[[\d;]*m/g, "")).toMatch(/Tests\s+\d+ passed/);
  }, 120_000);

  it("passes the catalog in every stepMatch example of AGENTS.md, like the template's own tests", () => {
    for (const name of ["turn-based", "realtime", "single"]) {
      const agents = readFileSync(join(templateRoot(name), "AGENTS.md"), "utf8");
      for (const [example] of agents.matchAll(/`stepMatch\([^`]*`/g)) {
        expect(example, `${name}/AGENTS.md: ${example}`).toContain("{ catalog: manifest }");
      }
    }
  });

  it("names only files, paths and commands in AGENTS.md that exist", () => {
    const agents = readFileSync(join(template, "AGENTS.md"), "utf8");
    const scripts = (JSON.parse(readFileSync(join(template, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    for (const [, script] of agents.matchAll(/npm run ([a-z:]+)/g)) {
      expect(Object.keys(scripts), `npm run ${script}`).toContain(script);
    }
    const installed: Record<string, string> = {
      "node_modules/@gamehearth/sdk/README.md": join(devtool, "..", "sdk", "README.md"),
      "node_modules/gamehearth/README.md": join(devtool, "README.md"),
      [`node_modules/gamehearth/templates/${name}/`]: template,
    };
    for (const [, path] of agents.matchAll(/`(node_modules\/[^`]+)`/g)) {
      expect(installed[path as string], path).toBeDefined();
      expect(existsSync(installed[path as string] as string), path).toBe(true);
    }
    for (const [, path] of agents.matchAll(/^\| `((?:src|client|test)\/[^`]*|manifest\.json)` \|/gm)) {
      const file = (path as string).replace(/\/$/, "");
      expect(existsSync(join(template, file)), file).toBe(true);
    }
    const sdkReadme = readFileSync(join(devtool, "..", "sdk", "README.md"), "utf8");
    const contract = [
      ...(name === "single"
        ? ["connectSolo", "game.saved", "game.best", "game.save", "game.record", "stats", '"higher"', '"lower"', '"time"']
        : ["random.int", "random.pick", "random.shuffle", "ctx.now", "connect()", "game.onUpdate", "game.move", "bot(state, player, moves, ctx)", '"away": "play-on"']),
      "game.sound",
      "game.soundOn",
      "defineTexts",
      "game.language",
      "languages",
    ];
    for (const entry of contract) {
      expect(agents, entry).toContain(entry);
      expect(sdkReadme, entry).toContain(entry);
    }
  });

  it("is published with the package, but without the built client and node_modules", () => {
    const files = (JSON.parse(readFileSync(join(devtool, "package.json"), "utf8")) as { files: string[] }).files;
    expect(files).toContain("templates");
    expect(files).toContain("!templates/*/dist");
    expect(files).toContain("!templates/*/node_modules");
  });
});

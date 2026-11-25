import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = mkdtempSync(join(root, "cli-test-"));

afterAll(() => rmSync(out, { recursive: true, force: true }));

function scriptArgs(script: string): string[] {
  return [...script.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "");
}

describe("dev tool as a command", () => {
  it("starts through the npm launcher because dist/cli.js has a shebang line", () => {
    const scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: { build: string; prepack?: string } }).scripts;
    expect(scripts.prepack).toBe("npm run build");
    const build = scripts.build;
    const [command, ...args] = scriptArgs(build);
    expect(command).toBe("esbuild");
    const outfile = join(out, "cli.js");
    const esbuild = join(dirname(createRequire(import.meta.url).resolve("esbuild/package.json")), "bin", "esbuild");
    execFileSync(process.execPath, [esbuild, ...args.map((arg) => (arg.startsWith("--outfile=") ? `--outfile=${outfile}` : arg))], { cwd: root });
    expect(readFileSync(outfile, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
    const run = spawnSync(process.execPath, [outfile], { cwd: root, encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("gamehearth pack <game-folder>");

    const game = join(out, "rt-dots");
    cpSync(fileURLToPath(new URL("./fixtures/rt-dots", import.meta.url)), game, { recursive: true });
    writeFileSync(join(game, "LICENSE"), "MIT License\n");
    const short = spawnSync(process.execPath, [outfile, "pack", game, "--max-seconds", "1", "--out", join(out, "short")], { cwd: root, encoding: "utf8" });
    expect(short.status).toBe(1);
    expect(short.stdout).toMatch(/after 1 seconds of game time/);
    const wrong = spawnSync(process.execPath, [outfile, "pack", game, "--max-seconds", "0"], { cwd: root, encoding: "utf8" });
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain("--max-seconds needs an integer of at least 1, got 0");
    const packed = spawnSync(process.execPath, [outfile, "pack", game, "--max-seconds", "60", "--out", join(out, "long")], { cwd: root, encoding: "utf8" });
    expect(packed.stdout).toContain("Package built");
    expect(packed.status).toBe(0);
  }, 120_000);
});

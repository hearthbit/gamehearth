import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = process.argv[2];
if (target === undefined) {
  console.error("Usage: npm run starter -- <folder of the starter repo>");
  process.exit(2);
}
const destination = resolve(target);

function looksLikeStarter(dir) {
  const entries = existsSync(dir) ? readdirSync(dir).filter((entry) => entry !== ".git") : [];
  if (entries.length === 0) {
    return true;
  }
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    return (manifest.id === "my-game" || manifest.id === "mein-spiel") && existsSync(join(dir, "AGENTS.md"));
  } catch {
    return false;
  }
}

if (!looksLikeStarter(destination)) {
  console.error(`${destination} is neither empty nor a snapshot of the starter (manifest.json with id my-game and AGENTS.md). Nothing changed.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "gamehearth-starter-"));
try {
  const emptyConfig = join(work, "empty-gitconfig");
  writeFileSync(emptyConfig, "");
  const game = join(work, "my-game");
  execFileSync(process.execPath, [join(root, "packages", "devtool", "dist", "cli.js"), "new", game, "--name", "My Game", "--no-install", "--no-git"], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1" },
  });
  cpSync(join(root, "scripts", "starter", "README.md"), join(game, "README.md"));
  const lock = spawnSync("npm install --package-lock-only --no-audit --no-fund", { cwd: game, shell: true, encoding: "utf8" });
  const locked = lock.status === 0 && existsSync(join(game, "package-lock.json"));

  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(destination)) {
    if (entry !== ".git") {
      rmSync(join(destination, entry), { recursive: true, force: true });
    }
  }
  cpSync(game, destination, { recursive: true });
  console.log(`Wrote the starter to ${destination}${existsSync(join(destination, ".git")) ? " (Git repo unchanged, nothing committed)" : ""}`);
  if (!locked) {
    console.warn(
      "Without package-lock.json: npm could not resolve the SDK and the dev tool (not on npm yet?). The CI of the starter repo needs the lock file; run npm run starter again after publishing.",
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative as relativePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sdkVersion } from "@gamehearth/sdk/platform";
import { devtoolVersion } from "./package";

export const templates = ["turn-based", "realtime", "single"] as const;
export type TemplateName = (typeof templates)[number];
export const defaultTemplate: TemplateName = "turn-based";
export const templateAliases: Readonly<Record<string, TemplateName>> = { rundenbasiert: "turn-based", echtzeit: "realtime", einzelspieler: "single" };

const examples: Record<TemplateName, string> = { "turn-based": "Card Duel", realtime: "Tag", single: "Mushroom Hunt" };
const translatedExamples: Record<TemplateName, readonly string[]> = { "turn-based": ["Kartenduell"], realtime: ["Fangen"], single: ["Pilzsuche"] };
const idPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const skipped = new Set(["node_modules", "dist", "coverage"]);
const renamed: Record<string, string> = { gitignore: ".gitignore", gitattributes: ".gitattributes", github: ".github" };

export interface CommandRunner {
  (command: string, cwd: string, options?: { inherit?: boolean }): Promise<{ code: number; output: string }>;
}

export interface NewOptions {
  name?: string;
  template?: string;
  install?: boolean;
  git?: boolean;
  localPackages?: string;
  owner?: string;
  year?: number;
  run?: CommandRunner;
  log?: (line: string) => void;
}

export interface NewResult {
  dir: string;
  id: string;
  name: string;
  installed: boolean;
  git: "created" | "existing" | "off" | "missing";
}

export class NewGameError extends Error {}

export function resolveTemplate(template: string): string {
  return Object.hasOwn(templateAliases, template) ? (templateAliases[template] as TemplateName) : template;
}

export function templateRoot(requested: string = defaultTemplate): string {
  const template = resolveTemplate(requested);
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "..", "templates", template), join(here, "..", "..", "templates", template)]) {
    if (existsSync(join(candidate, "manifest.json"))) {
      return candidate;
    }
  }
  throw new NewGameError(`The template ${template} was not found next to ${here}`);
}

export function idFromFolder(folder: string): string {
  return folder
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function nameFromId(id: string): string {
  const words = id.split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export async function createGame(target: string, options: NewOptions = {}): Promise<NewResult> {
  const log = options.log ?? (() => {});
  const run = options.run ?? runCommand;
  const template = resolveTemplate(options.template ?? defaultTemplate) as TemplateName;
  if (!(templates as readonly string[]).includes(template)) {
    throw new NewGameError(`The template ${template} does not exist. Available: ${templates.join(", ")}`);
  }
  const exampleName = examples[template];
  const dir = resolve(target);
  const id = idFromFolder(basename(dir));
  if (!idPattern.test(id) || id.length > 64) {
    throw new NewGameError(
      `The folder name "${basename(dir)}" does not give a valid game id. Use a name made of letters, digits and hyphens, for example connect-four.`,
    );
  }
  const name = (options.name ?? nameFromId(id)).trim();
  if (name.length === 0 || name.length > 60 || /[\u0000-\u001f]/.test(name)) {
    throw new NewGameError("The name must be 1 to 60 characters long and must not contain control characters.");
  }
  if (existsSync(dir) && (await readdir(dir)).length > 0) {
    throw new NewGameError(`The folder ${dir} is not empty. new only creates a game in a new or empty folder.`);
  }

  const packages = options.localPackages === undefined ? undefined : await localTarballs(resolve(options.localPackages));
  await copyTree(templateRoot(template), dir);

  const year = options.year ?? new Date().getUTCFullYear();
  const owner = options.owner ?? ((await gitUserName(run, dir)) || `the authors of ${name}`);
  await rewrite(join(dir, "manifest.json"), (text) => {
    const manifest = JSON.parse(text) as Record<string, unknown>;
    manifest["id"] = id;
    manifest["name"] = name;
    manifest["sdk"] = `^${sdkVersion}`;
    return `${JSON.stringify(manifest, null, 2)}\n`;
  });
  await rewrite(join(dir, "package.json"), (text) => {
    const pkg = JSON.parse(text) as Record<string, unknown> & { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    pkg["name"] = id;
    pkg.dependencies["@gamehearth/sdk"] = `^${sdkVersion}`;
    pkg.devDependencies["gamehearth"] = `^${devtoolVersion}`;
    if (packages !== undefined) {
      pkg.dependencies["@gamehearth/sdk"] = `file:vendor/${packages.sdk}`;
      pkg.devDependencies["gamehearth"] = `file:vendor/${packages.devtool}`;
      pkg["overrides"] = { "@gamehearth/sdk": "$@gamehearth/sdk" };
    }
    return `${JSON.stringify(pkg, null, 2)}\n`;
  });
  await rewrite(join(dir, "client", "index.html"), (text) => text.split(exampleName).join(escapeHtml(name)));
  const textsFile = join(dir, "client", "src", "texts.ts");
  if (existsSync(textsFile)) {
    await rewrite(textsFile, (text) =>
      [exampleName, ...translatedExamples[template]].reduce((result, example) => result.split(`name: ${JSON.stringify(example)},`).join(`name: ${JSON.stringify(name)},`), text),
    );
  }
  await rewrite(join(dir, "README.md"), (text) =>
    text.replace(
      new RegExp(`^# ${exampleName}\\r?\\n`),
      () =>
        `# ${name}\n\n> This game was created with \`npx gamehearth new\` and still contains the example "${exampleName}" from the template. The rules below belong to the example until they are replaced with the rules of your own game.\n`,
    ),
  );
  await rewrite(join(dir, "LICENSE"), (text) => text.replace("{{year}}", () => String(year)).replace("{{holder}}", () => owner));
  if (packages !== undefined) {
    await mkdir(join(dir, "vendor"), { recursive: true });
    await copyFile(join(packages.dir, packages.sdk), join(dir, "vendor", packages.sdk));
    await copyFile(join(packages.dir, packages.devtool), join(dir, "vendor", packages.devtool));
  }
  log(`Created the game "${name}" (id ${id}) from the template ${template} in ${dir}`);

  let git: NewResult["git"] = "off";
  if (options.git !== false) {
    git = await initGit(run, dir);
    if (git === "created") {
      log("Created a Git repo (no commit yet).");
    } else if (git === "existing") {
      log("The folder is already inside a Git repo; no separate one created.");
    } else {
      log("git was not found; no Git repo created.");
    }
  }

  let installed = false;
  if (options.install !== false) {
    log("Installing dependencies with npm install …");
    const outcome = await run("npm install --no-audit --no-fund", dir, { inherit: true });
    if (outcome.code !== 0) {
      const output = outcome.output.trim();
      throw new NewGameError(`npm install failed. The game is still in ${dir}; run npm install there again.${output === "" ? "" : `\n${output}`}`);
    }
    installed = true;
  }
  return { dir, id, name, installed, git };
}

export function nextSteps(result: NewResult, cwd: string): string {
  const shown = relativePath(cwd, result.dir) || ".";
  const target = isAbsolute(shown) ? result.dir : shown;
  const lines = ["", "Next steps:", `  cd ${target.includes(" ") ? `"${target}"` : target}`];
  if (!result.installed) {
    lines.push("  npm install");
  }
  lines.push(
    "  npm run dev       try the game in the browser (the address then shows up in the terminal, usually http://localhost:5180)",
    "  npm run check     check the game like the platform does",
    "",
    "With an AI agent: open the folder and describe the game you want to make.",
    "The instructions for the agent are in AGENTS.md.",
  );
  return lines.join("\n");
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (skipped.has(entry.name)) {
      continue;
    }
    const target = join(to, renamed[entry.name] ?? entry.name);
    if (entry.isDirectory()) {
      await copyTree(join(from, entry.name), target);
    } else if (entry.isFile()) {
      await copyFile(join(from, entry.name), target);
    }
  }
}

async function rewrite(file: string, change: (text: string) => string): Promise<void> {
  await writeFile(file, change(await readFile(file, "utf8")), "utf8");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function localTarballs(dir: string): Promise<{ dir: string; sdk: string; devtool: string }> {
  const files = existsSync(dir) ? await readdir(dir) : [];
  const sdk = files.find((file) => /^gamehearth-sdk-.*\.tgz$/.test(file));
  const devtool = files.find((file) => /^gamehearth-\d.*\.tgz$/.test(file));
  if (sdk === undefined || devtool === undefined) {
    throw new NewGameError(
      `The tarballs gamehearth-sdk-<version>.tgz and gamehearth-<version>.tgz (from npm pack in packages/sdk and packages/devtool) are missing in ${dir}.`,
    );
  }
  return { dir, sdk, devtool };
}

async function gitUserName(run: CommandRunner, cwd: string): Promise<string> {
  const outcome = await run("git config --get user.name", existsSync(cwd) ? cwd : dirname(cwd)).catch(() => ({ code: 1, output: "" }));
  return outcome.code === 0 ? outcome.output.trim() : "";
}

async function initGit(run: CommandRunner, dir: string): Promise<NewResult["git"]> {
  const inside = await run("git rev-parse --is-inside-work-tree", dir).catch(() => undefined);
  if (inside === undefined || (inside.code !== 0 && /not found|nicht gefunden|ENOENT|is not recognized/i.test(inside.output))) {
    return "missing";
  }
  if (inside.code === 0 && inside.output.trim() === "true") {
    return "existing";
  }
  const init = await run("git init --quiet", dir).catch(() => undefined);
  if (init === undefined || init.code !== 0) {
    return "missing";
  }
  await run("git symbolic-ref HEAD refs/heads/main", dir).catch(() => undefined);
  return "created";
}

export function runCommand(command: string, cwd: string, options: { inherit?: boolean } = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const stdio = options.inherit === true ? (["ignore", "inherit", "inherit"] as const) : (["ignore", "pipe", "pipe"] as const);
    const child = spawn(command, { cwd, shell: true, stdio: [...stdio], windowsHide: true });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, output }));
  });
}

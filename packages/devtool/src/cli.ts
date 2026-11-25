import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { addToCatalog, formatCatalog, parseCatalog, versionEntry, type Catalog } from "./catalog";
import { checkGame, type CheckOptions } from "./check";
import { download } from "./download";
import { formatReport, players } from "./format";
import { startDev } from "./dev/server";
import { createGame, NewGameError, nextSteps } from "./new";
import { buildPackage, inspectPackage, maxPackageBytes, PackageError, sha256 } from "./package";

const usage = `Gamehearth dev tool

Usage:
  gamehearth new <folder> [--name <name>] [--template turn-based|realtime|single] [--no-install] [--no-git]
  gamehearth dev [game-folder] [--build "<command>"] [--client <folder>] [--port <n>] [--host] [--players <n>]
  gamehearth check <game-folder> [options]
  gamehearth pack <game-folder> [--out <folder>] [--max-seconds <n>]
  gamehearth catalog add <catalog.json> <package-url> [--name <catalog-name>] [--replace]
  gamehearth catalog check <catalog.json> [--download]

new creates a game from a template in a new or empty folder, runs
npm install and git init and names the next steps. The id comes from the
folder name, the display name from --name. Templates: turn-based (default, everyone
on their own device, example Card Duel), realtime (TV and phones as
controllers, example Tag) and single (one player without rules on the server,
example Mushroom Hunt).

dev starts the game locally (default http://localhost:5180) with all seats
side by side, bots, a view of the state and readable errors. When the
rules change, it replays the match with the new code (in realtime a
new match starts with the same seats and bots); when the built
UI changes, it reloads it. --build also starts a command that keeps
building the UI, --host makes dev reachable on the Wi-Fi.

pack checks the game with check and only builds the game package
<id>-<version>.zip if there are no errors (default: <game-folder>/dist).

catalog add downloads a package, checks it like the server does and adds the
version with size and checksum to the catalog. --name is only needed for a new
catalog, --replace replaces a version that is already listed.

catalog check checks the form of the catalog, with --download also every package.

Options for check:
  --games <n>       matches per player count (default 200, realtime 20)
  --players <n>     check only this player count
  --seed <seed>     replay exactly one match and show all moves (with --players)
  --bots            with --seed: the match is one in which the game's bot plays every seat (seeds check-bots-…)
  --option <n>=<v>  set a game option, also several times; without --seed all matches then run with these options
  --max-moves <n>   moves after which a match counts as "does not end" (default 5000)
  --max-seconds <n> game time in seconds after which a realtime match counts as "does not end" (default 600)
  --timeout <ms>    time without progress after which game code counts as hanging (default 3000)
  --quickjs <n>     matches per player count that also run in QuickJS like on the server (default 10, realtime 2, 0 turns it off)
  --bot-games <n>   for a game with bot: matches per player count in which bot plays every seat (default 10, realtime 2, 0 turns them off)
  --json            print the report as JSON`;

const downloadLimits = { maxBytes: maxPackageBytes, timeoutMs: 120_000 };

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === "new") {
      return await newGame(rest);
    }
    if (command === "dev") {
      return await dev(rest);
    }
    if (command === "check") {
      return await check(rest);
    }
    if (command === "pack") {
      return await pack(rest);
    }
    if (command === "catalog") {
      return await catalog(rest);
    }
  } catch (error) {
    if (error instanceof NewGameError) {
      console.error(error.message);
      return 1;
    }
    if (error instanceof PackageError) {
      console.error(`The package is invalid:\n${list(error.problems)}`);
      return 1;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  console.error(usage);
  return 2;
}

function list(problems: readonly string[]): string {
  return problems.map((problem) => `  - ${problem}`).join("\n");
}

function wrongCall(problem?: string): number {
  console.error(problem === undefined ? usage : `${problem}\n\n${usage}`);
  return 2;
}

function flags(args: string[], known: Record<string, "value" | "switch">): { positional: string[]; values: Map<string, string | true> } | string {
  const positional: string[] = [];
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const kind = known[arg];
    if (kind === undefined) {
      return `Unknown option ${arg}`;
    }
    if (kind === "switch") {
      values.set(arg, true);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) {
      return `${arg} needs a value`;
    }
    values.set(arg, value);
    index += 1;
  }
  return { positional, values };
}

async function newGame(args: string[]): Promise<number> {
  const parsed = flags(args, {
    "--name": "value",
    "--template": "value",
    "--no-install": "switch",
    "--no-git": "switch",
    "--local-packages": "value",
  });
  if (typeof parsed === "string") {
    return wrongCall(parsed);
  }
  if (parsed.positional.length !== 1) {
    return wrongCall("new needs exactly one folder, e.g. gamehearth new connect-four");
  }
  const name = parsed.values.get("--name");
  const template = parsed.values.get("--template");
  const localPackages = parsed.values.get("--local-packages");
  const result = await createGame(parsed.positional[0] as string, {
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof template === "string" ? { template } : {}),
    ...(typeof localPackages === "string" ? { localPackages } : {}),
    install: !parsed.values.has("--no-install"),
    git: !parsed.values.has("--no-git"),
    log: (line) => console.log(line),
  });
  console.log(nextSteps(result, process.cwd()));
  return 0;
}

async function dev(args: string[]): Promise<number> {
  const parsed = flags(args, { "--build": "value", "--client": "value", "--port": "value", "--host": "switch", "--players": "value" });
  if (typeof parsed === "string") {
    return wrongCall(parsed);
  }
  if (parsed.positional.length > 1) {
    return wrongCall();
  }
  const port = parsed.values.get("--port");
  const players = parsed.values.get("--players");
  const build = parsed.values.get("--build");
  const client = parsed.values.get("--client");
  for (const [flag, value] of [["--port", port], ["--players", players]] as const) {
    if (typeof value === "string" && !/^\d+$/.test(value)) {
      return wrongCall(`${flag} needs a number`);
    }
  }
  if (typeof port === "string" && Number(port) > 65535) {
    return wrongCall("--port needs a number from 0 to 65535");
  }
  process.off("SIGINT", interrupted);
  let stopRequested = false;
  const stopping = new Promise<void>((done) => {
    const stop = () => {
      if (stopRequested) {
        process.exit(130);
      }
      stopRequested = true;
      done();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  const server = await startDev(parsed.positional[0] ?? ".", {
    ...(typeof port === "string" ? { port: Number(port) } : {}),
    ...(typeof players === "string" ? { players: Number(players) } : {}),
    ...(typeof build === "string" ? { build } : {}),
    ...(typeof client === "string" ? { client } : {}),
    ...(parsed.values.has("--host") ? { host: "0.0.0.0" } : {}),
  });
  await stopping;
  await server.close();
  return 0;
}

async function pack(args: string[]): Promise<number> {
  const parsed = flags(args, { "--out": "value", "--max-seconds": "value" });
  if (typeof parsed === "string") {
    return wrongCall(parsed);
  }
  if (parsed.positional.length !== 1) {
    return wrongCall();
  }
  const seconds = parsed.values.get("--max-seconds");
  const maxSeconds = seconds === undefined ? undefined : Number(seconds);
  if (maxSeconds !== undefined && (!Number.isSafeInteger(maxSeconds) || maxSeconds < 1)) {
    return wrongCall(`--max-seconds needs an integer of at least 1, got ${String(seconds)}`);
  }
  const gameDir = resolve(parsed.positional[0] as string);
  const report = await checkGame(gameDir, {
    ...(maxSeconds === undefined ? {} : { maxSeconds }),
    onProgress: (playerCount, done, total) => {
      if (done === total || done % 50 === 0) {
        process.stderr.write(`  ${players(playerCount)}: ${done}/${total} matches\n`);
      }
    },
    onBotProgress: (playerCount, done, total) => {
      if (done === total) {
        process.stderr.write(`  ${players(playerCount)}: ${done}/${total} matches with the game's bot\n`);
      }
    },
    onReplay: (done, total) => {
      if (done === 1 || done === total || done % 5 === 0) {
        process.stderr.write(`  QuickJS: ${done}/${total} matches\n`);
      }
    },
  });
  const errors = report.findings.filter((finding) => finding.severity === "error").length;
  if (errors > 0) {
    console.log(formatReport(report));
    console.error(`pack stops: check reports ${errors} ${errors === 1 ? "error" : "errors"}. Fix them first, then pack.`);
    return 1;
  }
  const warnings = report.findings.length - errors;
  const { archive, pkg } = await buildPackage(gameDir, { warnings });
  const out = resolve((parsed.values.get("--out") as string | undefined) ?? join(gameDir, "dist"));
  await mkdir(out, { recursive: true });
  const file = join(out, `${pkg.manifest.id}-${pkg.manifest.version}.zip`);
  await writeFile(file, archive);
  console.log(`Package built: ${file}`);
  console.log(`  Build    ${pkg.build}`);
  console.log(`  Size     ${archive.length} bytes`);
  console.log(`  SHA-256  ${sha256(archive)}`);
  console.log(`  check    ${warnings === 0 ? "no warnings" : `${warnings} ${warnings === 1 ? "warning" : "warnings"}`}`);
  return 0;
}

async function readCatalogFile(file: string): Promise<Catalog | undefined> {
  const checked = parseCatalog(await readFile(file, "utf8"));
  if (!checked.ok) {
    console.error(`${file} is not a valid catalog:\n${list(checked.problems)}`);
    return undefined;
  }
  return checked.catalog;
}

async function catalog(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "add") {
    return catalogAdd(rest);
  }
  if (sub === "check") {
    return catalogCheck(rest);
  }
  return wrongCall();
}

async function catalogAdd(args: string[]): Promise<number> {
  const parsed = flags(args, { "--name": "value", "--replace": "switch" });
  if (typeof parsed === "string") {
    return wrongCall(parsed);
  }
  if (parsed.positional.length !== 2) {
    return wrongCall();
  }
  const [file, url] = parsed.positional as [string, string];
  const name = parsed.values.get("--name");
  let current: Catalog;
  if (existsSync(file)) {
    const loaded = await readCatalogFile(file);
    if (loaded === undefined) {
      return 1;
    }
    current = typeof name === "string" ? { ...loaded, name } : loaded;
  } else {
    if (typeof name !== "string") {
      console.error(`${file} does not exist yet. For a new catalog, pass --name <catalog-name>.`);
      return 2;
    }
    current = { format: 1, name, games: [] };
  }
  const archive = await download(url, downloadLimits);
  const pkg = inspectPackage(archive);
  const entry = versionEntry(pkg, archive, url);
  const next = addToCatalog(current, pkg, entry, { replace: parsed.values.get("--replace") === true });
  const checked = parseCatalog(formatCatalog(next));
  if (!checked.ok) {
    console.error(`The catalog would be invalid afterwards:\n${list(checked.problems)}`);
    return 1;
  }
  await writeFile(file, formatCatalog(next));
  console.log(
    next === current
      ? `${pkg.manifest.id} ${entry.version} is already in the catalog like this.`
      : `${pkg.manifest.id} ${entry.version} added (${entry.size} bytes, SHA-256 ${entry.sha256}, build ${pkg.build}).`,
  );
  return 0;
}

async function catalogCheck(args: string[]): Promise<number> {
  const parsed = flags(args, { "--download": "switch" });
  if (typeof parsed === "string") {
    return wrongCall(parsed);
  }
  if (parsed.positional.length !== 1) {
    return wrongCall();
  }
  const file = parsed.positional[0] as string;
  const loaded = await readCatalogFile(file);
  if (loaded === undefined) {
    return 1;
  }
  let failures = 0;
  if (parsed.values.get("--download") === true) {
    for (const game of loaded.games) {
      for (const version of game.versions) {
        const label = `${game.id} ${version.version}`;
        try {
          const archive = await download(version.url, downloadLimits);
          const problems: string[] = [];
          if (archive.length !== version.size) {
            problems.push(`size ${archive.length} instead of ${version.size}`);
          }
          if (sha256(archive) !== version.sha256) {
            problems.push("checksum does not match");
          }
          const pkg = inspectPackage(archive);
          if (pkg.manifest.id !== game.id || pkg.manifest.version !== version.version) {
            problems.push(`the package is ${pkg.manifest.id} ${pkg.manifest.version}`);
          }
          if (problems.length > 0) {
            failures += 1;
            console.error(`${label}: ${problems.join("; ")}`);
          } else {
            console.log(`${label}: OK (${pkg.build})`);
          }
        } catch (error) {
          failures += 1;
          console.error(`${label}: ${error instanceof PackageError ? error.problems.join("; ") : error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  const versions = loaded.games.reduce((sum, game) => sum + game.versions.length, 0);
  console.log(`${loaded.name}: ${loaded.games.length} games, ${versions} versions${failures > 0 ? `, ${failures} faulty` : ""}`);
  return failures > 0 ? 1 : 0;
}

async function check(args: string[]): Promise<number> {
  const [gameDir, ...rest] = args;
  if (gameDir === undefined || gameDir.startsWith("--")) {
    console.error(usage);
    return 2;
  }
  const parsed = parseOptions(rest);
  if (typeof parsed === "string") {
    console.error(`${parsed}\n\n${usage}`);
    return 2;
  }
  const report = await checkGame(gameDir, {
    ...parsed.options,
    onProgress: (playerCount, done, total) => {
      if (done === total || done % 50 === 0) {
        process.stderr.write(`  ${players(playerCount)}: ${done}/${total} matches\n`);
      }
    },
    onBotProgress: (playerCount, done, total) => {
      if (done === total) {
        process.stderr.write(`  ${players(playerCount)}: ${done}/${total} matches with the game's bot\n`);
      }
    },
    onReplay: (done, total) => {
      if (done === 1 || done === total || done % 5 === 0) {
        process.stderr.write(`  QuickJS: ${done}/${total} matches\n`);
      }
    },
  });
  console.log(parsed.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.findings.some((finding) => finding.severity === "error") ? 1 : 0;
}

function parseOptions(args: string[]): { options: CheckOptions; json: boolean } | string {
  const options: CheckOptions = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === "--bots") {
      options.bots = true;
      continue;
    }
    const value = args[i + 1];
    if (value === undefined) {
      return `${flag} needs a value`;
    }
    i += 1;
    switch (flag) {
      case "--games":
      case "--players":
      case "--max-moves":
      case "--max-seconds":
      case "--timeout": {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < 1) {
          return `${flag} needs an integer of at least 1, got ${value}`;
        }
        if (flag === "--games") options.games = number;
        if (flag === "--players") options.players = number;
        if (flag === "--max-moves") options.maxMoves = number;
        if (flag === "--max-seconds") options.maxSeconds = number;
        if (flag === "--timeout") options.timeoutMs = number;
        break;
      }
      case "--quickjs":
      case "--bot-games": {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < 0) {
          return `${flag} needs an integer of at least 0, got ${value}`;
        }
        if (flag === "--quickjs") options.quickjsGames = number;
        if (flag === "--bot-games") options.botGames = number;
        break;
      }
      case "--seed":
        options.seed = value;
        break;
      case "--option": {
        const match = /^([^=]+)=(.+)$/.exec(value);
        if (match === null) {
          return `--option needs name=value, e.g. --option duration=60, got ${value}`;
        }
        options.options = { ...options.options, [match[1] as string]: match[2] as string };
        break;
      }
      default:
        return `Unknown option ${flag}`;
    }
  }
  if (options.bots === true && options.seed === undefined) {
    return "--bots only works together with --seed; without --seed, check plays the matches with the game's bot by itself";
  }
  return { options, json };
}

function interrupted(): void {
  process.exit(130);
}

process.once("SIGINT", interrupted);
process.exitCode = await main(process.argv.slice(2));

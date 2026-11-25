import {
  bundleGameModule,
  catalogOf,
  contentHash,
  inspectClient,
  inspectPackage,
  normalizedManifest,
  PackageError,
  validateManifest,
  type ClientFile,
  type GamePackage,
  type Manifest,
} from "gamehearth";
import {
  allowedPlayerCounts,
  applyChange,
  defaultOptions,
  emptyProfile,
  hasCatalog,
  localize,
  sampleMove,
  seatIds,
  tickMs,
  type GameOptions,
  type Localized,
  type ProfileChange,
  type ProfileData,
} from "@gamehearth/sdk/platform";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { HostResult, SandboxHost } from "./sandbox/host";

export interface GameBuild {
  build: string;
  manifest: Manifest;
  code: string;
  clientDir: string;
  clientFiles: ReadonlySet<string>;
}

export function catalogJson(manifest: Manifest): string | undefined {
  return hasCatalog(catalogOf(manifest)) ? JSON.stringify(catalogOf(manifest)) : undefined;
}

export function clientUrl(build: string): string {
  const at = build.indexOf("@");
  return `/games/${build.slice(0, at)}/${build.slice(at + 1)}/`;
}

export interface LanguagesAndCover {
  languages?: string[];
  cover?: string;
}

export function languagesAndCover(build: GameBuild): LanguagesAndCover {
  const { languages, cover } = build.manifest;
  return {
    ...(languages === undefined ? {} : { languages }),
    ...(cover === undefined || !build.clientFiles.has(cover) ? {} : { cover: `${clientUrl(build.build)}${cover.split("/").map(encodeURIComponent).join("/")}` }),
  };
}

export function defaultText(value: Localized, languages: readonly string[] | undefined): string {
  return localize(value, undefined, languages ?? []);
}

export interface InstallReport {
  installed: GameBuild[];
  problems: string[];
}

export type LibraryErrorCode = "package-invalid" | "wrong-package" | "probe-failed" | "local-game" | "unknown-game";

export class LibraryError extends Error {
  readonly code: LibraryErrorCode;

  constructor(code: LibraryErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface InstalledGame extends LanguagesAndCover {
  id: string;
  name: Localized;
  version: string;
  build: string;
  source: "local" | "catalog";
  catalogId: number | undefined;
  installedAt: number | undefined;
  broken: boolean;
  shadowed: string | undefined;
  solo: boolean;
}

export interface LibraryOptions {
  maxPlayers?: number;
  probeMoves?: number;
  probeTimeMs?: number;
  clock?: () => number;
  log?: (message: string) => void;
}

interface InstalledRow {
  game_id: string;
  build: string;
  version: string;
  catalog_id: number | null;
  installed_at: number;
}

interface BuildContent {
  manifestText: string;
  code: string;
  files: readonly ClientFile[];
  write: (file: ClientFile, target: string) => Promise<void>;
  probe: boolean;
}

const trialRandom = { next: () => randomInt(2 ** 32) / 2 ** 32 };
const buildPattern = /^[a-z0-9]+(-[a-z0-9]+)*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\+[0-9a-f]{12}$/;
const partialAgeMs = 60 * 60 * 1000;

export class GameLibrary {
  readonly #buildsDir: string;
  readonly #sandbox: SandboxHost;
  readonly #db: DatabaseSync;
  readonly #options: LibraryOptions;
  readonly #local = new Map<string, string>();
  readonly #loaded = new Map<string, GameBuild>();
  readonly #pending = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(buildsDir: string, sandbox: SandboxHost, db: DatabaseSync, options: LibraryOptions = {}) {
    this.#buildsDir = buildsDir;
    this.#sandbox = sandbox;
    this.#db = db;
    this.#options = options;
  }

  async restore(): Promise<string[]> {
    const problems: string[] = [];
    for (const row of this.#rows()) {
      if ((await this.load(row.build)) === undefined) {
        problems.push(`${row.game_id}: the build ${row.build} is missing or damaged; please reinstall it in the admin view`);
      }
    }
    return problems;
  }

  async installAll(gamesDir: string): Promise<InstallReport> {
    const report: InstallReport = { installed: [], problems: [] };
    if (!existsSync(gamesDir)) {
      report.problems.push(`Games folder ${gamesDir} is missing`);
      return report;
    }
    const entries = await readdir(gamesDir, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = join(gamesDir, entry.name);
      if (!existsSync(join(dir, "manifest.json"))) {
        continue;
      }
      try {
        report.installed.push(await this.install(dir));
      } catch (error) {
        report.problems.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return report;
  }

  async install(gameDir: string): Promise<GameBuild> {
    const manifest = await readManifest(gameDir);
    const client = await inspectClient(gameDir, manifest.client);
    if (!client.ok) {
      throw new Error(client.problems.join("; "));
    }
    const code = manifest.server ? await bundleGameModule(gameDir) : "";
    const loaded = await this.#exclusive(() => this.#store(manifest, {
      manifestText: normalizedManifest(manifest),
      code,
      files: client.files,
      write: (file, target) => copyFile(join(client.dir, ...file.path.split("/")), target),
      probe: false,
    }));
    this.#local.set(manifest.id, loaded.build);
    return loaded;
  }

  async installPackage(archive: Buffer, options: { catalogId?: number; expect?: { id: string; version: string } } = {}): Promise<GameBuild> {
    let pkg: GamePackage;
    try {
      pkg = inspectPackage(archive);
    } catch (error) {
      if (error instanceof PackageError) {
        throw new LibraryError("package-invalid", `The package is invalid: ${error.problems.join("; ")}`);
      }
      throw error;
    }
    const expect = options.expect;
    if (expect !== undefined && (pkg.manifest.id !== expect.id || pkg.manifest.version !== expect.version)) {
      throw new LibraryError(
        "wrong-package",
        `The catalog announces ${expect.id} ${expect.version}, but the package contains ${pkg.manifest.id} ${pkg.manifest.version}`,
      );
    }
    const files = new Map(pkg.client.map((file) => [file.path, file.data]));
    return this.#exclusive(async () => {
      const loaded = await this.#store(pkg.manifest, {
      manifestText: pkg.manifestText,
      code: pkg.code,
      files: pkg.client.map((file) => ({ path: file.path, size: file.data.length, sha256: file.sha256 })),
        write: (file, target) => writeFile(target, files.get(file.path) as Buffer),
        probe: true,
      });
      const now = (this.#options.clock ?? Date.now)();
      this.#db
        .prepare(
          `INSERT INTO installed_games (game_id, build, version, catalog_id, installed_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (game_id) DO UPDATE SET build = excluded.build, version = excluded.version, catalog_id = excluded.catalog_id, installed_at = excluded.installed_at`,
        )
        .run(pkg.manifest.id, loaded.build, pkg.manifest.version, options.catalogId ?? null, now);
      return loaded;
    });
  }

  remove(gameId: string): string {
    if (this.#local.has(gameId)) {
      throw new LibraryError("local-game", `${gameId} comes from GAMES_DIR and can only be removed there`);
    }
    const row = this.#row(gameId);
    if (row === undefined) {
      throw new LibraryError("unknown-game", `The game ${gameId} is not installed`);
    }
    this.#db.prepare("DELETE FROM installed_games WHERE game_id = ?").run(gameId);
    return row.build;
  }

  current(gameId: string): GameBuild | undefined {
    const build = this.#local.get(gameId) ?? this.#row(gameId)?.build;
    return build === undefined ? undefined : this.#loaded.get(build);
  }

  isInstalled(gameId: string): boolean {
    return this.current(gameId) !== undefined;
  }

  catalogOf(gameId: string): number | undefined {
    return this.#local.has(gameId) ? undefined : (this.#row(gameId)?.catalog_id ?? undefined);
  }

  list(): Manifest[] {
    const ids = new Set([...this.#local.keys(), ...this.#rows().map((row) => row.game_id)]);
    return [...ids]
      .map((id) => this.current(id)?.manifest)
      .filter((manifest): manifest is Manifest => manifest !== undefined)
      .sort((a, b) => defaultText(a.name, a.languages).localeCompare(defaultText(b.name, b.languages), "de"));
  }

  installed(): InstalledGame[] {
    const rows = new Map(this.#rows().map((row) => [row.game_id, row]));
    const ids = new Set([...this.#local.keys(), ...rows.keys()]);
    const games: InstalledGame[] = [];
    for (const id of ids) {
      const local = this.#local.get(id);
      const row = rows.get(id);
      const build = local ?? (row as InstalledRow).build;
      const loaded = this.#loaded.get(build);
      games.push({
        id,
        name: loaded?.manifest.name ?? id,
        version: loaded?.manifest.version ?? row?.version ?? "?",
        build,
        source: local === undefined ? "catalog" : "local",
        catalogId: local === undefined ? (row?.catalog_id ?? undefined) : undefined,
        installedAt: local === undefined ? row?.installed_at : undefined,
        broken: loaded === undefined,
        shadowed: local !== undefined && row !== undefined ? row.build : undefined,
        solo: loaded !== undefined && loaded.manifest.mode === "single" && !loaded.manifest.server,
        ...(loaded === undefined ? {} : languagesAndCover(loaded)),
      });
    }
    return games.sort((a, b) => defaultText(a.name, a.languages).localeCompare(defaultText(b.name, b.languages), "de"));
  }

  displayName(gameId: string, build: string): Localized {
    return this.current(gameId)?.manifest.name ?? this.#loaded.get(build)?.manifest.name ?? gameId;
  }

  async load(build: string): Promise<GameBuild | undefined> {
    const cached = this.#loaded.get(build);
    if (cached !== undefined) {
      return cached;
    }
    if (!buildPattern.test(build)) {
      return undefined;
    }
    const stored = await readBuild(this.#buildDir(build), build.slice(build.lastIndexOf("+") + 1));
    if (stored === undefined) {
      return undefined;
    }
    const manifest = JSON.parse(stored.manifestText) as Manifest;
    const code = stored.code;
    if (manifest.server) {
      this.#sandbox.register(build, code, catalogJson(manifest));
    }
    const loaded: GameBuild = { build, manifest, code, clientDir: stored.clientDir, clientFiles: new Set(stored.files.map((file) => file.path)) };
    this.#loaded.set(build, loaded);
    return loaded;
  }

  sweep(referenced: () => ReadonlySet<string>): Promise<string[]> {
    return this.#exclusive(() => this.#sweep(referenced()));
  }

  async #sweep(referenced: ReadonlySet<string>): Promise<string[]> {
    const keep = new Set([...referenced, ...this.#local.values(), ...this.#rows().map((row) => row.build), ...this.#pending]);
    const removed: string[] = [];
    const now = Date.now();
    let games: string[];
    try {
      games = await readdir(this.#buildsDir);
    } catch {
      return removed;
    }
    for (const game of games) {
      const gameDir = join(this.#buildsDir, game);
      let versions: string[];
      try {
        versions = await readdir(gameDir);
      } catch {
        continue;
      }
      for (const version of versions) {
        const dir = join(gameDir, version);
        const partial = version.indexOf(".partial-");
        if (partial >= 0) {
          const stats = await lstat(dir).catch(() => undefined);
          if (stats !== undefined && now - stats.mtimeMs > partialAgeMs && !this.#pending.has(`${game}@${version.slice(0, partial)}`)) {
            await rm(dir, { recursive: true, force: true });
          }
          continue;
        }
        const build = `${game}@${version}`;
        if (keep.has(build) || !buildPattern.test(build)) {
          continue;
        }
        await rm(dir, { recursive: true, force: true });
        this.#loaded.delete(build);
        removed.push(build);
      }
      if ((await readdir(gameDir).catch(() => ["?"])).length === 0) {
        await rm(gameDir, { recursive: true, force: true });
      }
    }
    return removed;
  }

  async usage(): Promise<{ builds: Map<string, number>; total: number; free: number | undefined }> {
    const builds = new Map<string, number>();
    let total = 0;
    for (const game of await readdir(this.#buildsDir).catch(() => [] as string[])) {
      for (const version of await readdir(join(this.#buildsDir, game)).catch(() => [] as string[])) {
        const bytes = await directorySize(join(this.#buildsDir, game, version));
        total += bytes;
        if (!version.includes(".partial-")) {
          builds.set(`${game}@${version}`, bytes);
        }
      }
    }
    let free: number | undefined;
    try {
      await mkdir(this.#buildsDir, { recursive: true });
      const stats = await statfs(this.#buildsDir);
      free = stats.bavail * stats.bsize;
    } catch {
      free = undefined;
    }
    return { builds, total, free };
  }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #store(manifest: Manifest, content: BuildContent): Promise<GameBuild> {
    const hash = contentHash(content.manifestText, content.code, content.files);
    const build = `${manifest.id}@${manifest.version}+${hash}`;
    this.#pending.add(build);
    try {
      const dir = this.#buildDir(build);
      if ((await readBuild(dir, hash)) === undefined) {
        const staging = `${dir}.partial-${randomBytes(4).toString("hex")}`;
        await mkdir(staging, { recursive: true });
        await writeFile(join(staging, "manifest.json"), content.manifestText);
        if (manifest.server) {
          await writeFile(join(staging, "game.mjs"), content.code);
        }
        for (const file of content.files) {
          const target = join(staging, "client", ...file.path.split("/"));
          await mkdir(join(target, ".."), { recursive: true });
          await content.write(file, target);
        }
        await rm(dir, { recursive: true, force: true });
        await rename(staging, dir);
        this.#loaded.delete(build);
      }
      const problem = manifest.server ? await this.#sandbox.verify(build, content.code, catalogJson(manifest)) : undefined;
      if (problem !== undefined) {
        throw new LibraryError("probe-failed", `Build ${build} cannot be loaded in the sandbox: ${problem}`);
      }
      const loaded = await this.load(build);
      if (loaded === undefined) {
        throw new Error(`Build ${build} could not be loaded after building`);
      }
      const probe = content.probe && manifest.server ? await this.#probe(loaded) : undefined;
      if (probe !== undefined) {
        throw new LibraryError("probe-failed", `The trial match with ${build} failed: ${probe}`);
      }
      return loaded;
    } finally {
      this.#pending.delete(build);
    }
  }

  async #probe(build: GameBuild): Promise<string | undefined> {
    const counts = allowedPlayerCounts(build.manifest.players, this.#options.maxPlayers ?? 12);
    const tested = [...new Set([counts[0], counts.at(-1)])].filter((count): count is number => count !== undefined);
    const deadline = Date.now() + (this.#options.probeTimeMs ?? 30_000);
    const maxMoves = this.#options.probeMoves ?? 300;
    const defaults = defaultOptions(build.manifest.options);
    const chosen: { options?: GameOptions } = Object.keys(defaults).length === 0 ? {} : { options: defaults };
    for (const count of tested) {
      const room = `probe-${randomBytes(6).toString("hex")}`;
      try {
        const seed = randomBytes(16).toString("hex");
        const players = seatIds(count);
        const realtime = build.manifest.mode === "realtime";
        const catalog = catalogOf(build.manifest);
        const profiles: Record<string, ProfileData> = Object.fromEntries(players.map((player) => [player, emptyProfile()]));
        const track = (changes: readonly ProfileChange[] | undefined): string | undefined => {
          for (const change of changes ?? []) {
            const problem = applyChange(profiles[change.player] ?? emptyProfile(), change, catalog);
            if (problem !== undefined) {
              return problem.message;
            }
          }
          return undefined;
        };
        let outcome = await this.#sandbox.run(room, build.build, "createMatch", JSON.stringify({ playerCount: count, seed, ...chosen, profiles }), {
          seed,
          players,
          ...chosen,
          version: 0,
          ...(realtime ? { tick: 0 } : {}),
        });
        let now = Date.UTC(2026, 0, 1);
        for (let move = 0; ; move++) {
          const match = matchOf(outcome);
          if (typeof match === "string") {
            return `${count} players, move ${move}: ${match}`;
          }
          const tracked = track(outcome.ok && outcome.outcome.ok ? outcome.outcome.changes : undefined);
          if (tracked !== undefined) {
            return `${count} players, move ${move}: ${tracked}`;
          }
          if (match.result !== undefined || move >= maxMoves) {
            break;
          }
          if (Date.now() > deadline) {
            return `it takes longer than ${Math.round((this.#options.probeTimeMs ?? 30_000) / 1000)} seconds`;
          }
          if (realtime) {
            const inputs = Object.entries(match.moves)
              .filter(([, moves]) => moves.length > 0 && randomInt(5) === 0)
              .map(([player, moves]) => ({ player, action: sampleMove(moves[randomInt(moves.length)], trialRandom) }));
            now += tickMs;
            const input = `{"match":${JSON.stringify(match)},"step":${JSON.stringify({ inputs, now, dt: tickMs })},"profiles":${JSON.stringify(profiles)}}`;
            outcome = await this.#sandbox.run(room, build.build, "stepMatch", input, {
              seed: match.seed,
              players: match.players,
              ...chosen,
              version: match.version + 1,
              tick: (match.tick ?? 0) + 1,
              inputs: inputs.length,
            });
            continue;
          }
          const options = Object.entries(match.moves).filter(([, moves]) => moves.length > 0);
          const [player, moves] = options[randomInt(options.length)] as [string, unknown[]];
          const action = sampleMove(moves[randomInt(moves.length)], trialRandom);
          now += 1000;
          const input = `{"match":${JSON.stringify(match)},"move":${JSON.stringify({ player, action, now, expectedVersion: match.version })},"profiles":${JSON.stringify(profiles)}}`;
          outcome = await this.#sandbox.run(room, build.build, "applyMove", input, { seed: match.seed, players: match.players, ...chosen, version: match.version + 1 });
        }
      } finally {
        this.#sandbox.forget(room);
      }
    }
    return undefined;
  }

  #rows(): InstalledRow[] {
    return this.#db.prepare("SELECT game_id, build, version, catalog_id, installed_at FROM installed_games ORDER BY game_id").all() as unknown as InstalledRow[];
  }

  #row(gameId: string): InstalledRow | undefined {
    return this.#db.prepare("SELECT game_id, build, version, catalog_id, installed_at FROM installed_games WHERE game_id = ?").get(gameId) as
      | InstalledRow
      | undefined;
  }

  #buildDir(build: string): string {
    const at = build.indexOf("@");
    return join(this.#buildsDir, build.slice(0, at), build.slice(at + 1));
  }
}

interface ProbeMatch {
  seed: string;
  players: string[];
  version: number;
  tick?: number;
  moves: Record<string, unknown[]>;
  result?: unknown;
}

function matchOf(result: HostResult): ProbeMatch | string {
  if (!result.ok) {
    return `Sandbox (${result.failure.kind}): ${result.failure.message}`;
  }
  if (!result.outcome.ok) {
    return `${result.outcome.error.code}: ${result.outcome.error.message}`;
  }
  const match = result.outcome.match as unknown as ProbeMatch;
  if (match.result === undefined && match.tick === undefined && !Object.values(match.moves).some((moves) => moves.length > 0)) {
    return "nobody has a move, but the match is not over";
  }
  return match;
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(path);
    } else if (entry.isFile()) {
      total += (await lstat(path).catch(() => undefined))?.size ?? 0;
    }
  }
  return total;
}

interface StoredBuild {
  manifestText: string;
  code: string;
  clientDir: string;
  files: ClientFile[];
}

async function readBuild(dir: string, hash: string): Promise<StoredBuild | undefined> {
  try {
    const manifestText = await readFile(join(dir, "manifest.json"), "utf8");
    const server = (JSON.parse(manifestText) as { server?: unknown }).server !== false;
    const code = server ? await readFile(join(dir, "game.mjs"), "utf8") : "";
    const client = await inspectClient(dir, "client");
    if (!client.ok) {
      return undefined;
    }
    return contentHash(manifestText, code, client.files) === hash ? { manifestText, code, clientDir: client.dir, files: client.files } : undefined;
  } catch {
    return undefined;
  }
}

async function readManifest(gameDir: string): Promise<Manifest> {
  const text = await readFile(join(gameDir, "manifest.json"), "utf8");
  const checked = validateManifest(JSON.parse(text.replace(/^﻿/, "")));
  if (!checked.ok) {
    throw new Error(`manifest.json is invalid: ${checked.problems.join("; ")}`);
  }
  return checked.manifest;
}

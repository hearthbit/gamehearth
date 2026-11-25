import {
  compareVersions,
  download,
  DownloadError,
  downloadUrlProblem,
  maxCatalogBytes,
  maxPackageBytes,
  parseCatalog,
  satisfies,
  sha256,
  type Catalog,
  type CatalogVersion,
} from "gamehearth";
import { sdkVersion, type Localized } from "@gamehearth/sdk/platform";
import type { DatabaseSync } from "node:sqlite";
import { LibraryError, type GameBuild, type GameLibrary } from "./games";

export const suggestedCatalog = {
  name: "Gamehearth",
  url: "https://raw.githubusercontent.com/hearthbit/gamehearth-catalog/main/catalog.json",
};

export const catalogRefreshMs = 24 * 60 * 60 * 1000;

export type CatalogErrorCode =
  | "bad-url"
  | "catalog-exists"
  | "catalog-unavailable"
  | "catalog-invalid"
  | "unknown-catalog"
  | "unknown-version"
  | "incompatible"
  | "other-catalog"
  | "install-busy"
  | "trust-required";

export class CatalogError extends Error {
  readonly code: CatalogErrorCode;

  constructor(code: CatalogErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type CatalogProblemCode = "catalog-unavailable" | "catalog-invalid";

export interface CatalogProblem {
  code: CatalogProblemCode;
  message: string;
}

export interface CatalogInfo {
  id: number;
  url: string;
  name: string;
  addedAt: number;
  fetchedAt: number;
  checkedAt: number;
  error?: string;
  errorCode?: CatalogProblemCode;
  games: number;
}

export interface OfferedVersion extends CatalogVersion {
  compatible: boolean;
}

export interface CatalogOffer {
  catalogId: number;
  catalogName: string;
  id: string;
  name: Localized;
  description?: Localized;
  repository?: string;
  versions: OfferedVersion[];
  installed?: { version: string; build: string; fromThisCatalog: boolean; local: boolean };
  update?: string;
}

export interface CatalogServiceOptions {
  fetch?: typeof fetch;
  clock?: () => number;
  log?: (message: string) => void;
  catalogTimeoutMs?: number;
  packageTimeoutMs?: number;
}

interface CatalogRow {
  id: number;
  url: string;
  name: string;
  content: string;
  fetched_at: number;
  checked_at: number;
  error: string | null;
  error_code: string | null;
  added_at: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

export class CatalogService {
  readonly #db: DatabaseSync;
  readonly #library: GameLibrary;
  readonly #options: CatalogServiceOptions;
  readonly #refreshing = new Map<number, Promise<CatalogInfo>>();
  #installing = false;

  constructor(db: DatabaseSync, library: GameLibrary, options: CatalogServiceOptions = {}) {
    this.#db = db;
    this.#library = library;
    this.#options = options;
  }

  list(): CatalogInfo[] {
    return this.#rows().map((row) => this.#info(row));
  }

  async add(url: string): Promise<CatalogInfo> {
    const trimmed = url.trim();
    const problem = downloadUrlProblem(trimmed);
    if (problem !== undefined) {
      throw new CatalogError("bad-url", problem);
    }
    if (this.#db.prepare("SELECT 1 FROM catalogs WHERE url = ?").get(trimmed) !== undefined) {
      throw new CatalogError("catalog-exists", "This catalog already exists");
    }
    const catalog = await this.#fetch(trimmed);
    if ("code" in catalog) {
      throw new CatalogError(catalog.code, catalog.message);
    }
    const now = this.#now();
    try {
      const id = Number(
        this.#db
          .prepare("INSERT INTO catalogs (url, name, content, fetched_at, checked_at, error, added_at) VALUES (?, ?, ?, ?, ?, NULL, ?)")
          .run(trimmed, catalog.name, JSON.stringify(catalog), now, now, now).lastInsertRowid,
      );
      return this.#info(this.#row(id));
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message)) {
        throw new CatalogError("catalog-exists", "This catalog already exists");
      }
      throw error;
    }
  }

  refresh(id: number): Promise<CatalogInfo> {
    const running = this.#refreshing.get(id);
    if (running !== undefined) {
      return running;
    }
    const work = this.#refresh(id).finally(() => this.#refreshing.delete(id));
    this.#refreshing.set(id, work);
    return work;
  }

  async refreshDue(): Promise<void> {
    const cutoff = this.#now() - catalogRefreshMs;
    for (const row of this.#rows().filter((candidate) => candidate.checked_at <= cutoff)) {
      try {
        const info = await this.refresh(row.id);
        if (info.error !== undefined) {
          this.#options.log?.(`Catalog ${info.name} (${info.url}) could not be loaded: ${info.error}`);
        }
      } catch (error) {
        this.#options.log?.(`Catalog ${row.url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  requireIdle(): void {
    if (this.#installing) {
      throw new CatalogError("install-busy", "An installation is running; this works again afterwards");
    }
  }

  remove(id: number): { games: string[] } {
    this.#row(id);
    this.requireIdle();
    const games = (this.#db.prepare("SELECT game_id FROM installed_games WHERE catalog_id = ? ORDER BY game_id").all(id) as unknown as { game_id: string }[]).map(
      (row) => row.game_id,
    );
    this.#db.prepare("DELETE FROM catalogs WHERE id = ?").run(id);
    return { games };
  }

  offers(): CatalogOffer[] {
    const installed = new Map(this.#library.installed().map((game) => [game.id, game]));
    const offers: CatalogOffer[] = [];
    for (const row of this.#rows()) {
      const catalog = JSON.parse(row.content) as Catalog;
      for (const game of catalog.games) {
        const versions = game.versions
          .map((version) => ({ ...version, compatible: satisfies(sdkVersion, version.sdk) }))
          .sort((a, b) => compareVersions(b.version, a.version));
        const mine = installed.get(game.id);
        const offer: CatalogOffer = {
          catalogId: row.id,
          catalogName: row.name,
          id: game.id,
          name: game.name,
          ...(game.description === undefined ? {} : { description: game.description }),
          ...(game.repository === undefined ? {} : { repository: game.repository }),
          versions,
        };
        if (mine !== undefined) {
          const fromThisCatalog = mine.source === "catalog" && mine.catalogId === row.id;
          offer.installed = { version: mine.version, build: mine.build, fromThisCatalog, local: mine.source === "local" };
          const newest = versions.find((version) => version.compatible);
          if (fromThisCatalog && newest !== undefined && compareVersions(newest.version, mine.version) > 0) {
            offer.update = newest.version;
          }
        }
        offers.push(offer);
      }
    }
    return offers;
  }

  async install(catalogId: number, gameId: string, version: string, options: { replace?: boolean } = {}): Promise<GameBuild> {
    if (this.#installing) {
      throw new CatalogError("install-busy", "An installation is already running, please wait a moment");
    }
    this.#installing = true;
    try {
      const row = this.#row(catalogId);
      const catalog = JSON.parse(row.content) as Catalog;
      const entry = catalog.games.find((game) => game.id === gameId)?.versions.find((candidate) => candidate.version === version);
      if (entry === undefined) {
        throw new CatalogError("unknown-version", `${gameId} ${version} is not in the catalog ${row.name}`);
      }
      if (new URL(entry.url).protocol !== "https:" && new URL(row.url).protocol === "https:") {
        throw new CatalogError("bad-url", `${entry.url} is not allowed; packages over http only come from a catalog that is itself on localhost`);
      }
      if (!satisfies(sdkVersion, entry.sdk)) {
        throw new CatalogError("incompatible", `${gameId} ${version} needs SDK ${entry.sdk}, this server has ${sdkVersion}`);
      }
      const installed = this.#library.installed().find((game) => game.id === gameId);
      const otherCatalog = installed !== undefined && installed.source === "catalog" && installed.catalogId !== catalogId;
      if (otherCatalog && options.replace !== true) {
        throw new CatalogError("other-catalog", `${gameId} is already installed from another catalog; replace only after confirmation`);
      }
      let archive: Buffer;
      try {
        archive = await download(entry.url, {
          maxBytes: Math.min(entry.size, maxPackageBytes),
          timeoutMs: this.#options.packageTimeoutMs ?? 5 * 60_000,
          ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
        });
      } catch (error) {
        throw new CatalogError("catalog-unavailable", error instanceof DownloadError ? `The package could not be loaded: ${error.message}` : String(error));
      }
      if (archive.length !== entry.size || sha256(archive) !== entry.sha256) {
        throw new LibraryError("package-invalid", "The package does not match the checksum in the catalog; it was not installed");
      }
      return await this.#library.installPackage(archive, { catalogId, expect: { id: gameId, version } });
    } finally {
      this.#installing = false;
    }
  }

  async #refresh(id: number): Promise<CatalogInfo> {
    const row = this.#row(id);
    const catalog = await this.#fetch(row.url);
    const now = this.#now();
    if ("code" in catalog) {
      this.#db.prepare("UPDATE catalogs SET checked_at = ?, error = ?, error_code = ? WHERE id = ?").run(now, catalog.message, catalog.code, id);
    } else {
      this.#db
        .prepare("UPDATE catalogs SET name = ?, content = ?, fetched_at = ?, checked_at = ?, error = NULL, error_code = NULL WHERE id = ?")
        .run(catalog.name, JSON.stringify(catalog), now, now, id);
    }
    return this.#info(this.#row(id));
  }

  async #fetch(url: string): Promise<Catalog | CatalogProblem> {
    let data: Buffer;
    try {
      data = await download(url, {
        maxBytes: maxCatalogBytes,
        timeoutMs: this.#options.catalogTimeoutMs ?? 30_000,
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
      });
    } catch (error) {
      return { code: "catalog-unavailable", message: error instanceof DownloadError ? error.message : `The catalog could not be loaded: ${String(error)}` };
    }
    let text: string;
    try {
      text = decoder.decode(data);
    } catch {
      return { code: "catalog-invalid", message: "The catalog is not valid UTF-8" };
    }
    const checked = parseCatalog(text);
    if (!checked.ok) {
      const shown = checked.problems.slice(0, 5).join("; ");
      return { code: "catalog-invalid", message: `The catalog is invalid: ${shown}${checked.problems.length > 5 ? ` (and ${checked.problems.length - 5} more)` : ""}` };
    }
    return checked.catalog;
  }

  #info(row: CatalogRow): CatalogInfo {
    const games = (JSON.parse(row.content) as Catalog).games.length;
    return {
      id: row.id,
      url: row.url,
      name: row.name,
      addedAt: row.added_at,
      fetchedAt: row.fetched_at,
      checkedAt: row.checked_at,
      ...(row.error === null ? {} : { error: row.error, errorCode: row.error_code === "catalog-invalid" ? "catalog-invalid" : "catalog-unavailable" }),
      games,
    };
  }

  #rows(): CatalogRow[] {
    return this.#db.prepare("SELECT * FROM catalogs ORDER BY name, id").all() as unknown as CatalogRow[];
  }

  #row(id: number): CatalogRow {
    const row = this.#db.prepare("SELECT * FROM catalogs WHERE id = ?").get(id) as CatalogRow | undefined;
    if (row === undefined) {
      throw new CatalogError("unknown-catalog", "This catalog does not exist");
    }
    return row;
  }

  #now(): number {
    return (this.#options.clock ?? Date.now)();
  }
}

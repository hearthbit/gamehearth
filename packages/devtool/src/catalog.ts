import { isLanguage, localize, maxLanguages, validatePlayerCountSpec, type Localized, type PlayerCountSpec } from "@gamehearth/sdk/platform";
import { downloadUrlProblem } from "./download";
import { gameModes, isHttpsUrl, licenseProblems, maxDescriptionLength, roleProblems, type GameMode, type Manifest, type RoleName, type RoleSpec } from "./manifest";
import { maxPackageBytes, sha256, type GamePackage } from "./package";

export const maxCatalogBytes = 1024 * 1024;
export const maxCatalogGames = 500;
export const maxCatalogVersions = 50;
export const maxNameLength = 80;

export interface CatalogVersion {
  version: string;
  sdk: string;
  mode: GameMode;
  players: PlayerCountSpec;
  roles: Partial<Record<RoleName, RoleSpec>>;
  license: { code: string; assets: string };
  size: number;
  url: string;
  sha256: string;
}

export interface CatalogGame {
  id: string;
  name: Localized;
  description?: Localized;
  repository?: string;
  versions: CatalogVersion[];
}

export interface Catalog {
  format: 1;
  name: string;
  games: CatalogGame[];
}

export type CatalogCheck = { ok: true; catalog: Catalog } | { ok: false; problems: string[] };

const catalogKeys = ["format", "name", "games"];
const gameKeys = ["id", "name", "description", "repository", "versions"];
const versionKeys = ["version", "sdk", "mode", "players", "roles", "license", "size", "url", "sha256"];
const versionPattern = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const idPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function parseCatalog(text: string): CatalogCheck {
  if (Buffer.byteLength(text, "utf8") > maxCatalogBytes) {
    return { ok: false, problems: [`The catalog is larger than ${maxCatalogBytes / 1024} KB`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { ok: false, problems: ["The catalog is not valid JSON"] };
  }
  return validateCatalog(raw);
}

export function validateCatalog(raw: unknown): CatalogCheck {
  if (!isRecord(raw)) {
    return { ok: false, problems: ["The catalog must be a JSON object"] };
  }
  const problems: string[] = [];
  unknownKeys(raw, catalogKeys, "", problems);
  if (raw["format"] !== 1) {
    problems.push("format must be 1");
  }
  if (!shortText(raw["name"], maxNameLength)) {
    problems.push(`name must be a text with 1 to ${maxNameLength} characters`);
  }
  const games = raw["games"];
  if (!Array.isArray(games)) {
    problems.push("games must be a list");
  } else if (games.length > maxCatalogGames) {
    problems.push(`A catalog has at most ${maxCatalogGames} games`);
  } else {
    const ids = new Set<string>();
    games.forEach((game, index) => {
      const where = `games[${index}]`;
      if (!isRecord(game)) {
        problems.push(`${where} must be an object`);
        return;
      }
      gameProblems(game, isRecord(game) && typeof game["id"] === "string" ? `${where} (${game["id"]})` : where, problems);
      if (typeof game["id"] === "string") {
        if (ids.has(game["id"])) {
          problems.push(`${where}: the game ${game["id"]} is listed more than once in the catalog`);
        }
        ids.add(game["id"]);
      }
    });
  }
  return problems.length === 0 ? { ok: true, catalog: raw as unknown as Catalog } : { ok: false, problems };
}

function gameProblems(game: Record<string, unknown>, where: string, problems: string[]): void {
  unknownKeys(game, gameKeys, `${where}.`, problems);
  if (typeof game["id"] !== "string" || !idPattern.test(game["id"])) {
    problems.push(`${where}.id must consist of lowercase letters, digits and hyphens`);
  }
  const nameProblem = localizedTextProblem(game["name"], `${where}.name`, maxNameLength);
  if (nameProblem !== undefined) {
    problems.push(nameProblem);
  }
  const descriptionProblem = game["description"] === undefined ? undefined : localizedTextProblem(game["description"], `${where}.description`, maxDescriptionLength);
  if (descriptionProblem !== undefined) {
    problems.push(descriptionProblem);
  }
  if (game["repository"] !== undefined && (typeof game["repository"] !== "string" || !isHttpsUrl(game["repository"]))) {
    problems.push(`${where}.repository must be an https URL`);
  }
  const versions = game["versions"];
  if (!Array.isArray(versions) || versions.length === 0) {
    problems.push(`${where}.versions must be a non-empty list`);
    return;
  }
  if (versions.length > maxCatalogVersions) {
    problems.push(`${where}.versions has more than ${maxCatalogVersions} entries`);
    return;
  }
  const seen = new Set<string>();
  versions.forEach((version, index) => {
    const at = `${where}.versions[${index}]`;
    if (!isRecord(version)) {
      problems.push(`${at} must be an object`);
      return;
    }
    versionProblems(version, at, problems);
    if (typeof version["version"] === "string") {
      if (seen.has(version["version"])) {
        problems.push(`${at}: the version ${version["version"]} is listed more than once in the catalog`);
      }
      seen.add(version["version"]);
    }
  });
}

function versionProblems(version: Record<string, unknown>, at: string, problems: string[]): void {
  unknownKeys(version, versionKeys, `${at}.`, problems);
  if (typeof version["version"] !== "string" || !versionPattern.test(version["version"])) {
    problems.push(`${at}.version must be a version number like "1.2.0"`);
  }
  if (typeof version["sdk"] !== "string" || !/^\^?\d+\.\d+\.\d+$/.test(version["sdk"])) {
    problems.push(`${at}.sdk must be an SDK version like "^0.1.0"`);
  }
  if (typeof version["mode"] !== "string" || !(gameModes as readonly string[]).includes(version["mode"])) {
    problems.push(`${at}.mode must be one of ${gameModes.join(", ")}`);
  }
  for (const problem of validatePlayerCountSpec(version["players"])) {
    problems.push(`${at}: ${problem}`);
  }
  for (const problem of roleProblems(version["roles"])) {
    problems.push(`${at}: ${problem}`);
  }
  for (const problem of licenseProblems(version["license"])) {
    problems.push(`${at}: ${problem}`);
  }
  const size = version["size"];
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > maxPackageBytes) {
    problems.push(`${at}.size must be the size of the package in bytes (at most ${maxPackageBytes})`);
  }
  const url = version["url"];
  const urlProblem = typeof url === "string" ? downloadUrlProblem(url) : "url is missing";
  if (urlProblem !== undefined) {
    problems.push(`${at}.url: ${urlProblem}`);
  }
  if (typeof version["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(version["sha256"])) {
    problems.push(`${at}.sha256 must be the SHA-256 checksum of the package (64 hex characters, lowercase)`);
  }
}

export function compareVersions(a: string, b: string): number {
  const split = (value: string) => {
    const [core = "", pre] = value.split(/-(.*)/s, 2);
    return { numbers: core.split(".").map(Number), pre };
  };
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < 3; index++) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  if (left.pre === right.pre) {
    return 0;
  }
  if (left.pre === undefined) {
    return 1;
  }
  if (right.pre === undefined) {
    return -1;
  }
  return left.pre < right.pre ? -1 : 1;
}

export function versionEntry(pkg: GamePackage, archive: Buffer, url: string): CatalogVersion {
  const manifest: Manifest = pkg.manifest;
  return {
    version: manifest.version,
    sdk: manifest.sdk,
    mode: manifest.mode,
    players: manifest.players,
    roles: catalogRoles(manifest.roles),
    license: manifest.license,
    size: archive.length,
    url,
    sha256: sha256(archive),
  };
}

function catalogRoles(roles: Manifest["roles"]): Manifest["roles"] {
  return Object.fromEntries(
    Object.entries(roles).map(([name, role]) => {
      const { optional: _optional, ...older } = role;
      return [name, older];
    }),
  );
}

export function addToCatalog(catalog: Catalog, pkg: GamePackage, entry: CatalogVersion, options: { replace?: boolean } = {}): Catalog {
  const manifest = pkg.manifest;
  const games = catalog.games.map((game) => ({ ...game, versions: [...game.versions] }));
  const found = games.find((candidate) => candidate.id === manifest.id);
  const defaultLanguage = manifest.languages?.[0];
  const game: CatalogGame = found ?? { id: manifest.id, name: localize(manifest.name, defaultLanguage), versions: [] };
  if (found === undefined) {
    games.push(game);
  }
  const existing = game.versions.findIndex((version) => version.version === entry.version);
  if (existing >= 0) {
    if (game.versions[existing]?.sha256 === entry.sha256 && game.versions[existing]?.url === entry.url) {
      return catalog;
    }
    if (options.replace !== true) {
      throw new Error(`The version ${entry.version} of ${manifest.id} is already in the catalog with a different checksum or URL. Pick a new version number or replace it with --replace.`);
    }
    game.versions.splice(existing, 1);
  }
  game.versions.push(entry);
  game.versions.sort((a, b) => compareVersions(b.version, a.version));
  if (game.versions[0] === entry) {
    game.name = localize(manifest.name, defaultLanguage);
    delete game.description;
    delete game.repository;
    if (manifest.description !== undefined) {
      game.description = localize(manifest.description, defaultLanguage);
    }
    if (manifest.repository !== undefined) {
      game.repository = manifest.repository;
    }
  }
  const ordered: CatalogGame[] = games
    .map((item) => ({
      id: item.id,
      name: item.name,
      ...(item.description === undefined ? {} : { description: item.description }),
      ...(item.repository === undefined ? {} : { repository: item.repository }),
      versions: item.versions,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { format: 1, name: catalog.name, games: ordered };
}

export function formatCatalog(catalog: Catalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

function unknownKeys(record: Record<string, unknown>, allowed: readonly string[], prefix: string, problems: string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      problems.push(`${prefix}${key} is unknown, allowed are ${allowed.join(", ")}`);
    }
  }
}

function shortText(value: unknown, max: number): boolean {
  return typeof value === "string" && value.trim() !== "" && value.length <= max;
}

function localizedTextProblem(value: unknown, where: string, max: number): string | undefined {
  const expected = `${where} must be a text with 1 to ${max} characters, or an object with one such text per language like { "en": "Card Duel", "de": "Kartenduell" }`;
  if (typeof value === "string") {
    return shortText(value, max) ? undefined : expected;
  }
  if (!isRecord(value)) {
    return expected;
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > maxLanguages) {
    return `${where} must have 1 to ${maxLanguages} languages`;
  }
  for (const [language, text] of entries) {
    if (!isLanguage(language)) {
      return `${where}: ${JSON.stringify(language)} is not a language code such as "en", "de" or "pt-BR"`;
    }
    if (!shortText(text, max)) {
      return `${where}.${language} must be a text with 1 to ${max} characters`;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

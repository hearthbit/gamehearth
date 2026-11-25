import {
  localizedProblem,
  maxSoloStats,
  sdkVersion,
  validateLanguages,
  validateCatalogSpec,
  validateOptionsSpec,
  validatePlayerCountSpec,
  type CatalogEntrySpec,
  type CatalogSpec,
  type Localized,
  type OptionsSpec,
  type PlayerCountSpec,
  type StatSpec,
} from "@gamehearth/sdk/platform";
import { clientPathProblem } from "./client-files";

export const codeLicenses = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Zlib",
  "Unlicense",
  "MPL-2.0",
  "EUPL-1.2",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
] as const;

export const assetLicenses = ["CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0"] as const;
export const gameModes = ["single", "turn-based", "realtime"] as const;
export const roleNames = ["player", "screen", "controller"] as const;
export const inputKinds = ["touch", "keyboard", "mouse", "gamepad"] as const;
export const screenClasses = ["small", "medium", "large"] as const;
export const maxStats = maxSoloStats;

export const awayModes = ["pause", "play-on"] as const;

export type GameMode = (typeof gameModes)[number];
export type AwayMode = (typeof awayModes)[number];
export type RoleName = (typeof roleNames)[number];
export type InputKind = (typeof inputKinds)[number];
export type ScreenClass = (typeof screenClasses)[number];

export type { StatSpec };

export interface RoleSpec {
  inputs: InputKind[];
  screen: ScreenClass;
  optional?: boolean;
}

export interface Manifest {
  id: string;
  name: Localized;
  version: string;
  sdk: string;
  license: { code: string; assets: string };
  mode: GameMode;
  away?: AwayMode;
  players: PlayerCountSpec;
  server: boolean;
  client: string;
  roles: Partial<Record<RoleName, RoleSpec>>;
  description?: Localized;
  repository?: string;
  languages?: string[];
  cover?: string;
  items?: Record<string, CatalogEntrySpec>;
  stats?: Record<string, StatSpec>;
  flags?: Record<string, CatalogEntrySpec>;
  options?: OptionsSpec;
}

export function catalogOf(manifest: Pick<Manifest, "items" | "stats" | "flags">): CatalogSpec {
  return {
    ...(manifest.items === undefined ? {} : { items: manifest.items }),
    ...(manifest.stats === undefined ? {} : { stats: manifest.stats }),
    ...(manifest.flags === undefined ? {} : { flags: manifest.flags }),
  };
}

export type ManifestCheck = { ok: true; manifest: Manifest } | { ok: false; problems: string[] };

const manifestKeys = [
  "id",
  "name",
  "version",
  "sdk",
  "license",
  "mode",
  "away",
  "players",
  "server",
  "client",
  "roles",
  "description",
  "repository",
  "languages",
  "cover",
  "options",
  "items",
  "stats",
  "flags",
];
export const maxDescriptionLength = 200;
export const maxNameLength = 80;
export const coverExtensions = [".png", ".webp", ".svg"] as const;

export function validateManifest(raw: unknown, installedSdk: string = sdkVersion): ManifestCheck {
  if (!isRecord(raw)) {
    return { ok: false, problems: ["manifest.json must be a JSON object"] };
  }
  const problems: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!manifestKeys.includes(key)) {
      problems.push(`${key} is unknown, allowed are ${manifestKeys.join(", ")}`);
    }
  }

  if (typeof raw["id"] !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(raw["id"])) {
    problems.push('id must consist of lowercase letters, digits and hyphens, e.g. "mau-mau"');
  }
  const languagesRaw = raw["languages"];
  const languageProblems = languagesRaw === undefined ? [] : validateLanguages(languagesRaw);
  problems.push(...languageProblems);
  const languages = languagesRaw === undefined ? undefined : languageProblems.length === 0 ? (languagesRaw as string[]) : null;
  const nameProblem = localizedProblem(raw["name"], "name", maxNameLength, languages);
  if (nameProblem !== undefined) {
    problems.push(nameProblem);
  }
  if (typeof raw["version"] !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(raw["version"])) {
    problems.push('version must be a version number like "1.2.0"');
  }
  const sdk = raw["sdk"];
  if (typeof sdk !== "string" || !/^\^?\d+\.\d+\.\d+$/.test(sdk)) {
    problems.push(`sdk must state the required SDK version, e.g. "^${installedSdk}"`);
  } else if (!satisfies(installedSdk, sdk)) {
    problems.push(`sdk requires ${sdk}, but the installed SDK is ${installedSdk}`);
  }
  problems.push(...licenseProblems(raw["license"]));

  const mode = raw["mode"];
  if (!includes(gameModes, mode)) {
    problems.push(`mode must be one of ${gameModes.join(", ")}`);
  }
  const away = raw["away"];
  if (away !== undefined) {
    if (!includes(awayModes, away)) {
      problems.push('away must be "play-on" (the match goes on without seats that are away) or "pause" (the default)');
    } else if (mode !== "realtime") {
      problems.push('away exists only for mode "realtime"; turn-based matches never pause, and single-player games have no seats');
    }
  }
  for (const problem of validatePlayerCountSpec(raw["players"])) {
    problems.push(problem);
  }
  if (typeof raw["server"] !== "boolean") {
    problems.push("server must be true (the game has a reducer) or false (runs only in the browser)");
  }
  const clientProblem = clientPathProblem(raw["client"]);
  if (clientProblem !== undefined) {
    problems.push(clientProblem);
  }
  problems.push(...roleProblems(raw["roles"]));
  const description = raw["description"];
  const descriptionProblem = description === undefined ? undefined : localizedProblem(description, "description", maxDescriptionLength, languages);
  if (descriptionProblem !== undefined) {
    problems.push(descriptionProblem);
  }
  const coverProblem = raw["cover"] === undefined ? undefined : coverPathProblem(raw["cover"]);
  if (coverProblem !== undefined) {
    problems.push(coverProblem);
  }
  const repository = raw["repository"];
  if (repository !== undefined && (typeof repository !== "string" || !isHttpsUrl(repository))) {
    problems.push('repository must be the https URL of the source code, e.g. "https://github.com/name/game"');
  }

  const solo = mode === "single" && raw["server"] === false;
  problems.push(...validateCatalogSpec({ items: raw["items"], stats: raw["stats"], flags: raw["flags"] }, solo, languages));
  if (raw["options"] !== undefined) {
    problems.push(...validateOptionsSpec(raw["options"], languages));
  }

  if (problems.length === 0) {
    const players = raw["players"] as PlayerCountSpec;
    if (solo && (raw["items"] !== undefined || raw["flags"] !== undefined)) {
      problems.push('items and flags only exist for games with a reducer; single-player games without a reducer (mode "single", server false) keep inventory and unlocks in their save and have only best scores under stats');
    }
    const profiles = raw["items"] !== undefined || raw["stats"] !== undefined || raw["flags"] !== undefined;
    if (!solo && profiles && below(String(raw["sdk"]), minimumProfileSdk)) {
      problems.push(`with items, stats or flags, sdk must be at least "^${minimumProfileSdk}"; older servers do not know profiles`);
    }
    if (solo && below(String(raw["sdk"]), minimumSoloSdk)) {
      problems.push(`with mode "single" without a reducer, sdk must be at least "^${minimumSoloSdk}"; older servers do not know connectSolo`);
    }
    if (solo && Object.keys(raw["roles"] as Record<string, unknown>).some((role) => role !== "player")) {
      problems.push('with mode "single" without a reducer there is only the role player, no TV and no controllers');
    }
    if (mode === "single" && (players.min !== 1 || players.max !== 1)) {
      problems.push('with mode "single", players must be { "min": 1, "max": 1 }');
    }
    if (mode !== "single" && raw["server"] === false) {
      problems.push(`with mode "${String(mode)}", server must be true; multiplayer logic runs on the server`);
    }
    if (raw["options"] !== undefined && raw["server"] === false) {
      problems.push("options only exist for games with a reducer (server true); single-player games without a reducer build their own menu");
    }
    if (raw["options"] !== undefined && below(String(raw["sdk"]), minimumOptionsSdk)) {
      problems.push(`with options, sdk must be at least "^${minimumOptionsSdk}"; older servers do not know options`);
    }
    if ((raw["languages"] !== undefined || raw["cover"] !== undefined) && below(String(raw["sdk"]), minimumLanguagesSdk)) {
      problems.push(`with languages or cover, sdk must be at least "^${minimumLanguagesSdk}"; older servers do not know them`);
    }
    if (mode === "realtime" && below(String(raw["sdk"]), minimumRealtimeSdk)) {
      problems.push(`with mode "realtime", sdk must be at least "^${minimumRealtimeSdk}"; older servers do not know tick`);
    }
    if (raw["away"] !== undefined && below(String(raw["sdk"]), minimumAwaySdk)) {
      problems.push(`with away, sdk must be at least "^${minimumAwaySdk}"; older servers do not know it`);
    }
    const screen = (raw["roles"] as Record<string, Record<string, unknown>>)["screen"];
    if (screen !== undefined && "optional" in screen && below(String(raw["sdk"]), minimumOptionalScreenSdk)) {
      problems.push(`with roles.screen.optional, sdk must be at least "^${minimumOptionalScreenSdk}"; older servers do not know an optional TV`);
    }
  }

  return problems.length === 0 ? { ok: true, manifest: raw as unknown as Manifest } : { ok: false, problems };
}

export function licenseProblems(license: unknown): string[] {
  if (!isRecord(license)) {
    return ['license must be an object like { "code": "MIT", "assets": "CC0-1.0" }'];
  }
  const problems: string[] = [];
  for (const key of Object.keys(license)) {
    if (key !== "code" && key !== "assets") {
      problems.push(`license.${key} is unknown, allowed are code and assets`);
    }
  }
  if (!includes(codeLicenses, license["code"])) {
    problems.push(`license.code must be an open source license: ${codeLicenses.join(", ")}`);
  }
  if (!includes(assetLicenses, license["assets"])) {
    problems.push(`license.assets must be one of these licenses: ${assetLicenses.join(", ")}`);
  }
  return problems;
}

export function roleProblems(roles: unknown): string[] {
  if (!isRecord(roles)) {
    return ['roles must be an object like { "player": { "inputs": ["touch"], "screen": "small" } }'];
  }
  const problems: string[] = [];
  const names = Object.keys(roles);
  if (!names.includes("player") && !names.includes("controller")) {
    problems.push("roles needs at least player or controller, otherwise nobody can play");
  }
  for (const name of names) {
    if (!includes(roleNames, name)) {
      problems.push(`roles.${name} is unknown, allowed are ${roleNames.join(", ")}`);
      continue;
    }
    const role = roles[name];
    if (!isRecord(role)) {
      problems.push(`roles.${name} must be an object with inputs and screen`);
      continue;
    }
    for (const key of Object.keys(role)) {
      if (key === "optional" && name !== "screen") {
        problems.push(`roles.${name}.optional is not allowed; only the TV (roles.screen) can be optional`);
      } else if (key !== "inputs" && key !== "screen" && key !== "optional") {
        problems.push(`roles.${name}.${key} is unknown, allowed are ${name === "screen" ? "inputs, screen and optional" : "inputs and screen"}`);
      }
    }
    if (name === "screen" && role["optional"] !== undefined) {
      if (typeof role["optional"] !== "boolean") {
        problems.push("roles.screen.optional must be true or false");
      } else if (role["optional"] && !names.includes("player")) {
        problems.push("roles.screen.optional needs the role player; with controllers only, nobody would see the game without a TV");
      }
    }
    const inputs = role["inputs"];
    if (!Array.isArray(inputs) || !inputs.every((input) => includes(inputKinds, input))) {
      problems.push(`roles.${name}.inputs must be a list of ${inputKinds.join(", ")}`);
    } else if (inputs.length === 0 && name !== "screen") {
      problems.push(`roles.${name}.inputs must not be empty; only a screen can do without input`);
    }
    if (!includes(screenClasses, role["screen"])) {
      problems.push(`roles.${name}.screen must be one of ${screenClasses.join(", ")}`);
    }
  }
  return problems;
}

export const minimumRealtimeSdk = "0.1.1";
export const minimumSoloSdk = "0.1.2";
export const minimumOptionsSdk = "0.1.3";
export const minimumProfileSdk = "0.1.4";
export const minimumLanguagesSdk = "0.1.6";
export const minimumPlaceholderSdk = "0.1.7";
export const minimumOptionalScreenSdk = "0.1.7";
export const minimumAwaySdk = "0.1.8";

export function coverPathProblem(raw: unknown): string | undefined {
  const example = 'cover must be the path of an image inside the client folder, e.g. "cover.svg" (PNG, WebP or SVG, aspect ratio 4:3, at most 256 KB)';
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > 200) {
    return example;
  }
  const segments = raw.split("/");
  if (raw.startsWith("/") || raw.includes("\\") || /^[A-Za-z]:/.test(raw) || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `${example}; got ${JSON.stringify(raw)}`;
  }
  if (!coverExtensions.some((extension) => raw.toLowerCase().endsWith(extension))) {
    return `cover must end in ${coverExtensions.join(", ")}; got ${JSON.stringify(raw)}`;
  }
  return undefined;
}

export function untranslatedTexts(manifest: Manifest): string[] {
  if (manifest.languages === undefined || manifest.languages.length < 2) {
    return [];
  }
  const found: string[] = [];
  const visit = (value: Localized | undefined, where: string) => {
    if (typeof value === "string") {
      found.push(where);
    }
  };
  visit(manifest.description, "description");
  for (const [name, option] of Object.entries(manifest.options ?? {})) {
    visit(option.label, `options.${name}.label`);
    if (option.type === "choice") {
      option.choices.forEach((choice, index) => visit(choice.label, `options.${name}.choices[${index}].label`));
    }
  }
  for (const section of ["items", "stats", "flags"] as const) {
    for (const [name, entry] of Object.entries(manifest[section] ?? {})) {
      visit(entry.label, `${section}.${name}.label`);
    }
  }
  return found;
}

export function sdkBelow(range: string, version: string): boolean {
  return below(range, version);
}

function below(range: string, version: string): boolean {
  const parse = (text: string) => text.replace(/^\^/, "").split(".").map(Number);
  const [a = 0, b = 0, c = 0] = parse(range);
  const [x = 0, y = 0, z = 0] = parse(version);
  return a !== x ? a < x : b !== y ? b < y : c < z;
}

export function isHttpsUrl(value: string): boolean {
  if (value.length > 300) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname !== "";
  } catch {
    return false;
  }
}

export function satisfies(version: string, range: string): boolean {
  const parse = (text: string) => text.replace(/^\^/, "").split(".").map(Number) as [number, number, number];
  const [major, minor, patch] = parse(version);
  const [wantMajor, wantMinor, wantPatch] = parse(range);
  if (!range.startsWith("^")) {
    return major === wantMajor && minor === wantMinor && patch === wantPatch;
  }
  if (major !== wantMajor) return false;
  if (wantMajor === 0 && minor !== wantMinor) return false;
  if (minor !== wantMinor) return minor > wantMinor;
  return patch >= wantPatch;
}

function includes<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

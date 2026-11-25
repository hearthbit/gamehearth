import { localizedProblem, type Localized } from "./i18n";
import type { PlayerId } from "./state";

export const profileIdPattern = /^[a-z][a-z0-9-]{0,39}$/;
export const maxProfileValue = 1e15;
export const maxCatalogItems = 1000;
export const maxCatalogStats = 200;
export const maxCatalogFlags = 200;
export const maxSoloStats = 10;
export const maxFlagLength = 200;
export const maxCatalogLabelLength = 40;
export const maxChangesPerCall = 1000;

export type StatDirection = "higher" | "lower";
export type StatFormat = "number" | "time";

export interface CatalogEntrySpec {
  label: Localized;
  deprecated?: boolean;
}

export interface StatSpec extends CatalogEntrySpec {
  better?: StatDirection;
  format?: StatFormat;
}

export interface CatalogSpec {
  items?: Record<string, CatalogEntrySpec>;
  stats?: Record<string, StatSpec>;
  flags?: Record<string, CatalogEntrySpec>;
}

export interface CatalogInput {
  readonly items?: Readonly<Record<string, { readonly label: Localized; readonly deprecated?: boolean }>>;
  readonly stats?: Readonly<Record<string, { readonly label: Localized; readonly better?: string; readonly format?: string; readonly deprecated?: boolean }>>;
  readonly flags?: Readonly<Record<string, { readonly label: Localized; readonly deprecated?: boolean }>>;
}

export type CatalogSection = "items" | "stats" | "flags";

export const catalogSections: readonly CatalogSection[] = ["items", "stats", "flags"];

export interface CatalogIds {
  items: string;
  stats: string;
  ranked: string;
  flags: string;
}

export interface AnyCatalog {
  items: string;
  stats: string;
  ranked: string;
  flags: string;
}

type KeysOf<T> = Extract<keyof T, string>;
type RankedKeys<T> = { [K in KeysOf<T>]: T[K] extends { better: unknown } ? K : never }[KeysOf<T>];

export type CatalogOf<M> = {
  items: M extends { items: infer I } ? KeysOf<I> : never;
  stats: M extends { stats: infer S } ? KeysOf<S> : never;
  ranked: M extends { stats: infer S } ? RankedKeys<S> : never;
  flags: M extends { flags: infer F } ? KeysOf<F> : never;
};

export interface Profile<C extends CatalogIds = AnyCatalog> {
  readonly items: { readonly [K in C["items"]]?: number };
  readonly stats: { readonly [K in C["stats"]]?: number };
  readonly flags: { readonly [K in C["flags"]]?: string | true };
}

export type Profiles<C extends CatalogIds = AnyCatalog> = Readonly<Record<PlayerId, Profile<C>>>;

export interface ProfileData {
  items: Record<string, number>;
  stats: Record<string, number>;
  flags: Record<string, string | true>;
}

export interface ProfileWriter<C extends CatalogIds = AnyCatalog> {
  add(player: PlayerId, item: C["items"], count: number): void;
  use(player: PlayerId, item: C["items"], count: number): void;
  stat(player: PlayerId, stat: C["stats"], amount: number): void;
  record(player: PlayerId, stat: C["ranked"], value: number): void;
  flag(player: PlayerId, flag: C["flags"], value: string | boolean): void;
}

export type TickProfileWriter<C extends CatalogIds = AnyCatalog> = Omit<ProfileWriter<C>, "use">;

export type ProfileOperation = "add" | "use" | "stat" | "record" | "flag";

export const profileOperations: readonly ProfileOperation[] = ["add", "use", "stat", "record", "flag"];

export interface ProfileChange {
  player: PlayerId;
  op: ProfileOperation;
  id: string;
  value: number | string | boolean;
}

export type ChangeProblem = { kind: "missing"; message: string; have: number } | { kind: "invalid"; message: string };

export function emptyProfile(): ProfileData {
  return { items: bare(), stats: bare(), flags: bare() };
}

export function validateCatalogSpec(raw: { items?: unknown; stats?: unknown; flags?: unknown }, solo: boolean, languages?: readonly string[] | null): string[] {
  const problems: string[] = [];
  if (raw.items !== undefined) {
    problems.push(...sectionProblems("items", raw.items, maxCatalogItems, ["label", "deprecated"], solo, languages));
  }
  if (raw.stats !== undefined) {
    problems.push(...sectionProblems("stats", raw.stats, solo ? maxSoloStats : maxCatalogStats, ["label", "better", "format", "deprecated"], solo, languages));
  }
  if (raw.flags !== undefined) {
    problems.push(...sectionProblems("flags", raw.flags, maxCatalogFlags, ["label", "deprecated"], solo, languages));
  }
  return problems;
}

const examples: Record<CatalogSection, string> = {
  items: '{ "bait-worm": { "label": "Worm" } }',
  stats: '{ "wins": { "label": "Wins", "better": "higher" } }',
  flags: '{ "book-pike": { "label": "Pike in the collection book" } }',
};

function sectionProblems(
  section: CatalogSection,
  value: unknown,
  limit: number,
  allowed: readonly string[],
  solo: boolean,
  languages: readonly string[] | undefined | null,
): string[] {
  if (!isRecord(value)) {
    return [`${section} must be an object like ${examples[section]}`];
  }
  const problems: string[] = [];
  const names = Object.keys(value);
  if (names.length === 0) {
    problems.push(`${section} must not be empty; without entries, leave the field out`);
  }
  if (names.length > limit) {
    problems.push(`${section} has ${names.length} entries, at most ${limit} are allowed`);
  }
  for (const name of names) {
    if (name in Object.prototype) {
      problems.push(`${section}.${name}: this name is already taken in JavaScript, pick another one`);
      continue;
    }
    if (!profileIdPattern.test(name)) {
      problems.push(
        `${section}.${name}: names consist of lowercase letters, digits and -, start with a letter and have at most 40 characters, e.g. "${section === "items" ? "healing-potion" : section === "stats" ? "wins" : "hero-mage"}"`,
      );
      continue;
    }
    const entry = value[name];
    const where = `${section}.${name}`;
    if (!isRecord(entry)) {
      problems.push(`${where} must be an object with label`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!allowed.includes(key)) {
        problems.push(`${where}.${key} is unknown, allowed are ${allowed.join(", ")}`);
      }
    }
    const labelProblem = localizedProblem(entry["label"], `${where}.label`, maxCatalogLabelLength, languages);
    if (labelProblem !== undefined) {
      problems.push(labelProblem);
    }
    if (entry["deprecated"] !== undefined && typeof entry["deprecated"] !== "boolean") {
      problems.push(`${where}.deprecated must be true or false`);
    }
    if (section === "stats") {
      const better = entry["better"];
      if (better === undefined && solo) {
        problems.push(`${where}.better is missing: best scores of a single-player game without a reducer need "higher" (bigger is better) or "lower" (smaller is better)`);
      } else if (better !== undefined && better !== "higher" && better !== "lower") {
        problems.push(`${where}.better must be "higher" (bigger is better) or "lower" (smaller is better); without better the stat is a counter without a leaderboard`);
      }
      const format = entry["format"];
      if (format !== undefined && format !== "number" && format !== "time") {
        problems.push(`${where}.format must be "number" or "time" (milliseconds)`);
      }
    }
  }
  return problems;
}

export function catalogIds(catalog: CatalogInput | undefined): Record<CatalogSection, string[]> {
  return {
    items: Object.keys(catalog?.items ?? {}).sort(),
    stats: Object.keys(catalog?.stats ?? {}).sort(),
    flags: Object.keys(catalog?.flags ?? {}).sort(),
  };
}

export function hasCatalog(catalog: CatalogInput | undefined): boolean {
  return catalogSections.some((section) => Object.keys(catalog?.[section] ?? {}).length > 0);
}

export function profileProblem(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return "a profile must be an object with items, stats and flags";
  }
  for (const key of Object.keys(raw)) {
    if (key !== "items" && key !== "stats" && key !== "flags") {
      return `a profile has the unknown field ${key}`;
    }
  }
  const items = raw["items"] ?? {};
  const stats = raw["stats"] ?? {};
  const flags = raw["flags"] ?? {};
  if (!isRecord(items) || !isRecord(stats) || !isRecord(flags)) {
    return "items, stats and flags of a profile must be objects";
  }
  if (Object.keys(items).length > maxCatalogItems || Object.keys(stats).length > maxCatalogStats || Object.keys(flags).length > maxCatalogFlags) {
    return "the profile has more entries than allowed";
  }
  for (const [id, count] of Object.entries(items)) {
    if (!profileIdPattern.test(id) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > maxProfileValue) {
      return `items.${id.slice(0, 40)} must be an integer of at least 1`;
    }
  }
  for (const [id, value] of Object.entries(stats)) {
    if (!profileIdPattern.test(id) || typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > maxProfileValue) {
      return `stats.${id.slice(0, 40)} must be a finite number`;
    }
  }
  for (const [id, value] of Object.entries(flags)) {
    if (!profileIdPattern.test(id) || !(value === true || (typeof value === "string" && value.length >= 1 && value.length <= maxFlagLength))) {
      return `flags.${id.slice(0, 40)} must be true or a text with 1 to ${maxFlagLength} characters`;
    }
  }
  return undefined;
}

export function readProfile(raw: unknown): ProfileData {
  const problem = profileProblem(raw);
  if (problem !== undefined) {
    throw new TypeError(problem);
  }
  const value = raw as Partial<ProfileData>;
  return {
    items: Object.assign(bare<number>(), value.items ?? {}),
    stats: Object.assign(bare<number>(), value.stats ?? {}),
    flags: Object.assign(bare<string | true>(), value.flags ?? {}),
  };
}

export function cloneProfile(profile: ProfileData): ProfileData {
  return {
    items: Object.assign(bare<number>(), profile.items),
    stats: Object.assign(bare<number>(), profile.stats),
    flags: Object.assign(bare<string | true>(), profile.flags),
  };
}

export function profileJson(profile: ProfileData): string {
  const sorted = (record: Record<string, unknown>) => Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  return JSON.stringify({ items: sorted(profile.items), stats: sorted(profile.stats), flags: sorted(profile.flags) });
}

export function isEmptyProfile(profile: ProfileData): boolean {
  return Object.keys(profile.items).length === 0 && Object.keys(profile.stats).length === 0 && Object.keys(profile.flags).length === 0;
}

export function applyChange(profile: ProfileData, change: Omit<ProfileChange, "player">, catalog: CatalogInput | undefined): ChangeProblem | undefined {
  const { op, id, value } = change;
  const call = `ctx.profile.${op}`;
  if (typeof id !== "string") {
    return invalid(`${call} needs a name from manifest.json as its second argument, got ${describeValue(id)}`);
  }
  if (op === "add" || op === "use") {
    if (!known(catalog?.items, id)) {
      return invalid(`${call}: The item ${JSON.stringify(id)} is not listed under items in manifest.json${suggest(catalog?.items, id)}`);
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      return invalid(`${call}(…, ${JSON.stringify(id)}, n) needs an integer n of at least 1, got ${describeValue(value)}${op === "add" ? "; to consume, call use" : ""}`);
    }
    const have = profile.items[id] ?? 0;
    if (op === "use") {
      if (have < value) {
        return { kind: "missing", have, message: `Missing ${JSON.stringify(id)}: needed ${value}, available ${have}` };
      }
      if (have === value) {
        delete profile.items[id];
      } else {
        profile.items[id] = have - value;
      }
      return undefined;
    }
    if (have + value > maxProfileValue) {
      return invalid(`${call}: ${JSON.stringify(id)} would then have more than ${maxProfileValue} pieces`);
    }
    if (have === 0 && Object.keys(profile.items).length >= maxCatalogItems) {
      return invalid(`${call}: A profile has at most ${maxCatalogItems} different items`);
    }
    profile.items[id] = have + value;
    return undefined;
  }
  if (op === "stat" || op === "record") {
    const spec = known(catalog?.stats, id) ? catalog?.stats?.[id] : undefined;
    if (spec === undefined) {
      return invalid(`${call}: The stat ${JSON.stringify(id)} is not listed under stats in manifest.json${suggest(catalog?.stats, id)}`);
    }
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > maxProfileValue) {
      return invalid(`${call}(…, ${JSON.stringify(id)}, value) needs a finite number between -${maxProfileValue} and ${maxProfileValue}, got ${describeValue(value)}`);
    }
    const current = Object.hasOwn(profile.stats, id) ? (profile.stats[id] as number) : undefined;
    if (op === "record") {
      if (spec.better === undefined) {
        return invalid(
          `${call}: The stat ${JSON.stringify(id)} has no better in manifest.json and is therefore a counter; record works only on stats with "better": "higher" or "lower", counters are changed with ctx.profile.stat`,
        );
      }
      if (current === undefined || (spec.better === "higher" ? value > current : value < current)) {
        profile.stats[id] = value;
      }
      return undefined;
    }
    const next = (current ?? 0) + value;
    if (Math.abs(next) > maxProfileValue) {
      return invalid(`${call}: ${JSON.stringify(id)} would then be outside ±${maxProfileValue}`);
    }
    profile.stats[id] = next;
    return undefined;
  }
  if (op === "flag") {
    if (!known(catalog?.flags, id)) {
      return invalid(`${call}: The flag ${JSON.stringify(id)} is not listed under flags in manifest.json${suggest(catalog?.flags, id)}`);
    }
    if (value === false) {
      delete profile.flags[id];
      return undefined;
    }
    if (value !== true && (typeof value !== "string" || value.length < 1 || value.length > maxFlagLength)) {
      return invalid(`${call}(…, ${JSON.stringify(id)}, value) needs true, false (deletes the flag) or a text with 1 to ${maxFlagLength} characters, got ${describeValue(value)}`);
    }
    profile.flags[id] = value;
    return undefined;
  }
  return invalid(`The profile operation ${String(op)} does not exist`);
}

export function changeProblem(raw: unknown, players: readonly PlayerId[]): string | undefined {
  if (!isRecord(raw)) {
    return "a profile change must be an object";
  }
  const keys = Object.keys(raw).sort().join(",");
  if (keys !== "id,op,player,value") {
    return "a profile change has exactly player, op, id and value";
  }
  if (typeof raw["player"] !== "string" || !players.includes(raw["player"])) {
    return "a profile change names a seat that is not in the match";
  }
  if (typeof raw["op"] !== "string" || !(profileOperations as readonly string[]).includes(raw["op"])) {
    return "a profile change names an unknown operation";
  }
  if (typeof raw["id"] !== "string" || !profileIdPattern.test(raw["id"])) {
    return "a profile change has an invalid name";
  }
  const value = raw["value"];
  if (!(typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= maxFlagLength))) {
    return "a profile change has an invalid value";
  }
  return undefined;
}

function invalid(message: string): ChangeProblem {
  return { kind: "invalid", message };
}

function known(section: Record<string, unknown> | undefined, id: string): boolean {
  return section !== undefined && Object.hasOwn(section, id);
}

function suggest(section: Record<string, unknown> | undefined, id: string): string {
  const names = Object.keys(section ?? {});
  if (names.length === 0) {
    return " (nothing is listed there yet)";
  }
  const close = names.find((name) => distance(name, id) <= 2);
  return close === undefined ? "" : `; did you mean ${JSON.stringify(close)}?`;
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) {
    return 3;
  }
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0] as number;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j] as number;
      previous[j] = Math.min(above + 1, (previous[j - 1] as number) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length] as number;
}

function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 37)}...` : value);
  }
  return typeof value === "number" || typeof value === "boolean" || value === null ? String(value) : typeof value;
}

function bare<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

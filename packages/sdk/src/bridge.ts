import { isLanguage } from "./i18n";
import { findNonJson } from "./json";
import { maxActionDepth, maxActionLength } from "./match";
import { optionsProblem, type GameOptions } from "./options";
import { maxProfileValue, profileIdPattern, profileProblem, readProfile, type ProfileData } from "./profile";
import { readSound, type Sound } from "./sound";
import type { PlayerId } from "./state";

export const bridgeVersion = 1;

export interface PlayerInfo {
  name: string;
  connected: boolean;
  you: boolean;
  bot?: boolean;
}

export type MoveResult = { ok: true } | { ok: false; code: string; message: string };

export type Role = "player" | "controller" | "screen";

export const roles: readonly Role[] = ["player", "controller", "screen"];

export interface BridgeUpdate<Snapshot = unknown> {
  seat: PlayerId | null;
  role: Role;
  snapshot: Snapshot;
  players: Record<PlayerId, PlayerInfo>;
  options: GameOptions;
  online: boolean;
  tickMs?: number;
  profile?: ProfileData;
  language?: string;
}

export const maxSaveBytes = 64 * 1024;
export const maxSaveDepth = 64;
export const statNamePattern = profileIdPattern;
export const maxStatValue = maxProfileValue;

export interface SoloState {
  saved: unknown;
  best: Record<string, number>;
  language?: string;
}

export type GameMessage =
  | { gamehearth: typeof bridgeVersion; type: "ready" }
  | { gamehearth: typeof bridgeVersion; type: "move"; id: number; action: unknown; expectedVersion: number }
  | { gamehearth: typeof bridgeVersion; type: "solo-ready" }
  | { gamehearth: typeof bridgeVersion; type: "save"; id: number; data: unknown; problem?: string }
  | { gamehearth: typeof bridgeVersion; type: "record"; id: number; stat: string; value: number; problem?: string }
  | { gamehearth: typeof bridgeVersion; type: "sound"; sound: Sound };

export type PlatformMessage<Snapshot = unknown> =
  | ({ gamehearth: typeof bridgeVersion; type: "update" } & BridgeUpdate<Snapshot>)
  | ({ gamehearth: typeof bridgeVersion; type: "result"; id: number } & MoveResult)
  | ({ gamehearth: typeof bridgeVersion; type: "solo" } & SoloState)
  | { gamehearth: typeof bridgeVersion; type: "settings"; sound: boolean }
  | { gamehearth: typeof bridgeVersion; type: "refused"; message: string };

export function saveProblem(data: unknown): string | undefined {
  if (data === undefined || data === null) {
    return 'The save is missing. Save a JSON object such as { level: 1 }; null stands for "no save".';
  }
  const problem = findNonJson(data, "save", maxSaveDepth);
  if (problem !== undefined) {
    return `The save is not plain JSON: ${problem.path} ${problem.reason}`;
  }
  let bytes: number;
  try {
    bytes = utf8Length(JSON.stringify(data));
  } catch (error) {
    return `The save cannot be written as JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  return bytes > maxSaveBytes ? `The save is ${Math.ceil(bytes / 1024)} KB, at most ${maxSaveBytes / 1024} KB are allowed.` : undefined;
}

export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function recordProblem(stat: unknown, value: unknown): string | undefined {
  if (typeof stat !== "string" || !statNamePattern.test(stat)) {
    return `${JSON.stringify(stat) ?? String(stat)} is not the name of a best score; names are listed under stats in manifest.json, such as "points".`;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > maxStatValue) {
    return `The value for ${stat} must be a finite number between -${maxStatValue} and ${maxStatValue}, not ${String(value)}.`;
  }
  return undefined;
}

export function parseGameMessage(data: unknown): GameMessage | undefined {
  if (!isRecord(data) || data["gamehearth"] !== bridgeVersion) {
    return undefined;
  }
  if (data["type"] === "ready") {
    return { gamehearth: bridgeVersion, type: "ready" };
  }
  if (data["type"] === "solo-ready") {
    return { gamehearth: bridgeVersion, type: "solo-ready" };
  }
  if (data["type"] === "sound") {
    const sound = readSound(data["sound"]);
    return sound === undefined ? undefined : { gamehearth: bridgeVersion, type: "sound", sound };
  }
  if (data["type"] === "save" && isCounter(data["id"])) {
    const problem = saveProblem(data["data"]);
    return problem === undefined
      ? { gamehearth: bridgeVersion, type: "save", id: data["id"], data: JSON.parse(JSON.stringify(data["data"])) as unknown }
      : { gamehearth: bridgeVersion, type: "save", id: data["id"], data: undefined, problem };
  }
  if (data["type"] === "record" && isCounter(data["id"])) {
    const stat = data["stat"];
    const value = data["value"];
    const problem = recordProblem(stat, value);
    return problem === undefined
      ? { gamehearth: bridgeVersion, type: "record", id: data["id"], stat: stat as string, value: value as number }
      : { gamehearth: bridgeVersion, type: "record", id: data["id"], stat: typeof stat === "string" ? stat.slice(0, 40) : "", value: 0, problem };
  }
  if (data["type"] !== "move" || !isCounter(data["id"]) || !isCounter(data["expectedVersion"]) || !("action" in data)) {
    return undefined;
  }
  const action = data["action"];
  if (findNonJson(action, "action", maxActionDepth) !== undefined) {
    return undefined;
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(action);
  } catch {
    return undefined;
  }
  if (serialized === undefined || serialized.length > maxActionLength) {
    return undefined;
  }
  return { gamehearth: bridgeVersion, type: "move", id: data["id"], action: JSON.parse(serialized) as unknown, expectedVersion: data["expectedVersion"] };
}

export function parsePlatformMessage(data: unknown): PlatformMessage | undefined {
  if (!isRecord(data) || data["gamehearth"] !== bridgeVersion) {
    return undefined;
  }
  if (data["type"] === "result") {
    if (!isCounter(data["id"])) {
      return undefined;
    }
    if (data["ok"] === true) {
      return { gamehearth: bridgeVersion, type: "result", id: data["id"], ok: true };
    }
    return data["ok"] === false && typeof data["code"] === "string" && typeof data["message"] === "string"
      ? { gamehearth: bridgeVersion, type: "result", id: data["id"], ok: false, code: data["code"], message: data["message"] }
      : undefined;
  }
  if (data["type"] === "settings") {
    return typeof data["sound"] === "boolean" ? { gamehearth: bridgeVersion, type: "settings", sound: data["sound"] } : undefined;
  }
  if (data["type"] === "refused") {
    return typeof data["message"] === "string" ? { gamehearth: bridgeVersion, type: "refused", message: data["message"].slice(0, 500) } : undefined;
  }
  if (data["type"] === "solo") {
    const best = readBest(data["best"]);
    if (best === undefined || !("saved" in data) || findNonJson(data["saved"], "saved", maxSaveDepth) !== undefined) {
      return undefined;
    }
    const soloLanguage = data["language"];
    return { gamehearth: bridgeVersion, type: "solo", saved: data["saved"] ?? null, best, ...(isLanguage(soloLanguage) ? { language: soloLanguage } : {}) };
  }
  if (data["type"] !== "update" || typeof data["online"] !== "boolean") {
    return undefined;
  }
  const role = data["role"];
  if (typeof role !== "string" || !(roles as readonly string[]).includes(role)) {
    return undefined;
  }
  const seat = data["seat"];
  if (role === "screen" ? seat !== null : typeof seat !== "string") {
    return undefined;
  }
  const snapshot = data["snapshot"];
  if (!isRecord(snapshot) || !isCounter(snapshot["version"]) || (snapshot["tick"] !== undefined && !isCounter(snapshot["tick"]))) {
    return undefined;
  }
  const players = readPlayers(data["players"]);
  if (players === undefined) {
    return undefined;
  }
  const rawOptions = data["options"] ?? {};
  if (optionsProblem(rawOptions) !== undefined) {
    return undefined;
  }
  const options: GameOptions = Object.freeze({ ...(rawOptions as GameOptions) });
  const rawProfile = data["profile"];
  if (rawProfile !== undefined && (role === "screen" || profileProblem(rawProfile) !== undefined)) {
    return undefined;
  }
  const pace = data["tickMs"];
  const update = {
    gamehearth: bridgeVersion as typeof bridgeVersion,
    type: "update" as const,
    seat: seat as PlayerId | null,
    role: role as Role,
    snapshot,
    players,
    options,
    online: data["online"],
    ...(rawProfile === undefined ? {} : { profile: readProfile(rawProfile) }),
    ...(isLanguage(data["language"]) ? { language: data["language"] } : {}),
  };
  return typeof pace === "number" && Number.isFinite(pace) && pace > 0 && pace <= 10_000 ? { ...update, tickMs: pace } : update;
}

function readPlayers(raw: unknown): Record<PlayerId, PlayerInfo> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const players: Record<PlayerId, PlayerInfo> = Object.create(null) as Record<PlayerId, PlayerInfo>;
  for (const [seat, info] of Object.entries(raw)) {
    if (!isRecord(info) || typeof info["name"] !== "string" || typeof info["connected"] !== "boolean" || typeof info["you"] !== "boolean") {
      return undefined;
    }
    players[seat] = { name: info["name"], connected: info["connected"], you: info["you"], ...(info["bot"] === true ? { bot: true } : {}) };
  }
  return players;
}

function readBest(raw: unknown): Record<string, number> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const best: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [stat, value] of Object.entries(raw)) {
    if (!statNamePattern.test(stat) || typeof value !== "number" || !Number.isFinite(value)) {
      return undefined;
    }
    best[stat] = value;
  }
  return best;
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

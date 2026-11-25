import type { CatalogEntrySpec, GameOptions, Localized, OptionsSpec, OptionValue, PlayerCountSpec, PlayerSnapshot, ProfileData, ScreenSnapshot } from "@gamehearth/sdk/platform";

export type { Localized, ProfileData };

export type RoomStatus = "lobby" | "running" | "finished";

export interface Member {
  id: number;
  name: string;
  seat: string | null;
  host: boolean;
  guest: boolean;
  deleted: boolean;
  bot?: number;
  autopilot?: true;
}

export interface MemberView extends Member {
  you: boolean;
  connected: boolean;
}

export interface RoomGame {
  id: string;
  name: Localized;
  version: string;
  client: string;
  mode?: string;
  roles?: string[];
  screenOptional?: boolean;
  languages?: string[];
  cover?: string;
  bots?: true;
  away?: "play-on";
}

export interface ScreenInfo {
  id: number;
  connected: boolean;
}

export interface RoomOptions {
  spec: OptionsSpec;
  values: GameOptions;
}

export type LiveState = "countdown" | "running" | "paused" | "halted";

export interface LiveView {
  state: LiveState;
  remainingMs?: number;
  missingSeats: string[];
  awaySeats?: string[];
  screenMissing: boolean;
  byHost: boolean;
  incident?: string;
}

export interface RoomView {
  code: string;
  game: RoomGame;
  status: RoomStatus;
  round: number;
  players: PlayerCountSpec;
  maxMembers: number;
  members: MemberView[];
  screens?: ScreenInfo[];
  you: Member;
  muted?: boolean;
  canStart: boolean;
  installed?: boolean;
  options?: RoomOptions;
  live?: LiveView;
  snapshot?: PlayerSnapshot<unknown, unknown, unknown>;
  profile?: ProfileData;
}

export interface ScreenView {
  code: string;
  screen: number;
  game: RoomGame;
  status: RoomStatus;
  round: number;
  players: PlayerCountSpec;
  maxMembers: number;
  members: MemberView[];
  screens: ScreenInfo[];
  installed?: boolean;
  options?: RoomOptions;
  live?: LiveView;
  snapshot?: ScreenSnapshot<unknown>;
}

export interface Pairing {
  code: string;
  expiresAt: number;
  expiresInMs?: number;
}

export function hasScreenRole(game: RoomGame): boolean {
  return game.roles?.includes("screen") === true;
}

export function requiresScreen(game: RoomGame): boolean {
  return hasScreenRole(game) && game.screenOptional !== true;
}

export type Role = "player" | "admin";

export interface Me {
  id: number;
  kind: "account" | "guest";
  username?: string;
  name: string;
  role: Role;
  language?: "de" | "en" | null;
  theme?: "neon" | "crt" | "front" | null;
}

export interface RoomSummary {
  code: string;
  gameId?: string;
  game: Localized;
  languages?: string[];
  cover?: string;
  status: RoomStatus;
  round: number;
  members: number;
  host: boolean;
  yourTurn: boolean;
  muted?: boolean;
  screen?: boolean;
  updatedAt: number;
  expiresAt?: number;
}

export interface Adoption {
  name: string;
  rooms: RoomSummary[];
  duplicates?: RoomSummary[];
}

export interface MeInfo {
  user?: Me;
  adopt?: Adoption;
}

export interface SessionInfo {
  id: number;
  browser?: string;
  system?: string;
  createdAt: number;
  seenAt: number;
  current: boolean;
  push?: boolean;
}

export type LinkKind = "setup" | "invite" | "reset";

export interface LinkInfo {
  kind: LinkKind;
  role: Role;
  expiresAt: number;
  username?: string;
  name?: string;
}

export interface RoleInfo {
  inputs: string[];
  screen: "small" | "medium" | "large";
  optional?: boolean;
}

export interface StatSpec {
  label: Localized;
  better: "higher" | "lower";
  format?: "number" | "time";
}

export interface ProfileStatSpec {
  label: Localized;
  better?: "higher" | "lower";
  format?: "number" | "time";
  deprecated?: boolean;
}

export interface GamePageInfo {
  id: string;
  name: Localized;
  version: string;
  description?: Localized;
  languages?: string[];
  cover?: string;
  mode: string;
  players: PlayerCountSpec;
  roles: string[];
  solo: boolean;
  build?: string;
  client?: string;
  items: Record<string, CatalogEntrySpec>;
  stats: Record<string, ProfileStatSpec>;
  flags: Record<string, CatalogEntrySpec>;
}

export interface GamePage {
  game: GamePageInfo;
  profile: ProfileData | null;
  boards: Record<string, BoardEntry[]>;
  source: "server" | "client";
}

export type CatalogSection = "items" | "stats" | "flags";

export type UnknownIds = Record<CatalogSection, string[]>;

export interface AdminProfile {
  user: number;
  name: string;
  profile: ProfileData;
  updatedAt: number;
}

export interface AdminProfiles {
  game: { id: string; name: Localized; items: Record<string, CatalogEntrySpec>; stats: Record<string, ProfileStatSpec>; flags: Record<string, CatalogEntrySpec> };
  profiles: AdminProfile[];
  unknownIds: UnknownIds;
}

export interface GameInfo {
  id: string;
  name: Localized;
  version: string;
  description?: Localized;
  languages?: string[];
  cover?: string;
  mode: string;
  players: PlayerCountSpec;
  roles?: Partial<Record<"player" | "controller" | "screen", RoleInfo>>;
  solo?: boolean;
  build?: string;
  stats?: Record<string, StatSpec>;
}

export interface SoloGameInfo extends GameInfo {
  solo: true;
  build: string;
  stats: Record<string, StatSpec>;
}

export function isSoloGame(game: GameInfo): game is SoloGameInfo {
  return game.solo === true && typeof game.build === "string" && game.stats !== undefined;
}

export interface BoardEntry {
  rank: number;
  name: string;
  value: number;
  you: boolean;
}

export interface SoloView {
  game: string;
  save: { data: unknown; savedAt: number } | null;
  savedAt: number | null;
  best: Record<string, number>;
  generations: Record<string, number>;
  boards: Record<string, BoardEntry[]>;
  ignored: string[];
}

export interface SoloSyncInput {
  save?: { data: unknown; savedAt: number } | { deleted: true; savedAt: number };
  best?: Record<string, { value: number; at: number; generation: number }>;
}

export interface OfflineFiles {
  build: string;
  client: string;
  files: string[];
}

export type ServerMessage =
  | { type: "room"; room: RoomView }
  | { type: "screen-room"; room: ScreenView }
  | { type: "frame"; snapshot: PlayerSnapshot<unknown, unknown, unknown> | ScreenSnapshot<unknown> }
  | { type: "frame"; base: number; delta: unknown[] }
  | { type: "pairing"; code: string; expiresAt: number; expiresInMs?: number }
  | { type: "ack"; id: number }
  | { type: "error"; code: string; message: string; id?: number };

export type Command =
  | { type: "start" }
  | { type: "set-option"; name: string; value: OptionValue }
  | { type: "leave" }
  | { type: "kick"; member: number }
  | { type: "add-bot" }
  | { type: "hand-over"; member: number }
  | { type: "take-back" }
  | { type: "move"; action: unknown; expectedVersion: number }
  | { type: "new-round" }
  | { type: "abort" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "remove-screen"; screen: number };

export type CommandResult = { ok: true } | { ok: false; code: string; message: string };

export function parseServerMessage(raw: unknown): ServerMessage | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const message = value as Record<string, unknown>;
  if (message["type"] === "room" && message["room"] !== null && typeof message["room"] === "object") {
    return { type: "room", room: message["room"] as RoomView };
  }
  if (message["type"] === "screen-room" && message["room"] !== null && typeof message["room"] === "object") {
    return { type: "screen-room", room: message["room"] as ScreenView };
  }
  if (message["type"] === "frame" && Number.isSafeInteger(message["base"]) && Array.isArray(message["delta"])) {
    return { type: "frame", base: message["base"] as number, delta: message["delta"] as unknown[] };
  }
  if (message["type"] === "frame" && message["snapshot"] !== null && typeof message["snapshot"] === "object") {
    return { type: "frame", snapshot: message["snapshot"] as PlayerSnapshot<unknown, unknown, unknown> };
  }
  if (message["type"] === "pairing" && typeof message["code"] === "string" && typeof message["expiresAt"] === "number") {
    return typeof message["expiresInMs"] === "number"
      ? { type: "pairing", code: message["code"], expiresAt: message["expiresAt"], expiresInMs: message["expiresInMs"] }
      : { type: "pairing", code: message["code"], expiresAt: message["expiresAt"] };
  }
  if (message["type"] === "ack" && typeof message["id"] === "number") {
    return { type: "ack", id: message["id"] };
  }
  if (message["type"] === "error" && typeof message["code"] === "string" && typeof message["message"] === "string") {
    return typeof message["id"] === "number"
      ? { type: "error", code: message["code"], message: message["message"], id: message["id"] }
      : { type: "error", code: message["code"], message: message["message"] };
  }
  return undefined;
}

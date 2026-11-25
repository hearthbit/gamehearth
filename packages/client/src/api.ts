import type { Localized, PlayerCountSpec } from "@gamehearth/sdk/platform";
import type {
  AdminProfiles,
  CatalogSection,
  GameInfo,
  GamePage,
  LinkInfo,
  LinkKind,
  Me,
  MeInfo,
  OfflineFiles,
  Role,
  RoomSummary,
  SessionInfo,
  SoloSyncInput,
  SoloView,
  UnknownIds,
} from "./protocol";

export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  } catch {
    throw new ApiError("offline", "No connection to the server.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(response.ok ? "server-error" : "offline", `Unexpected answer from the server (${response.status}).`);
  }
  if (!response.ok) {
    const error = body as { code?: unknown; message?: unknown };
    throw new ApiError(typeof error.code === "string" ? error.code : "server-error", typeof error.message === "string" ? error.message : "Fehler im Server");
  }
  return body as T;
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export function listGames(): Promise<GameInfo[]> {
  return request<GameInfo[]>("/api/games");
}

export const games = {
  page: (game: string) => request<GamePage>(`/api/games/${encodeURIComponent(game)}`),
  reset: (game: string) => post<GamePage>(`/api/games/${encodeURIComponent(game)}/reset`),
};

export const solo = {
  view: (game: string) => request<SoloView>(`/api/solo/${encodeURIComponent(game)}`),
  sync: (game: string, input: SoloSyncInput) => post<SoloView>(`/api/solo/${encodeURIComponent(game)}/sync`, input),
  remove: (game: string, what: "save" | "best") => post<SoloView>(`/api/solo/${encodeURIComponent(game)}/delete`, { what }),
  files: (game: string) => request<OfflineFiles>(`/api/solo/${encodeURIComponent(game)}/files`),
};

export interface AdminBoardEntry {
  user: number;
  name: string;
  value: number;
  at: number;
}

export function fetchMe(): Promise<MeInfo> {
  return request<MeInfo>("/api/me");
}

export async function saveLanguage(language: "de" | "en" | null): Promise<void> {
  await request<unknown>("/api/me/language", { method: "POST", body: JSON.stringify({ language }) });
}

export async function saveTheme(theme: "neon" | "crt" | "front" | null): Promise<void> {
  await request<unknown>("/api/me/theme", { method: "POST", body: JSON.stringify({ theme }) });
}

export async function adopt(take: boolean): Promise<string[]> {
  return (await post<{ moved: string[] }>("/api/me/adopt", { take })).moved;
}

export async function rename(name: string): Promise<Me> {
  return (await post<{ user: Me }>("/api/me/name", { name })).user;
}

export async function changePassword(current: string, password: string): Promise<void> {
  await post("/api/me/password", { current, password });
}

export async function mySessions(): Promise<SessionInfo[]> {
  return (await request<{ sessions: SessionInfo[] }>("/api/me/sessions")).sessions;
}

export async function endSession(id: number): Promise<void> {
  await post(`/api/me/sessions/${id}/end`);
}

export async function endAllSessions(): Promise<void> {
  await post("/api/me/sessions/end-all");
}

export async function login(username: string, password: string): Promise<Me> {
  return (await post<{ user: Me }>("/api/login", { username, password })).user;
}

export function createTransferCode(): Promise<{ code: string; expiresAt: number }> {
  return post<{ code: string; expiresAt: number }>("/api/me/transfer");
}

export async function redeemTransferCode(code: string): Promise<Me> {
  return (await post<{ user: Me }>("/api/transfer", { code })).user;
}

export async function logout(): Promise<void> {
  await post("/api/logout");
}

export async function myRooms(): Promise<RoomSummary[]> {
  return (await request<{ rooms: RoomSummary[] }>("/api/me/rooms")).rooms;
}

export function pushStatus(): Promise<{ publicKey?: string; enabled: boolean }> {
  return request<{ publicKey?: string; enabled: boolean }>("/api/me/push");
}

export async function subscribePush(subscription: unknown, language: string): Promise<void> {
  await post("/api/me/push", { subscription, language });
}

export async function unsubscribePush(): Promise<void> {
  await post("/api/me/push/off");
}

export async function testPush(): Promise<void> {
  await post("/api/me/push/test");
}

export async function muteRoom(code: string, muted: boolean): Promise<boolean> {
  return (await post<{ muted: boolean }>(`/api/rooms/${encodeURIComponent(code)}/mute`, { muted })).muted;
}

export function createRoom(game: string): Promise<{ code: string }> {
  return post<{ code: string }>("/api/rooms", { game });
}

export async function ensureScreenDevice(): Promise<void> {
  await post("/api/tv");
}

export function pairScreen(room: string, code: string): Promise<{ id: number }> {
  return post<{ id: number }>(`/api/rooms/${encodeURIComponent(room)}/screens`, { code });
}

export function pairThisDevice(room: string): Promise<{ id: number }> {
  return post<{ id: number }>(`/api/rooms/${encodeURIComponent(room)}/screens/self`);
}

export function joinRoom(code: string, name?: string): Promise<{ code: string }> {
  return post<{ code: string }>(`/api/rooms/${encodeURIComponent(code)}/join`, name === undefined ? {} : { name });
}

export function claimRooms(tokens: string[]): Promise<{ claimed: string[]; user?: Me }> {
  return post<{ claimed: string[]; user?: Me }>("/api/claim", { tokens });
}

export function inspectLink(token: string, kind: LinkKind): Promise<LinkInfo> {
  return post<LinkInfo>("/api/links/inspect", { token, kind });
}

export function acceptInvite(token: string, username: string, name: string, password: string): Promise<{ user: Me; upgraded: boolean }> {
  return post<{ user: Me; upgraded: boolean }>("/api/invites/accept", { token, username, name, password });
}

export function resetPassword(token: string, password: string): Promise<{ username: string }> {
  return post<{ username: string }>("/api/reset", { token, password });
}

export interface AdminUser {
  id: number;
  username: string;
  name: string;
  role: Role;
  locked: boolean;
  createdAt: number;
  activeAt: number;
  rooms: number;
}

export interface AdminInvite {
  id: number;
  role: Role;
  note?: string;
  username?: string;
  name?: string;
  createdAt: number;
  expiresAt: number;
  createdBy?: string;
}

export interface AdminRoom {
  code: string;
  game: Localized;
  status: "lobby" | "running" | "finished";
  round: number;
  createdAt: number;
  updatedAt: number;
  members: { name: string; host: boolean; guest: boolean; deleted: boolean; bot?: number }[];
}

export interface QuarantinedBuild {
  build: string;
  since: number;
  reason: string;
  hardAborts?: number;
  softAborts?: number;
  windowMinutes?: number;
}

export interface BackupEntry {
  file: string;
  kind: "daily" | "manual" | "migration";
  createdAt: number;
  bytes: number;
}

export interface AdminGame {
  id: string;
  name: Localized;
  languages?: string[];
  version: string;
  build: string;
  source: "local" | "catalog";
  catalogId?: number;
  catalogName?: string;
  installedAt?: number;
  broken: boolean;
  shadowed?: string;
  solo?: boolean;
  unknownIds?: UnknownIds;
  rooms: { lobby: number; running: number; finished: number };
  bytes: number;
}

export interface AdminCatalog {
  id: number;
  url: string;
  name: string;
  addedAt: number;
  fetchedAt: number;
  checkedAt: number;
  error?: string;
  errorCode?: string;
  games: number;
}

export interface OfferedVersion {
  version: string;
  sdk: string;
  mode: string;
  players: PlayerCountSpec;
  license: { code: string; assets: string };
  size: number;
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

export interface GamesOverview {
  games: AdminGame[];
  catalogs: AdminCatalog[];
  offers: CatalogOffer[];
  storage: { total: number; free: number | null };
  suggested: { name: string; url: string } | null;
  enabled: boolean;
}

export const admin = {
  users: async () => (await request<{ users: AdminUser[] }>("/api/admin/users")).users,
  updateUser: (id: number, changes: { role?: Role; locked?: boolean; username?: string }) => post<{ user: Me }>(`/api/admin/users/${id}`, changes),
  resetLink: async (id: number) => (await post<{ token: string }>(`/api/admin/users/${id}/reset`)).token,
  deleteUser: (id: number) => post(`/api/admin/users/${id}/delete`),
  invites: async () => (await request<{ invites: AdminInvite[] }>("/api/admin/invites")).invites,
  createInvite: (invite: { role: Role; note?: string; username?: string; name?: string }) => post<{ token: string; invite: AdminInvite }>("/api/admin/invites", invite),
  revokeInvite: (id: number) => post(`/api/admin/invites/${id}/revoke`),
  rooms: async () => (await request<{ rooms: AdminRoom[] }>("/api/admin/rooms")).rooms,
  closeRoom: (code: string) => post(`/api/admin/rooms/${encodeURIComponent(code)}/close`),
  quarantined: async () => (await request<{ quarantined: QuarantinedBuild[] }>("/api/admin/builds")).quarantined,
  backups: () => request<{ backups: BackupEntry[]; enabled: boolean }>("/api/admin/backups"),
  backupNow: async () => (await post<{ backup: BackupEntry }>("/api/admin/backups")).backup,
  games: () => request<GamesOverview>("/api/admin/games"),
  addCatalog: async (url: string) => (await post<{ catalog: AdminCatalog }>("/api/admin/catalogs", { url, trust: true })).catalog,
  refreshCatalog: async (id: number) => (await post<{ catalog: AdminCatalog }>(`/api/admin/catalogs/${id}/refresh`)).catalog,
  removeCatalog: (id: number) => post<{ games: string[] }>(`/api/admin/catalogs/${id}/delete`),
  install: (choice: { catalog: number; game: string; version: string; replace?: boolean }) =>
    post<{ build: string; unknownIds?: UnknownIds }>("/api/admin/games/install", choice),
  profiles: (id: string) => request<AdminProfiles>(`/api/admin/games/${encodeURIComponent(id)}/profiles`),
  resetProfile: (id: string, user: number) => post<AdminProfiles>(`/api/admin/games/${encodeURIComponent(id)}/profiles/${user}/reset`),
  deleteProfileEntry: (id: string, user: number, section: CatalogSection, entry: string) =>
    post<AdminProfiles>(`/api/admin/games/${encodeURIComponent(id)}/profiles/${user}/delete`, { section, id: entry }),
  removeGame: (id: string) => post<{ closed: number; remaining: number }>(`/api/admin/games/${encodeURIComponent(id)}/remove`),
  boards: async (id: string) => (await request<{ boards: Record<string, AdminBoardEntry[]> }>(`/api/admin/games/${encodeURIComponent(id)}/boards`)).boards,
  deleteBoardEntry: async (id: string, user: number, stat: string) =>
    (await post<{ boards: Record<string, AdminBoardEntry[]> }>(`/api/admin/games/${encodeURIComponent(id)}/boards`, { user, stat })).boards,
};

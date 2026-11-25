import type { ServerResponse } from "node:http";
import type { AccountService, Role, Session } from "./accounts";
import type { BackupInfo } from "./backup";
import { CatalogError, suggestedCatalog, type CatalogService } from "./catalogs";
import { catalogOf } from "gamehearth";
import { defaultText, type GameLibrary } from "./games";
import { RequestError, sendJson } from "./http";
import type { RoomService } from "./rooms";
import type { QuarantinedBuild } from "./sandbox/host";
import type { SoloService } from "./solo";

export type QuarantineInfo = QuarantinedBuild;

export interface BackupControl {
  list(): BackupInfo[];
  create(): BackupInfo;
}

export interface AdminDependencies {
  rooms: RoomService;
  accounts: AccountService;
  quarantine: () => QuarantineInfo[];
  backups: BackupControl | undefined;
  removeUser: (userId: number) => void;
  library: GameLibrary;
  catalogs: CatalogService | undefined;
  solo?: SoloService | undefined;
  log: (message: string) => void;
}

export interface AdminRequest {
  method: string;
  parts: string[];
  session: Session | undefined;
  response: ServerResponse;
  body: () => Promise<Record<string, unknown>>;
}

function requireAdmin(session: Session | undefined): Session {
  if (session === undefined) {
    throw new RequestError("not-signed-in", "Please sign in first");
  }
  if (session.user.kind !== "account" || session.user.role !== "admin") {
    throw new RequestError("not-admin", "Only admins may do this");
  }
  return session;
}

function requireSolo(solo: SoloService | undefined): SoloService {
  if (solo === undefined) {
    throw new RequestError("not-found", "Single-player games are not set up on this server");
  }
  return solo;
}

function id(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RequestError("not-found", "This entry does not exist");
  }
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireCatalogs(catalogs: CatalogService | undefined): CatalogService {
  if (catalogs === undefined) {
    throw new RequestError("not-found", "Catalogs are not set up on this server");
  }
  return catalogs;
}

export async function gamesOverview(deps: Pick<AdminDependencies, "library" | "catalogs" | "rooms">): Promise<unknown> {
  const { library, catalogs, rooms } = deps;
  const usage = await library.usage();
  const counts = rooms.gameRoomCounts();
  const catalogList = catalogs?.list() ?? [];
  const names = new Map(catalogList.map((catalog) => [catalog.id, catalog.name]));
  const games = library.installed().map((game) => {
    let bytes = 0;
    for (const [build, size] of usage.builds) {
      if (build.startsWith(`${game.id}@`)) {
        bytes += size;
      }
    }
    const current = library.current(game.id);
    const unknown = current === undefined ? undefined : rooms.profiles.unknownIds(game.id, catalogOf(current.manifest));
    return {
      ...game,
      ...(unknown === undefined || Object.values(unknown).every((ids) => ids.length === 0) ? {} : { unknownIds: unknown }),
      catalogName: game.catalogId === undefined ? undefined : names.get(game.catalogId),
      rooms: counts.get(game.id) ?? { lobby: 0, running: 0, finished: 0 },
      bytes,
    };
  });
  return {
    games,
    catalogs: catalogList,
    offers: catalogs?.offers() ?? [],
    storage: { total: usage.total, free: usage.free ?? null },
    suggested: catalogs !== undefined && catalogList.length === 0 ? suggestedCatalog : null,
    enabled: catalogs !== undefined,
  };
}

function adminProfiles(rooms: RoomService, gameId: string): unknown {
  const { manifest, catalog } = rooms.profiles.catalog(gameId);
  return {
    game: { id: manifest.id, name: manifest.name, items: catalog.items ?? {}, stats: catalog.stats ?? {}, flags: catalog.flags ?? {} },
    profiles: rooms.profiles.adminProfiles(gameId),
    unknownIds: rooms.profiles.unknownIds(gameId, catalog),
  };
}

export function createAdminApi(deps: AdminDependencies): (request: AdminRequest) => Promise<boolean> {
  const { rooms, accounts } = deps;
  const settle = (game: string | undefined) => {
    if (game !== undefined) {
      rooms.gameChanged(game);
    }
    void deps.library.sweep(() => rooms.referencedBuilds()).then(
      (removed) => {
        if (removed.length > 0) {
          deps.log(`Old builds deleted: ${removed.join(", ")}`);
        }
      },
      (error: unknown) => deps.log(`Cleaning up builds failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  };
  return async ({ method, parts, session, response, body }) => {
    if (parts[1] !== "admin") {
      return false;
    }
    const admin = requireAdmin(session);
    const [, , area, target, action] = parts;
    const get = method === "GET";
    const post = method === "POST";
    if (area === "users" && get && target === undefined) {
      const counts = rooms.membershipCounts();
      sendJson(response, 200, { users: accounts.users().map((user) => ({ ...user, rooms: counts.get(user.id) ?? 0 })) });
      return true;
    }
    if (area === "users" && post && target !== undefined) {
      const userId = id(target);
      if (action === undefined) {
        const input = await body();
        const role = input["role"];
        if (role !== undefined && role !== "player" && role !== "admin") {
          throw new RequestError("bad-message", "role must be player or admin");
        }
        const locked = input["locked"];
        if (locked !== undefined && typeof locked !== "boolean") {
          throw new RequestError("bad-message", "locked must be true or false");
        }
        const username = optionalString(input["username"]);
        const user = accounts.updateUser(userId, {
          ...(role === undefined ? {} : { role: role as Role }),
          ...(locked === undefined ? {} : { locked }),
          ...(username === undefined ? {} : { username }),
        });
        sendJson(response, 200, { user });
        return true;
      }
      if (action === "reset") {
        sendJson(response, 200, { token: accounts.createResetLink(userId, admin.user.id) });
        return true;
      }
      if (action === "delete") {
        accounts.requireDeletable(userId);
        deps.removeUser(userId);
        sendJson(response, 200, {});
        return true;
      }
    }
    if (area === "invites" && get && target === undefined) {
      sendJson(response, 200, { invites: accounts.invites() });
      return true;
    }
    if (area === "invites" && post && target === undefined) {
      const input = await body();
      const role = input["role"] === "admin" ? "admin" : input["role"] === "player" || input["role"] === undefined ? "player" : undefined;
      if (role === undefined) {
        throw new RequestError("bad-message", "role must be player or admin");
      }
      const note = optionalString(input["note"]);
      const username = optionalString(input["username"]);
      const name = optionalString(input["name"]);
      const created = accounts.createInvite(admin.user.id, {
        role,
        ...(note === undefined ? {} : { note }),
        ...(username === undefined ? {} : { username }),
        ...(name === undefined ? {} : { name }),
      });
      sendJson(response, 201, created);
      return true;
    }
    if (area === "invites" && post && target !== undefined && action === "revoke") {
      accounts.revokeInvite(id(target));
      sendJson(response, 200, {});
      return true;
    }
    if (area === "rooms" && get && target === undefined) {
      sendJson(response, 200, { rooms: rooms.allRooms() });
      return true;
    }
    if (area === "rooms" && post && target !== undefined && action === "close") {
      rooms.close(target);
      sendJson(response, 200, {});
      return true;
    }
    if (area === "builds" && get && target === undefined) {
      sendJson(response, 200, { quarantined: deps.quarantine() });
      return true;
    }
    if (area === "games" && get && target === undefined) {
      sendJson(response, 200, await gamesOverview(deps));
      return true;
    }
    if (area === "games" && post && target === "install" && action === undefined) {
      const input = await body();
      const catalog = input["catalog"];
      const game = input["game"];
      const version = input["version"];
      if (!Number.isSafeInteger(catalog) || typeof game !== "string" || typeof version !== "string") {
        throw new RequestError("bad-message", "catalog, game and version are missing");
      }
      const installed = await requireCatalogs(deps.catalogs).install(catalog as number, game, version, { replace: input["replace"] === true });
      deps.log(`Game installed: ${defaultText(installed.manifest.name, installed.manifest.languages)} (${installed.build}) from catalog ${String(catalog)} by ${admin.user.username ?? admin.user.id}`);
      settle(game);
      const unknown = rooms.profiles.unknownIds(installed.manifest.id, catalogOf(installed.manifest));
      sendJson(response, 200, { build: installed.build, ...(Object.values(unknown).every((ids) => ids.length === 0) ? {} : { unknownIds: unknown }) });
      return true;
    }
    if (area === "games" && get && target !== undefined && action === "profiles" && parts.length === 5) {
      sendJson(response, 200, adminProfiles(rooms, target));
      return true;
    }
    if (area === "games" && post && target !== undefined && action === "profiles" && parts.length === 7) {
      const userId = id(parts[5]);
      rooms.profiles.catalog(target);
      const what = parts[6];
      if (what === "reset") {
        rooms.profiles.reset(userId, target);
        deps.log(`Profile reset: ${target} of user ${userId} by ${admin.user.username ?? admin.user.id}`);
      } else if (what === "delete") {
        const input = await body();
        const section = input["section"];
        const entry = input["id"];
        if ((section !== "items" && section !== "stats" && section !== "flags") || typeof entry !== "string") {
          throw new RequestError("bad-message", "section (items, stats or flags) and id are missing");
        }
        rooms.profiles.deleteEntry(userId, target, section, entry);
        deps.log(`Profile entry deleted: ${target} ${section}.${entry} of user ${userId} by ${admin.user.username ?? admin.user.id}`);
      } else {
        throw new RequestError("not-found", `POST /${parts.join("/")} does not exist`);
      }
      sendJson(response, 200, adminProfiles(rooms, target));
      return true;
    }
    if (area === "games" && get && target !== undefined && action === "boards") {
      sendJson(response, 200, { boards: requireSolo(deps.solo).adminBoards(target) });
      return true;
    }
    if (area === "games" && post && target !== undefined && action === "boards") {
      const input = await body();
      const user = input["user"];
      const stat = input["stat"];
      if (!Number.isSafeInteger(user) || typeof stat !== "string") {
        throw new RequestError("bad-message", "user and stat are missing");
      }
      const solo = requireSolo(deps.solo);
      solo.adminDelete(target, user as number, stat);
      deps.log(`Best score deleted: ${target} ${stat} of user ${String(user)} by ${admin.user.username ?? admin.user.id}`);
      sendJson(response, 200, { boards: solo.adminBoards(target) });
      return true;
    }
    if (area === "games" && post && target !== undefined && action === "remove") {
      deps.catalogs?.requireIdle();
      const build = deps.library.remove(target);
      const changed = rooms.gameChanged(target);
      deps.log(`Game removed: ${target} (${build}) by ${admin.user.username ?? admin.user.id}; ${changed.closed.length} lobbies closed`);
      settle(undefined);
      sendJson(response, 200, { closed: changed.closed.length, remaining: changed.touched.length });
      return true;
    }
    if (area === "catalogs" && post && target === undefined) {
      const input = await body();
      if (input["trust"] !== true) {
        throw new CatalogError("trust-required", "Only add a catalog you explicitly trust");
      }
      const url = input["url"];
      if (typeof url !== "string") {
        throw new RequestError("bad-message", "url is missing");
      }
      const catalog = await requireCatalogs(deps.catalogs).add(url);
      deps.log(`Catalog added: ${catalog.name} (${catalog.url}) by ${admin.user.username ?? admin.user.id}`);
      sendJson(response, 201, { catalog });
      return true;
    }
    if (area === "catalogs" && post && target !== undefined && action === "refresh") {
      sendJson(response, 200, { catalog: await requireCatalogs(deps.catalogs).refresh(id(target)) });
      return true;
    }
    if (area === "catalogs" && post && target !== undefined && action === "delete") {
      const removed = requireCatalogs(deps.catalogs).remove(id(target));
      deps.log(`Catalog ${target} removed by ${admin.user.username ?? admin.user.id}; ${removed.games.length} games stay without a catalog`);
      sendJson(response, 200, removed);
      return true;
    }
    if (area === "backups" && get && target === undefined) {
      sendJson(response, 200, { backups: deps.backups?.list() ?? [], enabled: deps.backups !== undefined });
      return true;
    }
    if (area === "backups" && post && target === undefined) {
      if (deps.backups === undefined) {
        throw new RequestError("not-found", "Backups are not set up on this server");
      }
      sendJson(response, 201, { backup: deps.backups.create() });
      return true;
    }
    throw new RequestError("not-found", `${method} /${parts.join("/")} does not exist`);
  };
}

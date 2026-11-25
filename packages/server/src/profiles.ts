import {
  applyChange,
  catalogIds,
  catalogSections,
  cloneProfile,
  emptyProfile,
  isEmptyProfile,
  profileJson,
  profileIdPattern,
  type CatalogSection,
  type CatalogSpec,
  type ProfileChange,
  type ProfileData,
} from "@gamehearth/sdk/platform";
import { catalogOf, type Manifest } from "gamehearth";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db";
import type { GameLibrary } from "./games";

export const boardSize = 10;

export type ProfileErrorCode = "unknown-game" | "account-required" | "unknown-user" | "unknown-entry" | "invalid-entry";

export class ProfileError extends Error {
  readonly code: ProfileErrorCode;

  constructor(code: ProfileErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface StoredProfile {
  profile: ProfileData;
  revision: number;
}

export interface BoardEntry {
  rank: number;
  name: string;
  value: number;
  you: boolean;
}

export interface AdminProfile {
  user: number;
  name: string;
  profile: ProfileData;
  updatedAt: number;
}

export type ProfileSource = "server" | "client";

export interface ProfileChangeEvent {
  users: number[];
  game: string;
  room?: string;
}

interface ProfileRow {
  items: string;
  flags: string;
  revision: number;
}

interface StatRow {
  stat: string;
  value: number | null;
}

export class ProfileService {
  readonly #db: DatabaseSync;
  readonly #library: GameLibrary;
  readonly #clock: () => number;
  readonly #listeners: ((event: ProfileChangeEvent) => void)[] = [];

  constructor(db: DatabaseSync, library: GameLibrary, options: { clock?: () => number } = {}) {
    this.#db = db;
    this.#library = library;
    this.#clock = options.clock ?? Date.now;
  }

  onChange(listener: (event: ProfileChangeEvent) => void): void {
    this.#listeners.push(listener);
  }

  changed(event: ProfileChangeEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  read(userId: number, gameId: string): StoredProfile {
    const row = this.#db.prepare("SELECT items, flags, revision FROM profiles WHERE user_id = ? AND game_id = ?").get(userId, gameId) as ProfileRow | undefined;
    const profile = emptyProfile();
    if (row !== undefined) {
      Object.assign(profile.items, parseRecord(row.items, (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0));
      Object.assign(profile.flags, parseRecord(row.flags, (value) => value === true || typeof value === "string"));
    }
    for (const stat of this.#db.prepare("SELECT stat, value FROM stats WHERE user_id = ? AND game_id = ? AND value IS NOT NULL").all(userId, gameId) as unknown as StatRow[]) {
      profile.stats[stat.stat] = stat.value as number;
    }
    return { profile, revision: row?.revision ?? 0 };
  }

  revision(userId: number, gameId: string): number {
    return (this.#db.prepare("SELECT revision FROM profiles WHERE user_id = ? AND game_id = ?").get(userId, gameId) as { revision: number } | undefined)?.revision ?? 0;
  }

  apply(userId: number, gameId: string, changes: readonly ProfileChange[], catalog: CatalogSpec): string | undefined {
    if (changes.length === 0) {
      return undefined;
    }
    const before = this.read(userId, gameId).profile;
    const after = cloneProfile(before);
    for (const change of changes) {
      const problem = applyChange(after, change, catalog);
      if (problem !== undefined) {
        return problem.message;
      }
    }
    if (profileJson(after) === profileJson(before)) {
      return undefined;
    }
    const now = this.#clock();
    this.#write(userId, gameId, after, now);
    const upsert = this.#db.prepare(
      `INSERT INTO stats (user_id, game_id, stat, value, source, updated_at) VALUES (?, ?, ?, ?, 'server', ?)
       ON CONFLICT (user_id, game_id, stat) DO UPDATE SET value = excluded.value, source = 'server', updated_at = excluded.updated_at`,
    );
    for (const stat of new Set(changes.filter((change) => change.op === "stat" || change.op === "record").map((change) => change.id))) {
      const value = after.stats[stat];
      if (value !== undefined && value !== before.stats[stat]) {
        upsert.run(userId, gameId, stat, value, now);
      }
    }
    return undefined;
  }

  touch(userId: number, gameId: string): void {
    const now = this.#clock();
    this.#db
      .prepare(
        `INSERT INTO profiles (user_id, game_id, revision, updated_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (user_id, game_id) DO UPDATE SET revision = profiles.revision + 1, updated_at = excluded.updated_at`,
      )
      .run(userId, gameId, now);
  }

  reset(userId: number, gameId: string): void {
    this.#requireUser(userId);
    const known = Object.keys(this.#library.current(gameId)?.manifest.stats ?? {});
    transaction(this.#db, () => {
      const now = this.#clock();
      this.#write(userId, gameId, emptyProfile(), now);
      this.#db.prepare("UPDATE stats SET value = NULL, updated_at = ?, generation = generation + 1 WHERE user_id = ? AND game_id = ?").run(now, userId, gameId);
      const mark = this.#db.prepare(
        "INSERT INTO stats (user_id, game_id, stat, value, source, updated_at, generation) VALUES (?, ?, ?, NULL, 'client', ?, 1) ON CONFLICT (user_id, game_id, stat) DO NOTHING",
      );
      for (const stat of known) {
        mark.run(userId, gameId, stat, now);
      }
    });
    this.changed({ users: [userId], game: gameId });
  }

  deleteEntry(userId: number, gameId: string, section: CatalogSection, id: string): void {
    if (!catalogSections.includes(section) || typeof id !== "string" || !profileIdPattern.test(id)) {
      throw new ProfileError("invalid-entry", "section must be items, stats or flags, id a name from the profile");
    }
    this.#requireUser(userId);
    const removed = transaction(this.#db, () => {
      const now = this.#clock();
      if (section === "stats") {
        const changed = this.#db
          .prepare("UPDATE stats SET value = NULL, updated_at = ?, generation = generation + 1 WHERE user_id = ? AND game_id = ? AND stat = ? AND value IS NOT NULL")
          .run(now, userId, gameId, id).changes;
        if (changed > 0) {
          this.touch(userId, gameId);
        }
        return changed > 0;
      }
      const current = this.read(userId, gameId).profile;
      if (!Object.hasOwn(current[section], id)) {
        return false;
      }
      delete current[section][id];
      this.#write(userId, gameId, current, now);
      return true;
    });
    if (!removed) {
      throw new ProfileError("unknown-entry", `The profile has no entry ${section}.${id}`);
    }
    this.changed({ users: [userId], game: gameId });
  }

  adminProfiles(gameId: string): AdminProfile[] {
    const users = this.#db
      .prepare(
        `SELECT u.id AS user, u.display_name AS name FROM users u WHERE u.kind = 'account' AND (
           EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = u.id AND p.game_id = ?) OR
           EXISTS (SELECT 1 FROM stats s WHERE s.user_id = u.id AND s.game_id = ? AND s.value IS NOT NULL))
         ORDER BY u.display_name COLLATE NOCASE, u.id`,
      )
      .all(gameId, gameId) as unknown as { user: number; name: string }[];
    const result: AdminProfile[] = [];
    for (const user of users) {
      const profile = this.read(user.user, gameId).profile;
      if (isEmptyProfile(profile)) {
        continue;
      }
      result.push({ user: user.user, name: user.name, profile, updatedAt: this.#updatedAt(user.user, gameId) });
    }
    return result;
  }

  unknownIds(gameId: string, catalog: CatalogSpec): Record<CatalogSection, string[]> {
    const known = catalogIds(catalog);
    const seen: Record<CatalogSection, Set<string>> = { items: new Set(), stats: new Set(), flags: new Set() };
    for (const row of this.#db.prepare("SELECT items, flags FROM profiles WHERE game_id = ?").all(gameId) as unknown as { items: string; flags: string }[]) {
      for (const id of Object.keys(parseRecord(row.items, (value) => typeof value === "number" && value > 0))) {
        seen.items.add(id);
      }
      for (const id of Object.keys(parseRecord(row.flags, (value) => value !== false))) {
        seen.flags.add(id);
      }
    }
    for (const row of this.#db.prepare("SELECT DISTINCT stat FROM stats WHERE game_id = ? AND value IS NOT NULL").all(gameId) as unknown as { stat: string }[]) {
      seen.stats.add(row.stat);
    }
    return {
      items: [...seen.items].filter((id) => !known.items.includes(id)).sort(),
      stats: [...seen.stats].filter((id) => !known.stats.includes(id)).sort(),
      flags: [...seen.flags].filter((id) => !known.flags.includes(id)).sort(),
    };
  }

  boards(userId: number | undefined, gameId: string, manifest: Manifest, source: ProfileSource): Record<string, BoardEntry[]> {
    const boards: Record<string, BoardEntry[]> = {};
    for (const [stat, spec] of Object.entries(manifest.stats ?? {})) {
      if (spec.better !== undefined) {
        boards[stat] = this.board(userId, gameId, stat, spec.better === "higher", source);
      }
    }
    return boards;
  }

  board(userId: number | undefined, gameId: string, stat: string, higher: boolean, source: ProfileSource): BoardEntry[] {
    const order = higher ? "DESC" : "ASC";
    const rows = this.#db
      .prepare(
        `SELECT s.user_id AS user, u.display_name AS name, s.value AS value FROM stats s JOIN users u ON u.id = s.user_id
         WHERE s.game_id = ? AND s.stat = ? AND s.value IS NOT NULL AND s.source = ? AND u.kind = 'account' AND u.locked = 0
         ORDER BY s.value ${order}, s.updated_at ASC, s.user_id ASC LIMIT ${boardSize}`,
      )
      .all(gameId, stat, source) as unknown as { user: number; name: string; value: number }[];
    const entries: BoardEntry[] = [];
    let rank = 0;
    let previous: number | undefined;
    rows.forEach((row, index) => {
      if (row.value !== previous) {
        rank = index + 1;
        previous = row.value;
      }
      entries.push({ rank, name: row.name, value: row.value, you: row.user === userId });
    });
    if (userId !== undefined && !entries.some((entry) => entry.you)) {
      const own = this.#db
        .prepare("SELECT value FROM stats WHERE user_id = ? AND game_id = ? AND stat = ? AND value IS NOT NULL AND source = ?")
        .get(userId, gameId, stat, source) as { value: number } | undefined;
      if (own !== undefined) {
        const better = this.#db
          .prepare(
            `SELECT COUNT(*) AS n FROM stats s JOIN users u ON u.id = s.user_id
             WHERE s.game_id = ? AND s.stat = ? AND s.value IS NOT NULL AND s.source = ? AND u.kind = 'account' AND u.locked = 0 AND s.value ${higher ? ">" : "<"} ?`,
          )
          .get(gameId, stat, source, own.value) as { n: number };
        const name = (this.#db.prepare("SELECT display_name FROM users WHERE id = ?").get(userId) as { display_name: string } | undefined)?.display_name ?? "";
        entries.push({ rank: better.n + 1, name, value: own.value, you: true });
      }
    }
    return entries;
  }

  catalog(gameId: string): { manifest: Manifest; catalog: CatalogSpec } {
    const build = this.#library.current(gameId);
    if (build === undefined) {
      throw new ProfileError("unknown-game", `The game ${gameId} is not installed on this server`);
    }
    return { manifest: build.manifest, catalog: catalogOf(build.manifest) };
  }

  #write(userId: number, gameId: string, profile: ProfileData, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO profiles (user_id, game_id, items, flags, revision, updated_at) VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT (user_id, game_id) DO UPDATE SET items = excluded.items, flags = excluded.flags, revision = profiles.revision + 1, updated_at = excluded.updated_at`,
      )
      .run(userId, gameId, sortedJson(profile.items), sortedJson(profile.flags), now);
  }

  #updatedAt(userId: number, gameId: string): number {
    const profile = (this.#db.prepare("SELECT updated_at FROM profiles WHERE user_id = ? AND game_id = ?").get(userId, gameId) as { updated_at: number } | undefined)?.updated_at ?? 0;
    const stat = (this.#db.prepare("SELECT MAX(updated_at) AS at FROM stats WHERE user_id = ? AND game_id = ? AND value IS NOT NULL").get(userId, gameId) as { at: number | null }).at ?? 0;
    return Math.max(profile, stat);
  }

  #requireUser(userId: number): void {
    const row = this.#db.prepare("SELECT kind FROM users WHERE id = ?").get(userId) as { kind: string } | undefined;
    if (row === undefined) {
      throw new ProfileError("unknown-user", "This account does not exist");
    }
    if (row.kind !== "account") {
      throw new ProfileError("account-required", "Only players with an account have profiles; guests play with a throwaway profile per match");
    }
  }
}

export function sortedJson(record: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]])));
}

export function parseRecord<T>(text: string, valid: (value: unknown) => boolean): Record<string, T> {
  const result = Object.create(null) as Record<string, T>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (profileIdPattern.test(key) && valid(value)) {
          result[key] = value as T;
        }
      }
    }
  } catch {
    return result;
  }
  return result;
}

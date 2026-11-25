import { maxStatValue, saveProblem, statNamePattern } from "@gamehearth/sdk/platform";
import type { Manifest } from "gamehearth";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db";
import { clientUrl, defaultText, type GameLibrary } from "./games";

export type SoloErrorCode = "unknown-game" | "not-solo" | "account-required" | "invalid-stat" | "unknown-user";

export class SoloError extends Error {
  readonly code: SoloErrorCode;

  constructor(code: SoloErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const boardSize = 10;

export interface SoloSave {
  data: unknown;
  savedAt: number;
}

export interface BoardEntry {
  rank: number;
  name: string;
  value: number;
  you: boolean;
}

export interface AdminBoardEntry {
  user: number;
  name: string;
  value: number;
  at: number;
}

export interface SoloView {
  game: string;
  save: SoloSave | null;
  savedAt: number | null;
  best: Record<string, number>;
  generations: Record<string, number>;
  boards: Record<string, BoardEntry[]>;
  ignored: string[];
}

export interface BestInput {
  value: number;
  at: number;
  generation: number;
}

export interface SyncInput {
  save?: { data: unknown; savedAt: number } | { deleted: true; savedAt: number };
  best?: Record<string, BestInput>;
}

export interface OfflineFiles {
  build: string;
  client: string;
  files: string[];
}

interface SaveRow {
  data: string | null;
  saved_at: number;
}

interface StatRow {
  stat: string;
  value: number | null;
  updated_at: number;
  generation: number;
}

export function isSoloManifest(manifest: Manifest): boolean {
  return manifest.mode === "single" && !manifest.server;
}

export class SoloService {
  readonly #db: DatabaseSync;
  readonly #library: GameLibrary;
  readonly #clock: () => number;

  constructor(db: DatabaseSync, library: GameLibrary, options: { clock?: () => number } = {}) {
    this.#db = db;
    this.#library = library;
    this.#clock = options.clock ?? Date.now;
  }

  view(userId: number, gameId: string): SoloView {
    const manifest = this.#manifest(gameId);
    this.#requireAccount(userId);
    return this.#view(userId, gameId, manifest, []);
  }

  offlineFiles(gameId: string): OfflineFiles {
    this.#manifest(gameId);
    const build = this.#library.current(gameId);
    if (build === undefined) {
      throw new SoloError("unknown-game", `The game ${gameId} is not installed on this server`);
    }
    return { build: build.build, client: clientUrl(build.build), files: [...build.clientFiles].sort() };
  }

  sync(userId: number, gameId: string, input: SyncInput): SoloView {
    const manifest = this.#manifest(gameId);
    this.#requireAccount(userId);
    const now = this.#clock();
    const ignored: string[] = [];
    transaction(this.#db, () => {
      if (input.save !== undefined) {
        const savedAt = Math.min(input.save.savedAt, now);
        const data = "deleted" in input.save ? null : JSON.stringify(input.save.data);
        const current = this.#saveRow(userId, gameId);
        if (current === undefined) {
          this.#db.prepare("INSERT INTO solo_saves (user_id, game_id, data, saved_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(userId, gameId, data, savedAt, now);
        } else if (savedAt > current.saved_at) {
          this.#db.prepare("UPDATE solo_saves SET data = ?, saved_at = ?, updated_at = ? WHERE user_id = ? AND game_id = ?").run(data, savedAt, now, userId, gameId);
        }
      }
      const stats = manifest.stats ?? {};
      for (const [stat, best] of Object.entries(input.best ?? {})) {
        const spec = Object.hasOwn(stats, stat) ? stats[stat] : undefined;
        if (spec === undefined) {
          ignored.push(stat);
          continue;
        }
        const at = Math.min(best.at, now);
        const row = this.#db.prepare("SELECT stat, value, updated_at, generation FROM stats WHERE user_id = ? AND game_id = ? AND stat = ?").get(userId, gameId, stat) as
          | StatRow
          | undefined;
        if (row === undefined) {
          this.#db
            .prepare("INSERT INTO stats (user_id, game_id, stat, value, source, updated_at) VALUES (?, ?, ?, ?, 'client', ?)")
            .run(userId, gameId, stat, best.value, at);
          continue;
        }
        if (best.generation < row.generation) {
          continue;
        }
        const better = row.value === null || (spec.better === "higher" ? best.value > row.value : best.value < row.value);
        if (better) {
          this.#db.prepare("UPDATE stats SET value = ?, source = 'client', updated_at = ? WHERE user_id = ? AND game_id = ? AND stat = ?").run(best.value, at, userId, gameId, stat);
        }
      }
    });
    return this.#view(userId, gameId, manifest, ignored);
  }

  deleteSave(userId: number, gameId: string): SoloView {
    return this.sync(userId, gameId, { save: { deleted: true, savedAt: this.#clock() } });
  }

  deleteBest(userId: number, gameId: string): SoloView {
    const manifest = this.#manifest(gameId);
    this.#requireAccount(userId);
    const now = this.#clock();
    transaction(this.#db, () => {
      for (const stat of Object.keys(manifest.stats ?? {})) {
        this.#reset(userId, gameId, stat, now);
      }
    });
    return this.#view(userId, gameId, manifest, []);
  }

  adminBoards(gameId: string): Record<string, AdminBoardEntry[]> {
    const manifest = this.#manifest(gameId);
    const boards: Record<string, AdminBoardEntry[]> = {};
    for (const [stat, spec] of Object.entries(manifest.stats ?? {})) {
      const order = spec.better === "higher" ? "DESC" : "ASC";
      boards[stat] = (
        this.#db
          .prepare(
            `SELECT s.user_id AS user, u.display_name AS name, s.value AS value, s.updated_at AS at FROM stats s JOIN users u ON u.id = s.user_id
             WHERE s.game_id = ? AND s.stat = ? AND s.value IS NOT NULL AND u.kind = 'account'
             ORDER BY s.value ${order}, s.updated_at ASC, s.user_id ASC LIMIT 100`,
          )
          .all(gameId, stat) as unknown as AdminBoardEntry[]
      ).map((entry) => ({ user: entry.user, name: entry.name, value: entry.value, at: entry.at }));
    }
    return boards;
  }

  adminDelete(gameId: string, userId: number, stat: string): void {
    const manifest = this.#manifest(gameId);
    if (!Object.hasOwn(manifest.stats ?? {}, stat)) {
      throw new SoloError("invalid-stat", `${gameId} has no best score ${stat}`);
    }
    if (this.#db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId) === undefined) {
      throw new SoloError("unknown-user", "This account does not exist");
    }
    this.#reset(userId, gameId, stat, this.#clock());
  }

  #reset(userId: number, gameId: string, stat: string, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO stats (user_id, game_id, stat, value, source, updated_at, generation) VALUES (?, ?, ?, NULL, 'client', ?, 1)
         ON CONFLICT (user_id, game_id, stat) DO UPDATE SET value = NULL, updated_at = excluded.updated_at, generation = stats.generation + 1`,
      )
      .run(userId, gameId, stat, now);
  }

  #view(userId: number, gameId: string, manifest: Manifest, ignored: string[]): SoloView {
    const row = this.#saveRow(userId, gameId);
    const save = row === undefined || row.data === null ? null : { data: JSON.parse(row.data) as unknown, savedAt: row.saved_at };
    const best: Record<string, number> = {};
    const generations: Record<string, number> = {};
    const stats = manifest.stats ?? {};
    for (const entry of this.#db.prepare("SELECT stat, value, updated_at, generation FROM stats WHERE user_id = ? AND game_id = ?").all(userId, gameId) as unknown as StatRow[]) {
      if (!Object.hasOwn(stats, entry.stat)) {
        continue;
      }
      if (entry.generation > 0) {
        generations[entry.stat] = entry.generation;
      }
      if (entry.value !== null) {
        best[entry.stat] = entry.value;
      }
    }
    const boards: Record<string, BoardEntry[]> = {};
    for (const [stat, spec] of Object.entries(stats)) {
      boards[stat] = this.#board(userId, gameId, stat, spec.better === "higher");
    }
    return { game: gameId, save, savedAt: row === undefined ? null : row.saved_at, best, generations, boards, ignored };
  }

  #board(userId: number, gameId: string, stat: string, higher: boolean): BoardEntry[] {
    const order = higher ? "DESC" : "ASC";
    const rows = this.#db
      .prepare(
        `SELECT s.user_id AS user, u.display_name AS name, s.value AS value FROM stats s JOIN users u ON u.id = s.user_id
         WHERE s.game_id = ? AND s.stat = ? AND s.value IS NOT NULL AND u.kind = 'account' AND u.locked = 0
         ORDER BY s.value ${order}, s.updated_at ASC, s.user_id ASC LIMIT ${boardSize}`,
      )
      .all(gameId, stat) as unknown as { user: number; name: string; value: number }[];
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
    if (!entries.some((entry) => entry.you)) {
      const own = this.#db.prepare("SELECT value FROM stats WHERE user_id = ? AND game_id = ? AND stat = ? AND value IS NOT NULL").get(userId, gameId, stat) as
        | { value: number }
        | undefined;
      if (own !== undefined) {
        const better = this.#db
          .prepare(
            `SELECT COUNT(*) AS n FROM stats s JOIN users u ON u.id = s.user_id
             WHERE s.game_id = ? AND s.stat = ? AND s.value IS NOT NULL AND u.kind = 'account' AND u.locked = 0 AND s.value ${higher ? ">" : "<"} ?`,
          )
          .get(gameId, stat, own.value) as { n: number };
        const name = (this.#db.prepare("SELECT display_name FROM users WHERE id = ?").get(userId) as { display_name: string } | undefined)?.display_name ?? "";
        entries.push({ rank: better.n + 1, name, value: own.value, you: true });
      }
    }
    return entries;
  }

  #saveRow(userId: number, gameId: string): SaveRow | undefined {
    return this.#db.prepare("SELECT data, saved_at FROM solo_saves WHERE user_id = ? AND game_id = ?").get(userId, gameId) as SaveRow | undefined;
  }

  #manifest(gameId: string): Manifest {
    const build = this.#library.current(gameId);
    if (build === undefined) {
      throw new SoloError("unknown-game", `The game ${gameId} is not installed on this server`);
    }
    if (!isSoloManifest(build.manifest)) {
      throw new SoloError("not-solo", `${defaultText(build.manifest.name, build.manifest.languages)} is not a single-player game without a reducer; it is played in a room`);
    }
    return build.manifest;
  }

  #requireAccount(userId: number): void {
    const row = this.#db.prepare("SELECT kind FROM users WHERE id = ?").get(userId) as { kind: string } | undefined;
    if (row?.kind !== "account") {
      throw new SoloError("account-required", "Only players with an account play single-player games");
    }
  }
}

export function parseSyncInput(raw: Record<string, unknown>): SyncInput | string {
  const input: SyncInput = {};
  const save = raw["save"];
  if (save !== undefined) {
    if (save === null || typeof save !== "object" || Array.isArray(save)) {
      return "save must be an object { data, savedAt } or { deleted: true, savedAt }";
    }
    const record = save as Record<string, unknown>;
    const savedAt = record["savedAt"];
    if (typeof savedAt !== "number" || !Number.isSafeInteger(savedAt) || savedAt < 0) {
      return "save.savedAt must be a time in milliseconds";
    }
    if (record["deleted"] === true) {
      input.save = { deleted: true, savedAt };
    } else {
      const problem = saveProblem(record["data"]);
      if (problem !== undefined) {
        return problem;
      }
      input.save = { data: record["data"], savedAt };
    }
  }
  const best = raw["best"];
  if (best !== undefined) {
    if (best === null || typeof best !== "object" || Array.isArray(best) || Object.keys(best).length > 50) {
      return "best must be an object with at most 50 best scores";
    }
    const parsed: Record<string, BestInput> = {};
    for (const [stat, entry] of Object.entries(best as Record<string, unknown>)) {
      if (!statNamePattern.test(stat) || entry === null || typeof entry !== "object") {
        return `best.${stat.slice(0, 40)} must be { value, at, generation }`;
      }
      const value = (entry as Record<string, unknown>)["value"];
      const at = (entry as Record<string, unknown>)["at"];
      const generation = (entry as Record<string, unknown>)["generation"] ?? 0;
      if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > maxStatValue || typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) {
        return `best.${stat} needs a finite number value and a time at`;
      }
      if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
        return `best.${stat}.generation must be a whole number from 0`;
      }
      parsed[stat] = { value, at, generation };
    }
    input.best = parsed;
  }
  return input;
}

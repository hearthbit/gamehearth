import {
  allowedPlayerCounts,
  applyChange,
  canonicalJson,
  checkMove,
  emptyProfile,
  hasCatalog,
  legalMoveFor,
  sampleMove,
  profileJson,
  readProfile,
  isPlayerCountAllowed,
  optionValueProblem,
  playerSnapshot,
  resolveOptions,
  screenSnapshot,
  seatIds,
  type AnyGameState,
  type GameOptions,
  type Localized,
  type Match,
  type OptionsSpec,
  type OptionValue,
  type PlayerCountSpec,
  type PlayerSnapshot,
  type ProfileChange,
  type ProfileData,
  type ScreenSnapshot,
} from "@gamehearth/sdk/platform";
import { catalogOf } from "gamehearth";
import { randomBytes, randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { hashToken } from "./accounts";
import { transaction } from "./db";
import { clientUrl, defaultText, languagesAndCover, type GameBuild, type GameLibrary, type LanguagesAndCover } from "./games";
import { ProfileService, type ProfileChangeEvent } from "./profiles";
import { RealtimeRooms, type LiveView, type ProfileRead, type RealtimeOptions } from "./realtime";
import type { HostResult, SandboxHost } from "./sandbox/host";
import { hasScreenRole, maxScreensPerRoom, requiresScreen } from "./screens";

export type RoomStatus = "lobby" | "running" | "finished";

export type RoomErrorCode =
  | "unknown-game"
  | "game-unavailable"
  | "unknown-room"
  | "unknown-user"
  | "not-member"
  | "account-required"
  | "too-many-rooms"
  | "unknown-member"
  | "room-full"
  | "already-started"
  | "not-host"
  | "wrong-player-count"
  | "not-running"
  | "not-finished"
  | "game-over"
  | "unknown-player"
  | "stale"
  | "not-your-turn"
  | "illegal-move"
  | "game-error"
  | "paused"
  | "too-many-inputs"
  | "screen-missing"
  | "no-screen-role"
  | "too-many-screens"
  | "unknown-screen"
  | "solo-game"
  | "invalid-option"
  | "missing-item"
  | "not-in-lobby"
  | "no-bots"
  | "member-connected"
  | "already-bot"
  | "not-handed-over"
  | "bot-playing";

function soloBuild(build: GameBuild): boolean {
  return build.manifest.mode === "single" && !build.manifest.server;
}

export class RoomError extends Error {
  readonly code: RoomErrorCode;

  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

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

export interface RoomSummary extends LanguagesAndCover {
  code: string;
  gameId: string;
  game: Localized;
  status: RoomStatus;
  round: number;
  members: number;
  host: boolean;
  yourTurn: boolean;
  muted: boolean;
  screen: boolean;
  updatedAt: number;
  expiresAt?: number;
}

export interface AdminRoomView {
  code: string;
  game: Localized;
  status: RoomStatus;
  round: number;
  createdAt: number;
  updatedAt: number;
  members: { name: string; host: boolean; guest: boolean; deleted: boolean; bot?: number }[];
}

export interface ClaimResult {
  userId: number | undefined;
  codes: string[];
}

export interface MemberView extends Member {
  you: boolean;
  connected: boolean;
}

export interface GameInfo extends LanguagesAndCover {
  id: string;
  name: Localized;
  version: string;
  client: string;
  mode: string;
  roles: string[];
  screenOptional?: true;
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

export interface RoomView {
  code: string;
  game: GameInfo;
  status: RoomStatus;
  round: number;
  players: PlayerCountSpec;
  maxMembers: number;
  members: MemberView[];
  screens: ScreenInfo[];
  you: Member;
  muted: boolean;
  canStart: boolean;
  installed: boolean;
  options?: RoomOptions;
  live?: LiveView;
  snapshot?: PlayerSnapshot<unknown, unknown, unknown>;
  profile?: ProfileData;
}

export interface ScreenView {
  code: string;
  screen: number;
  game: GameInfo;
  status: RoomStatus;
  round: number;
  players: PlayerCountSpec;
  maxMembers: number;
  members: MemberView[];
  screens: ScreenInfo[];
  installed: boolean;
  options?: RoomOptions;
  live?: LiveView;
  snapshot?: ScreenSnapshot<unknown>;
}

export interface Connected {
  members: ReadonlySet<number>;
  screens: ReadonlySet<number>;
}

export interface RoomServiceOptions {
  serverMaxPlayers: number;
  maxHostedRooms?: number;
  maxRoomsPerUser?: number;
  lobbyIdleMs?: number;
  finishedRoomMs?: number;
  idleGameMs?: number;
  clock?: () => number;
  log?: (message: string) => void;
  realtime?: Partial<RealtimeOptions>;
  profiles?: ProfileService;
  botDelayMs?: number;
}

const day = 24 * 60 * 60 * 1000;

export const roomDefaults = {
  maxHostedRooms: 20,
  maxRoomsPerUser: 50,
  lobbyIdleMs: day,
  finishedRoomMs: 30 * day,
  idleGameMs: 90 * day,
};

export type AlertKind = "turn" | "finished";

export interface RoomAlert {
  code: string;
  round: number;
  kind: AlertKind;
  game: Localized;
  languages?: readonly string[];
  users: number[];
}

export interface RoomEvents {
  changed?: (code: string) => void;
  frame?: (code: string) => void;
  screenPaired?: (device: string, code: string) => void;
  screenRemoved?: (device: string, code: string) => void;
  memberChanged?: (code: string, userId: number) => void;
  alert?: (alert: RoomAlert) => void;
  removed?: (code: string, memberIds: number[]) => void;
  closed?: (code: string) => void;
}

type AnyMatch = Match<AnyGameState, unknown>;

interface RoomRow {
  code: string;
  game_id: string;
  build: string;
  status: RoomStatus;
  version: number;
  round: number;
  match: string | null;
  options: string | null;
  guest_profiles: string | null;
}

interface MemberRow {
  id: number;
  user_id: number | null;
  name: string | null;
  kind: string | null;
  host: number;
  seat: string | null;
  muted: number;
  bot: number | null;
  autopilot: number;
}

export const maxBotProblemsLogged = 20;
export const maxBotFallbacks = 3;

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const codeLength = 6;
const maxMoveAttempts = 5;
const maxProfileAttempts = 5;

class ProfileConflict extends Error {}

interface SeatOwner {
  seat: string;
  user: number | null;
  account: boolean;
}

export class RoomService {
  readonly #db: DatabaseSync;
  readonly #library: GameLibrary;
  readonly #sandbox: SandboxHost;
  readonly #options: RoomServiceOptions;
  readonly #listeners: RoomEvents[] = [];
  readonly #realtime: RealtimeRooms;
  readonly #profiles: ProfileService;
  readonly #refreshing = new Map<string, Promise<void>>();
  readonly #refreshAgain = new Set<string>();
  readonly #botTimers = new Map<string, NodeJS.Timeout>();
  readonly #botsRunning = new Set<string>();
  readonly #botProblems = new Map<string, Set<string>>();
  #stopped = false;

  constructor(db: DatabaseSync, library: GameLibrary, sandbox: SandboxHost, options: RoomServiceOptions) {
    this.#db = db;
    this.#library = library;
    this.#sandbox = sandbox;
    this.#options = options;
    this.#profiles = options.profiles ?? new ProfileService(db, library, options.clock === undefined ? {} : { clock: options.clock });
    this.#profiles.onChange((event) => this.#profilesChanged(event));
    this.#realtime = new RealtimeRooms(
      sandbox,
      {
        profiles: (code, build) => this.#liveProfiles(code, build),
        commit: (code, round, build, match, changes, read) => this.#commitLive(code, round, build, match, changes, read),
        frame: (code) => this.#emit((events) => events.frame?.(code)),
        changed: (code) => this.#emit((events) => events.changed?.(code)),
        save: (code, round, match) => {
          this.#db
            .prepare("UPDATE rooms SET match = ?, version = ?, updated_at = ? WHERE code = ? AND status = 'running' AND round = ?")
            .run(JSON.stringify(match), match.version, this.#now(), code, round);
        },
        finished: (code, round, build, match) => this.#finishRealtime(code, round, build, match),
        failed: (code, build, result) => this.#failure(result, `Room ${code}, ${build.build}, tick`),
      },
      { ...(options.clock === undefined ? {} : { clock: options.clock }), ...(options.log === undefined ? {} : { log: options.log }), ...options.realtime },
    );
  }

  on(events: RoomEvents): void {
    this.#listeners.push(events);
  }

  get realtime(): RealtimeRooms {
    return this.#realtime;
  }

  get profiles(): ProfileService {
    return this.#profiles;
  }

  async whenRefreshed(): Promise<void> {
    while (this.#refreshing.size > 0) {
      await Promise.all([...this.#refreshing.values()]);
    }
  }

  isRealtime(code: string): boolean {
    return this.#realtime.has(normalizeCode(code));
  }

  async restoreRealtime(): Promise<string[]> {
    const rows = this.#db.prepare("SELECT code, round, build, match FROM rooms WHERE status = 'running' AND match IS NOT NULL").all() as unknown as {
      code: string;
      round: number;
      build: string;
      match: string;
    }[];
    const restored: string[] = [];
    for (const row of rows) {
      const match = JSON.parse(row.match) as AnyMatch;
      if (match.tick === undefined) {
        continue;
      }
      const build = await this.#library.load(row.build);
      if (build === undefined) {
        continue;
      }
      this.#realtime.attach(row.code, row.round, build, match, "paused", this.#botSeats(row.code));
      restored.push(row.code);
    }
    return restored;
  }

  restoreBots(): string[] {
    const rows = this.#db
      .prepare(
        "SELECT DISTINCT r.code FROM rooms r JOIN members m ON m.room_code = r.code WHERE r.status = 'running' AND r.match IS NOT NULL AND (m.bot IS NOT NULL OR m.autopilot = 1)",
      )
      .all() as unknown as { code: string }[];
    for (const row of rows) {
      this.#scheduleBots(row.code);
    }
    return rows.map((row) => row.code);
  }

  stop(): void {
    this.#stopped = true;
    this.#realtime.close();
    for (const timer of this.#botTimers.values()) {
      clearTimeout(timer);
    }
    this.#botTimers.clear();
  }

  async hasBots(gameId: string): Promise<boolean> {
    const build = this.#library.current(gameId);
    return build !== undefined && build.manifest.server && (await this.#sandbox.features(build.build)).bot;
  }

  async addBot(code: string, userId: number): Promise<void> {
    code = normalizeCode(code);
    const room = this.#room(code);
    const build = await this.#build(room);
    const bots = build.manifest.server && (await this.#sandbox.features(build.build)).bot;
    transaction(this.#db, () => {
      const member = this.member(code, userId);
      if (!member.host) {
        throw new RoomError("not-host", "Only the host can add bots");
      }
      if (this.#room(code).status !== "lobby") {
        throw new RoomError("not-in-lobby", "Bots can only be added in the lobby");
      }
      if (!bots) {
        throw new RoomError("no-bots", "This game has no bots");
      }
      const members = this.#members(code);
      if (members.length >= this.#maxMembers(build)) {
        throw new RoomError("room-full", "The room is full");
      }
      const used = new Set(members.map((row) => row.bot).filter((number): number is number => number !== null));
      let number = 1;
      while (used.has(number)) {
        number += 1;
      }
      this.#db.prepare("INSERT INTO members (room_code, user_id, host, seat, joined_at, bot) VALUES (?, NULL, 0, NULL, ?, ?)").run(code, this.#now(), number);
      this.#touch(code, this.#now());
    });
    this.#emit((events) => events.changed?.(code));
  }

  async handOver(code: string, userId: number, memberId: number, connected: ReadonlySet<number>): Promise<void> {
    code = normalizeCode(code);
    const room = this.#room(code);
    const build = await this.#build(room, false);
    const bots = build.manifest.server && (await this.#sandbox.features(build.build)).bot;
    transaction(this.#db, () => {
      const member = this.member(code, userId);
      if (this.#room(code).status !== "running") {
        throw new RoomError("not-running", "Seats can only be handed to a bot during a match");
      }
      if (!bots) {
        throw new RoomError("no-bots", "This game has no bots");
      }
      const target = this.#members(code).find((row) => row.id === memberId);
      if (target === undefined || target.seat === null || target.bot !== null) {
        throw new RoomError("unknown-member", "This member has no seat in the match");
      }
      if (target.id !== member.id) {
        if (!member.host) {
          throw new RoomError("not-host", "Only the host can hand someone else's seat to a bot");
        }
        if (connected.has(target.id)) {
          throw new RoomError("member-connected", "This member is still connected; they can hand over their seat themselves");
        }
      }
      if (target.autopilot === 1) {
        throw new RoomError("already-bot", "A bot is already playing this seat");
      }
      this.#db.prepare("UPDATE members SET autopilot = 1 WHERE id = ?").run(target.id);
      this.#touch(code, this.#now());
    });
    this.#botsChanged(code);
  }

  takeBack(code: string, userId: number): void {
    code = normalizeCode(code);
    transaction(this.#db, () => {
      const member = this.member(code, userId);
      if (member.autopilot !== true) {
        throw new RoomError("not-handed-over", "No bot is playing your seat");
      }
      this.#db.prepare("UPDATE members SET autopilot = 0 WHERE id = ?").run(member.id);
      this.#touch(code, this.#now());
    });
    this.#botsChanged(code);
  }

  #botsChanged(code: string): void {
    if (this.#realtime.has(code)) {
      this.#realtime.setBots(code, this.#botSeats(code));
    } else {
      this.#scheduleBots(code);
    }
    this.#emit((events) => events.changed?.(code));
  }

  #botSeats(code: string): string[] {
    return this.#members(code)
      .filter((row) => row.seat !== null && (row.bot !== null || row.autopilot === 1))
      .map((row) => row.seat as string);
  }

  #scheduleBots(code: string): void {
    if (this.#stopped || this.#botTimers.has(code) || this.#botsRunning.has(code)) {
      return;
    }
    const timer = setTimeout(() => {
      this.#botTimers.delete(code);
      this.#botsRunning.add(code);
      this.#runBot(code)
        .catch((error: unknown) => {
          this.#log(`[Bots] Room ${code}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
          return false;
        })
        .then((again) => {
          this.#botsRunning.delete(code);
          if (again) {
            this.#scheduleBots(code);
          }
        });
    }, this.#options.botDelayMs ?? 1000);
    timer.unref?.();
    this.#botTimers.set(code, timer);
  }

  async #runBot(code: string): Promise<boolean> {
    let room: RoomRow;
    try {
      room = this.#room(code);
    } catch {
      return false;
    }
    if (room.status !== "running" || room.match === null || this.#realtime.has(code)) {
      return false;
    }
    const match = JSON.parse(room.match) as AnyMatch;
    if (match.tick !== undefined || match.result !== undefined) {
      return false;
    }
    const seat = this.#botSeats(code).find((candidate) => (match.moves[candidate]?.length ?? 0) > 0);
    if (seat === undefined) {
      return false;
    }
    const build = await this.#build(room);
    const read = this.#readProfiles(build, room.game_id, this.#owners(code), room.guest_profiles);
    const now = this.#now();
    const result = await this.#sandbox.run(
      code,
      build.build,
      "botMove",
      `{"match":${room.match},"player":${JSON.stringify(seat)},"now":${now},"profiles":${JSON.stringify(read.profiles)}}`,
      { seed: match.seed, players: match.players, ...withOptions(match.options), version: match.version },
    );
    const available = match.moves[seat] ?? [];
    let action: unknown;
    if (result.ok && result.outcome.ok && result.outcome.bot !== undefined) {
      const choice = result.outcome.bot;
      if (choice.problem !== undefined) {
        this.#botProblem(code, build, seat, choice.problem);
      }
      action = choice.action === undefined ? undefined : legalMoveFor(available, choice.action)?.action;
      if (choice.action !== undefined && action === undefined) {
        this.#botProblem(code, build, seat, "the sandbox returned a bot move that is not legal");
      }
    } else {
      this.#botProblem(code, build, seat, result.ok ? (result.outcome.ok ? "the sandbox returned no bot choice" : result.outcome.error.message) : result.failure.message);
    }
    const tried = new Set<string>();
    const random = () => {
      const untried = available.filter((candidate) => !tried.has(canonicalJson(candidate)));
      const pool = untried.length > 0 ? untried : available;
      return sampleMove(pool[randomInt(pool.length)], { next: () => randomInt(2 ** 31) / 2 ** 31 });
    };
    for (let attempt = 0; attempt <= maxBotFallbacks; attempt++) {
      if (action === undefined || tried.has(canonicalJson(action))) {
        action = random();
      }
      tried.add(canonicalJson(action));
      try {
        await this.#moveSeat(code, seat, action, match.version);
        return true;
      } catch (error) {
        if (error instanceof RoomError && (error.code === "stale" || error.code === "not-running" || error.code === "game-over")) {
          return true;
        }
        this.#botProblem(code, build, seat, `the move ${canonicalJson(action).slice(0, 200)} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      action = undefined;
    }
    return false;
  }

  #botProblem(code: string, build: GameBuild, seat: string, message: string): void {
    const key = `${build.build}|${seat}|${message}`;
    const seen = this.#botProblems.get(code) ?? new Set<string>();
    if (seen.has(key) || seen.size >= maxBotProblemsLogged) {
      return;
    }
    seen.add(key);
    this.#botProblems.set(code, seen);
    this.#log(`[Bots] Room ${code}, ${build.build}, seat ${seat}: ${message}`);
  }

  #log(message: string): void {
    (this.#options.log ?? ((text: string) => console.error(text)))(message);
  }

  createRoom(gameId: string, userId: number): { code: string } {
    const build = this.#library.current(gameId);
    if (build === undefined) {
      throw new RoomError("unknown-game", `The game ${gameId} is not installed on this server`);
    }
    this.#requireUsable(build);
    if (this.#userKind(userId) !== "account") {
      throw new RoomError("account-required", "Only players with an account create rooms");
    }
    const now = this.#now();
    const code = transaction(this.#db, () => {
      this.#requireCapacity(userId, true);
      const fresh = this.#freeCode();
      this.#db
        .prepare("INSERT INTO rooms (code, game_id, build, status, created_at, updated_at) VALUES (?, ?, ?, 'lobby', ?, ?)")
        .run(fresh, gameId, build.build, now, now);
      this.#db
        .prepare("INSERT INTO members (room_code, user_id, host, joined_at) VALUES (?, ?, 1, ?)")
        .run(fresh, userId, now);
      return fresh;
    });
    return { code };
  }

  async joinRoom(code: string, userId: number): Promise<{ code: string; joined: boolean }> {
    code = normalizeCode(code);
    const build = await this.#build(this.#room(code));
    if (this.#userKind(userId) === undefined) {
      throw new RoomError("unknown-user", "This user does not exist");
    }
    const joined = transaction(this.#db, () => {
      const room = this.#room(code);
      if (this.#memberRow(code, userId) !== undefined) {
        return false;
      }
      if (room.status !== "lobby") {
        throw new RoomError("already-started", "The match in this room has already started");
      }
      if (this.#members(code).length >= this.#maxMembers(build)) {
        throw new RoomError("room-full", "The room is full");
      }
      this.#requireCapacity(userId, false);
      const now = this.#now();
      this.#db.prepare("INSERT INTO members (room_code, user_id, joined_at) VALUES (?, ?, ?)").run(code, userId, now);
      this.#touch(code, now);
      return true;
    });
    if (joined) {
      this.#emit((events) => events.changed?.(code));
    }
    return { code, joined };
  }

  member(code: string, userId: number): Member {
    code = normalizeCode(code);
    this.#room(code);
    const row = this.#memberRow(code, userId);
    if (row === undefined) {
      throw new RoomError("not-member", "You are not a member of this room");
    }
    return toMember(row);
  }

  rooms(userId: number): RoomSummary[] {
    const rows = this.#db
      .prepare(
        `SELECT r.code, r.game_id, r.build, r.status, r.round, r.updated_at, r.match, m.host, m.seat, m.muted, m.autopilot,
           (SELECT COUNT(*) FROM members other WHERE other.room_code = r.code AND other.user_id IS NOT NULL) AS member_count
         FROM members m JOIN rooms r ON r.code = m.room_code WHERE m.user_id = ? ORDER BY r.updated_at DESC, r.code`,
      )
      .all(userId) as unknown as {
      code: string;
      game_id: string;
      build: string;
      status: RoomStatus;
      round: number;
      updated_at: number;
      match: string | null;
      host: number;
      seat: string | null;
      muted: number;
      autopilot: number;
      member_count: number;
    }[];
    return rows.map((row) => {
      const expiresAt = this.#expiresAt(row.status, row.round, row.updated_at);
      const current = this.#library.current(row.game_id);
      return {
        code: row.code,
        gameId: row.game_id,
        game: this.#library.displayName(row.game_id, row.build),
        ...(current === undefined ? {} : languagesAndCover(current)),
        status: row.status,
        round: row.round,
        members: row.member_count,
        host: row.host === 1,
        yourTurn: row.status === "running" && row.seat !== null && row.autopilot !== 1 && row.match !== null && hasMoves(row.match, row.seat),
        muted: row.muted === 1,
        screen: current !== undefined && hasScreenRole(current.manifest),
        updatedAt: row.updated_at,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
    });
  }

  codes(userId: number): string[] {
    return (this.#db.prepare("SELECT room_code FROM members WHERE user_id = ?").all(userId) as unknown as { room_code: string }[]).map(
      (row) => row.room_code,
    );
  }

  claim(tokens: readonly string[], userId: number | undefined): ClaimResult {
    let target = userId;
    const codes: string[] = [];
    const orphans = new Set<number>();
    transaction(this.#db, () => {
      for (const token of tokens) {
        const row = this.#db
          .prepare("SELECT id, room_code, user_id FROM members WHERE legacy_token_hash = ?")
          .get(hashToken(token)) as { id: number; room_code: string; user_id: number | null } | undefined;
        if (row === undefined) {
          continue;
        }
        if (target === undefined && row.user_id !== null) {
          target = row.user_id;
        }
        if (target === undefined || (row.user_id !== target && this.#memberRow(row.room_code, target) !== undefined)) {
          continue;
        }
        if (row.user_id !== null && row.user_id !== target) {
          orphans.add(row.user_id);
        }
        this.#db.prepare("UPDATE members SET user_id = ?, legacy_token_hash = NULL WHERE id = ?").run(target, row.id);
        codes.push(row.room_code);
      }
      for (const orphan of orphans) {
        this.#db
          .prepare(
            "DELETE FROM users WHERE id = ? AND kind = 'guest' AND NOT EXISTS (SELECT 1 FROM members WHERE user_id = ?) AND NOT EXISTS (SELECT 1 FROM sessions WHERE user_id = ?)",
          )
          .run(orphan, orphan, orphan);
      }
    });
    for (const code of codes) {
      this.#emit((events) => events.changed?.(code));
    }
    return { userId: target, codes };
  }

  leave(code: string, userId: number): void {
    code = normalizeCode(code);
    const outcome = transaction(this.#db, () => {
      const member = this.member(code, userId);
      if (this.#room(code).status === "running") {
        throw new RoomError("already-started", "During the match the seat stays reserved; you can only leave in the lobby or after the end");
      }
      this.#db.prepare("DELETE FROM members WHERE id = ?").run(member.id);
      return { member, closed: this.#afterDeparture(code, member.host) };
    });
    this.#emit((events) => events.removed?.(code, [outcome.member.id]));
    this.#emit((events) => (outcome.closed ? events.closed?.(code) : events.changed?.(code)));
  }

  transferMemberships(fromUserId: number, toUserId: number): string[] {
    const codes = transaction(this.#db, () => {
      const rows = this.#db
        .prepare(
          "SELECT id, room_code FROM members WHERE user_id = ? AND room_code NOT IN (SELECT room_code FROM members WHERE user_id = ?) ORDER BY id",
        )
        .all(fromUserId, toUserId) as unknown as { id: number; room_code: string }[];
      for (const row of rows) {
        this.#db.prepare("UPDATE members SET user_id = ? WHERE id = ?").run(toUserId, row.id);
      }
      return rows.map((row) => row.room_code);
    });
    for (const code of codes) {
      this.#emit((events) => events.changed?.(code));
    }
    return codes;
  }

  removeUser(userId: number): void {
    const departures = transaction(this.#db, () => {
      const rows = this.#db
        .prepare("SELECT m.id, m.room_code, m.host, r.status FROM members m JOIN rooms r ON r.code = m.room_code WHERE m.user_id = ? ORDER BY m.id")
        .all(userId) as unknown as { id: number; room_code: string; host: number; status: RoomStatus }[];
      return rows.map((row) => {
        if (row.status === "running") {
          this.#db.prepare("UPDATE members SET user_id = NULL, host = 0 WHERE id = ?").run(row.id);
        } else {
          this.#db.prepare("DELETE FROM members WHERE id = ?").run(row.id);
        }
        return { code: row.room_code, member: row.id, closed: this.#afterDeparture(row.room_code, row.host === 1) };
      });
    });
    for (const departure of departures) {
      if (departure.closed) {
        this.#forget(departure.code);
      }
      this.#emit((events) => events.removed?.(departure.code, [departure.member]));
      this.#emit((events) => (departure.closed ? events.closed?.(departure.code) : events.changed?.(departure.code)));
    }
  }

  close(code: string): void {
    code = normalizeCode(code);
    const devices = this.#screenDevices(code);
    if (this.#db.prepare("DELETE FROM rooms WHERE code = ?").run(code).changes === 0) {
      throw new RoomError("unknown-room", `There is no room ${code}`);
    }
    this.#forget(code);
    this.#emit((events) => events.closed?.(code));
    this.#screensGone(code, devices);
  }

  membershipCounts(): Map<number, number> {
    const rows = this.#db
      .prepare("SELECT user_id, COUNT(*) AS count FROM members WHERE user_id IS NOT NULL GROUP BY user_id")
      .all() as unknown as { user_id: number; count: number }[];
    return new Map(rows.map((row) => [row.user_id, row.count]));
  }

  allRooms(): AdminRoomView[] {
    const rows = this.#db
      .prepare("SELECT code, game_id, build, status, round, created_at, updated_at FROM rooms ORDER BY updated_at DESC, code")
      .all() as unknown as { code: string; game_id: string; build: string; status: RoomStatus; round: number; created_at: number; updated_at: number }[];
    return rows.map((row) => ({
      code: row.code,
      game: this.#library.displayName(row.game_id, row.build),
      status: row.status,
      round: row.round,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      members: this.#members(row.code).map((member) => {
        const view = toMember(member);
        return { name: view.name, host: view.host, guest: view.guest, deleted: view.deleted, ...(view.bot === undefined ? {} : { bot: view.bot }) };
      }),
    }));
  }

  #afterDeparture(code: string, wasHost: boolean): boolean {
    this.#purgeOrphans(code);
    const remaining = this.#members(code).filter((row) => row.user_id !== null);
    if (remaining.length === 0) {
      this.#db.prepare("DELETE FROM rooms WHERE code = ?").run(code);
      return true;
    }
    if (wasHost) {
      this.#db.prepare("UPDATE members SET host = 1 WHERE id = ?").run((remaining[0] as MemberRow).id);
    }
    this.#touch(code, this.#now());
    return false;
  }

  kick(code: string, userId: number, memberId: number): void {
    code = normalizeCode(code);
    transaction(this.#db, () => {
      const member = this.member(code, userId);
      this.#requireLobby(code, "Kicking only works in the lobby");
      if (!member.host) {
        throw new RoomError("not-host", "Only the host can remove someone from the lobby");
      }
      const target = this.#members(code).find((row) => row.id === memberId);
      if (target === undefined || target.id === member.id) {
        throw new RoomError("unknown-member", "This member is not in the lobby");
      }
      this.#db.prepare("DELETE FROM members WHERE id = ?").run(memberId);
      this.#touch(code, this.#now());
    });
    this.#emit((events) => events.removed?.(code, [memberId]));
    this.#emit((events) => events.changed?.(code));
  }

  async start(code: string, userId: number): Promise<void> {
    code = normalizeCode(code);
    const before = this.#room(code);
    const build = this.#library.current(before.game_id);
    if (build === undefined) {
      throw new RoomError("game-unavailable", "This game is no longer installed on the server");
    }
    this.#requireUsable(build);
    const host = this.member(code, userId);
    this.#requireLobby(code, "The match in this room has already started");
    this.#purgeOrphans(code);
    if (!host.host) {
      throw new RoomError("not-host", "Only the host can start the match");
    }
    const members = this.#members(code);
    const spec = build.manifest.players;
    if (!isPlayerCountAllowed(spec, members.length, this.#options.serverMaxPlayers)) {
      const allowed = allowedPlayerCounts(spec, this.#options.serverMaxPlayers).join(", ");
      throw new RoomError("wrong-player-count", `${members.length} players are not allowed; allowed: ${allowed}`);
    }
    if (requiresScreen(build.manifest) && this.#realtime.screens(code) === 0) {
      throw new RoomError("screen-missing", "This game needs a paired and connected TV first");
    }
    const realtime = build.manifest.mode === "realtime";
    const seats = seatIds(members.length);
    const seed = randomBytes(16).toString("hex");
    const chosen = withOptions(resolveOptions(build.manifest.options, storedOptions(before.options)));
    const owners: SeatOwner[] = members.map((row, index) => ({ seat: seats[index] as string, user: row.user_id, account: row.kind === "account" }));
    for (let attempt = 1; ; attempt++) {
      const read = this.#readProfiles(build, before.game_id, owners, null);
      const outcome = await this.#sandbox.run(code, build.build, "createMatch", JSON.stringify({ playerCount: members.length, seed, ...chosen, profiles: read.profiles }), {
        seed,
        players: seats,
        ...chosen,
        version: 0,
        ...(realtime ? { tick: 0 } : {}),
      });
      const match = this.#accept(outcome, `Room ${code}, ${build.build}, start`, "The game could not start");
      const started = this.#conflictFree(() => this.#startTransaction(code, userId, before, build, members, seats, match, read));
      if (started) {
        if (realtime) {
          this.#realtime.attach(code, before.round, build, match, "countdown", this.#botSeats(code));
        }
        this.#emit((events) => events.changed?.(code));
        if (!realtime) {
          this.#alert(code, before.round, build, undefined, match);
          this.#scheduleBots(code);
        }
        return;
      }
      if (attempt >= maxProfileAttempts) {
        throw new RoomError("stale", "A profile changed several times during the start, please start again");
      }
    }
  }

  #startTransaction(
    code: string,
    userId: number,
    before: RoomRow,
    build: GameBuild,
    members: MemberRow[],
    seats: string[],
    match: AnyMatch,
    read: ProfileRead,
  ): boolean {
    return transaction(this.#db, () => {
      const member = this.member(code, userId);
      this.#requireLobby(code, "The match in this room has already started");
      if (!member.host) {
        throw new RoomError("not-host", "Only the host can start the match");
      }
      const now = this.#members(code);
      const room = this.#room(code);
      if (
        room.round !== before.round ||
        room.build !== before.build ||
        room.options !== before.options ||
        now.length !== members.length ||
        now.some((row, index) => row.id !== members[index]?.id)
      ) {
        throw new RoomError("stale", "The lobby changed during the start, please start again");
      }
      const assign = this.#db.prepare("UPDATE members SET seat = ? WHERE id = ?");
      members.forEach((row, index) => assign.run(seats[index] as string, row.id));
      const startedAt = this.#now();
      const throwaway = Object.fromEntries(Object.entries(read.users).filter(([, user]) => user === null).map(([seat]) => [seat, emptyProfile()]));
      const changed = this.#db
        .prepare("UPDATE rooms SET status = 'running', build = ?, match = ?, version = ?, guest_profiles = ?, updated_at = ? WHERE code = ? AND status = 'lobby' AND round = ?")
        .run(build.build, JSON.stringify(match), match.version, Object.keys(throwaway).length === 0 ? null : JSON.stringify(throwaway), startedAt, code, before.round);
      this.#verifyProfiles(code, before.game_id, read);
      if (changed.changes !== 1) {
        throw new RoomError("already-started", "The match in this room has already started");
      }
      const recorded = this.#historyProfiles(code, before.round, read.profiles);
      if (recorded !== null) {
        this.#db
          .prepare("INSERT INTO history (room_code, round, version, kind, seat, action, now, profiles) VALUES (?, ?, 0, 'start', NULL, NULL, ?, ?)")
          .run(code, before.round, startedAt, recorded);
      }
      return true;
    });
  }

  pause(code: string, userId: number, paused: boolean): void {
    code = normalizeCode(code);
    const member = this.member(code, userId);
    if (!member.host) {
      throw new RoomError("not-host", paused ? "Only the host can pause the match" : "Only the host can resume the match");
    }
    if (!this.#realtime.has(code)) {
      throw new RoomError("not-running", "No realtime match is running in this room right now");
    }
    if (paused) {
      this.#realtime.pause(code);
    } else {
      this.#realtime.resume(code);
    }
  }

  setMuted(code: string, userId: number, muted: boolean): void {
    code = normalizeCode(code);
    const member = this.member(code, userId);
    this.#db.prepare("UPDATE members SET muted = ? WHERE id = ?").run(muted ? 1 : 0, member.id);
    this.#emit((events) => events.memberChanged?.(code, userId));
  }

  alertDue(code: string, userId: number, kind: AlertKind, round: number): boolean {
    const room = this.#db.prepare("SELECT status, round, match FROM rooms WHERE code = ?").get(code) as
      | { status: RoomStatus; round: number; match: string | null }
      | undefined;
    const member = this.#memberRow(code, userId);
    if (room === undefined || room.round !== round || member === undefined || member.muted === 1 || member.seat === null) {
      return false;
    }
    if (kind === "turn" && member.autopilot === 1) {
      return false;
    }
    if (kind === "finished") {
      return room.status === "finished";
    }
    return room.status === "running" && room.match !== null && hasMoves(room.match, member.seat);
  }

  #alert(code: string, round: number, build: GameBuild, before: AnyMatch | undefined, after: AnyMatch): void {
    const kind: AlertKind = after.result === undefined ? "turn" : "finished";
    const seats =
      kind === "finished"
        ? after.players
        : after.players.filter((seat) => (after.moves[seat]?.length ?? 0) > 0 && (before?.moves[seat]?.length ?? 0) === 0);
    const wanted = new Set<string>(seats);
    const users = this.#members(code)
      .filter((row) => row.user_id !== null && row.muted === 0 && row.seat !== null && wanted.has(row.seat) && (kind === "finished" || row.autopilot === 0))
      .map((row) => row.user_id as number);
    if (users.length > 0) {
      const languages = build.manifest.languages;
      const alert: RoomAlert = { code, round, kind, game: build.manifest.name, ...(languages === undefined ? {} : { languages }), users };
      this.#emit((events) => events.alert?.(alert));
    }
  }

  async move(code: string, userId: number, action: unknown, expectedVersion?: number): Promise<void> {
    code = normalizeCode(code);
    if (this.#realtime.has(code)) {
      const member = this.member(code, userId);
      if (member.seat === null) {
        throw new RoomError("not-running", "You have no seat in this match");
      }
      if (member.autopilot === true) {
        throw new RoomError("bot-playing", "A bot is playing your seat; take it back first");
      }
      const result = await this.#realtime.input(code, member.seat, action);
      if (!result.ok) {
        throw new RoomError(result.code === "unknown-player" ? "not-member" : (result.code as RoomErrorCode), result.code === "missing-item" ? missingItemMessage : result.message);
      }
      return;
    }
    const seat = () => {
      const member = this.member(code, userId);
      if (member.autopilot === true) {
        throw new RoomError("bot-playing", "A bot is playing your seat; take it back first");
      }
      return member.seat;
    };
    await this.#moveAs(code, seat, action, expectedVersion);
  }

  async #moveSeat(code: string, seat: string, action: unknown, expectedVersion: number): Promise<void> {
    await this.#moveAs(code, () => (this.#botSeats(code).includes(seat) ? seat : null), action, expectedVersion);
  }

  async #moveAs(code: string, seatOf: () => string | null, action: unknown, expectedVersion: number | undefined): Promise<void> {
    let profileAttempts = 0;
    for (let attempt = 1; ; attempt++) {
      const applied = await this.#tryMove(code, seatOf, action, expectedVersion);
      if (applied === "profiles" && profileAttempts < maxProfileAttempts) {
        profileAttempts += 1;
        attempt -= 1;
        continue;
      }
      if (typeof applied === "object") {
        this.#emit((events) => events.changed?.(code));
        this.#alert(code, applied.round, applied.build, applied.before, applied.after);
        if (applied.users.length > 0) {
          this.#profiles.changed({ users: applied.users, game: applied.build.manifest.id, room: code });
        }
        this.#scheduleBots(code);
        return;
      }
      if (expectedVersion !== undefined || attempt >= maxMoveAttempts) {
        throw new RoomError("stale", "The match has changed in the meantime");
      }
    }
  }

  async #tryMove(
    code: string,
    seatOf: () => string | null,
    action: unknown,
    expectedVersion: number | undefined,
  ): Promise<{ round: number; build: GameBuild; before: AnyMatch; after: AnyMatch; users: number[] } | "version" | "profiles"> {
    const room = this.#room(code);
    const build = await this.#build(room);
    const seat = seatOf();
    if (room.status !== "running" || room.match === null || seat === null) {
      throw new RoomError(room.status === "finished" ? "game-over" : "not-running", "No match is running in this room right now");
    }
    const member = { seat };
    const match = JSON.parse(room.match) as AnyMatch;
    const now = this.#now();
    const checked = checkMove(match, { player: member.seat, action, now, ...(expectedVersion === undefined ? {} : { expectedVersion }) });
    if (!checked.ok) {
      throw new RoomError(checked.error.code as RoomErrorCode, checked.error.message);
    }
    const move = { player: member.seat, action: checked.action, now, expectedVersion: match.version };
    const read = this.#readProfiles(build, room.game_id, this.#owners(code), room.guest_profiles);
    const outcome = await this.#sandbox.run(
      code,
      build.build,
      "applyMove",
      `{"match":${room.match},"move":${JSON.stringify(move)},"profiles":${JSON.stringify(read.profiles)}}`,
      {
        seed: match.seed,
        players: match.players,
        ...withOptions(match.options),
        version: match.version + 1,
      },
    );
    if (outcome.ok && !outcome.outcome.ok && outcome.outcome.error.code === "missing-item") {
      throw new RoomError("missing-item", missingItemMessage);
    }
    const next = this.#accept(
      outcome,
      `Room ${code}, ${build.build}, seat ${member.seat}`,
      "An error occurred in the game, the move was not made",
    );
    const changes = outcome.ok && outcome.outcome.ok ? (outcome.outcome.changes ?? []) : [];
    let users: number[] = [];
    const written = this.#conflictFree(() =>
      transaction(this.#db, () => {
        if (seatOf() !== member.seat) {
          return false;
        }
        const changed = this.#db
          .prepare(
            "UPDATE rooms SET match = ?, status = ?, version = ?, updated_at = ? WHERE code = ? AND status = 'running' AND version = ? AND round = ?",
          )
          .run(JSON.stringify(next), next.result === undefined ? "running" : "finished", next.version, now, code, match.version, room.round);
        if (changed.changes !== 1) {
          return false;
        }
        this.#verifyProfiles(code, room.game_id, read);
        users = this.#writeChanges(code, build, read, changes, `Room ${code}, ${build.build}, seat ${member.seat}`);
        this.#db
          .prepare("INSERT INTO history (room_code, round, version, kind, seat, action, now, profiles) VALUES (?, ?, ?, 'move', ?, ?, ?, ?)")
          .run(code, room.round, next.version, member.seat, JSON.stringify(action), now, this.#historyProfiles(code, room.round, read.profiles));
        if (next.result !== undefined) {
          this.#db
            .prepare("INSERT INTO rounds (room_code, round, build, outcome, match, ended_at) VALUES (?, ?, ?, 'finished', ?, ?)")
            .run(code, room.round, room.build, JSON.stringify(next), now);
        }
        return true;
      }),
    );
    if (written === undefined) {
      return "profiles";
    }
    if (written && next.result !== undefined) {
      this.#sandbox.forget(code);
    }
    return written ? { round: room.round, build, before: match, after: next, users } : "version";
  }

  #conflictFree<T>(work: () => T): T | undefined {
    try {
      return work();
    } catch (error) {
      if (error instanceof ProfileConflict) {
        return undefined;
      }
      throw error;
    }
  }

  #owners(code: string): SeatOwner[] {
    return this.#members(code)
      .filter((row) => row.seat !== null)
      .map((row) => ({ seat: row.seat as string, user: row.user_id, account: row.user_id !== null && row.kind === "account" }));
  }

  #readProfiles(build: GameBuild, gameId: string, owners: readonly SeatOwner[], guestProfiles: string | null): ProfileRead {
    const profiles: Record<string, ProfileData> = {};
    const revisions: Record<string, number> = {};
    const users: Record<string, number | null> = {};
    if (!hasCatalog(catalogOf(build.manifest))) {
      for (const owner of owners) {
        profiles[owner.seat] = emptyProfile();
        users[owner.seat] = owner.account ? owner.user : null;
      }
      return { profiles, revisions, users, tracked: false };
    }
    const guests = parseGuestProfiles(guestProfiles);
    for (const owner of owners) {
      if (profileUser(owner, guests) !== null && owner.user !== null) {
        const stored = this.#profiles.read(owner.user, gameId);
        profiles[owner.seat] = stored.profile;
        revisions[owner.seat] = stored.revision;
        users[owner.seat] = owner.user;
      } else {
        profiles[owner.seat] = guests[owner.seat] ?? emptyProfile();
        users[owner.seat] = null;
      }
    }
    return { profiles, revisions, users, tracked: true };
  }

  #verifyProfiles(code: string, gameId: string, read: ProfileRead): void {
    if (!read.tracked) {
      return;
    }
    const guests = parseGuestProfiles((this.#db.prepare("SELECT guest_profiles FROM rooms WHERE code = ?").get(code) as { guest_profiles: string | null } | undefined)?.guest_profiles ?? null);
    for (const owner of this.#owners(code)) {
      if (Object.hasOwn(read.users, owner.seat) && read.users[owner.seat] !== profileUser(owner, guests)) {
        throw new ProfileConflict();
      }
    }
    for (const [seat, user] of Object.entries(read.users)) {
      if (user === null) {
        continue;
      }
      if (this.#profiles.revision(user, gameId) !== read.revisions[seat]) {
        throw new ProfileConflict();
      }
    }
  }

  #writeChanges(code: string, build: GameBuild, read: ProfileRead, changes: readonly ProfileChange[], where: string): number[] {
    if (changes.length === 0) {
      return [];
    }
    const catalog = catalogOf(build.manifest);
    const bySeat = new Map<string, ProfileChange[]>();
    for (const change of changes) {
      bySeat.set(change.player, [...(bySeat.get(change.player) ?? []), change]);
    }
    const guests = parseGuestProfiles((this.#db.prepare("SELECT guest_profiles FROM rooms WHERE code = ?").get(code) as { guest_profiles: string | null } | undefined)?.guest_profiles ?? null);
    let guestsChanged = false;
    const users: number[] = [];
    for (const [seat, seatChanges] of bySeat) {
      const user = Object.hasOwn(read.users, seat) ? read.users[seat] : null;
      if (user !== null && user !== undefined) {
        const problem = this.#profiles.apply(user, build.manifest.id, seatChanges, catalog);
        if (problem !== undefined) {
          const incident = this.#incident(where, `Profile change cannot be applied: ${problem}`, undefined);
          throw new RoomError("game-error", `An error occurred in the game (incident ${incident}). Details are in the server log.`);
        }
        users.push(user);
        continue;
      }
      const profile = guests[seat] ?? (read.profiles[seat] === undefined ? emptyProfile() : readProfile(read.profiles[seat]));
      for (const change of seatChanges) {
        const problem = applyChange(profile, change, catalog);
        if (problem !== undefined) {
          const incident = this.#incident(where, `Profile change cannot be applied: ${problem}`, undefined);
          throw new RoomError("game-error", `An error occurred in the game (incident ${incident}). Details are in the server log.`);
        }
      }
      guests[seat] = profile;
      guestsChanged = true;
    }
    if (guestsChanged) {
      this.#db.prepare("UPDATE rooms SET guest_profiles = ? WHERE code = ?").run(JSON.stringify(guests), code);
    }
    return users;
  }

  #historyProfiles(code: string, round: number, profiles: Readonly<Record<string, ProfileData>>): string | null {
    const text = profilesText(profiles);
    const last = this.#db
      .prepare("SELECT profiles FROM history WHERE room_code = ? AND round = ? AND profiles IS NOT NULL ORDER BY version DESC LIMIT 1")
      .get(code, round) as { profiles: string } | undefined;
    const baseline = last?.profiles ?? profilesText(Object.fromEntries(Object.keys(profiles).map((seat) => [seat, emptyProfile()])));
    return text === baseline ? null : text;
  }

  #liveProfiles(code: string, build: GameBuild): ProfileRead {
    const room = this.#room(code);
    return this.#readProfiles(build, room.game_id, this.#owners(code), room.guest_profiles);
  }

  #commitLive(code: string, round: number, build: GameBuild, match: AnyMatch, changes: readonly ProfileChange[], read: ProfileRead): "ok" | "conflict" | string {
    let users: number[] = [];
    try {
      const done = this.#conflictFree(() =>
        transaction(this.#db, () => {
          const room = this.#room(code);
          if (room.status !== "running" || room.round !== round) {
            return false;
          }
          this.#verifyProfiles(code, room.game_id, read);
          users = this.#writeChanges(code, build, read, changes, `Room ${code}, ${build.build}, tick`);
          this.#db.prepare("UPDATE rooms SET match = ?, version = ?, updated_at = ? WHERE code = ? AND status = 'running' AND round = ?").run(JSON.stringify(match), match.version, this.#now(), code, round);
          return true;
        }),
      );
      if (done === undefined) {
        return "conflict";
      }
      if (!done) {
        return "The match is no longer running";
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    if (users.length > 0) {
      this.#profiles.changed({ users, game: build.manifest.id, room: code });
    }
    return "ok";
  }

  #profilesChanged(event: ProfileChangeEvent): void {
    if (event.users.length === 0) {
      return;
    }
    const placeholders = event.users.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT r.code, r.status FROM rooms r JOIN members m ON m.room_code = r.code
         WHERE r.game_id = ? AND r.status != 'lobby' AND m.user_id IN (${placeholders})`,
      )
      .all(event.game, ...event.users) as unknown as { code: string; status: RoomStatus }[];
    for (const row of rows) {
      if (row.code === event.room) {
        continue;
      }
      if (row.status === "running" && !this.#realtime.has(row.code)) {
        this.#scheduleRefresh(row.code);
      } else {
        this.#emit((events) => events.changed?.(row.code));
      }
    }
  }

  #scheduleRefresh(code: string): void {
    if (this.#refreshing.has(code)) {
      this.#refreshAgain.add(code);
      return;
    }
    const run = async () => {
      do {
        this.#refreshAgain.delete(code);
        try {
          await this.#refresh(code);
        } catch (error) {
          (this.#options.log ?? console.error)(`[Profiles] Recomputing in room ${code} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } while (this.#refreshAgain.has(code));
      this.#refreshing.delete(code);
    };
    this.#refreshing.set(code, run());
  }

  async #refresh(code: string): Promise<void> {
    let room: RoomRow;
    try {
      room = this.#room(code);
    } catch {
      return;
    }
    if (room.status !== "running" || room.match === null || this.#realtime.has(code)) {
      this.#emit((events) => events.changed?.(code));
      return;
    }
    const match = JSON.parse(room.match) as AnyMatch;
    const build = await this.#library.load(room.build);
    if (build === undefined || match.tick !== undefined || match.result !== undefined || !hasCatalog(catalogOf(build.manifest))) {
      this.#emit((events) => events.changed?.(code));
      return;
    }
    const read = this.#readProfiles(build, room.game_id, this.#owners(code), room.guest_profiles);
    const outcome = await this.#sandbox.run(code, build.build, "refreshMatch", `{"match":${room.match},"profiles":${JSON.stringify(read.profiles)}}`, {
      seed: match.seed,
      players: match.players,
      ...withOptions(match.options),
      version: match.version + 1,
    });
    if (!outcome.ok || !outcome.outcome.ok) {
      this.#failure(outcome, `Room ${code}, ${build.build}, recompute moves after profile change`);
      this.#emit((events) => events.changed?.(code));
      return;
    }
    const next = outcome.outcome.match as unknown as AnyMatch;
    if (next.result !== undefined) {
      this.#incident(`Room ${code}, ${build.build}, recompute moves after profile change`, "recomputing returned a result although the state must not change", undefined);
      this.#emit((events) => events.changed?.(code));
      return;
    }
    if (canonicalJson(next.moves) === canonicalJson(match.moves)) {
      this.#emit((events) => events.changed?.(code));
      return;
    }
    const now = this.#now();
    const written = this.#conflictFree(() =>
      transaction(this.#db, () => {
        const changed = this.#db
          .prepare("UPDATE rooms SET match = ?, version = ?, updated_at = ? WHERE code = ? AND status = 'running' AND version = ? AND round = ?")
          .run(JSON.stringify(next), next.version, now, code, match.version, room.round);
        if (changed.changes !== 1) {
          return false;
        }
        this.#verifyProfiles(code, room.game_id, read);
        this.#db
          .prepare("INSERT INTO history (room_code, round, version, kind, seat, action, now, profiles) VALUES (?, ?, ?, 'refresh', NULL, NULL, ?, ?)")
          .run(code, room.round, next.version, now, profilesText(read.profiles));
        return true;
      }),
    );
    if (written === undefined) {
      this.#refreshAgain.add(code);
      return;
    }
    this.#emit((events) => events.changed?.(code));
    if (written) {
      this.#alert(code, room.round, build, match, next);
      this.#scheduleBots(code);
    }
  }

  async view(code: string, userId: number, connected: ReadonlySet<number> | Connected = new Set()): Promise<RoomView> {
    code = normalizeCode(code);
    const build = await this.#build(this.#room(code), false);
    const room = this.#room(code);
    const you = this.member(code, userId);
    const members = this.#members(code).map(toMember);
    const online = "members" in connected ? connected : { members: connected, screens: new Set<number>() };
    const bots = build.manifest.server && (await this.#sandbox.features(build.build)).bot;
    const view: RoomView = {
      code,
      game: { ...gameInfo(build), ...(bots ? { bots: true as const } : {}) },
      status: room.status,
      round: room.round,
      players: build.manifest.players,
      maxMembers: this.#maxMembers(build),
      members: members.map((member) => ({ ...member, you: member.id === you.id, connected: online.members.has(member.id) })),
      screens: this.#screenInfos(code, online.screens),
      you,
      muted: this.#memberRow(code, userId)?.muted === 1,
      canStart:
        room.status === "lobby" &&
        you.host &&
        isPlayerCountAllowed(build.manifest.players, members.length, this.#options.serverMaxPlayers) &&
        (!requiresScreen(build.manifest) || this.#realtime.screens(code) > 0),
      installed: this.#roomable(room.game_id),
    };
    const live = this.#realtime.view(code);
    if (live !== undefined) {
      view.live = live;
    }
    const match = this.#realtime.match(code) ?? (room.match === null ? undefined : (JSON.parse(room.match) as AnyMatch));
    const options = roomOptions(build, room, match);
    if (options !== undefined) {
      view.options = options;
    }
    if (match !== undefined && you.seat !== null) {
      view.snapshot = playerSnapshot(match, you.seat);
      const own = this.#readProfiles(build, room.game_id, this.#owners(code).filter((owner) => owner.seat === you.seat), room.guest_profiles).profiles[you.seat];
      view.profile = own ?? emptyProfile();
    }
    return view;
  }

  async setOption(code: string, userId: number, name: string, value: unknown): Promise<void> {
    code = normalizeCode(code);
    const build = await this.#build(this.#room(code));
    transaction(this.#db, () => {
      const member = this.member(code, userId);
      if (!member.host) {
        throw new RoomError("not-host", "Only the host sets the options");
      }
      const room = this.#room(code);
      if (room.status !== "lobby") {
        throw new RoomError("already-started", "Options can only be changed in the lobby");
      }
      if (room.build !== build.build) {
        throw new RoomError("stale", "The game was just updated, please choose again");
      }
      const spec = build.manifest.options;
      const problem = optionValueProblem(spec, name, value);
      if (problem !== undefined) {
        throw new RoomError("invalid-option", problem);
      }
      const next = { ...explicitChoices(spec, room.options), [name]: value };
      this.#db.prepare("UPDATE rooms SET options = ?, updated_at = ? WHERE code = ? AND status = 'lobby'").run(JSON.stringify(next), this.#now(), code);
    });
    this.#emit((events) => events.changed?.(code));
  }

  async screenView(code: string, screen: number, connected: Connected): Promise<ScreenView> {
    code = normalizeCode(code);
    const build = await this.#build(this.#room(code), false);
    const room = this.#room(code);
    const view: ScreenView = {
      code,
      screen,
      game: gameInfo(build),
      status: room.status,
      round: room.round,
      players: build.manifest.players,
      maxMembers: this.#maxMembers(build),
      members: this.#members(code)
        .map(toMember)
        .map((member) => ({ ...member, you: false, connected: connected.members.has(member.id) })),
      screens: this.#screenInfos(code, connected.screens),
      installed: this.#roomable(room.game_id),
    };
    const live = this.#realtime.view(code);
    if (live !== undefined) {
      view.live = live;
    }
    const match = this.#realtime.match(code) ?? (room.match === null ? undefined : (JSON.parse(room.match) as AnyMatch));
    const options = roomOptions(build, room, match);
    if (options !== undefined) {
      view.options = options;
    }
    if (match !== undefined) {
      view.snapshot = screenSnapshot(match);
    }
    return view;
  }

  liveSnapshot(code: string, seat: string | null): PlayerSnapshot<unknown, unknown, unknown> | ScreenSnapshot<unknown> | undefined {
    const match = this.#realtime.match(code);
    if (match === undefined) {
      return undefined;
    }
    if (seat === null) {
      return screenSnapshot(match);
    }
    return match.players.includes(seat) ? playerSnapshot(match, seat) : undefined;
  }

  seats(code: string): Map<number, string> {
    const seats = new Map<number, string>();
    for (const row of this.#members(code)) {
      if (row.seat !== null) {
        seats.set(row.id, row.seat);
      }
    }
    return seats;
  }

  async addScreen(code: string, userId: number, device: string): Promise<{ id: number; previous: string | undefined }> {
    code = normalizeCode(code);
    const build = await this.#build(this.#room(code), false);
    const result = transaction(this.#db, () => {
      this.member(code, userId);
      if (!hasScreenRole(build.manifest)) {
        throw new RoomError("no-screen-role", "This game has no TV view");
      }
      const previous = this.#db.prepare("SELECT id, room_code FROM screens WHERE device_hash = ?").get(device) as { id: number; room_code: string } | undefined;
      const others = (this.#db.prepare("SELECT COUNT(*) AS count FROM screens WHERE room_code = ? AND device_hash != ?").get(code, device) as { count: number }).count;
      if (others >= maxScreensPerRoom) {
        throw new RoomError("too-many-screens", `A room has at most ${maxScreensPerRoom} TVs. Remove one first.`);
      }
      const now = this.#now();
      this.#db.prepare("DELETE FROM screens WHERE device_hash = ?").run(device);
      const id = Number(
        this.#db
          .prepare("INSERT INTO screens (room_code, device_hash, paired_by, created_at, seen_at) VALUES (?, ?, ?, ?, ?)")
          .run(code, device, userId, now, now).lastInsertRowid,
      );
      return { id, previous: previous === undefined || previous.room_code === code ? undefined : previous.room_code };
    });
    if (result.previous !== undefined) {
      const previous = result.previous;
      this.#emit((events) => events.screenRemoved?.(device, previous));
      this.#emit((events) => events.changed?.(previous));
    }
    this.#emit((events) => events.screenPaired?.(device, code));
    this.#emit((events) => events.changed?.(code));
    return result;
  }

  removeScreen(code: string, userId: number, screenId: number): void {
    code = normalizeCode(code);
    const device = transaction(this.#db, () => {
      const member = this.member(code, userId);
      if (!member.host) {
        throw new RoomError("not-host", "Only the host can remove a TV");
      }
      const row = this.#db.prepare("SELECT device_hash FROM screens WHERE id = ? AND room_code = ?").get(screenId, code) as { device_hash: string } | undefined;
      if (row === undefined) {
        throw new RoomError("unknown-screen", "This TV is not in this room");
      }
      this.#db.prepare("DELETE FROM screens WHERE id = ?").run(screenId);
      return row.device_hash;
    });
    this.#emit((events) => events.screenRemoved?.(device, code));
    this.#emit((events) => events.changed?.(code));
  }

  screen(device: string): { id: number; code: string } | undefined {
    const row = this.#db.prepare("SELECT id, room_code FROM screens WHERE device_hash = ?").get(device) as { id: number; room_code: string } | undefined;
    return row === undefined ? undefined : { id: row.id, code: row.room_code };
  }

  touchScreens(ids: Iterable<number>): void {
    const now = this.#now();
    const touch = this.#db.prepare("UPDATE screens SET seen_at = ? WHERE id = ?");
    for (const id of ids) {
      touch.run(now, id);
    }
  }

  expireScreens(maxIdleMs: number, connected: ReadonlySet<number>): number {
    const cutoff = this.#now() - maxIdleMs;
    const stale = (this.#db.prepare("SELECT id, room_code, device_hash FROM screens WHERE seen_at < ?").all(cutoff) as unknown as {
      id: number;
      room_code: string;
      device_hash: string;
    }[]).filter((row) => !connected.has(row.id));
    for (const row of stale) {
      this.#db.prepare("DELETE FROM screens WHERE id = ?").run(row.id);
      this.#emit((events) => events.screenRemoved?.(row.device_hash, row.room_code));
      this.#emit((events) => events.changed?.(row.room_code));
    }
    return stale.length;
  }

  #screenInfos(code: string, connected: ReadonlySet<number>): ScreenInfo[] {
    return (this.#db.prepare("SELECT id FROM screens WHERE room_code = ? ORDER BY id").all(code) as unknown as { id: number }[]).map((row) => ({
      id: row.id,
      connected: connected.has(row.id),
    }));
  }

  #screenDevices(code: string): string[] {
    return (this.#db.prepare("SELECT device_hash FROM screens WHERE room_code = ?").all(code) as unknown as { device_hash: string }[]).map(
      (row) => row.device_hash,
    );
  }

  #screensGone(code: string, devices: readonly string[]): void {
    for (const device of devices) {
      this.#emit((events) => events.screenRemoved?.(device, code));
    }
  }

  #finishRealtime(code: string, round: number, build: GameBuild, match: AnyMatch): void {
    const now = this.#now();
    const written = transaction(this.#db, () => {
      const changed = this.#db
        .prepare("UPDATE rooms SET match = ?, status = 'finished', version = ?, updated_at = ? WHERE code = ? AND status = 'running' AND round = ?")
        .run(JSON.stringify(match), match.version, now, code, round);
      if (changed.changes !== 1) {
        return false;
      }
      this.#db
        .prepare("INSERT INTO rounds (room_code, round, build, outcome, match, ended_at) VALUES (?, ?, ?, 'finished', ?, ?)")
        .run(code, round, build.build, JSON.stringify(match), now);
      return true;
    });
    this.#sandbox.forget(code);
    if (written) {
      this.#emit((events) => events.changed?.(code));
      this.#alert(code, round, build, undefined, match);
    }
  }

  newRound(code: string, userId: number): void {
    this.#reset(normalizeCode(code), userId, "finished");
  }

  abort(code: string, userId: number): void {
    this.#reset(normalizeCode(code), userId, "running");
  }

  #reset(code: string, userId: number, from: "running" | "finished"): void {
    let devices: string[] = [];
    const closed = transaction(this.#db, () => {
      const member = this.member(code, userId);
      const room = this.#room(code);
      devices = this.#screenDevices(code);
      if (!member.host) {
        throw new RoomError("not-host", from === "finished" ? "Only the host can start a new round" : "Only the host can abort the match");
      }
      if (room.status !== from) {
        throw new RoomError(
          from === "finished" ? "not-finished" : "not-running",
          from === "finished" ? "A new round is only possible once the match is over" : "No match is running in this room right now",
        );
      }
      const installed = this.#library.current(room.game_id);
      const next = installed !== undefined && !soloBuild(installed) ? installed : undefined;
      if (installed !== undefined && next === undefined && from === "finished") {
        throw new RoomError("solo-game", `${defaultText(installed.manifest.name, installed.manifest.languages)} is now played alone and without a room; so there is no new round`);
      }
      if (next === undefined && from === "finished") {
        throw new RoomError("game-unavailable", "This game is no longer installed on the server; so there is no new round");
      }
      if (next === undefined) {
        this.#db.prepare("DELETE FROM rooms WHERE code = ?").run(code);
        return true;
      }
      const now = this.#now();
      if (room.match !== null) {
        this.#db
          .prepare("INSERT OR IGNORE INTO rounds (room_code, round, build, outcome, match, ended_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(code, room.round, room.build, from === "running" ? "aborted" : "finished", room.match, now);
      }
      this.#db
        .prepare("UPDATE rooms SET status = 'lobby', match = NULL, version = 0, round = round + 1, build = ?, options = ?, guest_profiles = NULL, updated_at = ? WHERE code = ? AND round = ?")
        .run(next.build, keptOptions(next, room.options), now, code, room.round);
      this.#db.prepare("DELETE FROM members WHERE room_code = ? AND user_id IS NULL AND bot IS NULL").run(code);
      this.#db.prepare("UPDATE members SET seat = NULL, autopilot = 0 WHERE room_code = ?").run(code);
      return false;
    });
    this.#forget(code);
    this.#emit((events) => (closed ? events.closed?.(code) : events.changed?.(code)));
    if (closed) {
      this.#screensGone(code, devices);
    }
  }

  gameChanged(gameId: string): { moved: string[]; closed: string[]; touched: string[] } {
    const installed = this.#library.current(gameId);
    const current = installed !== undefined && !soloBuild(installed) ? installed : undefined;
    const result = transaction(this.#db, () => {
      const lobbies = this.#db.prepare("SELECT code, build, options FROM rooms WHERE game_id = ? AND status = 'lobby'").all(gameId) as unknown as {
        code: string;
        build: string;
        options: string | null;
      }[];
      const others = (this.#db.prepare("SELECT code FROM rooms WHERE game_id = ? AND status != 'lobby'").all(gameId) as unknown as { code: string }[]).map(
        (row) => row.code,
      );
      if (current === undefined) {
        this.#db.prepare("DELETE FROM rooms WHERE game_id = ? AND status = 'lobby'").run(gameId);
        return { moved: [], closed: lobbies.map((row) => row.code), touched: others };
      }
      const moved = lobbies.filter((row) => row.build !== current.build).map((row) => row.code);
      const move = this.#db.prepare("UPDATE rooms SET build = ?, options = ? WHERE code = ? AND status = 'lobby'");
      for (const row of lobbies) {
        move.run(current.build, keptOptions(current, row.options), row.code);
      }
      return { moved, closed: [], touched: others };
    });
    for (const code of result.closed) {
      this.#forget(code);
      this.#emit((events) => events.closed?.(code));
    }
    for (const code of [...result.moved, ...result.touched]) {
      this.#emit((events) => events.changed?.(code));
    }
    return result;
  }

  referencedBuilds(): Set<string> {
    return new Set((this.#db.prepare("SELECT DISTINCT build FROM rooms").all() as unknown as { build: string }[]).map((row) => row.build));
  }

  gameRoomCounts(): Map<string, { lobby: number; running: number; finished: number }> {
    const rows = this.#db.prepare("SELECT game_id, status, COUNT(*) AS count FROM rooms GROUP BY game_id, status").all() as unknown as {
      game_id: string;
      status: RoomStatus;
      count: number;
    }[];
    const counts = new Map<string, { lobby: number; running: number; finished: number }>();
    for (const row of rows) {
      const entry = counts.get(row.game_id) ?? { lobby: 0, running: 0, finished: 0 };
      entry[row.status] = row.count;
      counts.set(row.game_id, entry);
    }
    return counts;
  }

  expireIdleLobbies(maxIdleMs: number): string[] {
    const cutoff = this.#now() - maxIdleMs;
    const codes = transaction(this.#db, () => {
      const rows = this.#db
        .prepare("SELECT code FROM rooms WHERE status = 'lobby' AND round = 1 AND updated_at < ?")
        .all(cutoff) as unknown as { code: string }[];
      this.#db.prepare("DELETE FROM rooms WHERE status = 'lobby' AND round = 1 AND updated_at < ?").run(cutoff);
      return rows.map((row) => row.code);
    });
    for (const code of codes) {
      this.#emit((events) => events.closed?.(code));
    }
    return codes;
  }

  expireRooms(): string[] {
    const now = this.#now();
    const finishedCutoff = now - this.#limit("finishedRoomMs");
    const idleCutoff = now - this.#limit("idleGameMs");
    const condition = "((status = 'finished' OR (status = 'lobby' AND round > 1)) AND updated_at < ?) OR (status = 'running' AND updated_at < ?)";
    const codes = transaction(this.#db, () => {
      const rows = this.#db.prepare(`SELECT code FROM rooms WHERE ${condition}`).all(finishedCutoff, idleCutoff) as unknown as { code: string }[];
      this.#db.prepare(`DELETE FROM rooms WHERE ${condition}`).run(finishedCutoff, idleCutoff);
      return rows.map((row) => row.code);
    });
    for (const code of codes) {
      this.#forget(code);
      this.#emit((events) => events.closed?.(code));
    }
    return codes;
  }

  #expiresAt(status: RoomStatus, round: number, updatedAt: number): number | undefined {
    if (status === "running") {
      return updatedAt + this.#limit("idleGameMs");
    }
    if (status === "finished" || round > 1) {
      return updatedAt + this.#limit("finishedRoomMs");
    }
    return undefined;
  }

  #limit<K extends keyof typeof roomDefaults>(key: K): number {
    return this.#options[key] ?? roomDefaults[key];
  }

  #requireCapacity(userId: number, hosting: boolean): void {
    const maxRooms = this.#limit("maxRoomsPerUser");
    const memberships = (this.#db.prepare("SELECT COUNT(*) AS count FROM members WHERE user_id = ?").get(userId) as { count: number }).count;
    if (memberships >= maxRooms) {
      throw new RoomError("too-many-rooms", `You are already in ${memberships} rooms. Leave one first; at most ${maxRooms} are possible.`);
    }
    if (!hosting || this.#userRole(userId) === "admin") {
      return;
    }
    const maxHosted = this.#limit("maxHostedRooms");
    const hosted = (
      this.#db
        .prepare("SELECT COUNT(*) AS count FROM members m JOIN rooms r ON r.code = m.room_code WHERE m.user_id = ? AND m.host = 1 AND r.status != 'finished'")
        .get(userId) as { count: number }
    ).count;
    if (hosted >= maxHosted) {
      throw new RoomError("too-many-rooms", `You already host ${hosted} open rooms. End or leave one first; at most ${maxHosted} are possible.`);
    }
  }

  #userRole(userId: number): string | undefined {
    return (this.#db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined)?.role;
  }

  #purgeOrphans(code: string): void {
    this.#db
      .prepare("DELETE FROM members WHERE room_code = ? AND user_id IS NULL AND bot IS NULL AND (SELECT status FROM rooms WHERE code = ?) != 'running'")
      .run(code, code);
  }

  #requireLobby(code: string, message: string): void {
    if (this.#room(code).status !== "lobby") {
      throw new RoomError("already-started", message);
    }
  }

  #room(code: string): RoomRow {
    const row = this.#db
      .prepare("SELECT code, game_id, build, status, version, round, match, options, guest_profiles FROM rooms WHERE code = ?")
      .get(code) as RoomRow | undefined;
    if (row === undefined) {
      throw new RoomError("unknown-room", `There is no room ${code}`);
    }
    return row;
  }

  #members(code: string): MemberRow[] {
    return this.#db
      .prepare(
        "SELECT m.id, m.user_id, u.display_name AS name, u.kind, m.host, m.seat, m.muted, m.bot, m.autopilot FROM members m LEFT JOIN users u ON u.id = m.user_id WHERE m.room_code = ? ORDER BY m.id",
      )
      .all(code) as unknown as MemberRow[];
  }

  #memberRow(code: string, userId: number): MemberRow | undefined {
    return this.#db
      .prepare(
        "SELECT m.id, m.user_id, u.display_name AS name, u.kind, m.host, m.seat, m.muted, m.bot, m.autopilot FROM members m JOIN users u ON u.id = m.user_id WHERE m.room_code = ? AND m.user_id = ?",
      )
      .get(code, userId) as MemberRow | undefined;
  }

  #userKind(userId: number): string | undefined {
    return (this.#db.prepare("SELECT kind FROM users WHERE id = ?").get(userId) as { kind: string } | undefined)?.kind;
  }

  #touch(code: string, now: number): void {
    this.#db.prepare("UPDATE rooms SET updated_at = ? WHERE code = ?").run(now, code);
  }

  async #build(room: RoomRow, usable = true): Promise<GameBuild> {
    const build = await this.#library.load(room.build);
    if (build === undefined) {
      throw new RoomError("game-unavailable", `The build ${room.build} of this room is not installed or damaged`);
    }
    if (usable) {
      this.#requireUsable(build);
    }
    return build;
  }

  #roomable(gameId: string): boolean {
    const current = this.#library.current(gameId);
    return current !== undefined && !soloBuild(current);
  }

  #requireUsable(build: GameBuild): void {
    if (soloBuild(build)) {
      throw new RoomError("solo-game", `${defaultText(build.manifest.name, build.manifest.languages)} is played alone and without a room: tap "Play" ("Spielen") in the game list`);
    }
    if (this.#sandbox.quarantined(build.build)) {
      throw new RoomError("game-unavailable", "This build is quarantined after repeated crashes. Details are in the server log.");
    }
  }

  #maxMembers(build: GameBuild): number {
    return Math.min(build.manifest.players.max ?? this.#options.serverMaxPlayers, this.#options.serverMaxPlayers);
  }

  #freeCode(): string {
    for (;;) {
      const code = Array.from({ length: codeLength }, () => codeAlphabet[randomInt(codeAlphabet.length)]).join("");
      if (this.#db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code) === undefined) {
        return code;
      }
    }
  }

  #accept(result: HostResult, where: string, failed: string): AnyMatch {
    if (result.ok && result.outcome.ok) {
      return result.outcome.match as unknown as AnyMatch;
    }
    if (!result.ok && result.failure.kind === "quarantine") {
      this.#incident(where, result.failure.message, undefined);
      throw new RoomError("game-unavailable", "This build is quarantined after repeated crashes. Details are in the server log.");
    }
    const incident = result.ok
      ? this.#incident(
          where,
          result.outcome.ok
            ? "unexpected result"
            : result.outcome.error.code === "game-error"
              ? result.outcome.error.message
              : `unexpected rejection (${result.outcome.error.code}): ${result.outcome.error.message}`,
          result.outcome.ok ? undefined : result.outcome.error.stack,
        )
      : this.#incident(where, `Sandbox (${result.failure.kind}): ${result.failure.message}`, "stack" in result.failure ? result.failure.stack : undefined);
    throw new RoomError("game-error", `${failed} (incident ${incident}). Details are in the server log.`);
  }

  #failure(result: HostResult, where: string): string {
    if (result.ok && result.outcome.ok) {
      return this.#incident(where, "unexpected result", undefined);
    }
    if (result.ok) {
      const error = result.outcome.ok ? undefined : result.outcome.error;
      return this.#incident(
        where,
        error === undefined ? "unexpected result" : error.code === "game-error" ? error.message : `unexpected rejection (${error.code}): ${error.message}`,
        error?.stack,
      );
    }
    return this.#incident(where, `Sandbox (${result.failure.kind}): ${result.failure.message}`, "stack" in result.failure ? result.failure.stack : undefined);
  }

  #forget(code: string): void {
    this.#realtime.detach(code);
    this.#realtime.forgetPresence(code);
    this.#sandbox.forget(code);
  }

  #incident(where: string, message: string, stack: string | undefined): string {
    const incident = randomBytes(4).toString("hex");
    (this.#options.log ?? console.error)(`[Incident ${incident}] ${where}: ${message}${stack === undefined ? "" : `\n${stack}`}`);
    return incident;
  }

  #now(): number {
    return (this.#options.clock ?? Date.now)();
  }

  #emit(call: (events: RoomEvents) => void): void {
    for (const events of this.#listeners) {
      call(events);
    }
  }
}

export function normalizeCode(code: string): string {
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}

function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    name: row.user_id === null ? "" : (row.name ?? ""),
    seat: row.seat,
    host: row.host === 1,
    guest: row.kind === "guest",
    deleted: row.user_id === null && row.bot === null,
    ...(row.bot === null ? {} : { bot: row.bot }),
    ...(row.autopilot === 1 ? { autopilot: true as const } : {}),
  };
}

const missingItemMessage = "Something this move needs is now missing from the profile; the move was not made";

function profileUser(owner: SeatOwner, guests: Readonly<Record<string, ProfileData>>): number | null {
  return Object.hasOwn(guests, owner.seat) || !owner.account ? null : owner.user;
}

function parseGuestProfiles(raw: string | null): Record<string, ProfileData> {
  const result: Record<string, ProfileData> = {};
  if (raw === null) {
    return result;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [seat, profile] of Object.entries(parsed)) {
      try {
        result[seat] = readProfile(profile);
      } catch {
        result[seat] = emptyProfile();
      }
    }
  } catch {
    return result;
  }
  return result;
}

function profilesText(profiles: Readonly<Record<string, ProfileData>>): string {
  return `{${Object.keys(profiles)
    .sort()
    .map((seat) => `${JSON.stringify(seat)}:${profileJson(profiles[seat] as ProfileData)}`)
    .join(",")}}`;
}

function storedOptions(raw: string | null): unknown {
  if (raw === null) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function explicitChoices(spec: OptionsSpec | undefined, raw: string | null): Record<string, OptionValue> {
  const stored = storedOptions(raw);
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(stored as Record<string, unknown>).filter((entry): entry is [string, OptionValue] => optionValueProblem(spec, entry[0], entry[1]) === undefined),
  );
}

function keptOptions(build: GameBuild, raw: string | null): string | null {
  const kept = explicitChoices(build.manifest.options, raw);
  return Object.keys(kept).length === 0 ? null : JSON.stringify(kept);
}

function withOptions(options: GameOptions | undefined): { options?: GameOptions } {
  return options === undefined || Object.keys(options).length === 0 ? {} : { options };
}

function roomOptions(build: GameBuild, room: RoomRow, match: AnyMatch | undefined): RoomOptions | undefined {
  const spec = build.manifest.options;
  if (spec === undefined) {
    return undefined;
  }
  return { spec, values: resolveOptions(spec, match === undefined ? storedOptions(room.options) : match.options) };
}

function gameInfo(build: GameBuild): GameInfo {
  return {
    id: build.manifest.id,
    name: build.manifest.name,
    version: build.manifest.version,
    client: clientUrl(build.build),
    mode: build.manifest.mode,
    roles: Object.keys(build.manifest.roles),
    ...(build.manifest.roles.screen?.optional === true ? { screenOptional: true as const } : {}),
    ...(build.manifest.away === "play-on" ? { away: "play-on" as const } : {}),
    ...languagesAndCover(build),
  };
}

function hasMoves(match: string, seat: string): boolean {
  try {
    const parsed = JSON.parse(match) as { moves?: Record<string, unknown>; tick?: unknown };
    if (parsed.tick !== undefined) {
      return false;
    }
    const moves = parsed.moves?.[seat];
    return Array.isArray(moves) && moves.length > 0;
  } catch {
    return false;
  }
}

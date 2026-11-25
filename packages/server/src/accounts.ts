import { createHash, createHmac, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db";
import { isUiLanguage, type UiLanguage } from "./languages";
import { isUiTheme, uiThemes, type UiTheme } from "./themes";

export type UserKind = "account" | "guest";
export type Role = "player" | "admin";
export type LinkKind = "setup" | "invite" | "reset";

export type AccountErrorCode =
  | "bad-name"
  | "bad-username"
  | "bad-password"
  | "username-taken"
  | "wrong-login"
  | "wrong-password"
  | "login-throttled"
  | "account-locked"
  | "unknown-link"
  | "unknown-code"
  | "signed-in"
  | "unknown-user"
  | "unknown-session"
  | "last-admin"
  | "invalid-language"
  | "invalid-theme";

export class AccountError extends Error {
  readonly code: AccountErrorCode;
  readonly retryAfterMs: number | undefined;

  constructor(code: AccountErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface User {
  id: number;
  kind: UserKind;
  username?: string;
  name: string;
  role: Role;
  locked: boolean;
  language: UiLanguage | null;
  theme: UiTheme | null;
}

export interface Session {
  id: number;
  user: User;
  adoptGuest?: number;
}

export interface NewSession {
  token: string;
  session: Session;
}

export interface DeviceInfo {
  browser?: string;
  system?: string;
}

export interface SessionInfo extends DeviceInfo {
  id: number;
  createdAt: number;
  seenAt: number;
  current: boolean;
}

export interface LinkInfo {
  kind: LinkKind;
  role: Role;
  expiresAt: number;
  username?: string;
  name?: string;
}

export interface InviteInfo {
  id: number;
  role: Role;
  note?: string;
  username?: string;
  name?: string;
  createdAt: number;
  expiresAt: number;
  createdBy?: string;
}

export interface UserSummary {
  id: number;
  username: string;
  name: string;
  role: Role;
  locked: boolean;
  createdAt: number;
  activeAt: number;
}

export interface PasswordCost {
  N: number;
  r: number;
  p: number;
}

export interface AccountOptions {
  clock?: () => number;
  passwordCost?: PasswordCost;
  sessionMs?: number;
  guestIdleMs?: number;
  inviteMs?: number;
  resetMs?: number;
  transferMs?: number;
}

export interface TransferCode {
  code: string;
  expiresAt: number;
}

export interface AccountEvents {
  sessionsEnded?: (sessionIds: number[]) => void;
  userChanged?: (userId: number) => void;
}

export const defaultPasswordCost: PasswordCost = { N: 2 ** 16, r: 8, p: 2 };
export const minPasswordLength = 10;
export const maxPasswordLength = 200;
export const maxNameLength = 24;
export const maxNoteLength = 80;
export const sessionDays = 90;
export const guestIdleDays = 30;
const day = 24 * 60 * 60 * 1000;
const touchEveryMs = 60 * 60 * 1000;
const throttleFreeFailures = 5;
const throttleBaseMs = 30_000;
const throttleMaxMs = 15 * 60 * 1000;
const globalFailureWindowMs = 60 * 60 * 1000;
export const globalFailuresPerName = 50;

export class Slots {
  readonly #size: number;
  readonly #waiting: (() => void)[] = [];
  #active = 0;
  peak = 0;

  constructor(size: number) {
    this.#size = size;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#size) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#active += 1;
    this.peak = Math.max(this.peak, this.#active);
    try {
      return await work();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }

  resetPeak(): void {
    this.peak = this.#active;
  }
}

export const passwordSlots = new Slots(2);
const usernamePattern = /^[A-Za-z0-9._-]{3,32}$/;
const transferAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const transferLength = 8;
const transferPattern = new RegExp(`^[${transferAlphabet}]{${transferLength}}$`);
export const transferMinutes = 10;

interface UserRow {
  id: number;
  kind: UserKind;
  username: string | null;
  display_name: string;
  role: Role;
  locked: number;
  language: string | null;
  theme: string | null;
}

interface SessionRow extends UserRow {
  session_id: number;
  adopt_guest_id: number | null;
  seen_at: number;
  expires_at: number | null;
}

interface LinkRow {
  id: number;
  kind: LinkKind;
  role: Role;
  user_id: number | null;
  note: string | null;
  username: string | null;
  display_name: string | null;
  expires_at: number;
}

export class AccountService {
  readonly #db: DatabaseSync;
  readonly #clock: () => number;
  readonly #cost: PasswordCost;
  readonly #sessionMs: number;
  readonly #guestIdleMs: number;
  readonly #inviteMs: number;
  readonly #resetMs: number;
  readonly #transferMs: number;
  readonly #transferKey = randomBytes(32);
  readonly #listeners: AccountEvents[] = [];
  readonly #throttle = new Map<string, { failures: number; until: number; last: number }>();
  readonly #nameFailures = new Map<string, { count: number; start: number }>();
  readonly #touched = new Map<number, number>();
  #dummy: Promise<string> | undefined;

  constructor(db: DatabaseSync, options: AccountOptions = {}) {
    this.#db = db;
    this.#clock = options.clock ?? Date.now;
    this.#cost = options.passwordCost ?? defaultPasswordCost;
    this.#sessionMs = options.sessionMs ?? sessionDays * day;
    this.#guestIdleMs = options.guestIdleMs ?? guestIdleDays * day;
    this.#inviteMs = options.inviteMs ?? 7 * day;
    this.#resetMs = options.resetMs ?? day;
    this.#transferMs = options.transferMs ?? transferMinutes * 60 * 1000;
  }

  on(events: AccountEvents): void {
    this.#listeners.push(events);
  }

  user(id: number): User {
    const row = this.#db
      .prepare("SELECT id, kind, username, display_name, role, locked, language, theme FROM users WHERE id = ?")
      .get(id) as UserRow | undefined;
    if (row === undefined) {
      throw new AccountError("unknown-user", "This user does not exist");
    }
    return toUser(row);
  }

  createGuest(name: string): User {
    const display = validName(name);
    const now = this.#clock();
    const id = Number(
      this.#db
        .prepare("INSERT INTO users (kind, display_name, created_at, active_at) VALUES ('guest', ?, ?, ?)")
        .run(display, now, now).lastInsertRowid,
    );
    return this.user(id);
  }

  createSession(userId: number, agent = "", adoptGuest?: number): NewSession {
    const token = newToken();
    const now = this.#clock();
    const user = this.user(userId);
    const expires = user.kind === "account" ? now + this.#sessionMs : null;
    const id = Number(
      this.#db
        .prepare(
          "INSERT INTO sessions (token_hash, user_id, adopt_guest_id, agent, created_at, seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(hashToken(token), userId, adoptGuest ?? null, agent.slice(0, 300), now, now, expires).lastInsertRowid,
    );
    return { token, session: { id, user, ...(adoptGuest === undefined ? {} : { adoptGuest }) } };
  }

  session(token: string | undefined): Session | undefined {
    if (token === undefined || token === "") {
      return undefined;
    }
    const row = this.#db
      .prepare(
        `SELECT s.id AS session_id, s.adopt_guest_id, s.seen_at, s.expires_at, u.id, u.kind, u.username, u.display_name, u.role, u.locked, u.language, u.theme
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(hashToken(token)) as SessionRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    const now = this.#clock();
    if ((row.expires_at !== null && row.expires_at <= now) || row.locked === 1) {
      this.#db.prepare("DELETE FROM sessions WHERE id = ?").run(row.session_id);
      return undefined;
    }
    if (now - row.seen_at >= touchEveryMs) {
      this.#db
        .prepare("UPDATE sessions SET seen_at = ?, expires_at = CASE WHEN expires_at IS NULL THEN NULL ELSE ? END WHERE id = ?")
        .run(now, now + this.#sessionMs, row.session_id);
      this.touch(row.id);
    }
    return { id: row.session_id, user: toUser(row), ...(row.adopt_guest_id === null ? {} : { adoptGuest: row.adopt_guest_id }) };
  }

  touch(userId: number): void {
    const now = this.#clock();
    if (now - (this.#touched.get(userId) ?? -Infinity) < touchEveryMs) {
      return;
    }
    this.#touched.set(userId, now);
    if (this.#touched.size > 10_000) {
      this.#touched.clear();
    }
    this.#db.prepare("UPDATE users SET active_at = ? WHERE id = ?").run(now, userId);
  }

  sessions(userId: number, currentId: number): SessionInfo[] {
    const rows = this.#db
      .prepare("SELECT id, agent, created_at, seen_at FROM sessions WHERE user_id = ? ORDER BY seen_at DESC, id DESC")
      .all(userId) as unknown as { id: number; agent: string; created_at: number; seen_at: number }[];
    return rows.map((row) => ({ id: row.id, ...describeDevice(row.agent), createdAt: row.created_at, seenAt: row.seen_at, current: row.id === currentId }));
  }

  endSession(sessionId: number, userId?: number): void {
    const changed =
      userId === undefined
        ? this.#db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId)
        : this.#db.prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?").run(sessionId, userId);
    if (changed.changes === 0) {
      throw new AccountError("unknown-session", "This session does not exist");
    }
    this.#emit((events) => events.sessionsEnded?.([sessionId]));
  }

  endAllSessions(userId: number, except?: number): number[] {
    const ids = (
      this.#db.prepare("SELECT id FROM sessions WHERE user_id = ? AND id IS NOT ?").all(userId, except ?? null) as unknown as { id: number }[]
    ).map((row) => row.id);
    this.#db.prepare("DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?").run(userId, except ?? null);
    if (ids.length > 0) {
      this.#emit((events) => events.sessionsEnded?.(ids));
    }
    return ids;
  }

  endNewerSessions(userId: number, sessionId: number): number[] {
    const ids = (this.#db.prepare("SELECT id FROM sessions WHERE user_id = ? AND id > ?").all(userId, sessionId) as unknown as { id: number }[]).map(
      (row) => row.id,
    );
    this.#db.prepare("DELETE FROM sessions WHERE user_id = ? AND id > ?").run(userId, sessionId);
    if (ids.length > 0) {
      this.#emit((events) => events.sessionsEnded?.(ids));
    }
    return ids;
  }

  hasSessions(userId: number): boolean {
    return this.#db.prepare("SELECT 1 FROM sessions WHERE user_id = ?").get(userId) !== undefined;
  }

  clearAdoption(sessionId: number): void {
    this.#db.prepare("UPDATE sessions SET adopt_guest_id = NULL WHERE id = ?").run(sessionId);
  }

  async login(username: string, password: string, current: Session | undefined, agent = "", address = ""): Promise<NewSession> {
    const key = typeof username === "string" ? username.trim().toLowerCase() : "";
    const attempt = this.#attempt(key, address);
    const row = usernamePattern.test(key)
      ? (this.#db
          .prepare(
            `SELECT u.id, u.kind, u.username, u.display_name, u.role, u.locked, u.language, u.theme, c.secret FROM users u
             JOIN credentials c ON c.user_id = u.id AND c.kind = 'password' WHERE u.username = ?`,
          )
          .get(key) as (UserRow & { secret: string }) | undefined)
      : undefined;
    const valid = typeof password === "string" && password.length <= maxPasswordLength;
    const ok = await verifyPassword(valid ? password : "", row?.secret ?? (await this.#dummyHash()));
    if (row === undefined || !ok || !valid) {
      throw new AccountError("wrong-login", "Wrong username or password");
    }
    attempt.succeeded();
    if (row.locked === 1) {
      throw new AccountError("account-locked", "This account is locked. Contact an admin.");
    }
    if (needsRehash(row.secret, this.#cost)) {
      this.#db.prepare("UPDATE credentials SET secret = ? WHERE user_id = ? AND kind = 'password'").run(await hashPassword(password, this.#cost), row.id);
    }
    let adopt: number | undefined;
    if (current !== undefined) {
      if (current.user.kind === "guest") {
        adopt = current.user.id;
      }
      this.#db.prepare("DELETE FROM sessions WHERE id = ?").run(current.id);
      this.#emit((events) => events.sessionsEnded?.([current.id]));
    }
    this.touch(row.id);
    return this.createSession(row.id, agent, adopt);
  }

  logout(session: Session): void {
    this.endSession(session.id);
  }

  createTransferCode(session: Session): TransferCode {
    const raw = Array.from({ length: transferLength }, () => transferAlphabet[randomInt(transferAlphabet.length)]).join("");
    const now = this.#clock();
    const expiresAt = now + this.#transferMs;
    transaction(this.#db, () => {
      this.#db.prepare("DELETE FROM transfer_codes WHERE user_id = ?").run(session.user.id);
      this.#db
        .prepare("INSERT INTO transfer_codes (code_hash, user_id, session_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .run(this.#transferHash(raw), session.user.id, session.id, now, expiresAt);
    });
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
  }

  redeemTransferCode(code: string, current: Session | undefined, agent = ""): NewSession {
    const normalized = normalizeTransferCode(code);
    const now = this.#clock();
    const userId = transaction(this.#db, () => {
      const row =
        normalized === undefined
          ? undefined
          : (this.#db
              .prepare("SELECT t.id, t.user_id, t.expires_at, u.locked, u.role FROM transfer_codes t JOIN users u ON u.id = t.user_id WHERE t.code_hash = ?")
              .get(this.#transferHash(normalized)) as { id: number; user_id: number; expires_at: number; locked: number; role: Role } | undefined);
      if (row === undefined || row.expires_at <= now || row.locked === 1 || row.role === "admin") {
        if (row !== undefined) {
          this.#db.prepare("DELETE FROM transfer_codes WHERE id = ?").run(row.id);
        }
        return undefined;
      }
      this.#db.prepare("DELETE FROM transfer_codes WHERE id = ?").run(row.id);
      return row.user_id;
    });
    if (userId === undefined) {
      throw new AccountError("unknown-code", "This code is invalid, expired or already used");
    }
    let adopt: number | undefined;
    if (current !== undefined) {
      if (current.user.kind === "guest" && current.user.id !== userId) {
        adopt = current.user.id;
      }
      this.#db.prepare("DELETE FROM sessions WHERE id = ?").run(current.id);
      this.#emit((events) => events.sessionsEnded?.([current.id]));
    }
    this.touch(userId);
    return this.createSession(userId, agent, adopt);
  }

  async changePassword(session: Session, currentPassword: string, password: string, address = ""): Promise<void> {
    const attempt = this.#attempt((session.user.username ?? `#${session.user.id}`).toLowerCase(), address);
    const row = this.#db.prepare("SELECT secret FROM credentials WHERE user_id = ? AND kind = 'password'").get(session.user.id) as
      | { secret: string }
      | undefined;
    if (row === undefined || typeof currentPassword !== "string" || !(await verifyPassword(currentPassword.slice(0, maxPasswordLength), row.secret))) {
      throw new AccountError("wrong-password", "The current password is wrong");
    }
    attempt.succeeded();
    const secret = await hashPassword(validPassword(password), this.#cost);
    this.#db.prepare("UPDATE credentials SET secret = ? WHERE user_id = ? AND kind = 'password'").run(secret, session.user.id);
    this.#db.prepare("DELETE FROM links WHERE kind = 'reset' AND user_id = ?").run(session.user.id);
    this.endAllSessions(session.user.id, session.id);
  }

  setLanguage(userId: number, language: unknown): User {
    if (language !== null && !isUiLanguage(language)) {
      throw new AccountError("invalid-language", 'language must be "en", "de" or null (the device decides)');
    }
    this.#db.prepare("UPDATE users SET language = ? WHERE id = ?").run(language, userId);
    return this.user(userId);
  }

  setTheme(userId: number, theme: unknown): User {
    if (theme !== null && !isUiTheme(theme)) {
      throw new AccountError("invalid-theme", `theme must be one of ${uiThemes.map((name) => `"${name}"`).join(", ")} or null (the default)`);
    }
    this.#db.prepare("UPDATE users SET theme = ? WHERE id = ?").run(theme, userId);
    return this.user(userId);
  }

  rename(userId: number, name: string): User {
    const display = validName(name);
    this.#db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(display, userId);
    this.#emit((events) => events.userChanged?.(userId));
    return this.user(userId);
  }

  findAccount(username: string): User | undefined {
    const row = this.#db.prepare("SELECT id FROM users WHERE kind = 'account' AND username = ?").get(String(username).trim()) as { id: number } | undefined;
    return row === undefined ? undefined : this.user(row.id);
  }

  hasAdmin(): boolean {
    return this.#db.prepare("SELECT 1 FROM users WHERE kind = 'account' AND role = 'admin' AND locked = 0 LIMIT 1").get() !== undefined;
  }

  ensureSetupLink(): string | undefined {
    if (this.hasAdmin()) {
      this.#db.prepare("DELETE FROM links WHERE kind = 'setup'").run();
      return undefined;
    }
    return transaction(this.#db, () => {
      this.#db.prepare("DELETE FROM links WHERE kind = 'setup'").run();
      return this.#createLink({ kind: "setup", role: "admin", expiresInMs: this.#resetMs });
    });
  }

  createInvite(
    createdBy: number | undefined,
    options: { role: Role; note?: string; username?: string; name?: string; expiresInMs?: number },
  ): { token: string; invite: InviteInfo } {
    const role = options.role === "admin" ? "admin" : "player";
    const note = optionalText(options.note, maxNoteLength, "The note");
    const username = options.username === undefined || options.username.trim() === "" ? undefined : validUsername(options.username);
    const name = options.name === undefined || options.name.trim() === "" ? undefined : validName(options.name);
    const token = this.#createLink({
      kind: "invite",
      role,
      expiresInMs: options.expiresInMs ?? this.#inviteMs,
      ...(note === undefined ? {} : { note }),
      ...(username === undefined ? {} : { username }),
      ...(name === undefined ? {} : { name }),
      ...(createdBy === undefined ? {} : { createdBy }),
    });
    const invite = this.invites().find((candidate) => candidate.id === this.#linkId(token));
    return { token, invite: invite as InviteInfo };
  }

  invites(): InviteInfo[] {
    const rows = this.#db
      .prepare(
        `SELECT l.id, l.role, l.note, l.username, l.display_name, l.created_at, l.expires_at, u.username AS creator FROM links l
         LEFT JOIN users u ON u.id = l.created_by WHERE l.kind = 'invite' AND l.expires_at > ? ORDER BY l.created_at DESC, l.id DESC`,
      )
      .all(this.#clock()) as unknown as {
      id: number;
      role: Role;
      note: string | null;
      username: string | null;
      display_name: string | null;
      created_at: number;
      expires_at: number;
      creator: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...(row.note === null ? {} : { note: row.note }),
      ...(row.username === null ? {} : { username: row.username }),
      ...(row.display_name === null ? {} : { name: row.display_name }),
      ...(row.creator === null ? {} : { createdBy: row.creator }),
    }));
  }

  revokeInvite(id: number): void {
    if (this.#db.prepare("DELETE FROM links WHERE id = ? AND kind = 'invite'").run(id).changes === 0) {
      throw new AccountError("unknown-link", "This invite no longer exists");
    }
  }

  createResetLink(userId: number, createdBy?: number): string {
    const user = this.user(userId);
    if (user.kind !== "account") {
      throw new AccountError("unknown-user", "Guests have no password");
    }
    return transaction(this.#db, () => {
      this.#db.prepare("DELETE FROM links WHERE kind = 'reset' AND user_id = ?").run(userId);
      return this.#createLink({ kind: "reset", role: user.role, expiresInMs: this.#resetMs, userId, ...(createdBy === undefined ? {} : { createdBy }) });
    });
  }

  inspectLink(token: string, kinds: readonly LinkKind[]): LinkInfo {
    const row = this.#link(token, kinds);
    const target = row.user_id === null ? undefined : this.user(row.user_id);
    const username = target?.username ?? row.username ?? undefined;
    const name = target?.name ?? row.display_name ?? undefined;
    return {
      kind: row.kind,
      role: row.role,
      expiresAt: row.expires_at,
      ...(username === undefined ? {} : { username }),
      ...(name === undefined ? {} : { name }),
    };
  }

  async acceptInvite(
    token: string,
    details: { username: string; name: string; password: string },
    current: Session | undefined,
    agent = "",
  ): Promise<NewSession & { upgraded: boolean }> {
    if (current?.user.kind === "account") {
      throw new AccountError("signed-in", "You are already signed in with an account. Sign out to use this invite.");
    }
    this.#link(token, ["invite", "setup"]);
    const username = validUsername(details.username);
    const name = validName(details.name);
    const secret = await hashPassword(validPassword(details.password), this.#cost);
    const now = this.#clock();
    const ended: number[] = [];
    const userId = transaction(this.#db, () => {
      const link = this.#link(token, ["invite", "setup"]);
      if (link.kind === "setup" && this.hasAdmin()) {
        throw new AccountError("unknown-link", "Gamehearth is already set up");
      }
      if (this.#db.prepare("SELECT 1 FROM users WHERE username = ?").get(username) !== undefined) {
        throw new AccountError("username-taken", "This username is already taken");
      }
      let id: number;
      if (current !== undefined) {
        id = current.user.id;
        this.#db
          .prepare("UPDATE users SET kind = 'account', username = ?, display_name = ?, role = ?, active_at = ? WHERE id = ? AND kind = 'guest'")
          .run(username, name, link.role, now, id);
        ended.push(...(this.#db.prepare("SELECT id FROM sessions WHERE user_id = ?").all(id) as unknown as { id: number }[]).map((row) => row.id));
        this.#db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      } else {
        id = Number(
          this.#db
            .prepare("INSERT INTO users (kind, username, display_name, role, created_at, active_at) VALUES ('account', ?, ?, ?, ?, ?)")
            .run(username, name, link.role, now, now).lastInsertRowid,
        );
      }
      this.#db.prepare("INSERT INTO credentials (user_id, kind, secret, created_at) VALUES (?, 'password', ?, ?)").run(id, secret, now);
      this.#db.prepare("DELETE FROM links WHERE id = ?").run(link.id);
      if (link.kind === "setup") {
        this.#db.prepare("DELETE FROM links WHERE kind = 'setup'").run();
      }
      return id;
    });
    if (current !== undefined) {
      this.#emit((events) => events.sessionsEnded?.(ended));
      this.#emit((events) => events.userChanged?.(userId));
    }
    return { ...this.createSession(userId, agent), upgraded: current !== undefined };
  }

  async resetPassword(token: string, password: string): Promise<User> {
    this.#link(token, ["reset"]);
    const secret = await hashPassword(validPassword(password), this.#cost);
    const userId = transaction(this.#db, () => {
      const link = this.#link(token, ["reset"]);
      const id = link.user_id as number;
      this.#db.prepare("DELETE FROM credentials WHERE user_id = ? AND kind = 'password'").run(id);
      this.#db.prepare("INSERT INTO credentials (user_id, kind, secret, created_at) VALUES (?, 'password', ?, ?)").run(id, secret, this.#clock());
      this.#db.prepare("DELETE FROM links WHERE id = ?").run(link.id);
      return id;
    });
    this.endAllSessions(userId);
    const user = this.user(userId);
    if (user.username !== undefined) {
      this.#forgetFailures(user.username.toLowerCase());
    }
    return user;
  }

  users(): UserSummary[] {
    const rows = this.#db
      .prepare("SELECT id, username, display_name, role, locked, created_at, active_at FROM users WHERE kind = 'account' ORDER BY username COLLATE NOCASE")
      .all() as unknown as { id: number; username: string; display_name: string; role: Role; locked: number; created_at: number; active_at: number }[];
    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      name: row.display_name,
      role: row.role,
      locked: row.locked === 1,
      createdAt: row.created_at,
      activeAt: row.active_at,
    }));
  }

  updateUser(userId: number, changes: { role?: Role; locked?: boolean; username?: string }): User {
    const user = this.user(userId);
    if (user.kind !== "account") {
      throw new AccountError("unknown-user", "Guests cannot be managed");
    }
    const username = changes.username === undefined ? undefined : validUsername(changes.username);
    transaction(this.#db, () => {
      const losesAdmin = user.role === "admin" && !user.locked && (changes.role === "player" || changes.locked === true);
      if (losesAdmin && this.#otherAdmins(userId) === 0) {
        throw new AccountError("last-admin", "The last admin cannot be demoted or locked");
      }
      if (username !== undefined && this.#db.prepare("SELECT 1 FROM users WHERE username = ? AND id != ?").get(username, userId) !== undefined) {
        throw new AccountError("username-taken", "This username is already taken");
      }
      this.#db
        .prepare("UPDATE users SET role = COALESCE(?, role), locked = COALESCE(?, locked), username = COALESCE(?, username) WHERE id = ?")
        .run(changes.role ?? null, changes.locked === undefined ? null : changes.locked ? 1 : 0, username ?? null, userId);
    });
    if (changes.locked === true) {
      this.endAllSessions(userId);
      this.#db.prepare("DELETE FROM links WHERE kind = 'reset' AND user_id = ?").run(userId);
    }
    if (changes.locked === true || (user.role === "admin" && changes.role === "player")) {
      this.#db.prepare("DELETE FROM links WHERE created_by = ?").run(userId);
    }
    if (username !== undefined && user.username !== undefined) {
      this.#forgetFailures(user.username.toLowerCase());
    }
    this.#emit((events) => events.userChanged?.(userId));
    return this.user(userId);
  }

  requireDeletable(userId: number): User {
    const user = this.user(userId);
    if (user.kind === "account" && user.role === "admin" && !user.locked && this.#otherAdmins(userId) === 0) {
      throw new AccountError("last-admin", "The last admin cannot be deleted");
    }
    return user;
  }

  deleteUser(userId: number): void {
    this.requireDeletable(userId);
    const sessions = (this.#db.prepare("SELECT id FROM sessions WHERE user_id = ?").all(userId) as unknown as { id: number }[]).map((row) => row.id);
    this.#db.prepare("DELETE FROM links WHERE created_by = ?").run(userId);
    this.#db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    this.#touched.delete(userId);
    if (sessions.length > 0) {
      this.#emit((events) => events.sessionsEnded?.(sessions));
    }
  }

  expiredGuests(): number[] {
    const cutoff = this.#clock() - this.#guestIdleMs;
    return (
      this.#db.prepare("SELECT id FROM users WHERE kind = 'guest' AND active_at < ? ORDER BY id").all(cutoff) as unknown as { id: number }[]
    ).map((row) => row.id);
  }

  sweep(): void {
    const now = this.#clock();
    const expired = (
      this.#db.prepare("SELECT id FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= ?").all(now) as unknown as { id: number }[]
    ).map((row) => row.id);
    this.#db.prepare("DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
    if (expired.length > 0) {
      this.#emit((events) => events.sessionsEnded?.(expired));
    }
    this.#db.prepare("DELETE FROM links WHERE expires_at <= ?").run(now);
    this.#db.prepare("DELETE FROM transfer_codes WHERE expires_at <= ?").run(now);
    this.#sweepThrottle(now);
  }

  throttleEntries(): number {
    return this.#throttle.size + this.#nameFailures.size;
  }

  #forgetFailures(name: string): void {
    for (const key of this.#throttle.keys()) {
      if (key.startsWith(`${name}|`)) {
        this.#throttle.delete(key);
      }
    }
    this.#nameFailures.delete(name);
  }

  #sweepThrottle(now: number): void {
    for (const [key, entry] of this.#throttle) {
      if (entry.until <= now && now - entry.last >= throttleMaxMs) {
        this.#throttle.delete(key);
      }
    }
    for (const [key, entry] of this.#nameFailures) {
      if (now - entry.start >= globalFailureWindowMs) {
        this.#nameFailures.delete(key);
      }
    }
  }

  #attempt(name: string, address: string): { succeeded(): void } {
    const now = this.#clock();
    const key = `${name}|${address}`;
    const local = this.#throttle.get(key);
    if (local !== undefined && local.until > now) {
      throw new AccountError("login-throttled", "Too many failed attempts for this name, please try again later", local.until - now);
    }
    let global = this.#nameFailures.get(name);
    if (global !== undefined && now - global.start >= globalFailureWindowMs) {
      this.#nameFailures.delete(name);
      global = undefined;
    }
    if (global !== undefined && global.count >= globalFailuresPerName) {
      throw new AccountError("login-throttled", "Too many failed attempts for this name, please try again later", global.start + globalFailureWindowMs - now);
    }
    const entry = local ?? { failures: 0, until: 0, last: now };
    entry.failures += 1;
    entry.last = now;
    if (entry.failures >= throttleFreeFailures) {
      entry.until = now + Math.min(throttleMaxMs, throttleBaseMs * 2 ** (entry.failures - throttleFreeFailures));
    }
    this.#throttle.set(key, entry);
    const counted = global ?? { count: 0, start: now };
    counted.count += 1;
    this.#nameFailures.set(name, counted);
    if (this.#throttle.size + this.#nameFailures.size > 20_000) {
      this.#sweepThrottle(now);
    }
    return {
      succeeded: () => {
        this.#throttle.delete(key);
        const current = this.#nameFailures.get(name);
        if (current !== undefined) {
          current.count = Math.max(0, current.count - 1);
        }
      },
    };
  }

  #transferHash(code: string): string {
    return createHmac("sha256", this.#transferKey).update(code).digest("hex");
  }

  #otherAdmins(userId: number): number {
    return (
      this.#db
        .prepare("SELECT COUNT(*) AS count FROM users WHERE kind = 'account' AND role = 'admin' AND locked = 0 AND id != ?")
        .get(userId) as { count: number }
    ).count;
  }

  #dummyHash(): Promise<string> {
    this.#dummy ??= hashPassword(randomBytes(16).toString("hex"), this.#cost);
    return this.#dummy;
  }

  #createLink(options: {
    kind: LinkKind;
    role: Role;
    expiresInMs: number;
    userId?: number;
    note?: string;
    username?: string;
    name?: string;
    createdBy?: number;
  }): string {
    const token = newToken();
    const now = this.#clock();
    this.#db
      .prepare(
        "INSERT INTO links (token_hash, kind, role, user_id, note, username, display_name, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        hashToken(token),
        options.kind,
        options.role,
        options.userId ?? null,
        options.note ?? null,
        options.username ?? null,
        options.name ?? null,
        options.createdBy ?? null,
        now,
        now + options.expiresInMs,
      );
    return token;
  }

  #linkId(token: string): number | undefined {
    return (this.#db.prepare("SELECT id FROM links WHERE token_hash = ?").get(hashToken(token)) as { id: number } | undefined)?.id;
  }

  #link(token: string, kinds: readonly LinkKind[]): LinkRow {
    const row =
      typeof token === "string" && token !== ""
        ? (this.#db
            .prepare("SELECT id, kind, role, user_id, note, username, display_name, expires_at FROM links WHERE token_hash = ?")
            .get(hashToken(token)) as LinkRow | undefined)
        : undefined;
    if (row === undefined || !kinds.includes(row.kind) || row.expires_at <= this.#clock()) {
      throw new AccountError("unknown-link", "This link is invalid, expired or already used");
    }
    return row;
  }

  #emit(call: (events: AccountEvents) => void): void {
    for (const events of this.#listeners) {
      call(events);
    }
  }
}

export function validName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length === 0 || trimmed.length > maxNameLength || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new AccountError("bad-name", `The name must be 1 to ${maxNameLength} characters long`);
  }
  return trimmed;
}

export function validUsername(username: unknown): string {
  const trimmed = typeof username === "string" ? username.trim() : "";
  if (!usernamePattern.test(trimmed)) {
    throw new AccountError("bad-username", "The username must be 3 to 32 characters long and may only contain letters, digits, dot, underscore and hyphen");
  }
  return trimmed;
}

function validPassword(password: unknown): string {
  if (typeof password !== "string" || password.length < minPasswordLength || password.length > maxPasswordLength) {
    throw new AccountError("bad-password", `The password must be ${minPasswordLength} to ${maxPasswordLength} characters long`);
  }
  return password;
}

function optionalText(value: unknown, max: number, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new AccountError("bad-name", `${label} may be at most ${max} characters long`);
  }
  return trimmed === "" ? undefined : trimmed;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    kind: row.kind,
    ...(row.username === null ? {} : { username: row.username }),
    name: row.display_name,
    role: row.role,
    locked: row.locked === 1,
    language: isUiLanguage(row.language) ? row.language : null,
    theme: isUiTheme(row.theme) ? row.theme : null,
  };
}

export function normalizeTransferCode(code: unknown): string | undefined {
  if (typeof code !== "string" || code.length > 40) {
    return undefined;
  }
  const normalized = code.toUpperCase().replace(/[\s-]/g, "");
  return transferPattern.test(normalized) ? normalized : undefined;
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function scrypt(password: string, salt: Buffer, cost: PasswordCost): Promise<Buffer> {
  const options: ScryptOptions = { N: cost.N, r: cost.r, p: cost.p, maxmem: 256 * cost.N * cost.r + 1024 * 1024 };
  return passwordSlots.run(
    () => new Promise((resolve, reject) => scryptCallback(password, salt, 32, options, (error, key) => (error === null ? resolve(key) : reject(error)))),
  );
}

export async function hashPassword(password: string, cost: PasswordCost = defaultPasswordCost): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, cost);
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, secret: string): Promise<boolean> {
  const parts = secret.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const expected = Buffer.from(parts[5] as string, "base64");
  const key = await scrypt(password, Buffer.from(parts[4] as string, "base64"), { N, r, p });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

function needsRehash(secret: string, cost: PasswordCost): boolean {
  return !secret.startsWith(`scrypt$${cost.N}$${cost.r}$${cost.p}$`);
}

export function describeDevice(agent: string): DeviceInfo {
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : undefined;
  const system = /Android/.test(agent)
    ? "Android"
    : /iPhone|iPad|iPod/.test(agent)
      ? "iOS"
      : /Windows/.test(agent)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(agent)
          ? "macOS"
          : /Linux/.test(agent)
            ? "Linux"
            : undefined;
  return { ...(browser === undefined ? {} : { browser }), ...(system === undefined ? {} : { system }) };
}

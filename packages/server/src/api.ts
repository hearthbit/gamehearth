import type { IncomingMessage, ServerResponse } from "node:http";
import { AccountError, validName, type AccountService, type LinkKind, type Session, type User } from "./accounts";
import { createAdminApi, type BackupControl, type QuarantineInfo } from "./admin-api";
import type { CatalogService } from "./catalogs";
import { languagesAndCover, type GameLibrary } from "./games";
import type { PushService } from "./push/service";
import {
  RequestError,
  clearedSessionCookie,
  readBody,
  readCookie,
  sameOrigin,
  screenCookie,
  screenCookieName,
  sendJson,
  sessionCookie,
  sessionCookieName,
} from "./http";
import type { RateLimiter } from "./rate";
import { RoomError, type RoomService } from "./rooms";
import { deviceHash, newDeviceToken, type ScreenPairing } from "./screens";
import { gamePage } from "./game-page";
import { isSoloManifest, parseSyncInput, type SoloService } from "./solo";

export interface ApiRates {
  rooms: RateLimiter;
  joins: RateLimiter;
  failedAuth: RateLimiter;
  logins: RateLimiter;
  push: RateLimiter;
  solo?: RateLimiter;
  profileResets?: RateLimiter;
  language?: RateLimiter;
}

export interface ApiOptions {
  rooms: RoomService;
  accounts: AccountService;
  library: GameLibrary;
  rates: ApiRates;
  maxBodyBytes: number;
  maxClaimTokens: number;
  quarantine: () => QuarantineInfo[];
  backups: BackupControl | undefined;
  push?: PushService | undefined;
  catalogs?: CatalogService | undefined;
  pairing?: ScreenPairing | undefined;
  solo?: SoloService | undefined;
  maxSoloBodyBytes?: number;
  log?: (message: string) => void;
}

export interface ApiRequest {
  request: IncomingMessage;
  response: ServerResponse;
  path: string;
  ip: string;
  secure: boolean;
}

export interface PublicUser {
  id: number;
  kind: User["kind"];
  username?: string;
  name: string;
  role: User["role"];
  language: User["language"];
  theme: User["theme"];
}

interface Context extends ApiRequest {
  parts: string[];
  cookie: string | undefined;
  session: Session | undefined;
  agent: string;
}

const linkKinds: readonly LinkKind[] = ["setup", "invite", "reset"];

export function publicUser(user: User): PublicUser {
  return { id: user.id, kind: user.kind, ...(user.username === undefined ? {} : { username: user.username }), name: user.name, role: user.role, language: user.language, theme: user.theme };
}

export function createApi(options: ApiOptions): (request: ApiRequest) => Promise<boolean> {
  const { rooms, accounts, library, rates, push } = options;
  const admin = createAdminApi({
    rooms,
    accounts,
    quarantine: options.quarantine,
    backups: options.backups,
    library,
    catalogs: options.catalogs,
    solo: options.solo,
    log: options.log ?? console.log,
    removeUser: (userId) => {
      accounts.requireDeletable(userId);
      rooms.removeUser(userId);
      accounts.deleteUser(userId);
    },
  });

  const body = (context: Context) => readBody(context.request, options.maxBodyBytes);
  const setSession = (context: Context, token: string) => context.response.setHeader("set-cookie", sessionCookie(token, context.secure));
  const requireSession = (context: Context): Session => {
    if (context.session === undefined) {
      throw new RequestError("not-signed-in", "Please sign in first");
    }
    return context.session;
  };
  const countFailure = (context: Context, error: unknown) => {
    if (
      (error instanceof AccountError && (error.code === "unknown-link" || error.code === "unknown-code")) ||
      (error instanceof RoomError && error.code === "unknown-room")
    ) {
      rates.failedAuth.allow(context.ip);
    }
  };
  const requireNotBlocked = (context: Context, message: string) => {
    if (rates.failedAuth.blocked(context.ip)) {
      throw new RequestError("rate-limited", message);
    }
  };

  function adoption(
    session: Session,
  ): { name: string; rooms: ReturnType<RoomService["rooms"]>; duplicates: ReturnType<RoomService["rooms"]> } | undefined {
    if (session.adoptGuest === undefined || session.adoptGuest === session.user.id) {
      return undefined;
    }
    if (accounts.hasSessions(session.adoptGuest)) {
      accounts.clearAdoption(session.id);
      return undefined;
    }
    let guest: User;
    try {
      guest = accounts.user(session.adoptGuest);
    } catch {
      accounts.clearAdoption(session.id);
      return undefined;
    }
    const list = guest.kind === "guest" ? rooms.rooms(guest.id) : [];
    if (list.length === 0) {
      accounts.clearAdoption(session.id);
      return undefined;
    }
    const own = new Set(rooms.codes(session.user.id));
    return { name: guest.name, rooms: list.filter((room) => !own.has(room.code)), duplicates: list.filter((room) => own.has(room.code)) };
  }

  const requirePush = (context: Context): PushService => {
    if (push === undefined) {
      throw new RequestError("not-found", "Notifications are not available on this server");
    }
    if (!rates.push.allow(context.ip)) {
      throw new RequestError("rate-limited", "Too many changes in a short time, please try again later");
    }
    return push;
  };

  const pageOrigin = (context: Context): string => {
    const origin = context.request.headers.origin;
    if (typeof origin === "string" && origin.length <= 200 && /^https?:\/\/[A-Za-z0-9.\-\[\]:]+$/.test(origin)) {
      return origin;
    }
    const host = context.request.headers.host ?? "";
    return `${context.secure ? "https" : "http"}://${/^[A-Za-z0-9.\-\[\]:]{1,200}$/.test(host) ? host : "localhost"}`;
  };

  async function passwordAttempt<T>(context: Context, work: () => Promise<T>): Promise<T> {
    if (!rates.logins.allow(context.ip)) {
      throw new RequestError("rate-limited", "Too many failed attempts from this address, please try again later", 15 * 60 * 1000);
    }
    try {
      const result = await work();
      rates.logins.refund(context.ip);
      return result;
    } catch (error) {
      if (!(error instanceof AccountError && (error.code === "wrong-login" || error.code === "wrong-password"))) {
        rates.logins.refund(context.ip);
      }
      throw error;
    }
  }

  async function login(context: Context): Promise<void> {
    const input = await body(context);
    const created = await passwordAttempt(context, () =>
      accounts.login(String(input["username"] ?? ""), String(input["password"] ?? ""), context.session, context.agent, context.ip),
    );
    setSession(context, created.token);
    sendJson(context.response, 200, { user: publicUser(created.session.user) });
  }

  async function join(context: Context, code: string): Promise<void> {
    if (!rates.joins.allow(context.ip)) {
      throw new RequestError("rate-limited", "Too many join attempts in a short time, please try again later");
    }
    requireNotBlocked(context, "Too many join attempts in a short time, please try again later");
    const input = await body(context);
    const name = typeof input["name"] === "string" ? input["name"].trim() : "";
    let session = context.session;
    let created: { token: string; userId: number } | undefined;
    const rename = session?.user.kind === "guest" && name !== "" && name !== session.user.name ? validName(name) : undefined;
    if (session === undefined) {
      const guest = accounts.createGuest(name);
      const fresh = accounts.createSession(guest.id, context.agent);
      created = { token: fresh.token, userId: guest.id };
      session = fresh.session;
    }
    let joined: string;
    try {
      joined = (await rooms.joinRoom(code, session.user.id)).code;
    } catch (error) {
      countFailure(context, error);
      if (created !== undefined) {
        accounts.deleteUser(created.userId);
      }
      throw error;
    }
    if (created !== undefined) {
      setSession(context, created.token);
    }
    if (rename !== undefined) {
      accounts.rename(session.user.id, rename);
    }
    sendJson(context.response, 201, { code: joined });
  }

  async function claim(context: Context): Promise<void> {
    if (!rates.joins.allow(context.ip)) {
      throw new RequestError("rate-limited", "Too many requests in a short time, please try again later");
    }
    const input = await body(context);
    const tokens = input["tokens"];
    if (!Array.isArray(tokens) || tokens.length > options.maxClaimTokens || tokens.some((token) => typeof token !== "string" || token.length > 100)) {
      throw new RequestError("bad-message", `tokens must be a list of at most ${options.maxClaimTokens} tokens`);
    }
    const result = rooms.claim(tokens as string[], context.session?.user.id);
    let user = context.session?.user;
    if (context.session === undefined && result.userId !== undefined) {
      const created = accounts.createSession(result.userId, context.agent);
      setSession(context, created.token);
      user = created.session.user;
    }
    sendJson(context.response, 200, { claimed: result.codes, ...(user === undefined ? {} : { user: publicUser(user) }) });
  }

  async function inspectLink(context: Context): Promise<void> {
    requireNotBlocked(context, "Too many invalid links from this address, please try again later");
    const input = await body(context);
    const kind = input["kind"];
    if (typeof kind !== "string" || !linkKinds.includes(kind as LinkKind)) {
      throw new RequestError("bad-message", "kind must be setup, invite or reset");
    }
    try {
      const link = accounts.inspectLink(String(input["token"] ?? ""), kind === "invite" ? ["invite", "setup"] : [kind as LinkKind]);
      sendJson(context.response, 200, link);
    } catch (error) {
      countFailure(context, error);
      throw error;
    }
  }

  async function acceptInvite(context: Context): Promise<void> {
    requireNotBlocked(context, "Too many invalid links from this address, please try again later");
    const input = await body(context);
    try {
      const created = await accounts.acceptInvite(
        String(input["token"] ?? ""),
        { username: String(input["username"] ?? ""), name: String(input["name"] ?? ""), password: String(input["password"] ?? "") },
        context.session,
        context.agent,
      );
      setSession(context, created.token);
      sendJson(context.response, 201, { user: publicUser(created.session.user), upgraded: created.upgraded });
    } catch (error) {
      countFailure(context, error);
      throw error;
    }
  }

  async function resetPassword(context: Context): Promise<void> {
    requireNotBlocked(context, "Too many invalid links from this address, please try again later");
    const input = await body(context);
    try {
      const user = await accounts.resetPassword(String(input["token"] ?? ""), String(input["password"] ?? ""));
      sendJson(context.response, 200, { username: user.username });
    } catch (error) {
      countFailure(context, error);
      throw error;
    }
  }

  async function soloRoute(context: Context, method: string, parts: string[]): Promise<boolean> {
    const solo = options.solo;
    if (solo === undefined) {
      return false;
    }
    const session = requireSession(context);
    const gameId = parts[2] as string;
    const action = parts[3];
    if (parts.length > 4) {
      return false;
    }
    if (method === "GET" && action === undefined) {
      sendJson(context.response, 200, solo.view(session.user.id, gameId));
      return true;
    }
    if (method === "GET" && action === "files") {
      solo.view(session.user.id, gameId);
      sendJson(context.response, 200, solo.offlineFiles(gameId));
      return true;
    }
    if (method !== "POST" || (action !== "sync" && action !== "delete")) {
      return false;
    }
    if (options.rates.solo !== undefined && !options.rates.solo.allow(String(session.user.id))) {
      throw new RequestError("rate-limited", "Too many saves in a short time, please wait a moment");
    }
    const input = await readBody(context.request, options.maxSoloBodyBytes ?? 98_304);
    if (action === "delete") {
      const what = input["what"];
      if (what !== "save" && what !== "best") {
        throw new RequestError("bad-message", "what must be save or best");
      }
      sendJson(context.response, 200, what === "save" ? solo.deleteSave(session.user.id, gameId) : solo.deleteBest(session.user.id, gameId));
      return true;
    }
    const parsed = parseSyncInput(input);
    if (typeof parsed === "string") {
      throw new RequestError("bad-message", parsed);
    }
    sendJson(context.response, 200, solo.sync(session.user.id, gameId, parsed));
    return true;
  }

  async function route(context: Context): Promise<boolean> {
    const { request, response, path, parts } = context;
    const method = request.method ?? "GET";
    const post = method === "POST";
    if (method === "GET" && path === "/api/health") {
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (method === "GET" && path === "/api/games") {
      sendJson(
        response,
        200,
        library.list().map((manifest) => {
          const build = library.current(manifest.id);
          return {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            mode: manifest.mode,
            players: manifest.players,
            roles: manifest.roles,
            ...(manifest.description === undefined ? {} : { description: manifest.description }),
            ...(build === undefined ? {} : languagesAndCover(build)),
            ...(isSoloManifest(manifest) ? { solo: true, build: build?.build, stats: manifest.stats ?? {} } : {}),
          };
        }),
      );
      return true;
    }
    if (method === "GET" && path === "/api/me") {
      if (context.session === undefined && context.cookie !== undefined) {
        response.setHeader("set-cookie", clearedSessionCookie(context.secure));
      }
      if (context.session === undefined) {
        sendJson(response, 200, {});
        return true;
      }
      const adopt = adoption(context.session);
      sendJson(response, 200, { user: publicUser(context.session.user), ...(adopt === undefined ? {} : { adopt }) });
      return true;
    }
    if (post && path === "/api/me/adopt") {
      const session = requireSession(context);
      const input = await body(context);
      const guestId = adoption(session) === undefined ? undefined : session.adoptGuest;
      accounts.clearAdoption(session.id);
      let moved: string[] = [];
      if (guestId !== undefined && input["take"] === true) {
        moved = rooms.transferMemberships(guestId, session.user.id);
        rooms.removeUser(guestId);
        accounts.deleteUser(guestId);
      }
      sendJson(response, 200, { moved });
      return true;
    }
    if (post && path === "/api/me/language") {
      const session = requireSession(context);
      if (!(rates.language ?? rates.push).allow(context.ip)) {
        throw new RequestError("rate-limited", "Too many changes in a short time, please try again later");
      }
      const input = await body(context);
      sendJson(response, 200, { user: publicUser(accounts.setLanguage(session.user.id, input["language"])) });
      return true;
    }
    if (post && path === "/api/me/theme") {
      const session = requireSession(context);
      if (!(rates.language ?? rates.push).allow(context.ip)) {
        throw new RequestError("rate-limited", "Too many changes in a short time, please try again later");
      }
      const input = await body(context);
      sendJson(response, 200, { user: publicUser(accounts.setTheme(session.user.id, input["theme"])) });
      return true;
    }
    if (post && path === "/api/me/name") {
      const session = requireSession(context);
      const input = await body(context);
      sendJson(response, 200, { user: publicUser(accounts.rename(session.user.id, input["name"] as string)) });
      return true;
    }
    if (post && path === "/api/me/password") {
      const session = requireSession(context);
      const input = await body(context);
      await passwordAttempt(context, () => accounts.changePassword(session, String(input["current"] ?? ""), String(input["password"] ?? ""), context.ip));
      sendJson(response, 200, {});
      return true;
    }
    if (method === "GET" && path === "/api/me/sessions") {
      const session = requireSession(context);
      const withPush = push?.sessionsWithPush(session.user.id) ?? new Set<number>();
      sendJson(response, 200, { sessions: accounts.sessions(session.user.id, session.id).map((info) => ({ ...info, push: withPush.has(info.id) })) });
      return true;
    }
    if (method === "GET" && path === "/api/me/push") {
      const session = requireSession(context);
      sendJson(response, 200, push === undefined ? { enabled: false } : { publicKey: push.publicKey(), enabled: push.enabled(session.id) });
      return true;
    }
    if (post && path === "/api/me/push") {
      const session = requireSession(context);
      const service = requirePush(context);
      const input = await body(context);
      service.subscribe(session.id, input["subscription"], pageOrigin(context), input["language"]);
      sendJson(response, 200, { enabled: true });
      return true;
    }
    if (post && path === "/api/me/push/renew") {
      const session = requireSession(context);
      const service = requirePush(context);
      const input = await body(context);
      sendJson(response, 200, { renewed: service.renew(session.id, input["oldEndpoint"], input["subscription"]) });
      return true;
    }
    if (post && path === "/api/me/push/off") {
      const session = requireSession(context);
      requirePush(context).unsubscribe(session.id);
      sendJson(response, 200, { enabled: false });
      return true;
    }
    if (post && path === "/api/me/push/test") {
      const session = requireSession(context);
      requirePush(context).sendTest(session.id);
      sendJson(response, 200, {});
      return true;
    }
    if (post && path === "/api/me/sessions/end-all") {
      const session = requireSession(context);
      if (session.user.kind === "guest") {
        accounts.endNewerSessions(session.user.id, session.id);
        sendJson(response, 200, {});
        return true;
      }
      accounts.endAllSessions(session.user.id);
      response.setHeader("set-cookie", clearedSessionCookie(context.secure));
      sendJson(response, 200, {});
      return true;
    }
    if (post && parts.length === 5 && parts[1] === "me" && parts[2] === "sessions" && parts[4] === "end") {
      const session = requireSession(context);
      const target = Number(parts[3]);
      if (!Number.isSafeInteger(target)) {
        throw new RequestError("unknown-session", "This session does not exist");
      }
      if (session.user.kind === "guest" && target <= session.id) {
        throw new RequestError(
          "forbidden",
          target === session.id
            ? "As a guest you cannot sign out this device, or you could not get back in without a password"
            : "As a guest you can only sign out devices added after this one",
        );
      }
      accounts.endSession(target, session.user.id);
      if (target === session.id) {
        response.setHeader("set-cookie", clearedSessionCookie(context.secure));
      }
      sendJson(response, 200, {});
      return true;
    }
    if (method === "GET" && path === "/api/me/rooms") {
      sendJson(response, 200, { rooms: rooms.rooms(requireSession(context).user.id) });
      return true;
    }
    if (post && path === "/api/login") {
      await login(context);
      return true;
    }
    if (post && path === "/api/me/transfer") {
      const session = requireSession(context);
      if (session.user.role === "admin") {
        throw new RequestError("forbidden", "Admins sign in on a new device with their password");
      }
      if (!rates.joins.allow(context.ip)) {
        throw new RequestError("rate-limited", "Too many codes in a short time, please wait a moment");
      }
      sendJson(response, 200, accounts.createTransferCode(session));
      return true;
    }
    if (post && path === "/api/transfer") {
      requireNotBlocked(context, "Too many invalid codes from this address, please try again later");
      const input = await body(context);
      try {
        const created = accounts.redeemTransferCode(String(input["code"] ?? ""), context.session, context.agent);
        setSession(context, created.token);
        sendJson(response, 200, { user: publicUser(created.session.user) });
      } catch (error) {
        countFailure(context, error);
        throw error;
      }
      return true;
    }
    if (post && path === "/api/logout") {
      if (context.session !== undefined) {
        accounts.logout(context.session);
      }
      response.setHeader("set-cookie", clearedSessionCookie(context.secure));
      sendJson(response, 200, {});
      return true;
    }
    if (post && path === "/api/rooms") {
      const session = requireSession(context);
      if (!rates.rooms.allow(context.ip)) {
        throw new RequestError("rate-limited", "Too many new rooms in a short time, please try again later");
      }
      const input = await body(context);
      sendJson(response, 201, rooms.createRoom(String(input["game"] ?? ""), session.user.id));
      return true;
    }
    if (post && path === "/api/tv") {
      if (!rates.joins.allow(context.ip)) {
        throw new RequestError("rate-limited", "Too many requests in a short time, please wait a moment");
      }
      if (readCookie(context.request, screenCookieName(context.secure)) === undefined) {
        response.setHeader("set-cookie", screenCookie(newDeviceToken(), context.secure));
      }
      sendJson(response, 200, {});
      return true;
    }
    if (post && parts.length === 4 && parts[1] === "rooms" && parts[3] === "screens") {
      const session = requireSession(context);
      requireNotBlocked(context, "Too many invalid codes from this address, please try again later");
      const input = await body(context);
      const pairing = options.pairing;
      const device = pairing?.peek(input["code"]);
      if (pairing === undefined || device === undefined) {
        rates.failedAuth.allow(context.ip);
        throw new RequestError("unknown-code", "This TV code does not exist or has expired. The TV shows the current code.");
      }
      let added: { id: number };
      try {
        added = await rooms.addScreen(parts[2] as string, session.user.id, device);
      } catch (error) {
        countFailure(context, error);
        throw error;
      }
      pairing.forget(device);
      sendJson(response, 201, { id: added.id });
      return true;
    }
    if (post && parts.length === 5 && parts[1] === "rooms" && parts[3] === "screens" && parts[4] === "self") {
      const session = requireSession(context);
      if (!rates.joins.allow(context.ip)) {
        throw new RequestError("rate-limited", "Too many requests in a short time, please wait a moment");
      }
      requireNotBlocked(context, "Too many unknown rooms from this address, please try again later");
      const existing = readCookie(context.request, screenCookieName(context.secure));
      const token = existing ?? newDeviceToken();
      let added: { id: number };
      try {
        added = await rooms.addScreen(parts[2] as string, session.user.id, deviceHash(token));
      } catch (error) {
        countFailure(context, error);
        throw error;
      }
      if (existing === undefined) {
        response.setHeader("set-cookie", screenCookie(token, context.secure));
      }
      sendJson(response, 201, { id: added.id });
      return true;
    }
    if (post && parts.length === 4 && parts[1] === "rooms" && parts[3] === "join") {
      await join(context, parts[2] as string);
      return true;
    }
    if (post && parts.length === 4 && parts[1] === "rooms" && parts[3] === "mute") {
      const session = requireSession(context);
      if (!rates.push.allow(context.ip)) {
        throw new RequestError("rate-limited", "Too many changes in a short time, please try again later");
      }
      const input = await body(context);
      if (typeof input["muted"] !== "boolean") {
        throw new RequestError("bad-message", "muted must be true or false");
      }
      rooms.setMuted(parts[2] as string, session.user.id, input["muted"]);
      sendJson(response, 200, { muted: input["muted"] });
      return true;
    }
    if (parts[1] === "solo" && parts.length >= 3) {
      return soloRoute(context, method, parts);
    }
    if (method === "GET" && parts.length === 3 && parts[1] === "games") {
      const session = requireSession(context);
      sendJson(response, 200, gamePage(library, rooms.profiles, parts[2] as string, session.user.kind === "account" ? session.user.id : undefined));
      return true;
    }
    if (post && parts.length === 4 && parts[1] === "games" && parts[3] === "reset") {
      const session = requireSession(context);
      if (session.user.kind !== "account") {
        throw new RequestError("account-required", "Only players with an account have a profile");
      }
      if (!(rates.profileResets ?? rates.push).allow(String(session.user.id))) {
        throw new RequestError("rate-limited", "Reset too often, please try again later");
      }
      const gameId = parts[2] as string;
      gamePage(library, rooms.profiles, gameId, session.user.id);
      rooms.profiles.reset(session.user.id, gameId);
      sendJson(response, 200, gamePage(library, rooms.profiles, gameId, session.user.id));
      return true;
    }
    if (post && path === "/api/claim") {
      await claim(context);
      return true;
    }
    if (post && path === "/api/links/inspect") {
      await inspectLink(context);
      return true;
    }
    if (post && path === "/api/invites/accept") {
      await acceptInvite(context);
      return true;
    }
    if (post && path === "/api/reset") {
      await resetPassword(context);
      return true;
    }
    if (parts[1] === "admin") {
      return admin({ method, parts, session: context.session, response, body: () => body(context) });
    }
    return false;
  }

  return async (request: ApiRequest) => {
    if (request.path !== "/api" && !request.path.startsWith("/api/")) {
      return false;
    }
    if (request.request.method === "POST") {
      if (!sameOrigin(request.request)) {
        throw new RequestError("forbidden", "Requests from other sites are not accepted");
      }
      if (!(request.request.headers["content-type"] ?? "").startsWith("application/json")) {
        throw new RequestError("bad-message", "Requests must be JSON with content-type application/json");
      }
    }
    const cookie = readCookie(request.request, sessionCookieName(request.secure));
    const context: Context = {
      ...request,
      parts: request.path.split("/").filter((part) => part !== ""),
      cookie,
      session: accounts.session(cookie),
      agent: typeof request.request.headers["user-agent"] === "string" ? request.request.headers["user-agent"] : "",
    };
    if (!(await route(context))) {
      throw new RequestError("not-found", `${request.request.method ?? "?"} ${request.path} does not exist`);
    }
    return true;
  };
}

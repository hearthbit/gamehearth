import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { AccountService } from "./accounts";
import type { BackupControl, QuarantineInfo } from "./admin-api";
import { createApi } from "./api";
import type { CatalogService } from "./catalogs";
import { frameBase, frameSender, type FrameReceiver } from "./frames";
import type { GameLibrary } from "./games";
import { RequestError, clientIp, errorMessage, isSecure, readCookie, sameOrigin, screenCookieName, sendError, sessionCookieName } from "./http";
import { parseClientMessage, type ClientMessage, type ProtocolErrorCode, type ServerMessage } from "./protocol";
import type { PushService } from "./push/service";
import { RateLimiter } from "./rate";
import { RoomError, normalizeCode, type Connected, type RoomService, type RoomView, type ScreenView } from "./rooms";
import { ScreenPairing, deviceHash, screenIdleMs } from "./screens";
import type { SoloService } from "./solo";
import { serveStatic } from "./static";

export interface Limits {
  maxBodyBytes: number;
  maxMessageBytes: number;
  helloTimeoutMs: number;
  heartbeatMs: number;
  realtimeHeartbeatMs: number;
  maxBufferedBytes: number;
  maxConnections: number;
  maxConnectionsPerRoom: number;
  maxConnectionsPerMember: number;
  maxConnectionsPerAddress: number;
  roomsPerMinute: number;
  joinsPerMinute: number;
  failedAuthPerMinute: number;
  failedLoginsPerQuarterHour: number;
  movesPerMinute: number;
  inputsPerSecond: number;
  frameDropBytes: number;
  maxUnpairedScreens: number;
  maxUnpairedScreensPerAddress: number;
  pairingRequestsPerMinute: number;
  maxClaimTokens: number;
  pushChangesPerMinute: number;
  languageChangesPerMinute: number;
  soloSyncsPerMinute: number;
  profileResetsPerMinute: number;
  maxSoloBodyBytes: number;
}

export const defaultLimits: Limits = {
  maxBodyBytes: 4096,
  maxMessageBytes: 65_536,
  helloTimeoutMs: 10_000,
  heartbeatMs: 30_000,
  realtimeHeartbeatMs: 5000,
  maxBufferedBytes: 1_048_576,
  maxConnections: 1000,
  maxConnectionsPerRoom: 64,
  maxConnectionsPerMember: 4,
  maxConnectionsPerAddress: 50,
  roomsPerMinute: 20,
  joinsPerMinute: 30,
  failedAuthPerMinute: 30,
  failedLoginsPerQuarterHour: 10,
  movesPerMinute: 120,
  inputsPerSecond: 30,
  frameDropBytes: 65_536,
  maxUnpairedScreens: 100,
  maxUnpairedScreensPerAddress: 4,
  pairingRequestsPerMinute: 30,
  maxClaimTokens: 30,
  pushChangesPerMinute: 20,
  languageChangesPerMinute: 20,
  soloSyncsPerMinute: 60,
  profileResetsPerMinute: 10,
  maxSoloBodyBytes: 98_304,
};

export interface ServerOptions {
  rooms: RoomService;
  accounts: AccountService;
  library: GameLibrary;
  port: number;
  host?: string;
  trustProxy?: boolean;
  clientDir?: string;
  limits?: Partial<Limits>;
  log?: (message: string) => void;
  quarantine?: () => QuarantineInfo[];
  backups?: BackupControl;
  push?: PushService;
  catalogs?: CatalogService;
  pairing?: ScreenPairing;
  solo?: SoloService;
}

export interface RunningServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

interface Joined {
  code: string;
  user: number;
  member: number;
  seat?: string | null;
}

interface ScreenJoin {
  id: number;
  code: string;
}

interface Connection extends FrameReceiver {
  socket: WebSocket;
  ip: string;
  pingAt: number | undefined;
  pongAt: number;
  visible: boolean;
  session: { id: number; user: number } | undefined;
  device: string | undefined;
  wantsScreen: boolean;
  joined?: Joined | undefined;
  screen?: ScreenJoin | undefined;
}

const screenSweepMs = 10 * 60 * 1000;

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const { rooms, accounts, library } = options;
  const limits: Limits = { ...defaultLimits, ...options.limits };
  const log = options.log ?? console.error;
  const trustProxy = options.trustProxy === true;
  const connections = new Set<Connection>();
  const pending = new Set<string>();
  const pairing = options.pairing ?? new ScreenPairing();
  let stopping = false;
  const rates = {
    rooms: new RateLimiter(limits.roomsPerMinute, 60_000),
    joins: new RateLimiter(limits.joinsPerMinute, 60_000),
    failedAuth: new RateLimiter(limits.failedAuthPerMinute, 60_000),
    logins: new RateLimiter(limits.failedLoginsPerQuarterHour, 15 * 60_000),
    moves: new RateLimiter(limits.movesPerMinute, 60_000),
    inputs: new RateLimiter(limits.inputsPerSecond, 1000),
    pairing: new RateLimiter(limits.pairingRequestsPerMinute, 60_000),
    push: new RateLimiter(limits.pushChangesPerMinute, 60_000),
    language: new RateLimiter(limits.languageChangesPerMinute, 60_000),
    solo: new RateLimiter(limits.soloSyncsPerMinute, 60_000),
    profileResets: new RateLimiter(limits.profileResetsPerMinute, 60_000),
  };
  const api = createApi({
    rooms,
    accounts,
    library,
    rates,
    maxBodyBytes: limits.maxBodyBytes,
    maxClaimTokens: limits.maxClaimTokens,
    quarantine: options.quarantine ?? (() => []),
    backups: options.backups,
    push: options.push,
    catalogs: options.catalogs,
    pairing,
    solo: options.solo,
    maxSoloBodyBytes: limits.maxSoloBodyBytes,
    log: options.log === undefined ? console.log : options.log,
  });

  const inRoom = (code: string) => [...connections].filter((connection) => connection.joined?.code === code);
  const screensIn = (code: string) => [...connections].filter((connection) => connection.screen?.code === code);
  const connectedMembers = (code: string) => new Set(inRoom(code).map((connection) => connection.joined?.member as number));
  const connectedIn = (code: string): Connected => ({
    members: connectedMembers(code),
    screens: new Set(screensIn(code).map((connection) => connection.screen?.id as number)),
  });
  const updatePresence = (code: string) => {
    const screens = screensIn(code).filter((connection) => connection.socket.readyState === WebSocket.OPEN).length;
    if (!rooms.isRealtime(code)) {
      rooms.realtime.presence(code, { seats: new Set(), screens });
      return;
    }
    let seats: Map<number, string>;
    try {
      seats = rooms.seats(code);
    } catch {
      return;
    }
    const present = new Set<string>();
    for (const connection of inRoom(code)) {
      const seat = seats.get(connection.joined?.member as number);
      if (seat !== undefined && connection.visible && connection.socket.readyState === WebSocket.OPEN) {
        present.add(seat);
      }
    }
    rooms.realtime.presence(code, { seats: present, screens });
  };
  const watching = (code: string, user: number) =>
    inRoom(code).some((connection) => connection.joined?.user === user && connection.visible && connection.socket.readyState === WebSocket.OPEN);

  const afterFlush = new Map<string, (() => void)[]>();
  const whenFlushed = (code: string | undefined, callback: () => void) => {
    if (code === undefined || !pending.has(code)) {
      callback();
      return;
    }
    afterFlush.set(code, [...(afterFlush.get(code) ?? []), callback]);
  };

  const flush = (code: string) => {
    pending.delete(code);
    if (stopping) {
      return;
    }
    const callbacks = afterFlush.get(code) ?? [];
    afterFlush.delete(code);
    updatePresence(code);
    const targets = inRoom(code);
    const connected = connectedIn(code);
    const byMember = new Map<string, Connection[]>();
    for (const connection of targets) {
      const key = `${connection.joined?.member}:${connection.joined?.user}`;
      byMember.set(key, [...(byMember.get(key) ?? []), connection]);
    }
    const screenViews = screensIn(code).map((connection) => sendScreenView(connection, connected));
    void Promise.allSettled([...[...byMember.values()].map((group) => sendViews(group, connected)), ...screenViews]).then(() => {
      for (const callback of callbacks) {
        callback();
      }
    });
  };
  const schedule = (code: string) => {
    if (!pending.has(code)) {
      pending.add(code);
      setImmediate(() => flush(code));
    }
  };

  const sendText = (connection: Connection, text: string): boolean => {
    const socket = connection.socket;
    if (socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (socket.bufferedAmount > limits.maxBufferedBytes) {
      socket.terminate();
      return false;
    }
    socket.send(text);
    return true;
  };
  const send = (connection: Connection, message: ServerMessage) => sendText(connection, JSON.stringify(message));

  const sendViews = async (group: readonly Connection[], connected: Connected) => {
    const joined = group[0]?.joined;
    if (joined === undefined) {
      return;
    }
    let text: string;
    let room: RoomView | undefined;
    try {
      room = await rooms.view(joined.code, joined.user, connected);
      text = JSON.stringify({ type: "room", room } satisfies ServerMessage);
    } catch (error) {
      text = JSON.stringify(errorMessage(error, log));
    }
    for (const connection of group) {
      if (connection.joined?.code === joined.code && connection.joined.member === joined.member && connection.joined.user === joined.user) {
        if (room !== undefined) {
          connection.joined.seat = room.you.seat;
        }
        if (sendText(connection, text) && room !== undefined) {
          connection.frameBase = room.you.seat === null ? undefined : frameBase(joined.code, room.you.seat, room.snapshot);
        }
      }
    }
  };
  const sendView = (connection: Connection, connected: Connected) => sendViews([connection], connected);
  const sendScreenView = async (connection: Connection, connected: Connected) => {
    const screen = connection.screen;
    if (screen === undefined) {
      return;
    }
    let text: string;
    let room: ScreenView | undefined;
    try {
      room = await rooms.screenView(screen.code, screen.id, connected);
      text = JSON.stringify({ type: "screen-room", room } satisfies ServerMessage);
    } catch (error) {
      text = JSON.stringify(errorMessage(error, log));
    }
    if (connection.screen === screen && sendText(connection, text) && room !== undefined) {
      connection.frameBase = frameBase(screen.code, null, room.snapshot);
    }
  };
  const unpaired = (connection: Connection) => connection.wantsScreen && connection.screen === undefined;
  const sendPairing = (connection: Connection) => {
    if (connection.device === undefined) {
      return;
    }
    const others = [...connections].filter((other) => other !== connection && unpaired(other));
    if (others.length >= limits.maxUnpairedScreens || others.filter((other) => other.ip === connection.ip).length >= limits.maxUnpairedScreensPerAddress) {
      drop(connection, "too-many-connections", "Too many TVs are waiting for pairing right now");
      return;
    }
    if (!rates.pairing.allow(connection.ip)) {
      drop(connection, "rate-limited", "Too many new TVs in a short time, please wait a moment");
      return;
    }
    const code = pairing.code(connection.device);
    if (code === undefined) {
      drop(connection, "too-many-connections", "Too many TVs are waiting for pairing right now");
      return;
    }
    send(connection, { type: "pairing", ...code });
  };
  const leaveScreen = (connection: Connection) => {
    const screen = connection.screen;
    if (screen === undefined) {
      return;
    }
    connection.screen = undefined;
    connection.frameBase = undefined;
    if (stopping) {
      return;
    }
    try {
      rooms.touchScreens([screen.id]);
    } catch (error) {
      log(`TV ${screen.id} could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
    updatePresence(screen.code);
    schedule(screen.code);
  };
  const screenHello = (connection: Connection) => {
    if (connection.device === undefined) {
      throw new RequestError("no-device", "This device is not set up as a TV yet");
    }
    connection.wantsScreen = true;
    const screen = rooms.screen(connection.device);
    if (screen === undefined) {
      leaveScreen(connection);
      sendPairing(connection);
      return;
    }
    if (connection.screen?.id === screen.id) {
      void sendScreenView(connection, connectedIn(screen.code));
      return;
    }
    leaveScreen(connection);
    if (screensIn(screen.code).length >= limits.maxConnectionsPerRoom) {
      throw new RequestError("too-many-connections", "Too many connections to this room");
    }
    connection.screen = screen;
    connection.frameBase = undefined;
    pairing.forget(connection.device);
    rooms.touchScreens([screen.id]);
    updatePresence(screen.code);
    schedule(screen.code);
  };
  const sendFrames = (code: string) => {
    const deliver = frameSender(code, (seat) => rooms.liveSnapshot(code, seat), limits.frameDropBytes);
    for (const connection of inRoom(code)) {
      const seat = connection.joined?.seat;
      if (typeof seat === "string") {
        deliver(connection, seat);
      }
    }
    for (const connection of screensIn(code)) {
      deliver(connection, null);
    }
  };

  const drop = (connection: Connection, code: ProtocolErrorCode, message: string) => {
    send(connection, { type: "error", code, message });
    const joined = connection.joined;
    connection.joined = undefined;
    connection.frameBase = undefined;
    connection.socket.close(4000, code);
    if (joined !== undefined && !connectedMembers(joined.code).has(joined.member)) {
      schedule(joined.code);
    }
  };

  rooms.on({
    changed: schedule,
    frame: sendFrames,
    screenPaired: (device) => {
      for (const connection of connections) {
        if (connection.device === device && connection.wantsScreen) {
          try {
            screenHello(connection);
          } catch (error) {
            send(connection, errorMessage(error, log));
          }
        }
      }
    },
    screenRemoved: (device, code) => {
      for (const connection of connections) {
        if (connection.device === device && connection.screen?.code === code) {
          leaveScreen(connection);
          sendPairing(connection);
        }
      }
    },
    memberChanged: (code, user) => {
      const own = inRoom(code).filter((connection) => connection.joined?.user === user);
      if (own.length > 0) {
        void sendViews(own, connectedIn(code));
      }
    },
    alert: (alert) => {
      const push = options.push;
      if (push === undefined) {
        return;
      }
      for (const user of alert.users) {
        push.notify(user, alert.code, { kind: alert.kind, room: alert.code, game: alert.game, ...(alert.languages === undefined ? {} : { languages: alert.languages }) }, () => !watching(alert.code, user) && rooms.alertDue(alert.code, user, alert.kind, alert.round));
      }
    },
    removed: (code, memberIds) => {
      for (const connection of inRoom(code)) {
        if (memberIds.includes(connection.joined?.member as number)) {
          drop(connection, "removed", "You are no longer a member of this room");
        }
      }
    },
    closed: (code) => {
      for (const connection of inRoom(code)) {
        drop(connection, "room-closed", "This room was closed");
      }
      for (const connection of screensIn(code)) {
        connection.screen = undefined;
        connection.frameBase = undefined;
        sendPairing(connection);
      }
    },
  });

  accounts.on({
    sessionsEnded: (ids) => {
      const ended = new Set(ids);
      for (const connection of connections) {
        if (connection.session !== undefined && ended.has(connection.session.id)) {
          connection.session = undefined;
          if (!connection.wantsScreen) {
            drop(connection, "signed-out", "You were signed out on this device");
          }
        }
      }
    },
    userChanged: (userId) => {
      for (const code of rooms.codes(userId)) {
        schedule(code);
      }
    },
  });

  const server = createServer((request, response) => {
    handleHttp(request, response).catch((error: unknown) => sendError(response, error, log));
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: limits.maxMessageBytes });

  server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/ws" || connections.size >= limits.maxConnections) {
      socket.destroy();
      return;
    }
    if (!sameOrigin(request)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws, request));
  });

  sockets.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const secure = isSecure(request, trustProxy);
    const session = accounts.session(readCookie(request, sessionCookieName(secure)));
    const deviceToken = readCookie(request, screenCookieName(secure));
    const connection: Connection = {
      socket,
      ip: clientIp(request, trustProxy),
      pingAt: undefined,
      pongAt: 0,
      visible: true,
      session: session === undefined ? undefined : { id: session.id, user: session.user.id },
      device: deviceToken === undefined ? undefined : deviceHash(deviceToken),
      wantsScreen: false,
      deltas: false,
      frameBase: undefined,
    };
    if (session === undefined && connection.device === undefined) {
      send(connection, { type: "error", code: "not-signed-in", message: "Please sign in first or join as a guest" });
      socket.close(4000, "not-signed-in");
      return;
    }
    if ([...connections].filter((other) => other.ip === connection.ip).length >= limits.maxConnectionsPerAddress) {
      send(connection, { type: "error", code: "too-many-connections", message: "Too many connections from this address" });
      socket.close(4000, "too-many-connections");
      return;
    }
    connections.add(connection);
    socket.on("pong", () => {
      connection.pongAt = Date.now();
    });
    const helloTimer = setTimeout(() => {
      if (connection.joined === undefined && !connection.wantsScreen) {
        socket.close(4001, "hello is missing");
      }
    }, limits.helloTimeoutMs);
    socket.on("message", (data) => {
      const parsed = parseClientMessage(data.toString());
      if (typeof parsed === "string") {
        send(connection, { type: "error", code: "bad-message", message: parsed });
        return;
      }
      const id = parsed.id;
      const code = connection.joined?.code;
      handleMessage(connection, parsed).then(
        (handled) => {
          if (handled && id !== undefined) {
            whenFlushed(code, () => send(connection, { type: "ack", id }));
          }
        },
        (error: unknown) => send(connection, id === undefined ? errorMessage(error, log) : { ...errorMessage(error, log), id }),
      );
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      connections.delete(connection);
      if (stopping) {
        return;
      }
      const joined = connection.joined;
      if (joined !== undefined) {
        updatePresence(joined.code);
        if (!connectedMembers(joined.code).has(joined.member)) {
          schedule(joined.code);
        }
      }
      leaveScreen(connection);
    });
  });

  const probe = (connection: Connection, timeoutMs: number) => {
    const now = Date.now();
    const pingAt = connection.pingAt;
    const outstanding = pingAt !== undefined && connection.pongAt < pingAt;
    if (outstanding && now - pingAt >= timeoutMs) {
      connection.socket.terminate();
      return;
    }
    if (!outstanding) {
      connection.pingAt = now;
      connection.socket.ping();
    }
  };

  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      probe(connection, limits.heartbeatMs);
    }
  }, limits.heartbeatMs);
  heartbeat.unref();

  const realtimeHeartbeat = setInterval(() => {
    for (const connection of connections) {
      const code = connection.joined?.code ?? connection.screen?.code;
      if (code !== undefined && rooms.isRealtime(code)) {
        probe(connection, limits.realtimeHeartbeatMs);
      }
    }
  }, limits.realtimeHeartbeatMs);
  realtimeHeartbeat.unref();

  const screenSweep = setInterval(() => {
    try {
      const connected = new Set([...connections].map((connection) => connection.screen?.id).filter((id): id is number => id !== undefined));
      rooms.touchScreens(connected);
      rooms.expireScreens(screenIdleMs, connected);
      pairing.sweep();
    } catch (error) {
      log(`Cleaning up TVs failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, screenSweepMs);
  screenSweep.unref();

  async function handleMessage(connection: Connection, message: ClientMessage): Promise<boolean> {
    if (message.type === "resync") {
      connection.frameBase = undefined;
      return false;
    }
    if (message.type === "screen") {
      if (connection.joined !== undefined) {
        throw new RequestError("bad-message", "A connection is either a member or a TV");
      }
      connection.deltas = message.deltas === true;
      screenHello(connection);
      return false;
    }
    if (message.type === "visibility" && connection.screen !== undefined) {
      return false;
    }
    if (connection.wantsScreen) {
      throw new RequestError("bad-message", "A TV only sends screen");
    }
    if (message.type === "hello") {
      if (message.visible !== undefined) {
        connection.visible = message.visible;
      }
      connection.deltas = message.deltas === true;
      await hello(connection, message.room);
      return false;
    }
    if (message.type === "visibility") {
      connection.visible = message.visible;
      if (connection.joined !== undefined) {
        updatePresence(connection.joined.code);
      }
      return false;
    }
    const joined = connection.joined;
    if (joined === undefined) {
      throw new RequestError("not-joined", "Send hello with room first");
    }
    switch (message.type) {
      case "start":
        await rooms.start(joined.code, joined.user);
        return true;
      case "set-option":
        await rooms.setOption(joined.code, joined.user, message.name, message.value);
        return true;
      case "leave":
        rooms.leave(joined.code, joined.user);
        return true;
      case "kick":
        rooms.kick(joined.code, joined.user, message.member);
        return true;
      case "add-bot":
        await rooms.addBot(joined.code, joined.user);
        return true;
      case "hand-over":
        await rooms.handOver(joined.code, joined.user, message.member, connectedMembers(joined.code));
        return true;
      case "take-back":
        rooms.takeBack(joined.code, joined.user);
        return true;
      case "new-round":
        rooms.newRound(joined.code, joined.user);
        return true;
      case "abort":
        rooms.abort(joined.code, joined.user);
        return true;
      case "move":
        if (!(rooms.isRealtime(joined.code) ? rates.inputs : rates.moves).allow(`${joined.code}:${joined.member}`)) {
          throw new RequestError("rate-limited", "Too many moves in a short time, please slow down");
        }
        accounts.touch(joined.user);
        await rooms.move(joined.code, joined.user, message.action, message.expectedVersion);
        return true;
      case "pause":
        rooms.pause(joined.code, joined.user, true);
        return true;
      case "resume":
        rooms.pause(joined.code, joined.user, false);
        return true;
      case "remove-screen":
        rooms.removeScreen(joined.code, joined.user, message.screen);
        return true;
    }
  }

  async function hello(connection: Connection, room: string): Promise<void> {
    if (rates.failedAuth.blocked(connection.ip)) {
      drop(connection, "rate-limited", "Too many failed sign-ins, please try again later");
      return;
    }
    if (connection.session === undefined) {
      throw new RequestError("not-signed-in", "Please sign in first or join as a guest");
    }
    const user = connection.session.user;
    const code = normalizeCode(room);
    let member: number;
    try {
      member = rooms.member(code, user).id;
    } catch (error) {
      if (error instanceof RoomError && error.code === "unknown-room") {
        rates.failedAuth.allow(connection.ip);
      }
      throw error;
    }
    accounts.touch(user);
    const previous = connection.joined;
    if (previous !== undefined && previous.code === code && previous.member === member) {
      await sendView(connection, connectedIn(code));
      return;
    }
    const others = inRoom(code).filter((other) => other !== connection);
    if (others.length >= limits.maxConnectionsPerRoom) {
      drop(connection, "too-many-connections", "Too many connections to this room");
      return;
    }
    if (others.filter((other) => other.joined?.member === member).length >= limits.maxConnectionsPerMember) {
      drop(connection, "too-many-connections", "Too many simultaneous connections for this member");
      return;
    }
    const wasConnected = connectedMembers(code).has(member);
    connection.joined = { code, user, member };
    connection.frameBase = undefined;
    if (previous !== undefined) {
      updatePresence(previous.code);
      schedule(previous.code);
    }
    updatePresence(code);
    if (wasConnected) {
      await sendView(connection, connectedIn(code));
    } else {
      schedule(code);
    }
  }

  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const handled = await api({ request, response, path: url.pathname, ip: clientIp(request, trustProxy), secure: isSecure(request, trustProxy) });
    if (!handled) {
      await serveStatic(request, response, url.pathname, { clientDir: options.clientDir, library, trustProxy });
    }
  }

  return new Promise((resolve) => {
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      const address = server.address() as AddressInfo;
      resolve({
        server,
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            stopping = true;
            clearInterval(heartbeat);
            clearInterval(realtimeHeartbeat);
            clearInterval(screenSweep);
            for (const connection of connections) {
              connection.socket.terminate();
            }
            sockets.close();
            server.close(() => done());
          }),
      });
    });
  });
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { AccountError } from "./accounts";
import { CatalogError } from "./catalogs";
import { LibraryError } from "./games";
import { ProfileError } from "./profiles";
import { PushError } from "./push/service";
import type { ProtocolErrorCode, ServerMessage } from "./protocol";
import { RoomError } from "./rooms";
import { SoloError } from "./solo";

export class RequestError extends Error {
  readonly code: ProtocolErrorCode;
  readonly retryAfterMs: number | undefined;

  constructor(code: ProtocolErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export const cookieMaxAgeSeconds = 400 * 24 * 60 * 60;

export function statusFor(code: ProtocolErrorCode): number {
  switch (code) {
    case "unknown-game":
    case "unknown-room":
    case "unknown-user":
    case "unknown-session":
    case "unknown-link":
    case "unknown-code":
    case "unknown-catalog":
    case "unknown-version":
    case "unknown-screen":
    case "unknown-entry":
    case "not-found":
      return 404;
    case "not-signed-in":
    case "wrong-login":
      return 401;
    case "account-required":
    case "not-member":
    case "not-admin":
    case "forbidden":
    case "account-locked":
    case "signed-in":
    case "last-admin":
      return 403;
    case "room-full":
    case "too-many-screens":
    case "screen-missing":
    case "paused":
    case "push-off":
    case "too-many-rooms":
    case "already-started":
    case "username-taken":
    case "catalog-exists":
    case "other-catalog":
    case "install-busy":
    case "local-game":
    case "incompatible":
    case "solo-game":
    case "not-solo":
    case "missing-item":
      return 409;
    case "catalog-unavailable":
    case "catalog-invalid":
      return 502;
    case "rate-limited":
    case "too-many-inputs":
    case "login-throttled":
      return 429;
    case "server-error":
    case "game-unavailable":
      return 500;
    default:
      return 400;
  }
}

export function errorMessage(error: unknown, log: (message: string) => void): ServerMessage & { type: "error" } {
  if (
    error instanceof RoomError ||
    error instanceof RequestError ||
    error instanceof AccountError ||
    error instanceof PushError ||
    error instanceof CatalogError ||
    error instanceof LibraryError ||
    error instanceof SoloError ||
    error instanceof ProfileError
  ) {
    return { type: "error", code: error.code, message: error.message };
  }
  log(`Internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  return { type: "error", code: "server-error", message: "Internal server error" };
}

export function sendError(response: ServerResponse, error: unknown, log: (message: string) => void): void {
  const message = errorMessage(error, log);
  const retryAfter = error instanceof RequestError || error instanceof AccountError || error instanceof PushError ? error.retryAfterMs : undefined;
  if (retryAfter !== undefined && !response.headersSent) {
    response.setHeader("retry-after", String(Math.max(1, Math.ceil(retryAfter / 1000))));
  }
  sendJson(response, statusFor(message.code), { code: message.code, message: message.message });
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export async function readBody(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      throw new RequestError("bad-message", "The request is too large");
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError("bad-message", "The request is not valid JSON");
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function isSecure(request: IncomingMessage, trustProxy: boolean): boolean {
  if ((request.socket as { encrypted?: boolean }).encrypted === true) {
    return true;
  }
  const forwarded = request.headers["x-forwarded-proto"];
  return trustProxy && typeof forwarded === "string" && forwarded.split(",")[0]?.trim() === "https";
}

export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-gh-session" : "gh-session";
}

export function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${sessionCookieName(secure)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cookieMaxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function screenCookieName(secure: boolean): string {
  return secure ? "__Host-gh-tv" : "gh-tv";
}

export function screenCookie(token: string, secure: boolean): string {
  return `${screenCookieName(secure)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cookieMaxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${sessionCookieName(secure)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const site = request.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") {
    return false;
  }
  if (origin === undefined) {
    return true;
  }
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export function clientIp(request: IncomingMessage, trustProxy: boolean): string {
  const forwarded = request.headers["x-forwarded-for"];
  const hops = trustProxy && typeof forwarded === "string" ? forwarded.split(",").map((hop) => hop.trim()).filter((hop) => hop !== "") : [];
  return addressKey(hops.at(-1) ?? request.socket.remoteAddress ?? "unknown");
}

export function addressKey(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped !== null) {
    return mapped[1] as string;
  }
  if (!address.includes(":")) {
    return address;
  }
  const [head = "", tail] = address.toLowerCase().split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = tail === undefined ? front : [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, "") || "0")
    .join(":")}::/64`;
}

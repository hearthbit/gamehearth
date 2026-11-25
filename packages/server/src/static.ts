import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, relative, isAbsolute } from "node:path";
import { clientUrl, type GameLibrary } from "./games";
import { requestLanguage, type UiLanguage } from "./languages";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
};

export const platformCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function gameCsp(base: string): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${base} 'wasm-unsafe-eval'`,
    `style-src ${base} 'unsafe-inline'`,
    `img-src ${base} data: blob:`,
    `media-src ${base} data: blob:`,
    `font-src ${base} data:`,
    `connect-src ${base} data: blob:`,
    `worker-src ${base} blob:`,
    "frame-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "webrtc 'block'",
  ].join("; ");
}

export const preloadScript = [
  "const games = /^\\/games\\/[a-z0-9]+(-[a-z0-9]+)*\\/[0-9A-Za-z.+-]+\\/[^?#]*$/;",
  "addEventListener('message', async (event) => {",
  "  const data = event.data;",
  "  if (event.source !== parent || data === null || typeof data !== 'object' || data.gamehearth !== 1 || data.type !== 'preload' || !Array.isArray(data.urls)) return;",
  "  const urls = data.urls.filter((url) => typeof url === 'string' && url.length < 600 && games.test(url)).slice(0, 5000);",
  "  const failed = [];",
  "  let next = 0;",
  "  const work = async () => {",
  "    while (next < urls.length) {",
  "      const url = urls[next++];",
  "      try {",
  "        const response = await fetch(url, { cache: 'force-cache' });",
  "        if (!response.ok) throw new Error(String(response.status));",
  "        await response.arrayBuffer();",
  "      } catch {",
  "        failed.push(url);",
  "      }",
  "    }",
  "  };",
  "  await Promise.all([work(), work(), work(), work()]);",
  "  parent.postMessage({ gamehearth: 1, type: 'preloaded', id: data.id, total: urls.length, failed }, '*');",
  "});",
  "parent.postMessage({ gamehearth: 1, type: 'preload-ready' }, '*');",
].join("\n");

const preloadHash = createHash("sha256").update(preloadScript).digest("base64");
const preloadPage = `<!doctype html><meta charset="utf-8"><title>Gamehearth</title><script>${preloadScript}</script>`;

export function preloadCsp(gamesBase: string): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'sha256-${preloadHash}'`,
    `connect-src ${gamesBase}`,
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "webrtc 'block'",
  ].join("; ");
}

const embeddedOnly: Record<"game" | "preload", Record<UiLanguage, string>> = {
  game: {
    en: "Game files only run embedded in Gamehearth. Open the game from a room.",
    de: "Spieldateien laufen nur eingebettet in Gamehearth. Öffne das Spiel über einen Raum.",
  },
  preload: {
    en: "This page only runs embedded in Gamehearth.",
    de: "Diese Seite läuft nur eingebettet in Gamehearth.",
  },
};

const hostPattern = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

export interface StaticOptions {
  clientDir: string | undefined;
  library: GameLibrary;
  trustProxy: boolean;
}

export async function serveStatic(request: IncomingMessage, response: ServerResponse, pathname: string, options: StaticOptions): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Only GET and HEAD", { allow: "GET, HEAD" });
    return;
  }
  const segments = decodeSegments(pathname);
  if (segments === undefined) {
    sendText(response, 400, "Invalid path");
    return;
  }
  if (segments[0] === "games") {
    await serveGameFile(request, response, segments.slice(1), options);
    return;
  }
  if (segments[0] === "preload" && segments.length === 2 && /^[0-9]{1,6}$/.test(segments[1] as string)) {
    servePreload(request, response, options.trustProxy);
    return;
  }
  await servePlatformFile(request, response, segments, options.clientDir);
}

async function serveGameFile(request: IncomingMessage, response: ServerResponse, segments: string[], options: StaticOptions): Promise<void> {
  const [id, versionHash, ...rest] = segments;
  const host = request.headers.host;
  if (id === undefined || versionHash === undefined || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\+[0-9a-f]{12}$/.test(versionHash)) {
    sendText(response, 404, "Not found");
    return;
  }
  if (typeof host !== "string" || !hostPattern.test(host)) {
    sendText(response, 400, "Invalid host");
    return;
  }
  if (request.headers["sec-fetch-dest"] === "document") {
    sendEmbeddedOnly(request, response, "game");
    return;
  }
  const build = await options.library.load(`${id}@${versionHash}`);
  const path = rest.length === 0 || rest.join("/") === "" ? "index.html" : rest.join("/");
  if (build === undefined || !build.clientFiles.has(path)) {
    sendText(response, 404, "Not found");
    return;
  }
  const forwarded = request.headers["x-forwarded-proto"];
  const scheme = options.trustProxy && forwarded === "https" ? "https" : "http";
  const content = await readFile(join(build.clientDir, ...path.split("/")));
  const base = host.startsWith("[") ? "'self'" : `${scheme}://${host}${clientUrl(build.build)}`;
  send(request, response, 200, content, {
    "content-type": contentTypes[extname(path).toLowerCase()] ?? "application/octet-stream",
    "content-security-policy": gameCsp(base),
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
}

function servePreload(request: IncomingMessage, response: ServerResponse, trustProxy: boolean): void {
  const host = request.headers.host;
  if (typeof host !== "string" || !hostPattern.test(host)) {
    sendText(response, 400, "Invalid host");
    return;
  }
  if (request.headers["sec-fetch-dest"] === "document") {
    sendEmbeddedOnly(request, response, "preload");
    return;
  }
  const scheme = trustProxy && request.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  const base = host.startsWith("[") ? "'self'" : `${scheme}://${host}/games/`;
  send(request, response, 200, Buffer.from(preloadPage, "utf8"), {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": preloadCsp(base),
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
}

async function servePlatformFile(request: IncomingMessage, response: ServerResponse, segments: string[], clientDir: string | undefined): Promise<void> {
  if (clientDir === undefined) {
    sendText(response, 503, "The UI is not built. In the monorepo: npm run build");
    return;
  }
  const last = segments[segments.length - 1] ?? "";
  const isFile = last.includes(".");
  const file = isFile ? await findFile(clientDir, segments) : join(clientDir, "index.html");
  if (file === undefined) {
    sendText(response, 404, "Not found");
    return;
  }
  let content: Buffer;
  try {
    content = await readFile(file);
  } catch {
    sendText(response, isFile ? 404 : 503, isFile ? "Not found" : "The UI is not built. In the monorepo: npm run build");
    return;
  }
  const hashed = segments[0] === "assets";
  const type = contentTypes[extname(file).toLowerCase()] ?? "application/octet-stream";
  send(request, response, 200, content, {
    "content-type": type,
    "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    ...(type.startsWith("text/html") ? { "content-security-policy": platformCsp, "x-frame-options": "DENY" } : {}),
  });
}

async function findFile(root: string, segments: string[]): Promise<string | undefined> {
  try {
    const base = await realpath(root);
    const candidate = await realpath(join(base, ...segments));
    const inside = relative(base, candidate);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
      return undefined;
    }
    const stats = await lstat(candidate);
    return stats.isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function decodeSegments(pathname: string): string[] | undefined {
  const segments: string[] = [];
  for (const raw of pathname.split("/").slice(1)) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (segment === "." || segment === ".." || /[\\/\u0000-\u001f]/.test(segment)) {
      return undefined;
    }
    segments.push(segment);
  }
  return segments;
}

function send(request: IncomingMessage, response: ServerResponse, status: number, content: Buffer, headers: Record<string, string>): void {
  response.writeHead(status, { ...headers, "content-length": String(content.length) });
  response.end(request.method === "HEAD" ? undefined : content);
}

function sendEmbeddedOnly(request: IncomingMessage, response: ServerResponse, page: keyof typeof embeddedOnly): void {
  const language = requestLanguage(request.headers["accept-language"]);
  sendText(response, 403, embeddedOnly[page][language], {
    "content-security-policy": "sandbox; default-src 'none'",
    "content-language": language,
    vary: "Accept-Language",
  });
}

function sendText(response: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  response.end(text);
}

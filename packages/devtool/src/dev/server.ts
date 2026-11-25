import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, unwatchFile, watch, watchFile, type Stats } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { build } from "esbuild";
import { allowedPlayerCounts, defaultOptions, emptyProfile, hasCatalog, localize, optionValueProblem, pickLanguage, resolveOptions } from "@gamehearth/sdk/platform";
import { changedOptions, players } from "../format";
import { bundleGameForDev, devtoolSource } from "../bundle";
import { clientPathProblem } from "../client-files";
import { catalogOf, validateManifest, type Manifest } from "../manifest";
import { DevEngine } from "./engine";
import { gameCsp, hostCsp, hostHtml, injectFile, injectScript } from "./page";
import { DevSession, type DevProblem } from "./session";
import { DevProfiles, devProfilesFile } from "./profiles-file";
import { DevSoloState, soloSaveFile } from "./solo-state";
import { mapStack, sourceMapOf, type MappedFile } from "./stack";
import { formatProblem, type DevLog, type DevView } from "./view";

export interface DevOptions {
  port?: number;
  host?: string;
  build?: string;
  client?: string;
  players?: number;
  maxPlayers?: number;
  out?: (line: string) => void;
  limitMs?: number;
  pollMs?: number;
  botDelayMs?: number;
}

export interface DevServer {
  url: string;
  port: number;
  session: DevSession;
  reloadRules(): Promise<void>;
  view(): DevView;
  close(): Promise<void>;
}

export const defaultPort = 5180;

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".pck": "application/octet-stream",
};

const maxBody = 128 * 1024;
const maxLogs = 40;
const clientWaitMs = 10_000;
export const buildErrorCollectMs = 400;

async function bundlePage(file: string): Promise<string> {
  const result = await build({
    entryPoints: [devtoolSource(join("dev", "page", file))],
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    logLevel: "silent",
  });
  return result.outputFiles[0]?.text ?? "";
}

function readManifest(gameDir: string): { ok: true; manifest: Manifest } | { ok: false; message: string } {
  const file = join(gameDir, "manifest.json");
  if (!existsSync(file)) {
    return { ok: false, message: `manifest.json is missing in ${gameDir}. dev starts in a game folder, e.g. one that gamehearth new created.` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (error) {
    return { ok: false, message: `manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const checked = validateManifest(raw);
  return checked.ok ? checked : { ok: false, message: checked.problems.join("\n") };
}

function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

export function allowedHost(header: string | undefined): boolean {
  if (header === undefined || header === "") {
    return false;
  }
  let hostname: string;
  try {
    hostname = new URL(`http://${header}`).hostname;
  } catch {
    return false;
  }
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
    hostname.startsWith("[") ||
    hostname.endsWith(".app.github.dev")
  );
}

export function printable(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "");
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return;
  }
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  if (process.platform === "win32") {
    await new Promise<void>((done) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("exit", () => done());
      killer.once("error", () => done());
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))]);
}

export async function startDev(gameDirInput: string, options: DevOptions = {}): Promise<DevServer> {
  const gameDir = resolve(gameDirInput);
  const out = (line: string) => (options.out ?? ((text: string) => console.log(text)))(printable(line));
  const loaded = readManifest(gameDir);
  if (!loaded.ok) {
    throw new Error(loaded.message);
  }
  let manifest = loaded.manifest;
  let language = manifest.languages?.[0];
  const solo = manifest.mode === "single" && !manifest.server;
  const maxPlayers = options.maxPlayers ?? 12;
  const counts = () => allowedPlayerCounts(manifest.players, maxPlayers);
  if (options.client !== undefined) {
    const problem = clientPathProblem(options.client);
    if (problem !== undefined) {
      throw new Error(`--client: ${problem}`);
    }
  }
  const clientDir = () => resolve(gameDir, options.client ?? manifest.client);
  const firstCount = (() => {
    const allowed = counts();
    if (options.players !== undefined) {
      if (!allowed.includes(options.players)) {
        throw new Error(`--players ${options.players} does not fit manifest.json (allowed: ${allowed.join(", ")})`);
      }
      return options.players;
    }
    return allowed[0] ?? 2;
  })();
  const requestedPort = options.port ?? defaultPort;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error(`--port ${requestedPort} is not a valid port (0 to 65535)`);
  }

  const cleanups: (() => void | Promise<void>)[] = [];
  const cleanup = async () => {
    for (const step of cleanups.splice(0).reverse()) {
      try {
        await step();
      } catch {
        continue;
      }
    }
  };

  try {
    return await launch();
  } catch (error) {
    await cleanup();
    throw error;
  }

  async function launch(): Promise<DevServer> {
    const problems = new Map<string, DevProblem>();
    const logs: DevLog[] = [];
    const streams = new Set<ServerResponse>();
    let clientVersion = 1;
    let clientNote: string | undefined;
    let broadcastTimer: NodeJS.Timeout | undefined;
    let rulesMap: MappedFile | undefined;
    const clientMaps = new Map<string, { mtimeMs: number; mapped: MappedFile | undefined }>();
    cleanups.push(() => clearTimeout(broadcastTimer));

    const clientReady = () => existsSync(join(clientDir(), "index.html"));
    const clientFingerprint = (): string | undefined => {
      const root = clientDir();
      if (!clientReady()) {
        return undefined;
      }
      try {
        const hash = createHash("sha256");
        const files = (readdirSync(root, { recursive: true }) as string[])
          .filter((file) => !file.endsWith(".map") && statSync(join(root, file)).isFile())
          .map((file) => file.split(sep).join("/"))
          .sort();
        for (const file of files) {
          hash.update(file).update("\0").update(readFileSync(join(root, file))).update("\0");
        }
        return hash.digest("hex");
      } catch {
        return undefined;
      }
    };
    let clientPrint = clientFingerprint();
    let clientBuilt = clientPrint !== undefined;
    let clientGone = false;
    let clientPending = false;
    let stopping = false;
    cleanups.push(() => {
      stopping = true;
    });
    const waitForBuild = async () => {
      const until = Date.now() + clientWaitMs;
      while (!stopping && (clientPending || !clientReady()) && Date.now() < until) {
        await new Promise((done) => setTimeout(done, 50));
      }
    };

    const soloState = new DevSoloState(gameDir, () => manifest.stats ?? {});
    const profileStore = new DevProfiles(gameDir);
    const soloSession = () => ({
      playerCount: 1,
      seed: "",
      options: {},
      version: 0,
      result: undefined,
      screen: undefined,
      seats: [{ seat: "p1", name: "Anna", bot: false, paused: false, away: false, snapshot: null, profile: emptyProfile(), guest: false }],
      state: undefined,
      moves: [],
      problem: undefined,
      botProblems: [],
      note: undefined,
    });
    const view = (): DevView => ({
      game: {
        id: manifest.id,
        name: manifest.name,
        ...(manifest.languages === undefined ? {} : { languages: manifest.languages }),
        counts: counts(),
        mode: manifest.mode,
        ...(manifest.away === undefined ? {} : { away: manifest.away }),
        roles: Object.keys(manifest.roles),
        ...(manifest.options === undefined ? {} : { options: manifest.options }),
        profiles: hasCatalog(catalogOf(manifest)),
      },
      ...(language === undefined ? {} : { language }),
      ...(solo ? { solo: soloState.view(manifest.roles.player?.screen ?? "small") } : {}),
      session: solo ? soloSession() : session.view(),
      client: { version: clientVersion, ready: clientBuilt, note: clientNote },
      problems: [...problems.values()],
      logs: [...logs],
    });

    const broadcast = () => {
      if (broadcastTimer !== undefined) {
        return;
      }
      broadcastTimer = setTimeout(() => {
        broadcastTimer = undefined;
        const data = `data: ${JSON.stringify(view())}\n\n`;
        for (const stream of streams) {
          stream.write(data);
        }
      }, 20);
    };

    let lastReport = "";
    const report = (problem: DevProblem) => {
      const text = formatProblem(problem);
      if (text === lastReport) {
        return;
      }
      lastReport = text;
      out("");
      out(text);
      out("");
    };

    const playOn = () => manifest.mode === "realtime" && manifest.away === "play-on";
    const engine = await DevEngine.start(options.limitMs === undefined ? {} : { limitMs: options.limitMs });
    cleanups.push(() => engine.close());
    const session = new DevSession({
      engine,
      mapStack: (stack) => mapStack(stack, (file) => (file === "game.mjs" ? rulesMap : undefined), gameDir),
      onChange: () => {
        lastReport = session.problem === undefined ? "" : lastReport;
        checkProfilesFile();
        broadcast();
      },
      log: report,
      catalog: () => catalogOf(manifest),
      profiles: profileStore,
      realtime: manifest.mode === "realtime",
      playOn: playOn(),
      ...(options.botDelayMs === undefined ? {} : { botDelayMs: options.botDelayMs }),
    });
    cleanups.push(() => session.close());

    const setProblem = (key: string, problem: DevProblem | undefined) => {
      if (problem === undefined) {
        if (problems.delete(key)) {
          broadcast();
        }
        return;
      }
      const previous = problems.get(key);
      problems.set(key, problem);
      if (previous === undefined || formatProblem(previous) !== formatProblem(problem)) {
        out("");
        out(formatProblem(problem));
        out("");
      }
      broadcast();
    };

    const checkProfilesFile = () => {
      if (solo) {
        return;
      }
      const problem = session.profilesProblem;
      setProblem("profiles-file", problem === undefined ? undefined : { source: "ui", title: "Profile file", message: problem });
    };

    const checkSoloFile = () => {
      if (!solo) {
        return;
      }
      const problem = soloState.problem;
      setProblem("solo-file", problem === undefined ? undefined : { source: "ui", title: "Save file", message: problem });
    };

    const loadRules = async (): Promise<boolean> => {
      let bundle;
      try {
        bundle = await bundleGameForDev(gameDir);
      } catch (error) {
        setProblem("rules-build", {
          source: "build",
          title: "Cannot build the rules",
          message: `${error instanceof Error ? error.message : String(error)}\nUntil that is fixed, the last working version keeps running.`,
        });
        return false;
      }
      setProblem("rules-build", undefined);
      const result = await engine.load(bundle.code, JSON.stringify(catalogOf(manifest)));
      if (!result.ok) {
        setProblem("rules-load", {
          source: "rules",
          title: "Cannot load the game in the sandbox of the server",
          message: `${result.message}\nUntil that is fixed, the last working version keeps running.`,
        });
        return false;
      }
      const map = sourceMapOf(bundle.map);
      rulesMap = map === undefined ? undefined : { map, dir: gameDir };
      setProblem("rules-load", undefined);
      return true;
    };

    if (!solo) {
      await loadRules();
      await session.newMatch(firstCount, undefined, defaultOptions(manifest.options));
    }

    let rulesTimer: NodeJS.Timeout | undefined;
    cleanups.push(() => clearTimeout(rulesTimer));
    let rulesRunning: Promise<void> = Promise.resolve();
    const held = async (task: () => Promise<void>): Promise<void> => {
      await session.hold();
      try {
        await task();
      } finally {
        session.unhold();
      }
    };
    const reloadRules = (): Promise<void> => {
      rulesRunning = rulesRunning.then(() => held(async () => {
        const next = readManifest(gameDir);
        if (!next.ok) {
          setProblem("manifest", { source: "manifest", title: "manifest.json is invalid", message: `${next.message}\nUntil that is fixed, the last valid version applies.` });
        } else {
          setProblem("manifest", undefined);
          manifest = next.manifest;
          language = pickLanguage(manifest.languages, [language]);
        }
        if (solo || (manifest.mode === "single" && !manifest.server)) {
          if (solo !== (manifest.mode === "single" && !manifest.server)) {
            out("mode or server in manifest.json has changed; stop dev and start it again.");
          }
          broadcast();
          return;
        }
        if (!(await loadRules())) {
          broadcast();
          return;
        }
        if (session.playOn !== playOn()) {
          session.setPlayOn(playOn());
          out(playOn() ? 'away is now "play-on": the seats have an "Away" switch.' : "away is no longer \"play-on\": seats are never away.");
        }
        if (session.realtime !== (manifest.mode === "realtime")) {
          session.setRealtime(manifest.mode === "realtime");
          await session.newMatch(
            counts().includes(session.view().playerCount) ? session.view().playerCount : (counts()[0] ?? 2),
            undefined,
            resolveOptions(manifest.options, session.options),
          );
          out(`mode is now ${manifest.mode}, new match started.`);
          return;
        }
        if (!counts().includes(session.view().playerCount)) {
          await session.newMatch(counts()[0] ?? 2, undefined, resolveOptions(manifest.options, session.options));
          out("The player count no longer fits manifest.json, new match started.");
          return;
        }
        const options = resolveOptions(manifest.options, session.options);
        if (JSON.stringify(options) !== JSON.stringify(session.options)) {
          await session.newMatch(session.view().playerCount, undefined, options);
          out("The options in manifest.json have changed, new match started.");
          return;
        }
        await session.reload();
        const note = session.view().note;
        if (note !== undefined) {
          out(note);
        }
      }));
      return rulesRunning;
    };
    const scheduleRules = () => {
      clearTimeout(rulesTimer);
      rulesTimer = setTimeout(() => void reloadRules(), 150);
    };

    const srcDir = join(gameDir, "src");
    if (!solo && existsSync(srcDir)) {
      const watcher = watch(srcDir, { recursive: true }, scheduleRules);
      cleanups.push(() => watcher.close());
    }
    const manifestFile = join(gameDir, "manifest.json");
    const pollMs = options.pollMs ?? 300;
    watchFile(manifestFile, { interval: pollMs }, scheduleRules);
    cleanups.push(() => unwatchFile(manifestFile));

    let clientTimer: NodeJS.Timeout | undefined;
    cleanups.push(() => clearTimeout(clientTimer));
    const clientIndex = () => join(clientDir(), "index.html");
    const watchedIndex = clientIndex();
    const onClient = (current: Stats, previous: Stats) => {
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
        return;
      }
      clientPending = true;
      clearTimeout(clientTimer);
      clientTimer = setTimeout(() => {
        clientMaps.clear();
        const print = clientFingerprint();
        if (print === undefined) {
          if (!clientGone) {
            clientGone = true;
            out("The built UI is missing right now; the frames stay until the next build is there.");
          }
          return;
        }
        clientGone = false;
        clientPending = false;
        clientNote = undefined;
        clientBuilt = true;
        problems.delete("client-build");
        if (print === clientPrint) {
          broadcast();
          return;
        }
        clientPrint = print;
        clientVersion += 1;
        for (const key of [...problems.keys()]) {
          if (key.startsWith("client:")) {
            problems.delete(key);
          }
        }
        out("UI rebuilt, reloading the frames.");
        broadcast();
      }, 250);
    };
    watchFile(watchedIndex, { interval: pollMs }, onClient);
    cleanups.push(() => unwatchFile(watchedIndex));
    if (solo) {
      const savePath = soloState.path;
      watchFile(savePath, { interval: pollMs }, () => {
        checkSoloFile();
        broadcast();
      });
      cleanups.push(() => unwatchFile(savePath));
      checkSoloFile();
    }

    if (options.build !== undefined) {
      clientNote = clientReady() ? undefined : `Building the UI (${options.build}) …`;
      const child = spawn(options.build, { cwd: gameDir, shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
      let stopped = false;
      cleanups.push(async () => {
        stopped = true;
        await killTree(child);
      });
      let recent: string[] = [];
      let collecting: string[] | undefined;
      let collectTimer: NodeJS.Timeout | undefined;
      cleanups.push(() => clearTimeout(collectTimer));
      const onOutput = (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) {
          if (line.trim() === "") {
            continue;
          }
          out(`[build] ${line}`);
          const clean = printable(line);
          if (collecting !== undefined && collecting.length < 60) {
            collecting.push(clean);
          } else if (/error/i.test(line) && !/0 errors?/i.test(line)) {
            collecting = [...recent.slice(-3), clean];
            collectTimer = setTimeout(() => {
              collectTimer = undefined;
              const lines = collecting ?? [];
              collecting = undefined;
              setProblem("client-build", { source: "build", title: "Cannot build the UI", message: lines.join("\n") });
            }, buildErrorCollectMs);
          }
          recent = [...recent.slice(-30), clean];
        }
      };
      child.stdout?.on("data", onOutput);
      child.stderr?.on("data", onOutput);
      child.on("exit", (code) => {
        if (!stopped && code !== 0 && code !== null) {
          setProblem("client-build", { source: "build", title: `The build command stopped (code ${code})`, message: `${options.build}\n${recent.join("\n")}` });
        }
      });
    } else if (!clientReady()) {
      clientNote = `The UI is not built yet: ${relative(gameDir, clientIndex())} is missing. Run npm run build first.`;
    }

    const resolveClientMap = (file: string): MappedFile | undefined => {
      const path = /\/game\/([^?#]+)/.exec(file)?.[1];
      if (path === undefined) {
        return undefined;
      }
      let generated: string;
      try {
        generated = resolve(clientDir(), decodeURIComponent(path));
      } catch {
        return undefined;
      }
      if (!inside(clientDir(), generated)) {
        return undefined;
      }
      const mapFile = `${generated}.map`;
      let stat: Stats;
      try {
        stat = statSync(mapFile);
      } catch {
        return undefined;
      }
      const cached = clientMaps.get(mapFile);
      if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) {
        return cached.mapped;
      }
      const map = sourceMapOf(readFileSync(mapFile, "utf8"));
      const mapped = map === undefined ? undefined : { map, dir: resolve(generated, "..") };
      clientMaps.set(mapFile, { mtimeMs: stat.mtimeMs, mapped });
      return mapped;
    };

    const pages = { host: await bundlePage("host.ts"), inject: await bundlePage("inject.ts") };

    const send = (response: ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
      response.end(body);
    };

    const sendJson = (response: ServerResponse, status: number, body: unknown) => send(response, status, "application/json; charset=utf-8", JSON.stringify(body));

    const readBody = (request: IncomingMessage): Promise<unknown> =>
      new Promise((resolveBody, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBody) {
            reject(new Error("too large"));
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        request.on("end", () => {
          try {
            resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        request.on("error", reject);
      });

    const sameOrigin = (request: IncomingMessage): boolean => {
      const origin = request.headers.origin;
      if (typeof origin !== "string" || !(request.headers["content-type"] ?? "").startsWith("application/json")) {
        return false;
      }
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        return false;
      }
      const hosts = [request.headers.host, firstHeader(request.headers["x-forwarded-host"])].filter((entry): entry is string => typeof entry === "string");
      return hosts.includes(originHost);
    };

    const handlePost = async (path: string, request: IncomingMessage, response: ServerResponse) => {
      if (!sameOrigin(request)) {
        sendJson(response, 403, { ok: false, code: "forbidden", message: "Only the page of gamehearth dev may do that" });
        return;
      }
      let body: Record<string, unknown>;
      try {
        const parsed = await readBody(request);
        body = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      } catch {
        sendJson(response, 400, { ok: false, code: "bad-request", message: "Invalid request" });
        return;
      }
      const seat = typeof body["seat"] === "string" ? body["seat"] : "";
      const known = view().session.seats.some((entry) => entry.seat === seat);
      if (solo && path === "/__dev/solo") {
        const action = body["action"];
        const result =
          action === "save"
            ? soloState.save(body["data"])
            : action === "record"
              ? soloState.record(body["stat"], body["value"])
              : action === "clear-save"
                ? soloState.clearSave()
                : action === "clear-best"
                  ? soloState.clearBest()
                  : ({ ok: false, code: "bad-request", message: "action must be save, record, clear-save or clear-best" } as const);
        if (action === "save" || action === "record") {
          setProblem(
            `solo-${action}`,
            result.ok ? undefined : { source: "ui", title: action === "save" ? "Save rejected" : "Best score rejected", message: result.message },
          );
        }
        checkSoloFile();
        if (result.ok && action === "clear-save") {
          out(`Save deleted (${soloSaveFile}).`);
        }
        if (result.ok && action === "clear-best") {
          out(`Best scores deleted (${soloSaveFile}).`);
        }
        broadcast();
        sendJson(response, 200, { ...result, solo: soloState.view(manifest.roles.player?.screen ?? "small") });
        return;
      }
      if (path === "/__dev/language") {
        const wanted = body["language"];
        const languages = manifest.languages ?? [];
        if (typeof wanted !== "string" || !languages.includes(wanted)) {
          sendJson(response, 400, {
            ok: false,
            code: "invalid-language",
            message: languages.length === 0 ? "The game has no languages in manifest.json" : `Allowed are the languages from manifest.json: ${languages.join(", ")}`,
          });
          return;
        }
        if (wanted !== language) {
          language = wanted;
          out(`Language ${wanted}, reloading the frames.`);
          broadcast();
        }
        sendJson(response, 200, { ok: true });
        return;
      }
      if (solo && path !== "/__dev/log") {
        sendJson(response, 400, { ok: false, code: "solo", message: "Single-player games without a reducer have no match, moves, bots or ticks" });
        return;
      }
      if (path === "/__dev/move") {
        if (!known) {
          sendJson(response, 400, { ok: false, code: "unknown-player", message: `The seat ${seat} does not exist` });
          return;
        }
        const expected = body["expectedVersion"];
        const result = await session.move(seat, body["action"], typeof expected === "number" ? { expectedVersion: expected } : {});
        sendJson(response, 200, result);
        return;
      }
      if (path === "/__dev/new") {
        const count = Number(body["playerCount"]);
        if (!counts().includes(count)) {
          sendJson(response, 400, { ok: false, code: "players", message: `Allowed are ${counts().join(", ")} players` });
          return;
        }
        const wanted = body["options"];
        for (const [name, value] of Object.entries(wanted !== null && typeof wanted === "object" && !Array.isArray(wanted) ? wanted : {})) {
          const problem = optionValueProblem(manifest.options, name, value);
          if (problem !== undefined) {
            sendJson(response, 400, { ok: false, code: "invalid-option", message: problem });
            return;
          }
        }
        const options = resolveOptions(manifest.options, wanted === undefined ? session.options : { ...session.options, ...(wanted as object) });
        await session.newMatch(count, undefined, options);
        const chosen = changedOptions(manifest.options, options);
        out(`New match with ${players(count)}${chosen.length === 0 ? "" : `, options ${chosen.join(", ")}`}.`);
        sendJson(response, 200, { ok: true });
        return;
      }
      if (path === "/__dev/pause") {
        session.pause(body["paused"] === true);
        sendJson(response, 200, { ok: true });
        return;
      }
      if (path === "/__dev/step") {
        await session.step();
        sendJson(response, 200, { ok: true });
        return;
      }
      if (path === "/__dev/speed") {
        session.setSpeed(Number(body["speed"]));
        sendJson(response, 200, { ok: true });
        return;
      }
      if (path === "/__dev/profile" || path === "/__dev/guest") {
        if (!known) {
          sendJson(response, 400, { ok: false, code: "unknown-player", message: `The seat ${seat} does not exist` });
          return;
        }
        const result = path === "/__dev/profile" ? await session.editProfile(seat, body["profile"]) : await session.setGuest(seat, body["guest"] === true);
        if (result.ok) {
          out(path === "/__dev/profile" ? `Profile of ${seat} changed (${devProfilesFile}).` : `${seat} plays ${body["guest"] === true ? "as a guest with an empty profile" : "with their profile again"}; new match started.`);
        }
        sendJson(response, result.ok ? 200 : 400, result);
        return;
      }
      if (path === "/__dev/away") {
        if (!known) {
          sendJson(response, 400, { ok: false, code: "unknown-player", message: `The seat ${seat} does not exist` });
          return;
        }
        if (!playOn()) {
          sendJson(response, 400, { ok: false, code: "no-away", message: 'Only realtime games with "away": "play-on" in manifest.json have seats that are away; the others pause instead.' });
          return;
        }
        session.setAway(seat, body["on"] === true);
        sendJson(response, 200, { ok: true });
        return;
      }
      if (path === "/__dev/bot") {
        if (!known) {
          sendJson(response, 400, { ok: false, code: "unknown-player", message: `The seat ${seat} does not exist` });
          return;
        }
        session.setBot(seat, body["on"] === true);
        sendJson(response, 200, { ok: true });
        return;
      }
      if (path === "/__dev/log") {
        const level = body["level"];
        const text = typeof body["text"] === "string" ? printable(body["text"].slice(0, 4000)) : "";
        const stack = typeof body["stack"] === "string" ? printable(body["stack"].slice(0, 8000)) : undefined;
        if (!known || (level !== "log" && level !== "info" && level !== "warn" && level !== "error")) {
          sendJson(response, 400, { ok: false });
          return;
        }
        logs.push({ seat, level, text });
        logs.splice(0, Math.max(logs.length - maxLogs, 0));
        if (level === "error") {
          const mapped = stack === undefined ? undefined : mapStack(stack, resolveClientMap, gameDir);
          setProblem(`client:${seat}`, {
            source: "ui",
            title: `Error in the UI of ${seat}`,
            message: text,
            ...(mapped === undefined ? {} : { stack: mapped.split("\n").filter((line) => /:\d+:\d+\)?\s*$/.test(line)).join("\n") }),
          });
        } else {
          out(`[${seat}] ${level === "log" ? "" : `${level}: `}${text}`);
          broadcast();
        }
        sendJson(response, 200, { ok: true });
        return;
      }
      sendJson(response, 404, { ok: false });
    };

    const serveGameFile = async (path: string, request: IncomingMessage, response: ServerResponse) => {
      const host = request.headers.host ?? "localhost";
      const base = `http://${host}/game/`;
      const headers = { "content-security-policy": gameCsp(base), "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" };
      if (request.headers["sec-fetch-dest"] === "document") {
        send(response, 403, "text/plain; charset=utf-8", `Game files only run embedded. Open http://${host}/ instead of this file.`, headers);
        return;
      }
      if (path === injectFile) {
        send(response, 200, types[".js"] as string, pages.inject, headers);
        return;
      }
      const root = clientDir();
      const file = resolve(root, path === "" ? "index.html" : path);
      if (clientBuilt && inside(root, file) && !existsSync(file)) {
        await waitForBuild();
      }
      if (!inside(root, file) || !existsSync(file) || !statSync(file).isFile()) {
        send(response, 404, "text/plain; charset=utf-8", "Not found", headers);
        return;
      }
      const type = types[extname(file).toLowerCase()] ?? "application/octet-stream";
      if (extname(file).toLowerCase() === ".html") {
        send(response, 200, type, injectScript(await readFile(file, "utf8")), headers);
        return;
      }
      send(response, 200, type, await readFile(file), headers);
    };

    const handle = async (request: IncomingMessage, response: ServerResponse) => {
      if (!allowedHost(request.headers.host)) {
        send(response, 403, "text/plain; charset=utf-8", "gamehearth dev only answers on localhost or an IP address.");
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (request.method === "POST") {
        await handlePost(path, request, response);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        send(response, 405, "text/plain; charset=utf-8", "Not allowed");
        return;
      }
      if (path === "/" || /^\/(p\d+|tv)\/?$/.test(path)) {
        send(response, 200, types[".html"] as string, hostHtml, { "content-security-policy": hostCsp });
        return;
      }
      if (path === "/__dev/host.js") {
        send(response, 200, types[".js"] as string, pages.host);
        return;
      }
      if (path === "/__dev/view") {
        sendJson(response, 200, view());
        return;
      }
      if (path === "/__dev/events") {
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
        response.write(`data: ${JSON.stringify(view())}\n\n`);
        streams.add(response);
        request.on("close", () => streams.delete(response));
        return;
      }
      if (path.startsWith("/game/")) {
        let decoded: string;
        try {
          decoded = decodeURIComponent(path.slice("/game/".length));
        } catch {
          send(response, 400, "text/plain; charset=utf-8", "Invalid path");
          return;
        }
        if (decoded.includes("\0") || decoded.split(/[\\/]/).includes("..")) {
          send(response, 400, "text/plain; charset=utf-8", "Invalid path");
          return;
        }
        await serveGameFile(decoded.split("/").join(sep), request, response);
        return;
      }
      send(response, 404, "text/plain; charset=utf-8", "Not found");
    };

    const server: Server = createServer((request, response) => {
      handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          send(response, 500, "text/plain; charset=utf-8", error instanceof Error ? error.message : String(error));
        } else {
          response.end();
        }
      });
    });
    cleanups.push(async () => {
      for (const stream of streams) {
        stream.end();
      }
      if (!server.listening) {
        return;
      }
      const stopped = new Promise<void>((done) => server.close(() => done()));
      server.closeAllConnections();
      await stopped;
    });
    const heartbeat = setInterval(() => {
      for (const stream of streams) {
        stream.write(": ping\n\n");
      }
    }, 15_000);
    heartbeat.unref();
    cleanups.push(() => clearInterval(heartbeat));

    const host = options.host ?? "127.0.0.1";
    const port = await listen(server, requestedPort, host, options.port === undefined);
    if (options.port === undefined && port !== requestedPort) {
      out(`Port ${requestedPort} is in use (is dev already running?). dev takes port ${port}.`);
    }
    const shown = host === "0.0.0.0" || host === "::" || host === "127.0.0.1" ? "localhost" : host;
    const url = `http://${shown}:${port}`;

    out(`Gamehearth dev: ${localize(manifest.name, language)}`);
    if (solo) {
      out(`  Game:        ${url}`);
      out(`  Save and best scores: ${soloSaveFile}`);
    } else {
      out(`  All seats:   ${url}`);
      out(`  One seat:    ${url}/p1 (p2, p3 …)`);
      if (hasCatalog(catalogOf(manifest))) {
        out(`  Profiles:    ${devProfilesFile}`);
      }
    }
    if (manifest.roles.screen !== undefined) {
      out(`  TV:          ${url}/tv`);
    }
    if (manifest.languages !== undefined) {
      out(`  Languages:   ${manifest.languages.join(", ")} (switch at the top of the page)`);
    }
    if (host === "0.0.0.0" || host === "::") {
      for (const address of lanAddresses()) {
        out(`  On Wi-Fi:    http://${address}:${port}`);
      }
      out("  Warning: on the Wi-Fi, every device can see and control all seats.");
    }
    if (clientNote !== undefined && options.build === undefined) {
      out(clientNote);
    }
    out("Stop with Ctrl+C.");

    let closing: Promise<void> | undefined;
    return {
      url,
      port,
      session,
      reloadRules,
      view,
      close() {
        closing ??= cleanup();
        return closing;
      },
    };
  }
}

function listen(target: Server, first: number, address: string, fallback: boolean): Promise<number> {
  return new Promise((resolvePort, reject) => {
    let candidate = first;
    const attempt = () => {
      target.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && fallback && first !== 0 && candidate < first + 20) {
          candidate += 1;
          attempt();
          return;
        }
        reject(
          error.code === "EADDRINUSE"
            ? new Error(`Port ${candidate} is in use. Is dev already running? Otherwise pick another one with --port.`)
            : error,
        );
      });
      target.listen(candidate, address, () => resolvePort((target.address() as AddressInfo).port));
    };
    attempt();
  });
}

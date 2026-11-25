import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevEngine, workerCachePrefix } from "../src/dev/engine";
import { allowedHost, printable, startDev, type DevServer } from "../src/dev/server";

const devtool = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(devtool, "dev-review-"));

afterAll(() => rmSync(work, { recursive: true, force: true }));

const counter = `import { defineGame } from "@gamehearth/sdk";
export default defineGame<any, any>({
  setup: ({ players }) => ({ public: { count: 0 }, players: Object.fromEntries(players.map((player: string) => [player, {}])), secret: {} }),
  legalMoves: (state) => (state.public.count >= 50 ? [] : [{ type: "add" }]),
  apply: (state) => { state.public.count += 1; },
  result: (state) => (state.public.count >= 50 ? { winners: [] } : undefined),
});
`;

function game(name: string, client = "dist/client"): string {
  const dir = join(work, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), counter);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: name,
      name,
      version: "0.1.0",
      sdk: "^0.1.0",
      license: { code: "MIT", assets: "CC0-1.0" },
      mode: "turn-based",
      players: { min: 2, max: 3 },
      server: true,
      client: "dist/client",
      roles: { player: { inputs: ["touch"], screen: "small" } },
    }),
  );
  mkdirSync(join(dir, client), { recursive: true });
  writeFileSync(join(dir, client, "index.html"), `<!doctype html><html><head></head><body>${client}</body></html>`);
  return dir;
}

function devTempDirs(root: string = tmpdir()): string[] {
  return readdirSync(root).filter((entry) => entry.startsWith("gamehearth-dev-") && !entry.startsWith("gamehearth-dev-cache-"));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function raw(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path ?? "/", headers: options.headers ?? {} }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

const pidCommand = (file: string) => `node -e "require('fs').writeFileSync('${file}', String(process.pid)); setInterval(() => {}, 1000)"`;

describe("Review 13 and 6: host, origin and control characters", () => {
  let server: DevServer;
  const lines: string[] = [];

  beforeAll(async () => {
    server = await startDev(game("network"), { port: 0, out: (line) => lines.push(line) });
  });
  afterAll(async () => server.close());

  it("only answers on localhost, IP addresses and Codespaces names (against DNS rebinding)", async () => {
    expect((await raw(server.port, { headers: { host: "evil.example" } })).status).toBe(403);
    expect((await raw(server.port, { path: "/__dev/view", headers: { host: `evil.example:${server.port}` } })).status).toBe(403);
    expect((await raw(server.port, { headers: { host: `localhost:${server.port}` } })).status).toBe(200);
    expect((await raw(server.port, { headers: { host: `127.0.0.1:${server.port}` } })).status).toBe(200);
    expect(allowedHost("192.168.1.20:5180")).toBe(true);
    expect(allowedHost("[::1]:5180")).toBe(true);
    expect(allowedHost("game.localhost:5180")).toBe(true);
    expect(allowedHost("abc-5180.app.github.dev")).toBe(true);
    expect(allowedHost("my-computer.fritz.box:5180")).toBe(false);
    expect(allowedHost(undefined)).toBe(false);
  });

  it("accepts moves also behind HTTPS when the host matches", async () => {
    const body = JSON.stringify({ seat: "p1", action: { type: "add" } });
    const json = { "content-type": "application/json" };
    expect((await raw(server.port, { method: "POST", path: "/__dev/move", body, headers: { ...json, host: `127.0.0.1:${server.port}`, origin: `https://127.0.0.1:${server.port}` } })).body).toBe('{"ok":true}');
    const forwarded = await raw(server.port, {
      method: "POST",
      path: "/__dev/move",
      body,
      headers: { ...json, host: `localhost:${server.port}`, origin: "https://abc-5180.app.github.dev", "x-forwarded-host": "abc-5180.app.github.dev" },
    });
    expect(forwarded.body).toBe('{"ok":true}');
    const foreign = await raw(server.port, { method: "POST", path: "/__dev/move", body, headers: { ...json, host: `127.0.0.1:${server.port}`, origin: "https://evil.example" } });
    expect(foreign.status).toBe(403);
  });

  it("writes text from the iframe to the terminal without control characters", async () => {
    const body = JSON.stringify({ seat: "p2", level: "log", text: "\u001b[2J\u001b]0;Title\u0007\u001b[31mred\u001b[0m\rnext‮reversed" });
    await raw(server.port, { method: "POST", path: "/__dev/log", body, headers: { "content-type": "application/json", host: `127.0.0.1:${server.port}`, origin: `http://127.0.0.1:${server.port}` } });
    expect(lines).toContain("[p2] red\nnextreversed");
    expect(printable("a\u0000b\tc")).toBe("ab\tc");
  });
});

describe("Review 7: own folder for the UI in dev", () => {
  it("serves another folder than the one from manifest.json with --client", async () => {
    const dir = game("own-client", "dist/dev-client");
    writeFileSync(join(dir, "dist", "dev-client", "index.html"), "<html><head></head><body>from dev-client</body></html>");
    const server = await startDev(dir, { port: 0, client: "dist/dev-client", out: () => {} });
    try {
      const page = await raw(server.port, { path: "/game/index.html", headers: { host: `127.0.0.1:${server.port}` } });
      expect(page.body).toContain("from dev-client");
    } finally {
      await server.close();
    }
    await expect(startDev(dir, { port: 0, client: "../outside", out: () => {} })).rejects.toThrow(/--client/);
  });
});

describe("Review 10 and 12: start fails cleanly", () => {
  let blocker: Server;
  let busyPort: number;

  beforeAll(async () => {
    blocker = createServer();
    await new Promise<void>((done) => blocker.listen(0, "127.0.0.1", () => done()));
    busyPort = (blocker.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((done) => blocker.close(() => done())));

  it("does not switch ports with an explicit port and cleans up the build process and temp folder", async () => {
    const dir = game("busy");
    const before = devTempDirs();
    await expect(startDev(dir, { port: busyPort, build: pidCommand("build.pid"), out: () => {} })).rejects.toThrow(`Port ${busyPort} is in use`);
    expect(devTempDirs().filter((entry) => !before.includes(entry))).toEqual([]);
    await new Promise((done) => setTimeout(done, 1000));
    const pidFile = join(dir, "build.pid");
    if (existsSync(pidFile)) {
      expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    }
  }, 30_000);

  it("checks player count and port before anything has started", async () => {
    const dir = game("wrong");
    const before = devTempDirs();
    await expect(startDev(dir, { players: 7, out: () => {} })).rejects.toThrow("--players 7 does not fit");
    await expect(startDev(dir, { port: 99999, out: () => {} })).rejects.toThrow("is not a valid port");
    expect(devTempDirs().filter((entry) => !before.includes(entry))).toEqual([]);
  });

  it("says so when it switches ports without an explicit port", async () => {
    const dir = game("switch");
    const lines: string[] = [];
    const first = await startDev(dir, { out: () => {} });
    try {
      const second = await startDev(dir, { out: (line) => lines.push(line) });
      try {
        expect(second.port).not.toBe(first.port);
        expect(lines[0]).toBe(`Port ${first.port} is in use (is dev already running?). dev takes port ${second.port}.`);
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  }, 30_000);
});

describe("Review 4: Ctrl+C cleans up", () => {
  it("stops the build process and deletes the temp folder on SIGINT", async () => {
    const scripts = (JSON.parse(readFileSync(join(devtool, "package.json"), "utf8")) as { scripts: { build: string } }).scripts;
    const args = [...scripts.build.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "").slice(1);
    const outfile = join(work, "cli.js");
    const esbuild = join(dirname(createRequire(import.meta.url).resolve("esbuild/package.json")), "bin", "esbuild");
    execFileSync(process.execPath, [esbuild, ...args.map((arg) => (arg.startsWith("--outfile=") ? `--outfile=${outfile}` : arg))], { cwd: devtool });
    const preload = join(work, "ctrl-c.mjs");
    writeFileSync(
      preload,
      [
        "const write = process.stdout.write.bind(process.stdout);",
        "process.stdout.write = (chunk, ...rest) => {",
        "  const result = write(chunk, ...rest);",
        '  if (String(chunk).includes("Stop with Ctrl+C.")) setTimeout(() => process.emit("SIGINT"), 500);',
        "  return result;",
        "};",
      ].join("\n"),
    );
    const dir = game("ctrl-c");
    const temp = join(work, "temp");
    mkdirSync(temp);
    const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, outfile, "dev", dir, "--port", "0", "--build", pidCommand("build.pid")], {
      env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const code = await new Promise<number | null>((done) => child.on("exit", (exitCode) => done(exitCode)));
    expect(output).toContain("Stop with Ctrl+C.");
    expect(code).toBe(0);
    expect(devTempDirs(temp)).toEqual([]);
    const pid = Number(readFileSync(join(dir, "build.pid"), "utf8"));
    await new Promise((done) => setTimeout(done, 500));
    expect(alive(pid)).toBe(false);
  }, 60_000);
});

describe("temp files", () => {
  it("creates no folder per run that would be left behind after a hard stop, but uses a cache per version", async () => {
    const all = () => readdirSync(tmpdir()).filter((entry) => entry.startsWith("gamehearth-dev-"));
    const before = all();
    const first = await DevEngine.start();
    const second = await DevEngine.start();
    await first.close();
    await second.close();
    const added = all().filter((entry) => !before.includes(entry));
    expect(added.length).toBeLessThanOrEqual(1);
    expect(added.every((entry) => entry.startsWith(workerCachePrefix))).toBe(true);
    expect(all().some((entry) => entry.startsWith(workerCachePrefix))).toBe(true);
  });
});

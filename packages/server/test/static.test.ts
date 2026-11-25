import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clientUrl } from "../src/games";
import { startServer } from "../src/transport";
import { createSetup, zaehlenV1, type Setup } from "./helpers";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(port: number, path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

function platformDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gamehearth-ui-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Gamehearth</title>");
  writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(join(dir, "sw.js"), "self.addEventListener('fetch', () => {})");
  writeFileSync(join(dir, "manifest.webmanifest"), "{}");
  return dir;
}

async function serve(options: { clientDir?: string; trustProxy?: boolean } = {}): Promise<{ setup: Setup; port: number; build: string }> {
  const setup = await createSetup();
  cleanups.push(() => setup.cleanup());
  const build = (await setup.library.install(zaehlenV1)).build;
  const running = await startServer({ rooms: setup.rooms, accounts: setup.accounts, library: setup.library, port: 0, host: "127.0.0.1", log: () => {}, ...options });
  cleanups.push(() => running.close());
  return { setup, port: running.port, build };
}

describe("Platform UI", () => {
  it("serves index.html for the home page and room links with a strict CSP and without cache", async () => {
    const { port } = await serve({ clientDir: platformDir() });
    for (const path of ["/", "/r/ABC234", "/irgendwas/tief"]) {
      const response = await get(port, path);
      expect(response.status).toBe(200);
      expect(response.body).toContain("<title>Gamehearth</title>");
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-cache");
      expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(response.headers["content-security-policy"]).toContain("frame-src 'self'");
    }
  });

  it("serves hashed files with a long cache time, the service worker without", async () => {
    const { port } = await serve({ clientDir: platformDir() });
    const asset = await get(port, "/assets/index-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(asset.headers["cache-control"]).toContain("immutable");
    const worker = await get(port, "/sw.js");
    expect(worker.headers["cache-control"]).toBe("no-cache");
    expect((await get(port, "/manifest.webmanifest")).headers["content-type"]).toBe("application/manifest+json; charset=utf-8");
  });

  it("answers missing files and paths leading outside with 404 or 400", async () => {
    const { port } = await serve({ clientDir: platformDir() });
    expect((await get(port, "/assets/fehlt.js")).status).toBe(404);
    expect((await get(port, "/%2e%2e/%2e%2e/package.json")).status).toBe(404);
    expect((await get(port, "/assets/..%2f..%2fpackage.json")).status).toBe(400);
    expect((await get(port, "/assets/%5c..%5cpackage.json")).status).toBe(400);
    expect((await get(port, "/assets/%E0%A4%A")).status).toBe(400);
  });

  it("leaves unknown API paths to JSON errors and allows only GET and HEAD", async () => {
    const { port } = await serve({ clientDir: platformDir() });
    const api = await get(port, "/api/gibtsnicht");
    expect(api.status).toBe(404);
    expect(JSON.parse(api.body)).toMatchObject({ code: "not-found" });
    expect((await get(port, "/", { method: "DELETE" })).status).toBe(405);
    const head = await get(port, "/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
  });

  it("reports an unbuilt UI with 503", async () => {
    const { port } = await serve({ clientDir: join(tmpdir(), "gamehearth-gibt-es-nicht") });
    const response = await get(port, "/");
    expect(response.status).toBe(503);
    expect(response.body).toContain("npm run build");
  });
});

describe("Client of a build", () => {
  it("serves the files with a CSP sandbox, sources only from the build, and CORS", async () => {
    const { port, build } = await serve();
    const base = clientUrl(build);
    for (const path of [base, `${base}index.html`]) {
      const response = await get(port, path, { headers: { host: "games.example:8443" } });
      expect(response.status).toBe(200);
      expect(response.body).toContain("Testspiel");
      const csp = response.headers["content-security-policy"] as string;
      expect(csp).toMatch(/^sandbox allow-scripts;/);
      expect(csp).toContain(`script-src http://games.example:8443${base} 'wasm-unsafe-eval'`);
      expect(csp).toContain(`connect-src http://games.example:8443${base} data: blob:`);
      expect(csp).toContain("default-src 'none'");
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["cache-control"]).toContain("immutable");
    }
  });

  it("names https as the scheme behind a trusted proxy", async () => {
    const { port, build } = await serve({ trustProxy: true });
    const response = await get(port, clientUrl(build), { headers: { host: "games.example", "x-forwarded-proto": "https" } });
    expect(response.headers["content-security-policy"]).toContain(`script-src https://games.example${clientUrl(build)}`);
    const untrusted = await serve();
    const plain = await get(untrusted.port, clientUrl(untrusted.build), { headers: { host: "games.example", "x-forwarded-proto": "https" } });
    expect(plain.headers["content-security-policy"]).toContain("script-src http://games.example/");
  });

  it("serves only client files, never code, manifest or other builds", async () => {
    const { port, build } = await serve({ clientDir: platformDir() });
    const base = clientUrl(build);
    const [id, versionHash] = base.split("/").slice(2);
    expect((await get(port, `${base}game.mjs`)).status).toBe(404);
    expect((await get(port, `${base}../manifest.json`)).status).toBe(404);
    expect((await get(port, `${base}..%2fgame.mjs`)).status).toBe(400);
    expect((await get(port, `/games/${id}/${versionHash}/../../../test.sqlite`)).status).toBe(404);
    expect((await get(port, `/games/${id}/1.0.0+000000000000/index.html`)).status).toBe(404);
    expect((await get(port, `/games/${id}/latest/index.html`)).status).toBe(404);
    expect((await get(port, `/games/../builds/index.html`)).status).toBe(404);
  });

  it("falls back to 'self' for an IPv6 address because CSP sources know no IPv6 hosts", async () => {
    const { port, build } = await serve();
    const response = await get(port, clientUrl(build), { headers: { host: "[::1]:8080" } });
    expect(response.status).toBe(200);
    const csp = response.headers["content-security-policy"] as string;
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("[::1]");
  });

  it("rejects an invalid host instead of writing it into the CSP", async () => {
    const { port, build } = await serve();
    const response = await get(port, clientUrl(build), { headers: { host: "evil.example; script-src *" } });
    expect(response.status).toBe(400);
  });
});

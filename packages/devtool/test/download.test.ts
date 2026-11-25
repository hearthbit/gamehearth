import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { download, downloadUrlProblem, isLoopbackHost } from "../src/download";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/ok") {
      response.writeHead(200, { "content-length": "5" });
      response.end("hello");
    } else if (request.url === "/large") {
      response.writeHead(200, { "content-length": String(2000) });
      response.end("x".repeat(2000));
    } else if (request.url === "/stream") {
      response.writeHead(200);
      for (let index = 0; index < 20; index++) {
        response.write("x".repeat(100));
      }
      response.end();
    } else if (request.url === "/redirect-http") {
      response.writeHead(302, { location: `${base}/ok` });
      response.end();
    } else if (request.url === "/slow") {
      setTimeout(() => response.end("late"), 2000);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const limits = { maxBytes: 1000, timeoutMs: 1000 };

describe("download", () => {
  it("allows https and http only on loopback", () => {
    expect(downloadUrlProblem("https://example.org/catalog.json")).toBeUndefined();
    expect(downloadUrlProblem("http://127.0.0.1:8080/x")).toBeUndefined();
    expect(downloadUrlProblem("http://localhost/x")).toBeUndefined();
    expect(downloadUrlProblem("http://[::1]:9/x")).toBeUndefined();
    expect(downloadUrlProblem("http://example.org/x")).toContain("only come over https");
    expect(downloadUrlProblem("http://192.168.1.1/x")).toContain("only come over https");
    expect(downloadUrlProblem("file:///etc/passwd")).toContain("only come over https");
    expect(downloadUrlProblem("https://user:secret@example.org/x")).toContain("username");
    expect(downloadUrlProblem("no url")).toContain("is not a valid URL");
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("127.0.0.1.example.org")).toBe(false);
  });

  it("downloads a file", async () => {
    expect((await download(`${base}/ok`, limits)).toString()).toBe("hello");
  });

  it("stops right away on an announced oversize", async () => {
    await expect(download(`${base}/large`, limits)).rejects.toThrow("larger than 1000 bytes");
  });

  it("stops while reading without a length", async () => {
    await expect(download(`${base}/stream`, limits)).rejects.toThrow("larger than 1000 bytes");
  });

  it("reports error status and timeout", async () => {
    await expect(download(`${base}/missing`, limits)).rejects.toThrow("responds with 404");
    await expect(download(`${base}/slow`, { maxBytes: 1000, timeoutMs: 200 })).rejects.toThrow("Timed out");
  });

  it("follows redirects only to https", async () => {
    await expect(download(`${base}/redirect-http`, limits)).rejects.toThrow("Redirects only go to https");
  });

  it("follows at most five redirects and checks every target", async () => {
    const seen: string[] = [];
    const chain = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      const step = Number(new URL(url).pathname.slice(1));
      return step < 3 ? new Response(null, { status: 302, headers: { location: `https://cdn.example.org/${step + 1}` } }) : new Response("done");
    }) as typeof fetch;
    expect((await download("https://example.org/0", { ...limits, fetch: chain })).toString()).toBe("done");
    expect(seen).toEqual(["https://example.org/0", "https://cdn.example.org/1", "https://cdn.example.org/2", "https://cdn.example.org/3"]);
    const endless = (async () => new Response(null, { status: 301, headers: { location: "https://example.org/again" } })) as typeof fetch;
    await expect(download("https://example.org/start", { ...limits, fetch: endless })).rejects.toThrow("more than 5 times");
    const signed = `https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r&sv=2018-11-09&jwt=${"x".repeat(1200)}`;
    const github = (async (input: string | URL | Request) =>
      String(input) === signed ? new Response("package") : new Response(null, { status: 302, headers: { location: signed } })) as typeof fetch;
    expect((await download("https://github.com/name/game/releases/download/v1/game-1.zip", { ...limits, fetch: github })).toString()).toBe("package");
    const endlessUrl = (async () => new Response(null, { status: 302, headers: { location: `https://example.org/${"x".repeat(9000)}` } })) as typeof fetch;
    await expect(download("https://example.org/start", { ...limits, fetch: endlessUrl })).rejects.toThrow("longer than 8192 characters");
    const toUser = (async () => new Response(null, { status: 302, headers: { location: "https://a:b@example.org/x" } })) as typeof fetch;
    await expect(download("https://example.org/start", { ...limits, fetch: toUser })).rejects.toThrow("username");
  });
});

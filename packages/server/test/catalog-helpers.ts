import { addToCatalog, buildPackage, formatCatalog, versionEntry, type BuiltPackage, type Catalog } from "gamehearth";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sdk = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url)).replaceAll("\\", "/");

export async function packageOf(fixture: string, manifest: Record<string, unknown> = {}): Promise<BuiltPackage> {
  const dir = mkdtempSync(join(tmpdir(), "gamehearth-paket-"));
  try {
    cpSync(fixture, dir, { recursive: true });
    for (const file of readdirSync(join(dir, "src"))) {
      const path = join(dir, "src", file);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll('"@gamehearth/sdk"', JSON.stringify(sdk)));
    }
    const original = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...original, ...manifest }, null, 2));
    writeFileSync(join(dir, "LICENSE"), "MIT License\n");
    return await buildPackage(dir, { warnings: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Handler = Buffer | string | ((response: import("node:http").ServerResponse) => void);

export class CatalogHost {
  readonly files = new Map<string, Handler>();
  readonly requests: string[] = [];
  #server: Server;
  #base = "";

  private constructor() {
    this.#server = createServer((request, response) => {
      const path = request.url ?? "/";
      this.requests.push(path);
      const handler = this.files.get(path);
      if (handler === undefined) {
        response.writeHead(404);
        response.end();
      } else if (typeof handler === "function") {
        handler(response);
      } else {
        const data = typeof handler === "string" ? Buffer.from(handler) : handler;
        response.writeHead(200, { "content-length": String(data.length) });
        response.end(data);
      }
    });
  }

  static async start(): Promise<CatalogHost> {
    const host = new CatalogHost();
    await new Promise<void>((resolve) => host.#server.listen(0, "127.0.0.1", resolve));
    host.#base = `http://127.0.0.1:${(host.#server.address() as AddressInfo).port}`;
    return host;
  }

  url(path: string): string {
    return `${this.#base}${path}`;
  }

  publish(path: string, packages: BuiltPackage[], name = "Testkatalog"): Catalog {
    let catalog: Catalog = { format: 1, name, games: [] };
    for (const built of packages) {
      const file = `/pakete/${built.pkg.manifest.id}-${built.pkg.manifest.version}-${built.pkg.build.slice(-12)}.zip`;
      this.files.set(file, built.archive);
      catalog = addToCatalog(catalog, built.pkg, versionEntry(built.pkg, built.archive, this.url(file)), { replace: true });
    }
    this.files.set(path, formatCatalog(catalog));
    return catalog;
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise((resolve) => this.#server.close(resolve));
  }
}

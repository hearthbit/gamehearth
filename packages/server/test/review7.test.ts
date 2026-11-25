import type { BuiltPackage } from "gamehearth";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CatalogError, CatalogService } from "../src/catalogs";
import { startServer, type RunningServer } from "../src/transport";
import { CatalogHost, packageOf } from "./catalog-helpers";
import { getJson, postJson } from "./client";
import { account, createSetup, hostRoom, joinRoom, type Setup } from "./helpers";

const punkteV1 = fileURLToPath(new URL("./fixtures/punkte-v1", import.meta.url));
const punkteV2 = fileURLToPath(new URL("./fixtures/punkte-v2", import.meta.url));

let host: CatalogHost;
let v1: BuiltPackage;
let v2: BuiltPackage;
let setup: Setup;
let catalogs: CatalogService;

beforeAll(async () => {
  host = await CatalogHost.start();
  [v1, v2] = await Promise.all([packageOf(punkteV1), packageOf(punkteV2)]);
});

afterAll(async () => {
  await host.close();
});

beforeEach(async () => {
  setup = await createSetup();
  catalogs = new CatalogService(setup.db, setup.library);
  host.files.clear();
});

afterEach(async () => {
  await setup.cleanup();
});

function slowPackages(): { release: () => void } {
  const waiting: (() => void)[] = [];
  for (const [path, handler] of [...host.files]) {
    if (path.endsWith(".zip") && Buffer.isBuffer(handler)) {
      host.files.set(path, (response: ServerResponse) => {
        waiting.push(() => {
          response.writeHead(200, { "content-length": String(handler.length) });
          response.end(handler);
        });
      });
    }
  }
  return {
    release: () => {
      for (const send of waiting.splice(0)) {
        send();
      }
    },
  };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

describe("Review step 7", () => {
  it("does not delete a build on cleanup if a match was started on it during an installation", async () => {
    host.publish("/katalog.json", [v1, v2]);
    const id = (await catalogs.add(host.url("/katalog.json"))).id;
    await catalogs.install(id, "punkte", "1.0.0");
    const installing = setup.library.installPackage(v2.archive, { catalogId: id, expect: { id: "punkte", version: "1.1.0" } });
    const swept = setup.library.sweep(() => setup.rooms.referencedBuilds());
    const anna = hostRoom(setup, "punkte", "Anna");
    const ben = await joinRoom(setup, anna.code, "Ben");
    await setup.rooms.start(anna.code, anna.user);
    expect((await setup.rooms.view(anna.code, anna.user)).game.version).toBe("1.0.0");
    await installing;
    setup.rooms.gameChanged("punkte");
    expect(await swept).toEqual([]);
    await setup.rooms.move(anna.code, anna.user, { type: "add" });
    await setup.rooms.move(anna.code, ben.user, { type: "add" });
    expect(((await setup.rooms.view(anna.code, anna.user)).snapshot?.public as { count: number }).count).toBe(2);
  });

  it("detects updates even when the catalog lists versions in ascending order", async () => {
    const catalog = host.publish("/katalog.json", [v1, v2]);
    host.files.set("/aufsteigend.json", JSON.stringify({ ...catalog, games: catalog.games.map((game) => ({ ...game, versions: [...game.versions].reverse() })) }));
    const id = (await catalogs.add(host.url("/aufsteigend.json"))).id;
    await catalogs.install(id, "punkte", "1.0.0");
    const offer = catalogs.offers()[0];
    expect(offer?.versions.map((version) => version.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(offer?.update).toBe("1.1.0");
  });

  it("accepts http packages only from a catalog that is itself on localhost", async () => {
    host.publish("/katalog.json", [v1]);
    const catalog = JSON.parse(host.files.get("/katalog.json") as string) as { games: { versions: { url: string }[] }[] };
    const fetchVia = (async (input: string | URL | Request, init?: RequestInit) =>
      fetch(String(input).replace("https://katalog.example.org", host.url("")), init)) as typeof fetch;
    host.files.set("/https-katalog.json", JSON.stringify(catalog));
    const remote = new CatalogService(setup.db, setup.library, { fetch: fetchVia });
    const id = (await remote.add("https://katalog.example.org/https-katalog.json")).id;
    host.requests.length = 0;
    const error = await remote.install(id, "punkte", "1.0.0").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CatalogError);
    expect((error as CatalogError).code).toBe("bad-url");
    expect(host.requests.filter((path) => path.endsWith(".zip"))).toEqual([]);
  });
});

describe("Admin view during an installation", () => {
  let running: RunningServer;
  let base: string;
  let admin: { user: number; token: string };

  beforeEach(async () => {
    running = await startServer({ rooms: setup.rooms, accounts: setup.accounts, library: setup.library, catalogs, port: 0, host: "127.0.0.1", log: () => undefined });
    base = `http://127.0.0.1:${running.port}`;
    admin = account(setup, "Anna", "admin");
  });

  afterEach(async () => {
    await running.close();
  });

  it("removes neither game nor catalog while an installation is running", async () => {
    host.publish("/katalog.json", [v1, v2]);
    const id = (await catalogs.add(host.url("/katalog.json"))).id;
    await catalogs.install(id, "punkte", "1.0.0");
    const slow = slowPackages();
    host.requests.length = 0;
    const installing = postJson(base, "/api/admin/games/install", { catalog: id, game: "punkte", version: "1.1.0" }, admin.token);
    await until(() => host.requests.some((path) => path.endsWith(".zip")));
    expect(await postJson(base, "/api/admin/games/punkte/remove", {}, admin.token)).toMatchObject({ status: 409, body: { code: "install-busy" } });
    expect(await postJson(base, `/api/admin/catalogs/${id}/delete`, {}, admin.token)).toMatchObject({ status: 409, body: { code: "install-busy" } });
    slow.release();
    expect((await installing).status).toBe(200);
    expect(setup.library.current("punkte")?.build).toBe(v2.pkg.build);
    expect((await postJson(base, "/api/admin/games/punkte/remove", {}, admin.token)).status).toBe(200);
    expect((await postJson(base, `/api/admin/catalogs/${id}/delete`, {}, admin.token)).status).toBe(200);
  });

  it("does not serve game files as a top-level page, only embedded", async () => {
    await setup.library.install(punkteV1);
    const path = `/games/${setup.library.current("punkte")!.build.replace("@", "/")}/`;
    const top = await fetch(base + path, { headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" } });
    expect(top.status).toBe(403);
    expect(top.headers.get("content-security-policy")).toContain("sandbox");
    expect(await top.text()).toContain("only run embedded");
    expect((await fetch(base + path, { headers: { "sec-fetch-dest": "iframe" } })).status).toBe(200);
    expect((await fetch(base + path)).status).toBe(200);
    expect((await getJson(base, "/api/health")).status).toBe(200);
  });
});

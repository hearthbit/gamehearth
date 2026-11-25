import { readZip, writeZip, type BuiltPackage } from "gamehearth";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CatalogError, CatalogService } from "../src/catalogs";
import { GameLibrary, LibraryError } from "../src/games";
import { RoomError } from "../src/rooms";
import { CatalogHost, packageOf } from "./catalog-helpers";
import { createSetup, hostRoom, joinRoom, startfehler, zaehlenV1, type Setup } from "./helpers";

const punkteV1 = fileURLToPath(new URL("./fixtures/punkte-v1", import.meta.url));
const punkteV2 = fileURLToPath(new URL("./fixtures/punkte-v2", import.meta.url));

let host: CatalogHost;
let v1: BuiltPackage;
let v2: BuiltPackage;
let setup: Setup;
let catalogs: CatalogService;
let closed: string[];
let changed: string[];

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
  closed = [];
  changed = [];
  setup.rooms.on({ closed: (code) => closed.push(code), changed: (code) => changed.push(code) });
  host.files.clear();
});

afterEach(async () => {
  await setup.cleanup();
});

async function expectCode(work: Promise<unknown> | (() => unknown), code: string): Promise<string> {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    if (error instanceof CatalogError || error instanceof LibraryError || error instanceof RoomError) {
      expect(error.code).toBe(code);
      return error.message;
    }
    throw error;
  }
  throw new Error(`expected ${code}`);
}

function builds(): string[] {
  const dir = join(setup.dir, "builds", "punkte");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

async function playToEnd(code: string, seats: { user: number }[]): Promise<void> {
  for (let turn = 0; ; turn++) {
    const view = await setup.rooms.view(code, seats[0]!.user);
    if (view.status === "finished") {
      return;
    }
    const seat = seats[turn % seats.length]!;
    await setup.rooms.move(code, seat.user, { type: "add" });
  }
}

describe("Catalogs", () => {
  it("adds a catalog over HTTP from localhost and remembers its state", async () => {
    host.publish("/katalog.json", [v1], "Familienspiele");
    const info = await catalogs.add(host.url("/katalog.json"));
    expect(info).toMatchObject({ name: "Familienspiele", url: host.url("/katalog.json"), games: 1 });
    expect(info.error).toBeUndefined();
    expect(catalogs.list()).toHaveLength(1);
    await expectCode(catalogs.add(host.url("/katalog.json")), "catalog-exists");
    await expectCode(catalogs.add("http://example.org/katalog.json"), "bad-url");
    await expectCode(catalogs.add("ftp://example.org/katalog.json"), "bad-url");
    await expectCode(catalogs.add(host.url("/fehlt.json")), "catalog-unavailable");
    host.files.set("/kaputt.json", "{ nein");
    expect(await expectCode(catalogs.add(host.url("/kaputt.json")), "catalog-invalid")).toContain("is not valid JSON");
    host.files.set("/falsch.json", JSON.stringify({ format: 1, name: "x", games: [{ id: "a" }] }));
    expect(await expectCode(catalogs.add(host.url("/falsch.json")), "catalog-invalid")).toContain("invalid");
  });

  it("keeps the last good state on refresh when loading fails", async () => {
    host.publish("/katalog.json", [v1]);
    const { id } = await catalogs.add(host.url("/katalog.json"));
    host.files.set("/katalog.json", (response) => {
      response.writeHead(500);
      response.end();
    });
    const failed = await catalogs.refresh(id);
    expect(failed.error).toContain("responds with 500");
    expect(failed.errorCode).toBe("catalog-unavailable");
    expect(catalogs.offers().map((offer) => offer.id)).toEqual(["punkte"]);
    host.publish("/katalog.json", [v1, v2], "Neuer Name");
    const fresh = await catalogs.refresh(id);
    expect(fresh.error).toBeUndefined();
    expect(fresh.errorCode).toBeUndefined();
    expect(fresh.name).toBe("Neuer Name");
    expect(catalogs.offers()[0]?.versions.map((version) => version.version)).toEqual(["1.1.0", "1.0.0"]);
  });

  it("reloads due catalogs once a day", async () => {
    let now = 1_000_000;
    catalogs = new CatalogService(setup.db, setup.library, { clock: () => now });
    host.publish("/katalog.json", [v1]);
    await catalogs.add(host.url("/katalog.json"));
    host.requests.length = 0;
    now += 60 * 60 * 1000;
    await catalogs.refreshDue();
    expect(host.requests).toEqual([]);
    now += 24 * 60 * 60 * 1000;
    await catalogs.refreshDue();
    expect(host.requests).toEqual(["/katalog.json"]);
  });
});

describe("Installing from the catalog", () => {
  async function addCatalog(packages: BuiltPackage[] = [v1, v2]): Promise<number> {
    host.publish("/katalog.json", packages);
    return (await catalogs.add(host.url("/katalog.json"))).id;
  }

  it("installs, plays, updates, rolls back and removes", async () => {
    const id = await addCatalog();
    expect(catalogs.offers()[0]?.id).toBe("punkte");
    expect(catalogs.offers()[0]?.installed).toBeUndefined();
    const installed = await catalogs.install(id, "punkte", "1.0.0");
    expect(installed.build).toBe(v1.pkg.build);
    expect(setup.library.current("punkte")?.build).toBe(v1.pkg.build);
    expect(setup.library.installed()).toEqual([
      expect.objectContaining({ id: "punkte", version: "1.0.0", source: "catalog", catalogId: id, broken: false, shadowed: undefined }),
    ]);
    expect(catalogs.offers()[0]).toMatchObject({ installed: { version: "1.0.0", fromThisCatalog: true }, update: "1.1.0" });

    const running = hostRoom(setup, "punkte", "Anna");
    const ben = await joinRoom(setup, running.code, "Ben");
    await setup.rooms.start(running.code, running.user);
    await setup.rooms.move(running.code, running.user, { type: "add" });
    const lobby = hostRoom(setup, "punkte", "Cem");

    await catalogs.install(id, "punkte", "1.1.0");
    setup.rooms.gameChanged("punkte");
    expect(setup.library.current("punkte")?.build).toBe(v2.pkg.build);
    expect(catalogs.offers()[0]?.update).toBeUndefined();
    expect((await setup.rooms.view(running.code, running.user)).game.version).toBe("1.0.0");
    expect((await setup.rooms.view(lobby.code, lobby.user)).game.version).toBe("1.1.0");
    expect(changed).toContain(lobby.code);
    await setup.rooms.move(running.code, ben.user, { type: "add" });
    expect(((await setup.rooms.view(running.code, running.user)).snapshot?.public as { count: number }).count).toBe(2);

    expect(await setup.library.sweep(() => setup.rooms.referencedBuilds())).toEqual([]);
    await catalogs.install(id, "punkte", "1.0.0");
    expect(setup.library.current("punkte")?.build).toBe(v1.pkg.build);
    await catalogs.install(id, "punkte", "1.1.0");

    setup.library.remove("punkte");
    const effect = setup.rooms.gameChanged("punkte");
    expect(effect.closed).toEqual([lobby.code]);
    expect(closed).toEqual([lobby.code]);
    expect(setup.library.current("punkte")).toBeUndefined();
    expect(setup.rooms.gameRoomCounts().get("punkte")).toEqual({ lobby: 0, running: 1, finished: 0 });
    expect(() => setup.rooms.createRoom("punkte", running.user)).toThrow("not installed");
    const view = await setup.rooms.view(running.code, running.user);
    expect(view.installed).toBe(false);
    expect(view.game.name).toBe("Punkte");
    expect(setup.rooms.rooms(running.user)[0]?.game).toBe("Punkte");
    await playToEnd(running.code, [running, ben]);
    await expectCode(() => setup.rooms.newRound(running.code, running.user), "game-unavailable");

    expect(await setup.library.sweep(() => setup.rooms.referencedBuilds())).toEqual([v2.pkg.build]);
    expect(builds()).toEqual([v1.pkg.build.slice("punkte@".length)]);
    setup.rooms.leave(running.code, running.user);
    setup.rooms.leave(running.code, ben.user);
    expect(await setup.library.sweep(() => setup.rooms.referencedBuilds())).toEqual([v1.pkg.build]);
    expect(builds()).toEqual([]);
  });

  it("closes the room when a running match is aborted after the game was removed", async () => {
    const id = await addCatalog();
    await catalogs.install(id, "punkte", "1.0.0");
    const anna = hostRoom(setup, "punkte", "Anna");
    await joinRoom(setup, anna.code, "Ben");
    await setup.rooms.start(anna.code, anna.user);
    setup.library.remove("punkte");
    setup.rooms.gameChanged("punkte");
    setup.rooms.abort(anna.code, anna.user);
    expect(closed).toEqual([anna.code]);
    expect(setup.rooms.rooms(anna.user)).toEqual([]);
  });

  it("no longer starts a lobby when the game was removed in between", async () => {
    const id = await addCatalog();
    await catalogs.install(id, "punkte", "1.0.0");
    const anna = hostRoom(setup, "punkte", "Anna");
    await joinRoom(setup, anna.code, "Ben");
    setup.library.remove("punkte");
    await expectCode(setup.rooms.start(anna.code, anna.user), "game-unavailable");
  });

  it("survives a restart and detects damaged builds", async () => {
    const id = await addCatalog();
    await catalogs.install(id, "punkte", "1.0.0");
    setup = await setup.reopen();
    expect(setup.library.current("punkte")).toBeUndefined();
    expect(await setup.library.restore()).toEqual([]);
    expect(setup.library.current("punkte")?.build).toBe(v1.pkg.build);
    setup = await setup.reopen();
    const { rmSync } = await import("node:fs");
    rmSync(join(setup.dir, "builds", "punkte", v1.pkg.build.slice("punkte@".length), "game.mjs"));
    expect((await setup.library.restore())[0]).toContain("is missing or damaged");
    expect(setup.library.installed()[0]).toMatchObject({ id: "punkte", broken: true });
    expect(setup.library.list()).toEqual([]);
  });

  it("keeps games of a removed catalog installed, without updates", async () => {
    const id = await addCatalog();
    await catalogs.install(id, "punkte", "1.0.0");
    expect(catalogs.remove(id)).toEqual({ games: ["punkte"] });
    expect(setup.library.installed()[0]).toMatchObject({ id: "punkte", source: "catalog", catalogId: undefined });
    expect(catalogs.offers()).toEqual([]);
    expect(setup.library.current("punkte")?.build).toBe(v1.pkg.build);
    await expectCode(() => catalogs.remove(id), "unknown-catalog");
  });

  it("replaces a game from another catalog only after confirmation", async () => {
    const first = await addCatalog([v1]);
    host.publish("/zweiter.json", [v2], "Zweiter");
    const second = (await catalogs.add(host.url("/zweiter.json"))).id;
    await catalogs.install(first, "punkte", "1.0.0");
    await expectCode(catalogs.install(second, "punkte", "1.1.0"), "other-catalog");
    expect(catalogs.offers().find((offer) => offer.catalogId === second)).toMatchObject({ installed: { fromThisCatalog: false } });
    expect(catalogs.offers().find((offer) => offer.catalogId === second)?.update).toBeUndefined();
    await catalogs.install(second, "punkte", "1.1.0", { replace: true });
    expect(setup.library.installed()[0]).toMatchObject({ catalogId: second, version: "1.1.0" });
  });

  it("lets a local game from GAMES_DIR win and not be removed", async () => {
    const id = await addCatalog();
    const local = await setup.library.install(punkteV1);
    await catalogs.install(id, "punkte", "1.1.0");
    expect(setup.library.current("punkte")?.build).toBe(local.build);
    expect(setup.library.installed()[0]).toMatchObject({ source: "local", shadowed: v2.pkg.build });
    await expectCode(() => setup.library.remove("punkte"), "local-game");
  });

  it("measures storage even while cleanup deletes builds", async () => {
    const files = new Map(readZip(v1.archive, { maxEntries: 100, maxBytes: 10_000_000 }).map((entry) => [entry.path, entry.data]));
    for (let index = 0; index < 400; index++) {
      files.set(`client/assets/teil-${index}.js`, Buffer.from(`// ${index}`));
    }
    const big = writeZip([...files].map(([path, data]) => ({ path, data })));
    const { sha256 } = await import("gamehearth");
    host.publish("/katalog.json", [v1, v2]);
    const catalog = JSON.parse(host.files.get("/katalog.json") as string) as { games: { versions: Record<string, unknown>[] }[] };
    const old = catalog.games[0]!.versions[1]!;
    host.files.set(new URL(old["url"] as string).pathname, big);
    old["size"] = big.length;
    old["sha256"] = sha256(big);
    host.files.set("/katalog.json", JSON.stringify(catalog));
    const id = (await catalogs.add(host.url("/katalog.json"))).id;
    const bigBuild = (await catalogs.install(id, "punkte", "1.0.0")).build;
    await catalogs.install(id, "punkte", "1.1.0");
    const sweeping = setup.library.sweep(() => new Set());
    let measured = 0;
    let done = false;
    void sweeping.finally(() => (done = true));
    while (!done) {
      expect((await setup.library.usage()).total).toBeGreaterThan(0);
      measured += 1;
    }
    expect(await sweeping).toEqual([bigBuild]);
    expect(measured).toBeGreaterThan(0);
    expect([...(await setup.library.usage()).builds.keys()]).toEqual([v2.pkg.build]);
  });

  it("installs only one build at a time", async () => {
    const id = await addCatalog();
    const first = catalogs.install(id, "punkte", "1.0.0");
    await expectCode(catalogs.install(id, "punkte", "1.1.0"), "install-busy");
    await first;
  });

  it("rejects versions that do not exist or need a newer SDK", async () => {
    const newer = await packageOf(punkteV1, { version: "2.0.0", sdk: "^0.1.0" });
    host.publish("/katalog.json", [v1, newer]);
    const catalog = JSON.parse(host.files.get("/katalog.json") as string) as { games: { versions: { version: string; sdk: string }[] }[] };
    catalog.games[0]!.versions[0]!.sdk = "^0.2.0";
    host.files.set("/katalog.json", JSON.stringify(catalog));
    const id = (await catalogs.add(host.url("/katalog.json"))).id;
    await expectCode(catalogs.install(id, "punkte", "9.9.9"), "unknown-version");
    await expectCode(catalogs.install(id, "fehlt", "1.0.0"), "unknown-version");
    expect(await expectCode(catalogs.install(id, "punkte", "2.0.0"), "incompatible")).toContain("^0.2.0");
    expect(catalogs.offers()[0]?.versions.map((version) => [version.version, version.compatible])).toEqual([
      ["2.0.0", false],
      ["1.0.0", true],
    ]);
  });
});

describe("Tampered packages", () => {
  async function catalogWith(archive: Buffer, edit: (version: Record<string, unknown>) => void = () => undefined): Promise<number> {
    host.publish("/katalog.json", [v1]);
    const catalog = JSON.parse(host.files.get("/katalog.json") as string) as { games: { versions: Record<string, unknown>[] }[] };
    const version = catalog.games[0]!.versions[0]!;
    host.files.set(new URL(version["url"] as string).pathname, archive);
    version["size"] = archive.length;
    version["sha256"] = (await import("gamehearth")).sha256(archive);
    edit(version);
    host.files.set("/katalog.json", JSON.stringify(catalog));
    return (await catalogs.add(host.url("/katalog.json"))).id;
  }

  function repack(change: (files: Map<string, Buffer>) => void): Buffer {
    const files = new Map(readZip(v1.archive, { maxEntries: 100, maxBytes: 10_000_000 }).map((entry) => [entry.path, entry.data]));
    change(files);
    return writeZip([...files].map(([path, data]) => ({ path, data })));
  }

  async function expectNothingInstalled(): Promise<void> {
    expect(setup.library.installed()).toEqual([]);
    expect(setup.library.current("punkte")).toBeUndefined();
    await setup.library.sweep(() => setup.rooms.referencedBuilds());
    expect(builds()).toEqual([]);
  }

  it("rejects a package with a wrong checksum", async () => {
    const id = await catalogWith(v1.archive, (version) => {
      version["sha256"] = "0".repeat(64);
    });
    expect(await expectCode(catalogs.install(id, "punkte", "1.0.0"), "package-invalid")).toContain("checksum");
    await expectNothingInstalled();
  });

  it("rejects a package that is larger than announced", async () => {
    const id = await catalogWith(v1.archive, (version) => {
      version["size"] = 100;
    });
    expect(await expectCode(catalogs.install(id, "punkte", "1.0.0"), "catalog-unavailable")).toContain("is larger than");
    await expectNothingInstalled();
  });

  it("rejects paths outside the package without writing anything", async () => {
    const files = readZip(v1.archive, { maxEntries: 100, maxBytes: 10_000_000 });
    const archive = writeZip(files);
    const evil = Buffer.from(archive.toString("latin1").replaceAll("client/index.html", "client/../../x.ht"), "latin1");
    const id = await catalogWith(evil);
    expect(await expectCode(catalogs.install(id, "punkte", "1.0.0"), "package-invalid")).toContain("..");
    await expectNothingInstalled();
    expect(existsSync(join(setup.dir, "x.ht"))).toBe(false);
  });

  it("rejects a package with a broken manifest", async () => {
    const id = await catalogWith(repack((files) => files.set("manifest.json", Buffer.from("{ kaputt"))));
    expect(await expectCode(catalogs.install(id, "punkte", "1.0.0"), "package-invalid")).toContain("manifest.json is not valid JSON");
    await expectNothingInstalled();
  });

  it("rejects a package with foreign files", async () => {
    const id = await catalogWith(repack((files) => files.set("server.js", Buffer.from("process.exit()"))));
    expect(await expectCode(catalogs.install(id, "punkte", "1.0.0"), "package-invalid")).toContain("server.js does not belong");
  });

  it("rejects a package that contains a different game than announced", async () => {
    const other = await packageOf(punkteV1, { id: "anderes" });
    const id = await catalogWith(other.archive);
    expect(await expectCode(catalogs.install(id, "punkte", "1.0.0"), "wrong-package")).toContain("anderes");
    await expectNothingInstalled();
  });

  it("rejects a game that fails in the trial match", async () => {
    const broken = await packageOf(startfehler, { id: "punkte", version: "1.0.0" });
    const id = await catalogWith(broken.archive);
    expect(await expectCode(catalogs.install(id, "punkte", "1.0.0"), "probe-failed")).toContain("Startfehler im Spiel");
    await expectNothingInstalled();
  });

  it("rejects a game whose moves crash in the trial match", async () => {
    const shaky = await packageOf(zaehlenV1, { id: "punkte", version: "1.0.0" });
    const library = new GameLibrary(join(setup.dir, "builds"), setup.sandbox, setup.db, { probeMoves: 500 });
    catalogs = new CatalogService(setup.db, library);
    const id = await catalogWith(shaky.archive);
    let failed = false;
    for (let attempt = 0; attempt < 5 && !failed; attempt++) {
      try {
        await catalogs.install(id, "punkte", "1.0.0");
        library.remove("punkte");
      } catch (error) {
        expect(error).toBeInstanceOf(LibraryError);
        expect((error as LibraryError).message).toContain("absichtlich kaputt");
        failed = true;
      }
    }
    expect(failed).toBe(true);
  });
});

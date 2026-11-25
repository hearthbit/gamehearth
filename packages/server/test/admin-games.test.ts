import type { BuiltPackage } from "gamehearth";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CatalogService, suggestedCatalog } from "../src/catalogs";
import { startServer, type RunningServer } from "../src/transport";
import { CatalogHost, packageOf } from "./catalog-helpers";
import { Client, getJson, postJson } from "./client";
import { account, createSetup, hostRoom, joinRoom, type Setup } from "./helpers";

const punkteV1 = fileURLToPath(new URL("./fixtures/punkte-v1", import.meta.url));
const punkteV2 = fileURLToPath(new URL("./fixtures/punkte-v2", import.meta.url));

let host: CatalogHost;
let v1: BuiltPackage;
let v2: BuiltPackage;
let setup: Setup;
let running: RunningServer;
let base: string;
let admin: { user: number; token: string };

beforeAll(async () => {
  host = await CatalogHost.start();
  [v1, v2] = await Promise.all([packageOf(punkteV1), packageOf(punkteV2)]);
  host.publish("/katalog.json", [v1, v2], "Familienspiele");
});

afterAll(async () => {
  await host.close();
});

beforeEach(async () => {
  setup = await createSetup();
  running = await startServer({
    rooms: setup.rooms,
    accounts: setup.accounts,
    library: setup.library,
    catalogs: new CatalogService(setup.db, setup.library),
    port: 0,
    host: "127.0.0.1",
    log: (message) => setup.logs.push(message),
  });
  base = `http://127.0.0.1:${running.port}`;
  admin = account(setup, "Anna", "admin");
});

afterEach(async () => {
  await running.close();
  await setup.cleanup();
});

interface Overview {
  games: { id: string; version: string; source: string; catalogName?: string; rooms: { lobby: number; running: number; finished: number }; bytes: number }[];
  catalogs: { id: number; name: string; error?: string }[];
  offers: { catalogId: number; id: string; update?: string; versions: { version: string }[] }[];
  storage: { total: number; free: number | null };
  suggested: { name: string; url: string } | null;
  enabled: boolean;
}

async function overview(): Promise<Overview> {
  const response = await getJson(base, "/api/admin/games", admin.token);
  expect(response.status).toBe(200);
  return response.body as unknown as Overview;
}

async function addCatalog(): Promise<number> {
  const response = await postJson(base, "/api/admin/catalogs", { url: host.url("/katalog.json"), trust: true }, admin.token);
  expect(response.status).toBe(201);
  return (response.body["catalog"] as { id: number }).id;
}

describe("Games in the admin view", () => {
  it("is only for admins", async () => {
    const ben = account(setup, "Ben");
    expect((await getJson(base, "/api/admin/games", ben.token)).status).toBe(403);
    expect((await postJson(base, "/api/admin/catalogs", { url: host.url("/katalog.json"), trust: true }, ben.token)).status).toBe(403);
    expect((await postJson(base, "/api/admin/games/install", { catalog: 1, game: "punkte", version: "1.0.0" }, ben.token)).status).toBe(403);
    expect((await postJson(base, "/api/admin/games/punkte/remove", {}, ben.token)).status).toBe(403);
  });

  it("suggests the Gamehearth catalog and requires trust when adding", async () => {
    expect((await overview()).suggested).toEqual(suggestedCatalog);
    expect(await postJson(base, "/api/admin/catalogs", { url: host.url("/katalog.json") }, admin.token)).toMatchObject({
      status: 400,
      body: { code: "trust-required" },
    });
    expect(await postJson(base, "/api/admin/catalogs", { url: "http://example.org/x.json", trust: true }, admin.token)).toMatchObject({
      status: 400,
      body: { code: "bad-url" },
    });
    await addCatalog();
    expect(await postJson(base, "/api/admin/catalogs", { url: host.url("/katalog.json"), trust: true }, admin.token)).toMatchObject({
      status: 409,
      body: { code: "catalog-exists" },
    });
    const view = await overview();
    expect(view.suggested).toBeNull();
    expect(view.catalogs).toEqual([expect.objectContaining({ name: "Familienspiele" })]);
    expect(view.offers.map((offer) => [offer.id, offer.versions.map((version) => version.version)])).toEqual([["punkte", ["1.1.0", "1.0.0"]]]);
  });

  it("installs, shows updates, rooms and storage, and removes again", async () => {
    const catalog = await addCatalog();
    expect((await getJson(base, "/api/games")).body).toEqual([]);
    const installed = await postJson(base, "/api/admin/games/install", { catalog, game: "punkte", version: "1.0.0" }, admin.token);
    expect(installed).toMatchObject({ status: 200, body: { build: v1.pkg.build } });
    expect(setup.logs.some((line) => line.includes("Game installed: Punkte"))).toBe(true);
    expect((await getJson(base, "/api/games")).body).toEqual([expect.objectContaining({ id: "punkte", version: "1.0.0" })]);

    const lobbyHost = account(setup, "Lobby");
    const lobby = setup.rooms.createRoom("punkte", lobbyHost.user);
    const play = hostRoom(setup, "punkte", "Cem");
    await joinRoom(setup, play.code, "Dora");
    await setup.rooms.start(play.code, play.user);

    let view = await overview();
    expect(view.games).toEqual([
      expect.objectContaining({ id: "punkte", version: "1.0.0", source: "catalog", catalogName: "Familienspiele", rooms: { lobby: 1, running: 1, finished: 0 } }),
    ]);
    expect(view.games[0]?.bytes).toBeGreaterThan(0);
    expect(view.storage.total).toBeGreaterThanOrEqual(view.games[0]?.bytes ?? 0);
    expect(view.offers[0]?.update).toBe("1.1.0");

    const lobbyClient = await Client.connect(running.port, { token: lobbyHost.token });
    lobbyClient.send({ type: "hello", room: lobby.code });
    expect((await lobbyClient.room()).game.version).toBe("1.0.0");
    const player = await Client.connect(running.port, { token: play.token });
    player.send({ type: "hello", room: play.code });
    expect((await player.room()).installed).toBe(true);

    await postJson(base, "/api/admin/games/install", { catalog, game: "punkte", version: "1.1.0" }, admin.token);
    expect((await lobbyClient.room()).game.version).toBe("1.1.0");
    expect((await player.room()).game.version).toBe("1.0.0");

    const removed = await postJson(base, `/api/admin/games/punkte/remove`, {}, admin.token);
    expect(removed).toMatchObject({ status: 200, body: { closed: 1, remaining: 1 } });
    expect(await lobbyClient.error()).toMatchObject({ code: "room-closed" });
    const after = await player.room();
    expect(after.installed).toBe(false);
    expect(after.status).toBe("running");
    expect((await getJson(base, "/api/games")).body).toEqual([]);
    expect((await postJson(base, `/api/admin/games/punkte/remove`, {}, admin.token)).body).toMatchObject({ code: "unknown-game" });
    view = await overview();
    expect(view.games).toEqual([]);
    expect(view.offers[0]?.update).toBeUndefined();
    player.close();
    lobbyClient.close();
  });

  it("reports install errors with a code", async () => {
    const catalog = await addCatalog();
    expect((await postJson(base, "/api/admin/games/install", { catalog, game: "punkte", version: "7.0.0" }, admin.token)).body).toMatchObject({
      code: "unknown-version",
    });
    expect((await postJson(base, "/api/admin/games/install", { catalog: 99, game: "punkte", version: "1.0.0" }, admin.token)).status).toBe(404);
    expect((await postJson(base, "/api/admin/games/install", { game: "punkte" }, admin.token)).status).toBe(400);
  });

  it("refreshes and removes catalogs; games stay without a catalog", async () => {
    const catalog = await addCatalog();
    await postJson(base, "/api/admin/games/install", { catalog, game: "punkte", version: "1.1.0" }, admin.token);
    expect((await postJson(base, `/api/admin/catalogs/${catalog}/refresh`, {}, admin.token)).body).toMatchObject({ catalog: { name: "Familienspiele" } });
    expect((await postJson(base, `/api/admin/catalogs/${catalog}/delete`, {}, admin.token)).body).toEqual({ games: ["punkte"] });
    const view = await overview();
    expect(view.catalogs).toEqual([]);
    expect(view.games).toEqual([expect.objectContaining({ id: "punkte", source: "catalog" })]);
    expect(view.games[0]?.catalogName).toBeUndefined();
    expect((await postJson(base, `/api/admin/catalogs/${catalog}/refresh`, {}, admin.token)).status).toBe(404);
  });
});

describe("CSP of the games", () => {
  it("blocks WebRTC for browsers that know the directive", async () => {
    await setup.library.install(punkteV1);
    const build = setup.library.current("punkte")!.build;
    const response = await fetch(`${base}/games/${build.replace("@", "/")}/`);
    expect(response.headers.get("content-security-policy")).toContain("webrtc 'block'");
  });
});

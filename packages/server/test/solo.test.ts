import type { BuiltPackage } from "gamehearth";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CatalogService } from "../src/catalogs";
import { SoloService, type SoloView } from "../src/solo";
import { preloadCsp, preloadScript } from "../src/static";
import { startServer, type RunningServer } from "../src/transport";
import { CatalogHost, packageOf } from "./catalog-helpers";
import { getJson, postJson } from "./client";
import { account, createSetup, guest, mauMauDir, type Setup } from "./helpers";

const sternchen = fileURLToPath(new URL("./fixtures/sternchen", import.meta.url));

let host: CatalogHost;
let built: BuiltPackage;
let setup: Setup;
let running: RunningServer;
let base: string;
let clock: number;
let solo: SoloService;
let admin: { user: number; token: string };

beforeAll(async () => {
  host = await CatalogHost.start();
  built = await packageOf(sternchen);
  host.publish("/katalog.json", [built], "Einzelspieler");
});

afterAll(async () => {
  await host.close();
});

beforeEach(async () => {
  setup = await createSetup();
  clock = Date.UTC(2026, 10, 18, 12);
  solo = new SoloService(setup.db, setup.library, { clock: () => clock });
  const catalogs = new CatalogService(setup.db, setup.library);
  running = await startServer({
    rooms: setup.rooms,
    accounts: setup.accounts,
    library: setup.library,
    catalogs,
    solo,
    port: 0,
    host: "127.0.0.1",
    log: (message) => setup.logs.push(message),
  });
  base = `http://127.0.0.1:${running.port}`;
  admin = account(setup, "Admin", "admin");
  const added = await postJson(base, "/api/admin/catalogs", { url: host.url("/katalog.json"), trust: true }, admin.token);
  const installed = await postJson(base, "/api/admin/games/install", { catalog: (added.body["catalog"] as { id: number }).id, game: "sternchen", version: "1.0.0" }, admin.token);
  expect(installed.status).toBe(200);
});

afterEach(async () => {
  await running.close();
  await setup.cleanup();
});

async function view(token: string): Promise<SoloView> {
  const response = await getJson(base, "/api/solo/sternchen", token);
  expect(response.status).toBe(200);
  return response.body as unknown as SoloView;
}

async function sync(token: string, body: unknown): Promise<SoloView> {
  const response = await postJson(base, "/api/solo/sternchen/sync", body, token);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as unknown as SoloView;
}

describe("Installing games without a reducer", () => {
  it("installs a package without game.mjs and without a trial match and lists it in the game list as single-player", async () => {
    const build = setup.library.current("sternchen");
    expect(build?.build).toBe(built.pkg.build);
    expect(build?.code).toBe("");
    expect(existsSync(join(setup.dir, "builds", "sternchen", built.pkg.build.split("@")[1] as string, "game.mjs"))).toBe(false);
    const anna = account(setup, "Anna");
    const games = (await getJson(base, "/api/games", anna.token)).body as unknown as Record<string, unknown>[];
    expect(games).toEqual([
      expect.objectContaining({
        id: "sternchen",
        mode: "single",
        solo: true,
        build: built.pkg.build,
        stats: { punkte: { label: "Punkte", better: "higher" }, zeit: { label: "Bestzeit", better: "lower", format: "time" } },
      }),
    ]);
  });

  it("loads the build again after a restart without requiring game.mjs", async () => {
    await running.close();
    const reopened = await setup.reopen();
    try {
      expect(await reopened.library.restore()).toEqual([]);
      expect(reopened.library.current("sternchen")?.manifest.mode).toBe("single");
    } finally {
      setup = reopened;
      running = await startServer({ rooms: setup.rooms, accounts: setup.accounts, library: setup.library, port: 0, host: "127.0.0.1" });
    }
  });

  it("installs single-player games from GAMES_DIR too", async () => {
    const local = await setup.library.install(sternchen);
    expect(local.manifest.server).toBe(false);
    expect(local.clientFiles.has("index.html")).toBe(true);
  });

  it("creates no room for single-player games", async () => {
    const anna = account(setup, "Anna");
    const response = await postJson(base, "/api/rooms", { game: "sternchen" }, anna.token);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "solo-game", message: expect.stringContaining("without a room") });
  });

  it("returns the files of the current build for preloading", async () => {
    const anna = account(setup, "Anna");
    const response = await getJson(base, "/api/solo/sternchen/files", anna.token);
    expect(response.body).toEqual({
      build: built.pkg.build,
      client: `/games/sternchen/${built.pkg.build.split("@")[1] as string}/`,
      files: ["assets/main.js", "index.html"],
    });
  });
});

describe("Review 9: a game becomes single-player without a reducer", () => {
  it("closes waiting lobbies, lets running matches finish and then refuses a new round", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gamehearth-wechsel-"));
    try {
      const sdk = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url)).replaceAll("\\", "/");
      const manifest = {
        id: "wechsel",
        name: "Wechsel",
        version: "1.0.0",
        sdk: "^0.1.2",
        license: { code: "MIT", assets: "CC0-1.0" },
        mode: "single",
        players: { min: 1, max: 1 },
        server: true,
        client: "client",
        roles: { player: { inputs: ["touch"], screen: "small" } },
      };
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "client"), { recursive: true });
      writeFileSync(join(dir, "client", "index.html"), "<!doctype html><title>Wechsel</title>");
      writeFileSync(
        join(dir, "src", "index.ts"),
        [
          `import { defineGame } from ${JSON.stringify(sdk)};`,
          "type State = { public: { done: boolean }; players: Record<string, Record<string, never>>; secret: Record<string, never> };",
          "export default defineGame<State, { type: \"fertig\" }>({",
          "  setup: ({ players }) => ({ public: { done: false }, players: Object.fromEntries(players.map((p) => [p, {}])), secret: {} }),",
          "  legalMoves: (state) => (state.public.done ? [] : [{ type: \"fertig\" }]),",
          "  apply: (state) => { state.public.done = true; },",
          "  result: (state) => (state.public.done ? { winners: [\"p1\"] } : undefined),",
          "});",
        ].join("\n"),
      );
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
      await setup.library.install(dir);
      const anna = account(setup, "Anna");
      const lobby = setup.rooms.createRoom("wechsel", anna.user);
      const finished = setup.rooms.createRoom("wechsel", anna.user);
      await setup.rooms.start(finished.code, anna.user);
      await setup.rooms.move(finished.code, anna.user, { type: "fertig" });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, version: "1.1.0", server: false }));
      await setup.library.install(dir);
      expect(setup.rooms.gameChanged("wechsel").closed).toEqual([lobby.code]);
      expect(() => setup.rooms.newRound(finished.code, anna.user)).toThrow("is now played alone");
      expect((await setup.rooms.view(finished.code, anna.user)).installed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Access", () => {
  it("requires an account", async () => {
    expect((await getJson(base, "/api/solo/sternchen")).status).toBe(401);
    const gast = guest(setup, "Gast");
    const response = await getJson(base, "/api/solo/sternchen", gast.token);
    expect(response.status).toBe(403);
    expect(response.body["code"]).toBe("account-required");
    expect((await postJson(base, "/api/solo/sternchen/sync", { best: { punkte: { value: 5, at: clock } } }, gast.token)).status).toBe(403);
  });

  it("knows only installed single-player games", async () => {
    const anna = account(setup, "Anna");
    expect((await getJson(base, "/api/solo/gibtsnicht", anna.token)).body["code"]).toBe("unknown-game");
    await setup.library.install(mauMauDir);
    const response = await getJson(base, "/api/solo/mau-mau", anna.token);
    expect(response.status).toBe(409);
    expect(response.body["code"]).toBe("not-solo");
  });

  it("rejects requests from other sites", async () => {
    const anna = account(setup, "Anna");
    const response = await postJson(base, "/api/solo/sternchen/sync", { best: {} }, anna.token, { origin: "https://boese.example" });
    expect(response.status).toBe(403);
  });
});

describe("Save", () => {
  it("stores the save, returns it and keeps the newer one by device time", async () => {
    const anna = account(setup, "Anna");
    expect((await view(anna.token)).save).toBeNull();
    let current = await sync(anna.token, { save: { data: { level: 4 }, savedAt: clock - 1000 } });
    expect(current.save).toEqual({ data: { level: 4 }, savedAt: clock - 1000 });
    current = await sync(anna.token, { save: { data: { level: 5 }, savedAt: clock - 5000 } });
    expect(current.save).toEqual({ data: { level: 4 }, savedAt: clock - 1000 });
    current = await sync(anna.token, { save: { data: { level: 6 }, savedAt: clock - 500 } });
    expect(current.save?.data).toEqual({ level: 6 });
  });

  it("sets times in the future to now, so a fast clock does not push out everything later", async () => {
    const anna = account(setup, "Anna");
    expect((await sync(anna.token, { save: { data: { level: 9 }, savedAt: clock + 86_400_000 } })).save?.savedAt).toBe(clock);
    clock += 60_000;
    expect((await sync(anna.token, { save: { data: { level: 2 }, savedAt: clock - 1000 } })).save?.data).toEqual({ level: 2 });
  });

  it("keeps saves separate per person", async () => {
    const anna = account(setup, "Anna");
    const ben = account(setup, "Ben");
    await sync(anna.token, { save: { data: { level: 4 }, savedAt: clock } });
    expect((await view(ben.token)).save).toBeNull();
  });

  it("deletes the save so that an older one from another device does not come back", async () => {
    const anna = account(setup, "Anna");
    await sync(anna.token, { save: { data: { level: 4 }, savedAt: clock - 10_000 } });
    const deleted = await postJson(base, "/api/solo/sternchen/delete", { what: "save" }, anna.token);
    expect(deleted.body).toMatchObject({ save: null, savedAt: clock });
    expect((await sync(anna.token, { save: { data: { level: 3 }, savedAt: clock - 5000 } })).save).toBeNull();
    clock += 1000;
    expect((await sync(anna.token, { save: { data: { level: 1 }, savedAt: clock } })).save?.data).toEqual({ level: 1 });
  });

  it("accepts saves up to 64 KB and rejects larger and broken ones", async () => {
    const anna = account(setup, "Anna");
    const big = { text: "x".repeat(64 * 1024 - 20) };
    expect((await sync(anna.token, { save: { data: big, savedAt: clock } })).save?.data).toEqual(big);
    const tooBig = await postJson(base, "/api/solo/sternchen/sync", { save: { data: { text: "x".repeat(64 * 1024) }, savedAt: clock } }, anna.token);
    expect(tooBig.status).toBe(400);
    expect(tooBig.body["message"]).toContain("at most 64 KB");
    const missing = await postJson(base, "/api/solo/sternchen/sync", { save: { savedAt: clock } }, anna.token);
    expect(missing.status).toBe(400);
    const badTime = await postJson(base, "/api/solo/sternchen/sync", { save: { data: {}, savedAt: "gestern" } }, anna.token);
    expect(badTime.status).toBe(400);
  });

  it("Review 9: deletes a save the server has never seen, with a marker", async () => {
    const anna = account(setup, "Anna");
    const deleted = await sync(anna.token, { save: { deleted: true, savedAt: clock - 1000 } });
    expect(deleted).toMatchObject({ save: null, savedAt: clock - 1000 });
    expect((await sync(anna.token, { save: { data: { level: 3 }, savedAt: clock - 2000 } })).save).toBeNull();
    expect((await sync(anna.token, { save: { data: { level: 1 }, savedAt: clock } })).save?.data).toEqual({ level: 1 });
  });

  it("disappears with the account", async () => {
    const anna = account(setup, "Anna");
    await sync(anna.token, { save: { data: { level: 4 }, savedAt: clock }, best: { punkte: { value: 10, at: clock } } });
    setup.accounts.deleteUser(anna.user);
    expect(setup.db.prepare("SELECT COUNT(*) AS n FROM solo_saves").get()).toEqual({ n: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS n FROM stats").get()).toEqual({ n: 0 });
  });
});

describe("Best scores", () => {
  it("keeps the larger value for higher and the smaller one for lower", async () => {
    const anna = account(setup, "Anna");
    await sync(anna.token, { best: { punkte: { value: 100, at: clock }, zeit: { value: 30_000, at: clock } } });
    const current = await sync(anna.token, { best: { punkte: { value: 80, at: clock }, zeit: { value: 40_000, at: clock } } });
    expect(current.best).toEqual({ punkte: 100, zeit: 30_000 });
    expect((await sync(anna.token, { best: { punkte: { value: 120, at: clock }, zeit: { value: 25_000, at: clock } } })).best).toEqual({ punkte: 120, zeit: 25_000 });
  });

  it("skips names the manifest does not know and names them instead of rejecting the whole sync", async () => {
    const anna = account(setup, "Anna");
    const current = await sync(anna.token, { best: { punkte: { value: 5, at: clock }, sterne: { value: 3, at: clock }, constructor: { value: 1, at: clock } } });
    expect(current.best).toEqual({ punkte: 5 });
    expect(current.ignored).toEqual(["sterne", "constructor"]);
  });

  it("deletes the own best scores so that values from before do not come back", async () => {
    const anna = account(setup, "Anna");
    await sync(anna.token, { best: { punkte: { value: 100, at: clock - 5000, generation: 0 } } });
    const deleted = (await postJson(base, "/api/solo/sternchen/delete", { what: "best" }, anna.token)).body as unknown as SoloView;
    expect(deleted.best).toEqual({});
    expect(deleted.generations).toEqual({ punkte: 1, zeit: 1 });
    expect((await sync(anna.token, { best: { punkte: { value: 100, at: clock - 5000, generation: 0 } } })).best).toEqual({});
    expect((await sync(anna.token, { best: { punkte: { value: 7, at: clock - 9000, generation: 1 } } })).best).toEqual({ punkte: 7 });
  });

  it("Review 9: an old value reached offline does not beat a newer one after deletion, even if it is higher", async () => {
    const anna = account(setup, "Anna");
    await postJson(base, "/api/solo/sternchen/delete", { what: "best" }, anna.token);
    expect((await sync(anna.token, { best: { punkte: { value: 300, at: clock, generation: 1 } } })).best).toEqual({ punkte: 300 });
    const tablet = await sync(anna.token, { best: { punkte: { value: 500, at: clock - 60_000, generation: 0 } } });
    expect(tablet.best).toEqual({ punkte: 300 });
    expect(tablet.generations).toEqual({ punkte: 1, zeit: 1 });
  });

  it("Review 9: deletion counters do not depend on the device clock", async () => {
    const anna = account(setup, "Anna");
    await postJson(base, "/api/solo/sternchen/delete", { what: "best" }, anna.token);
    expect((await sync(anna.token, { best: { punkte: { value: 120, at: clock - 600_000, generation: 1 } } })).best).toEqual({ punkte: 120 });
    await postJson(base, "/api/solo/sternchen/delete", { what: "best" }, anna.token);
    expect((await sync(anna.token, { best: { punkte: { value: 500, at: clock + 600_000, generation: 1 } } })).best).toEqual({});
    expect((await view(anna.token)).generations).toEqual({ punkte: 2, zeit: 2 });
  });

  it("shows the leaderboard of accounts with rank, shared places and the own place outside the top 10", async () => {
    const players = Array.from({ length: 12 }, (_, index) => account(setup, `Spieler ${index + 1}`));
    for (const [index, player] of players.entries()) {
      await sync(player.token, { best: { punkte: { value: index === 1 ? 1000 : 1000 - index * 10, at: clock + index } } });
    }
    const gast = guest(setup, "Gast");
    setup.db.prepare("INSERT INTO stats (user_id, game_id, stat, value, source, updated_at) VALUES (?, 'sternchen', 'punkte', 99999, 'client', ?)").run(gast.user, clock);
    const last = players[11] as { token: string };
    const board = (await view(last.token)).boards["punkte"] ?? [];
    expect(board).toHaveLength(11);
    expect(board.slice(0, 3)).toEqual([
      { rank: 1, name: "Spieler 1", value: 1000, you: false },
      { rank: 1, name: "Spieler 2", value: 1000, you: false },
      { rank: 3, name: "Spieler 3", value: 980, you: false },
    ]);
    expect(board.at(-1)).toEqual({ rank: 12, name: "Spieler 12", value: 890, you: true });
    expect((await view(last.token)).boards["zeit"]).toEqual([]);
  });

  it("hides locked accounts in the leaderboard", async () => {
    const anna = account(setup, "Anna");
    const ben = account(setup, "Ben");
    await sync(anna.token, { best: { punkte: { value: 50, at: clock } } });
    await sync(ben.token, { best: { punkte: { value: 60, at: clock } } });
    setup.db.prepare("UPDATE users SET locked = 1 WHERE id = ?").run(ben.user);
    expect((await view(anna.token)).boards["punkte"]).toEqual([{ rank: 1, name: "Anna", value: 50, you: true }]);
  });

  it("lets admins delete single entries; the device does not bring back the old value", async () => {
    const anna = account(setup, "Anna");
    await sync(anna.token, { best: { punkte: { value: 99_999, at: clock - 1000 } } });
    const boards = await getJson(base, "/api/admin/games/sternchen/boards", admin.token);
    expect(boards.body["boards"]).toMatchObject({ punkte: [{ user: anna.user, name: "Anna", value: 99_999 }] });
    expect((await postJson(base, "/api/admin/games/sternchen/boards", { user: anna.user, stat: "punkte" }, anna.token)).status).toBe(403);
    const deleted = await postJson(base, "/api/admin/games/sternchen/boards", { user: anna.user, stat: "punkte" }, admin.token);
    expect(deleted.body["boards"]).toEqual({ punkte: [], zeit: [] });
    expect((await sync(anna.token, { best: { punkte: { value: 99_999, at: clock - 1000 } } })).best).toEqual({});
    expect(setup.logs.join("\n")).toContain("Best score deleted: sternchen punkte");
    expect((await postJson(base, "/api/admin/games/sternchen/boards", { user: anna.user, stat: "gibtsnicht" }, admin.token)).status).toBe(400);
    const unknown = await postJson(base, "/api/admin/games/sternchen/boards", { user: 99_999, stat: "punkte" }, admin.token);
    expect(unknown.status).toBe(404);
    expect(unknown.body["code"]).toBe("unknown-user");
  });

  it("rejects broken best scores", async () => {
    const anna = account(setup, "Anna");
    for (const best of [{ punkte: { value: "1", at: clock } }, { punkte: { value: Number.MAX_VALUE, at: clock } }, { punkte: 5 }, { "Punkte!": { value: 1, at: clock } }, []]) {
      expect((await postJson(base, "/api/solo/sternchen/sync", { best }, anna.token)).status, JSON.stringify(best)).toBe(400);
    }
    for (const generation of [-1, 1.5, "1"]) {
      expect((await postJson(base, "/api/solo/sternchen/sync", { best: { punkte: { value: 1, at: clock, generation } } }, anna.token)).status).toBe(400);
    }
  });
});

describe("Preload", () => {
  it("serves the preload page only embedded, sealed off and cached for a long time", async () => {
    const response = await fetch(`${base}/preload/1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toBe(preloadCsp(`http://127.0.0.1:${running.port}/games/`));
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(await response.text()).toContain(preloadScript);
    const direct = await fetch(`${base}/preload/1`, { headers: { "sec-fetch-dest": "document" } });
    expect(direct.status).toBe(403);
    expect((await fetch(`${base}/preload/x`)).status).not.toBe(200);
  });
});

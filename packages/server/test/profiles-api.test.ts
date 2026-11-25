import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogService } from "../src/catalogs";
import { startServer, type RunningServer } from "../src/transport";
import { getJson, postJson } from "./client";
import { account, createSetup, dorfladenDir, guest, type Setup } from "./helpers";

let setup: Setup;
let running: RunningServer;
let base: string;
let admin: { user: number; token: string };
let anna: { user: number; token: string };
const temporary: string[] = [];

beforeEach(async () => {
  setup = await createSetup();
  await setup.library.install(dorfladenDir);
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
  admin = account(setup, "Admin", "admin");
  anna = account(setup, "Anna");
  const catalog = setup.rooms.profiles.catalog("dorfladen").catalog;
  setup.rooms.profiles.apply(
    anna.user,
    "dorfladen",
    [
      { player: "p1", op: "add", id: "apfel", value: 2 },
      { player: "p1", op: "record", id: "bestwert", value: 7 },
      { player: "p1", op: "flag", id: "titel", value: "Ladenkönig" },
    ],
    catalog,
  );
});

afterEach(async () => {
  await running.close();
  await setup.cleanup();
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Page {
  game: {
    id: string;
    name: string;
    description?: Record<string, string>;
    languages?: string[];
    cover?: string;
    solo: boolean;
    items: Record<string, { label: Record<string, string> }>;
    stats: Record<string, { label: Record<string, string>; better?: string }>;
  };
  profile: { items: Record<string, number>; stats: Record<string, number>; flags: Record<string, string | true> } | null;
  boards: Record<string, { rank: number; name: string; value: number; you: boolean }[]>;
  source: string;
}

describe("Game page", () => {
  it("returns description, catalog, own profile and leaderboards, only with a session", async () => {
    expect((await getJson(base, "/api/games/dorfladen")).status).toBe(401);
    const response = await getJson(base, "/api/games/dorfladen", anna.token);
    expect(response.status).toBe(200);
    const page = response.body as unknown as Page;
    expect(page.game).toMatchObject({ id: "dorfladen", name: "Dorfladen", solo: false, languages: ["de", "en"] });
    expect(page.game.description).toEqual({ de: expect.stringContaining("Testspiel mit Profilen"), en: expect.stringContaining("Test game with profiles") });
    expect(page.game.cover).toBe(`/games/dorfladen/${setup.library.current("dorfladen")!.build.split("@")[1]}/cover.svg`);
    expect(page.game.items["apfel"]).toEqual({ label: { de: "Apfel", en: "Apple" } });
    expect(page.profile).toEqual({ items: { apfel: 2 }, stats: { bestwert: 7 }, flags: { titel: "Ladenkönig" } });
    expect(page.boards["bestwert"]).toEqual([{ rank: 1, name: "Anna", value: 7, you: true }]);
    expect(page.source).toBe("server");
    const visitor = guest(setup, "Gast");
    const forGuest = (await getJson(base, "/api/games/dorfladen", visitor.token)).body as unknown as Page;
    expect(forGuest.profile).toBeNull();
    expect(forGuest.boards["bestwert"]?.[0]).toMatchObject({ name: "Anna", you: false });
    expect((await getJson(base, "/api/games/gibt-es-nicht", anna.token)).status).toBe(404);
  });

  it("resets the own profile on request; guests have none", async () => {
    const response = await postJson(base, "/api/games/dorfladen/reset", {}, anna.token);
    expect(response.status).toBe(200);
    expect((response.body as unknown as Page).profile).toEqual({ items: {}, stats: {}, flags: {} });
    expect((response.body as unknown as Page).boards["bestwert"]).toEqual([]);
    const visitor = guest(setup, "Gast");
    expect((await postJson(base, "/api/games/dorfladen/reset", {}, visitor.token)).status).toBe(403);
  });
});

describe("Profiles in the admin view", () => {
  it("is only for admins", async () => {
    expect((await getJson(base, "/api/admin/games/dorfladen/profiles", anna.token)).status).toBe(403);
    expect((await postJson(base, `/api/admin/games/dorfladen/profiles/${anna.user}/reset`, {}, anna.token)).status).toBe(403);
  });

  it("lists profiles, deletes single entries and resets whole profiles", async () => {
    const listed = await getJson(base, "/api/admin/games/dorfladen/profiles", admin.token);
    expect(listed.status).toBe(200);
    expect(listed.body["profiles"]).toEqual([
      { user: anna.user, name: "Anna", profile: { items: { apfel: 2 }, stats: { bestwert: 7 }, flags: { titel: "Ladenkönig" } }, updatedAt: expect.any(Number) },
    ]);
    expect(listed.body["game"]).toMatchObject({ id: "dorfladen", name: "Dorfladen" });
    const deleted = await postJson(base, `/api/admin/games/dorfladen/profiles/${anna.user}/delete`, { section: "items", id: "apfel" }, admin.token);
    expect(deleted.status).toBe(200);
    expect((deleted.body["profiles"] as { profile: unknown }[])[0]?.profile).toEqual({ items: {}, stats: { bestwert: 7 }, flags: { titel: "Ladenkönig" } });
    expect((await postJson(base, `/api/admin/games/dorfladen/profiles/${anna.user}/delete`, { section: "items", id: "apfel" }, admin.token)).status).toBe(404);
    expect((await postJson(base, `/api/admin/games/dorfladen/profiles/${anna.user}/delete`, { section: "gold", id: "apfel" }, admin.token)).status).toBe(400);
    const reset = await postJson(base, `/api/admin/games/dorfladen/profiles/${anna.user}/reset`, {}, admin.token);
    expect(reset.status).toBe(200);
    expect(reset.body["profiles"]).toEqual([]);
    expect((await postJson(base, "/api/admin/games/dorfladen/profiles/999999/reset", {}, admin.token)).status).toBe(404);
  });

  it("names IDs in profiles that the installed build no longer knows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gamehearth-dorfladen-api-"));
    temporary.push(dir);
    cpSync(dorfladenDir, dir, { recursive: true });
    const file = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(file, "utf8")) as { version: string; items: Record<string, unknown>; flags: Record<string, unknown> };
    manifest.version = "0.2.0";
    delete manifest.items["apfel"];
    delete manifest.flags["titel"];
    writeFileSync(file, JSON.stringify(manifest, null, 2));
    await setup.library.install(dir);
    const overview = await getJson(base, "/api/admin/games", admin.token);
    expect((overview.body["games"] as { id: string; unknownIds?: unknown }[]).find((game) => game.id === "dorfladen")?.unknownIds).toEqual({ items: ["apfel"], stats: [], flags: ["titel"] });
    const profiles = await getJson(base, "/api/admin/games/dorfladen/profiles", admin.token);
    expect(profiles.body["unknownIds"]).toEqual({ items: ["apfel"], stats: [], flags: ["titel"] });
  });
});

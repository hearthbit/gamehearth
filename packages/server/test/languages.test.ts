import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccountService } from "../src/accounts";
import { gamesOverview } from "../src/admin-api";
import { CatalogError, CatalogService } from "../src/catalogs";
import { migrate, openDatabase, schemaVersion, userVersion } from "../src/db";
import { statusFor } from "../src/http";
import { acceptedLanguages, requestLanguage } from "../src/languages";
import { PushError, PushService } from "../src/push/service";
import type { RoomAlert, RoomView } from "../src/rooms";
import { startServer, type RunningServer } from "../src/transport";
import { CatalogHost } from "./catalog-helpers";
import { Client, getJson, postJson, settle } from "./client";
import { startFakePushService, type FakePushService } from "./fake-push";
import { account, cheapPasswords, createSetup, dorfladenSource, guest, mauMauDir, withStubClient, type Setup } from "./helpers";

const shopName = { de: "Dorfladen", en: "Village shop" };
const shopDir = localizedShop();
const always = () => true;
const temporary: string[] = [];

function localizedShop(): string {
  const dir = withStubClient(dorfladenSource);
  const path = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...manifest, name: shopName }, null, 2));
  return dir;
}

let setup: Setup;
let fake: FakePushService;
let push: PushService;
let running: RunningServer;
let base: string;
const clients: Client[] = [];

beforeEach(async () => {
  setup = await createSetup();
  fake = await startFakePushService();
  push = new PushService(setup.db, { hosts: [fake.origin], log: (message) => setup.logs.push(message), limits: { coalesceMs: 100 } });
  running = await startServer({
    rooms: setup.rooms,
    accounts: setup.accounts,
    library: setup.library,
    port: 0,
    host: "127.0.0.1",
    log: (message) => setup.logs.push(message),
    push,
  });
  base = `http://127.0.0.1:${running.port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  push.close();
  await running.close();
  await fake.close();
  await setup.cleanup();
});

afterAll(() => {
  for (const dir of temporary) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sessionId(token: string): number {
  return setup.accounts.session(token)!.id;
}

function payloads(): Record<string, unknown> {
  return Object.fromEntries(fake.received.map((received) => [received.path.replace("/push/", ""), received.payload]));
}

async function delivered(): Promise<void> {
  await settle(50);
  await push.idle();
}

describe("Migration to schema 11", () => {
  it("backs up, then adds the language of users and subscriptions and the error code of catalogs, all empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "gamehearth-migration11-"));
    temporary.push(dir);
    const raw = new DatabaseSync(join(dir, "v10.sqlite"));
    migrate(raw, 10);
    raw.prepare("INSERT INTO users (kind, display_name, created_at, active_at) VALUES ('guest', 'Anna', 1, 1)").run();
    raw.prepare("INSERT INTO sessions (token_hash, user_id, created_at, seen_at) VALUES ('hash', 1, 1, 1)").run();
    raw
      .prepare("INSERT INTO push_subscriptions (session_id, endpoint, p256dh, auth, origin, created_at) VALUES (1, 'https://fcm.googleapis.com/x', 'k', 'a', 'https://x.example', 1)")
      .run();
    raw
      .prepare("INSERT INTO catalogs (url, name, content, fetched_at, checked_at, error, added_at) VALUES ('https://x.example/c.json', 'C', ?, 1, 1, 'responds with 500', 1)")
      .run(JSON.stringify({ format: 1, name: "C", games: [] }));
    raw.close();
    const db = openDatabase(join(dir, "v10.sqlite"), { backupDir: join(dir, "backups") });
    expect(userVersion(db)).toBe(schemaVersion);
    expect(readdirSync(join(dir, "backups"))).toEqual([expect.stringMatching(/-migration-v10\.sqlite$/)]);
    expect(db.prepare("SELECT display_name, language FROM users").all()).toEqual([{ display_name: "Anna", language: null }]);
    expect(db.prepare("SELECT endpoint, language FROM push_subscriptions").all()).toEqual([{ endpoint: "https://fcm.googleapis.com/x", language: null }]);
    expect(db.prepare("SELECT error, error_code FROM catalogs").all()).toEqual([{ error: "responds with 500", error_code: null }]);
    const accounts = new AccountService(db, { passwordCost: cheapPasswords });
    expect(accounts.user(1).language).toBeNull();
    expect(accounts.setLanguage(1, "de").language).toBe("de");
    expect(new CatalogService(db, setup.library).list()[0]).toMatchObject({ error: "responds with 500", errorCode: "catalog-unavailable" });
    db.close();
  });
});

describe("Language of the UI", () => {
  it("is null until chosen; accounts and guests choose it for all their devices", async () => {
    const anna = account(setup, "Anna");
    expect((await getJson(base, "/api/me", anna.token)).body).toMatchObject({ user: { id: anna.user, language: null } });
    const chosen = await postJson(base, "/api/me/language", { language: "de" }, anna.token);
    expect(chosen).toMatchObject({ status: 200, body: { user: { id: anna.user, kind: "account", name: "Anna", language: "de" } } });
    const laptop = setup.accounts.createSession(anna.user).token;
    expect((await getJson(base, "/api/me", laptop)).body).toMatchObject({ user: { language: "de" } });
    expect((await postJson(base, "/api/me/language", { language: null }, laptop)).body).toMatchObject({ user: { language: null } });
    expect((await getJson(base, "/api/me", anna.token)).body).toMatchObject({ user: { language: null } });
    const gast = guest(setup, "Gast");
    expect(await postJson(base, "/api/me/language", { language: "en" }, gast.token)).toMatchObject({ status: 200, body: { user: { kind: "guest", language: "en" } } });
    expect((await getJson(base, "/api/me", gast.token)).body).toMatchObject({ user: { language: "en" } });
  });

  it("comes along when signing in on a new device", async () => {
    const { token } = setup.accounts.createInvite(undefined, { role: "player" });
    const created = await setup.accounts.acceptInvite(token, { username: "lena", name: "Lena", password: "geheim-lena-1" }, undefined);
    setup.accounts.setLanguage(created.session.user.id, "de");
    const login = await postJson(base, "/api/login", { username: "lena", password: "geheim-lena-1" });
    expect(login).toMatchObject({ status: 200, body: { user: { username: "lena", language: "de" } } });
  });

  it("rejects other values with invalid-language and changes nothing", async () => {
    const anna = account(setup, "Anna");
    await postJson(base, "/api/me/language", { language: "de" }, anna.token);
    for (const body of [{ language: "fr" }, { language: "DE" }, { language: "de-DE" }, { language: "" }, { language: 5 }, { language: ["de"] }, {}]) {
      expect(await postJson(base, "/api/me/language", body, anna.token)).toMatchObject({ status: 400, body: { code: "invalid-language" } });
    }
    expect((await getJson(base, "/api/me", anna.token)).body).toMatchObject({ user: { language: "de" } });
  });

  it("needs a session and a request from the own site", async () => {
    const anna = account(setup, "Anna");
    expect(await postJson(base, "/api/me/language", { language: "de" })).toMatchObject({ status: 401, body: { code: "not-signed-in" } });
    expect(await postJson(base, "/api/me/language", { language: "de" }, anna.token, { origin: "https://evil.example" })).toMatchObject({
      status: 403,
      body: { code: "forbidden" },
    });
    expect((await getJson(base, "/api/me", anna.token)).body).toMatchObject({ user: { language: null } });
  });

  it("is rate-limited like the push settings, 20 changes per minute and address", async () => {
    const anna = account(setup, "Anna");
    for (let change = 0; change < 20; change++) {
      expect((await postJson(base, "/api/me/language", { language: change % 2 === 0 ? "de" : "en" }, anna.token)).status).toBe(200);
    }
    expect(await postJson(base, "/api/me/language", { language: "de" }, anna.token)).toMatchObject({ status: 429, body: { code: "rate-limited" } });
    expect((await getJson(base, "/api/me", anna.token)).body).toMatchObject({ user: { language: "en" } });
  });
});

describe("Push in the user's language", () => {
  it("takes the user's language, then the device's, then English, and localizes the game name per device", async () => {
    const anna = guest(setup, "Anna");
    const phone = setup.accounts.createSession(anna.user).session.id;
    const laptop = setup.accounts.createSession(anna.user).session.id;
    push.subscribe(phone, fake.subscription("phone"), "https://x.example", "de");
    push.subscribe(laptop, fake.subscription("laptop"), "https://x.example", "en");
    push.subscribe(sessionId(anna.token), fake.subscription("tablet"), "https://x.example");
    push.notify(anna.user, "ABC234", { kind: "turn", room: "ABC234", game: shopName, languages: ["de", "en"] }, always);
    await push.idle();
    expect(payloads()).toEqual({
      phone: { kind: "turn", room: "ABC234", game: "Dorfladen", lang: "de" },
      laptop: { kind: "turn", room: "ABC234", game: "Village shop", lang: "en" },
      tablet: { kind: "turn", room: "ABC234", game: "Village shop", lang: "en" },
    });
    fake.received.length = 0;
    setup.accounts.setLanguage(anna.user, "de");
    push.notify(anna.user, "XYZ789", { kind: "finished", room: "XYZ789", game: shopName, languages: ["de", "en"] }, always);
    await push.idle();
    expect(Object.values(payloads())).toEqual(Array(3).fill({ kind: "finished", room: "XYZ789", game: "Dorfladen", lang: "de" }));
  });

  it("falls back to the game's default language and shortens the localized name", async () => {
    const anna = guest(setup, "Anna");
    push.subscribe(sessionId(anna.token), fake.subscription("anna"), "https://x.example", "en");
    push.notify(anna.user, "R1", { kind: "turn", room: "R1", game: { fr: "Boutique", de: "Laden" }, languages: ["de", "fr"] }, always);
    push.notify(anna.user, "R2", { kind: "turn", room: "R2", game: { de: "Laden", en: "x".repeat(200) }, languages: ["de", "en"] }, always);
    push.notify(anna.user, "R3", { kind: "turn", room: "R3", game: "Mau-Mau" }, always);
    await push.idle();
    const games = fake.received.map((received) => (received.payload as { room: string; game: string }).game);
    expect(games.sort()).toEqual(["Laden", "Mau-Mau", "x".repeat(80)]);
  });

  it("sends the test notification in the language of the device", async () => {
    const anna = guest(setup, "Anna");
    push.subscribe(sessionId(anna.token), fake.subscription("anna"), "https://x.example", "de");
    push.sendTest(sessionId(anna.token));
    await push.idle();
    expect(payloads()).toEqual({ anna: { kind: "test", lang: "de" } });
  });

  it("stores the device language of a subscription over HTTP, rejects unknown ones and keeps it on renewal", async () => {
    const anna = account(setup, "Anna");
    const first = fake.subscription("first");
    const subscription = (value: { endpoint: string; keys: unknown }) => ({ endpoint: value.endpoint, keys: value.keys });
    expect(await postJson(base, "/api/me/push", { subscription: subscription(first), language: "fr" }, anna.token)).toMatchObject({
      status: 400,
      body: { code: "invalid-language" },
    });
    expect(push.enabled(sessionId(anna.token))).toBe(false);
    expect(() => push.subscribe(sessionId(anna.token), first, "https://x.example", "english")).toThrow(PushError);
    expect((await postJson(base, "/api/me/push", { subscription: subscription(first), language: "de" }, anna.token)).status).toBe(200);
    const language = () => setup.db.prepare("SELECT endpoint, language FROM push_subscriptions").all();
    expect(language()).toEqual([{ endpoint: first.endpoint, language: "de" }]);
    const second = fake.subscription("second");
    expect((await postJson(base, "/api/me/push/renew", { oldEndpoint: first.endpoint, subscription: subscription(second) }, anna.token)).body).toEqual({ renewed: true });
    expect(language()).toEqual([{ endpoint: second.endpoint, language: "de" }]);
    expect((await postJson(base, "/api/me/push", { subscription: subscription(second) }, anna.token)).status).toBe(200);
    expect(language()).toEqual([{ endpoint: second.endpoint, language: null }]);
  });

  it("names the game of a room in each member's language", async () => {
    await setup.library.install(shopDir);
    const alerts: RoomAlert[] = [];
    setup.rooms.on({ alert: (alert) => alerts.push(alert) });
    const anna = account(setup, "Anna");
    const ben = guest(setup, "Ben");
    const enable = async (member: { token: string }, name: string, language: string) => {
      const { endpoint, keys } = fake.subscription(name);
      expect((await postJson(base, "/api/me/push", { subscription: { endpoint, keys }, language }, member.token)).status).toBe(200);
    };
    await enable(anna, "anna", "de");
    await enable(ben, "ben", "en");
    const { code } = setup.rooms.createRoom("dorfladen", anna.user);
    await setup.rooms.joinRoom(code, ben.user);
    await setup.rooms.start(code, anna.user);
    await setup.rooms.move(code, anna.user, { type: "arbeiten" });
    await delivered();
    expect(alerts[0]).toMatchObject({ kind: "turn", game: shopName, languages: ["de", "en"] });
    expect(payloads()).toEqual({
      anna: { kind: "turn", room: code, game: "Dorfladen", lang: "de" },
      ben: { kind: "turn", room: code, game: "Village shop", lang: "en" },
    });
  });
});

describe("Games with languages and a cover", () => {
  beforeEach(async () => {
    await setup.library.install(shopDir);
    await setup.library.install(mauMauDir);
  });

  function coverOf(): string {
    return `/games/dorfladen/${setup.library.current("dorfladen")!.build.split("@")[1]}/cover.svg`;
  }

  it("lists languages, the cover of the current build and the raw texts in the game list", async () => {
    const games = (await getJson(base, "/api/games")).body as unknown as Record<string, unknown>[];
    const shop = games.find((game) => game["id"] === "dorfladen");
    expect(shop).toMatchObject({ name: shopName, languages: ["de", "en"], cover: coverOf(), description: { de: expect.any(String), en: expect.any(String) } });
    const mauMau = games.find((game) => game["id"] === "mau-mau");
    expect(mauMau).not.toHaveProperty("languages");
    expect(mauMau).not.toHaveProperty("cover");
    const image = await fetch(base + coverOf(), { headers: { "sec-fetch-dest": "image" } });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/svg+xml");
  });

  it("sends name, languages, cover and option labels raw in the room over the WebSocket", async () => {
    const anna = account(setup, "Anna");
    const { code } = setup.rooms.createRoom("dorfladen", anna.user);
    const client = await Client.connect(running.port, { token: anna.token });
    clients.push(client);
    client.send({ type: "hello", room: code });
    const room: RoomView = await client.room();
    expect(room.game).toMatchObject({ id: "dorfladen", name: shopName, languages: ["de", "en"], cover: coverOf() });
    expect(room.options?.spec["runden"]).toMatchObject({ label: { de: "Runden", en: "Rounds" } });
    expect((room.options?.spec["runden"] as { choices: { label: unknown }[] }).choices[0]?.label).toEqual({ de: "2 Runden", en: "2 rounds" });
    expect((await getJson(base, "/api/me/rooms", anna.token)).body).toMatchObject({ rooms: [{ code, game: shopName }] });
  });

  it("Review 11: names the game of each room in My rooms by its ID, with languages and cover, so names cannot be mixed up", async () => {
    const anna = account(setup, "Anna");
    const shop = setup.rooms.createRoom("dorfladen", anna.user).code;
    const cards = setup.rooms.createRoom("mau-mau", anna.user).code;
    const rooms = (await getJson(base, "/api/me/rooms", anna.token)).body as { rooms: Record<string, unknown>[] };
    const byCode = Object.fromEntries(rooms.rooms.map((room) => [room["code"], room]));
    expect(byCode[shop]).toMatchObject({ gameId: "dorfladen", languages: ["de", "en"], cover: coverOf() });
    expect(byCode[cards]).toMatchObject({ gameId: "mau-mau" });
    expect(byCode[cards]).not.toHaveProperty("cover");
  });

  it("shows languages and the cover with the installed games and the raw name in the admin's room list", async () => {
    const anna = account(setup, "Anna");
    setup.rooms.createRoom("dorfladen", anna.user);
    const overview = (await gamesOverview({ library: setup.library, catalogs: undefined, rooms: setup.rooms })) as { games: Record<string, unknown>[] };
    expect(overview.games.find((game) => game["id"] === "dorfladen")).toMatchObject({ name: shopName, languages: ["de", "en"], cover: coverOf() });
    expect(overview.games.map((game) => game["id"])).toEqual(["dorfladen", "mau-mau"]);
    expect(setup.rooms.allRooms()[0]?.game).toEqual(shopName);
  });
});

describe("Catalogs with translated texts", () => {
  let host: CatalogHost;
  let catalogs: CatalogService;

  beforeAll(async () => {
    host = await CatalogHost.start();
  });

  afterAll(async () => {
    await host.close();
  });

  beforeEach(() => {
    host.files.clear();
    catalogs = new CatalogService(setup.db, setup.library);
  });

  function catalog(game: Record<string, unknown>): string {
    const version = {
      version: "1.0.0",
      sdk: "^0.1.6",
      mode: "turn-based",
      players: { min: 1, max: 4 },
      roles: { player: { inputs: ["touch", "mouse"], screen: "small" } },
      license: { code: "MIT", assets: "CC0-1.0" },
      size: 1000,
      url: host.url("/laden.zip"),
      sha256: "a".repeat(64),
    };
    return JSON.stringify({ format: 1, name: "Testkatalog", games: [{ id: "laden", name: "Laden", versions: [version], ...game }] });
  }

  async function rejected(work: Promise<unknown>): Promise<CatalogError> {
    try {
      await work;
    } catch (error) {
      if (error instanceof CatalogError) {
        return error;
      }
      throw error;
    }
    throw new Error("expected a CatalogError");
  }

  it("accepts a name and description per language and offers them raw", async () => {
    host.files.set("/katalog.json", catalog({ name: shopName, description: { de: "Münzen und Äpfel", en: "Coins and apples" } }));
    const info = await catalogs.add(host.url("/katalog.json"));
    expect(info).toMatchObject({ games: 1 });
    expect(info).not.toHaveProperty("errorCode");
    expect(catalogs.offers()[0]).toMatchObject({ id: "laden", name: shopName, description: { de: "Münzen und Äpfel", en: "Coins and apples" } });
  });

  it("rejects malformed translations as catalog-invalid, also on refresh with the last good state kept", async () => {
    for (const game of [
      { name: {} },
      { name: { Deutsch: "Laden" } },
      { name: { de: "" } },
      { name: { de: 5 } },
      { name: ["Laden"] },
      { name: { de: "x".repeat(81) } },
      { description: { de: "x".repeat(201) } },
    ]) {
      host.files.set("/kaputt.json", catalog(game));
      const error = await rejected(catalogs.add(host.url("/kaputt.json")));
      expect(error.code).toBe("catalog-invalid");
      expect(statusFor(error.code)).toBe(502);
    }
    host.files.set("/katalog.json", catalog({ name: shopName }));
    const { id } = await catalogs.add(host.url("/katalog.json"));
    host.files.set("/katalog.json", catalog({ name: { de: "" } }));
    const failed = await catalogs.refresh(id);
    expect(failed).toMatchObject({ errorCode: "catalog-invalid", error: expect.stringContaining("invalid") });
    expect(catalogs.offers()[0]?.name).toEqual(shopName);
  });
});

describe("Hint page for game files opened as a page", () => {
  it("reads the preferred languages from Accept-Language", () => {
    expect(acceptedLanguages("de-DE,de;q=0.9,en;q=0.8")).toEqual(["de-DE", "de", "en"]);
    expect(acceptedLanguages("en;q=0.1, fr;q=0, de")).toEqual(["de", "en"]);
    expect(acceptedLanguages("*")).toEqual([]);
    expect(requestLanguage(undefined)).toBe("en");
    expect(requestLanguage("fr-FR,fr;q=0.9")).toBe("en");
    expect(requestLanguage("fr, de-AT;q=0.5")).toBe("de");
    expect(requestLanguage("en-GB, de;q=0.9")).toBe("en");
  });

  it("answers in German or English by Accept-Language, English by default", async () => {
    await setup.library.install(mauMauDir);
    const path = `/games/${setup.library.current("mau-mau")!.build.replace("@", "/")}/`;
    const page = (language?: string) =>
      fetch(base + path, { headers: { "sec-fetch-dest": "document", ...(language === undefined ? {} : { "accept-language": language }) } });
    const german = await page("de-DE,de;q=0.9,en;q=0.8");
    expect(german.status).toBe(403);
    expect(german.headers.get("content-language")).toBe("de");
    expect(german.headers.get("vary")).toBe("Accept-Language");
    expect(german.headers.get("content-security-policy")).toContain("sandbox");
    expect(await german.text()).toContain("nur eingebettet");
    for (const language of [undefined, "en-US", "fr-FR,fr;q=0.9"]) {
      const english = await page(language);
      expect(english.headers.get("content-language")).toBe("en");
      expect(await english.text()).toContain("only run embedded");
    }
    const preload = await fetch(`${base}/preload/1`, { headers: { "sec-fetch-dest": "document", "accept-language": "de" } });
    expect(preload.status).toBe(403);
    expect(await preload.text()).toContain("nur eingebettet");
  });
});

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountService } from "../src/accounts";
import { migrate, openDatabase, schemaVersion, userVersion } from "../src/db";
import { startServer, type RunningServer } from "../src/transport";
import { getJson, postJson } from "./client";
import { account, cheapPasswords, createSetup, guest, type Setup } from "./helpers";

const temporary: string[] = [];
let setup: Setup;
let running: RunningServer;
let base: string;

beforeEach(async () => {
  setup = await createSetup();
  running = await startServer({ rooms: setup.rooms, accounts: setup.accounts, library: setup.library, port: 0, host: "127.0.0.1", log: (message) => setup.logs.push(message) });
  base = `http://127.0.0.1:${running.port}`;
});

afterEach(async () => {
  await running.close();
  await setup.cleanup();
});

afterAll(() => {
  for (const dir of temporary) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Migration to schema 12", () => {
  it("backs up, then adds the theme of users, empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "gamehearth-migration12-"));
    temporary.push(dir);
    const raw = new DatabaseSync(join(dir, "v11.sqlite"));
    migrate(raw, 11);
    raw.prepare("INSERT INTO users (kind, display_name, created_at, active_at, language) VALUES ('guest', 'Anna', 1, 1, 'de')").run();
    raw.close();
    const db = openDatabase(join(dir, "v11.sqlite"), { backupDir: join(dir, "backups") });
    expect(userVersion(db)).toBe(schemaVersion);
    expect(readdirSync(join(dir, "backups"))).toEqual([expect.stringMatching(/-migration-v11\.sqlite$/)]);
    expect(db.prepare("SELECT display_name, language, theme FROM users").all()).toEqual([{ display_name: "Anna", language: "de", theme: null }]);
    const accounts = new AccountService(db, { passwordCost: cheapPasswords });
    expect(accounts.user(1).theme).toBeNull();
    expect(accounts.setTheme(1, "crt").theme).toBe("crt");
    db.close();
  });
});

describe("Theme of the UI", () => {
  it("is null until chosen; accounts and guests choose it for all their devices", async () => {
    const anna = account(setup, "Anna");
    expect((await getJson(base, "/api/me", anna.token)).body).toMatchObject({ user: { id: anna.user, theme: null } });
    expect(await postJson(base, "/api/me/theme", { theme: "front" }, anna.token)).toMatchObject({ status: 200, body: { user: { id: anna.user, theme: "front" } } });
    const laptop = setup.accounts.createSession(anna.user).token;
    expect((await getJson(base, "/api/me", laptop)).body).toMatchObject({ user: { theme: "front" } });
    expect((await postJson(base, "/api/me/theme", { theme: null }, laptop)).body).toMatchObject({ user: { theme: null } });
    const gast = guest(setup, "Gast");
    expect(await postJson(base, "/api/me/theme", { theme: "crt" }, gast.token)).toMatchObject({ status: 200, body: { user: { kind: "guest", theme: "crt" } } });
  });

  it("comes along when logging in on a new device", async () => {
    const { token } = setup.accounts.createInvite(undefined, { role: "player" });
    const created = await setup.accounts.acceptInvite(token, { username: "lena", name: "Lena", password: "geheim-lena-1" }, undefined);
    setup.accounts.setTheme(created.session.user.id, "neon");
    const login = await postJson(base, "/api/login", { username: "lena", password: "geheim-lena-1" });
    expect(login).toMatchObject({ status: 200, body: { user: { username: "lena", theme: "neon" } } });
  });

  it("rejects other values with invalid-theme and changes nothing", async () => {
    const anna = account(setup, "Anna");
    await postJson(base, "/api/me/theme", { theme: "crt" }, anna.token);
    for (const body of [{ theme: "dark" }, { theme: "CRT" }, { theme: "" }, { theme: 1 }, { theme: ["crt"] }, {}]) {
      expect(await postJson(base, "/api/me/theme", body, anna.token)).toMatchObject({ status: 400, body: { code: "invalid-theme" } });
    }
    expect((await getJson(base, "/api/me", anna.token)).body).toMatchObject({ user: { theme: "crt" } });
  });

  it("needs a session and a request from the own site, and shares the rate limit of the language", async () => {
    const anna = account(setup, "Anna");
    expect(await postJson(base, "/api/me/theme", { theme: "crt" })).toMatchObject({ status: 401, body: { code: "not-signed-in" } });
    expect(await postJson(base, "/api/me/theme", { theme: "crt" }, anna.token, { origin: "https://evil.example" })).toMatchObject({ status: 403, body: { code: "forbidden" } });
    for (let change = 0; change < 20; change++) {
      const path = change % 2 === 0 ? "/api/me/theme" : "/api/me/language";
      expect((await postJson(base, path, change % 2 === 0 ? { theme: "front" } : { language: "de" }, anna.token)).status).toBe(200);
    }
    expect(await postJson(base, "/api/me/theme", { theme: "crt" }, anna.token)).toMatchObject({ status: 429, body: { code: "rate-limited" } });
  });
});

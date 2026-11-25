import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { runAdminCommand } from "../src/admin-commands";
import { startServer, type RunningServer } from "../src/transport";
import { Client, getJson, postJson, sessionFrom } from "./client";
import { account, createSetup, guest, mauMauDir, type Setup } from "./helpers";

let setup: Setup;
let running: RunningServer;
let base: string;

async function start(options: { trustProxy?: boolean } = {}): Promise<void> {
  running = await startServer({
    rooms: setup.rooms,
    accounts: setup.accounts,
    library: setup.library,
    port: 0,
    host: "127.0.0.1",
    log: (message) => setup.logs.push(message),
    ...options,
  });
  base = `http://127.0.0.1:${running.port}`;
}

beforeEach(async () => {
  setup = await createSetup();
  await setup.library.install(mauMauDir);
  await start();
});

afterEach(async () => {
  await running.close();
  await setup.cleanup();
});

async function registered(username: string, password = `geheim-${username}-1`, role: "player" | "admin" = "player"): Promise<{ token: string; id: number }> {
  const { token } = setup.accounts.createInvite(undefined, { role });
  const created = await postJson(base, "/api/invites/accept", { token, username, name: username, password });
  expect(created.status).toBe(201);
  return { token: created.cookie as string, id: (created.body["user"] as { id: number }).id };
}

describe("Session", () => {
  it("reports nobody without a cookie and clears an invalid cookie", async () => {
    expect((await getJson(base, "/api/me")).body).toEqual({});
    const stale = await fetch(`${base}/api/me`, { headers: { cookie: "gh-session=abgelaufen" } });
    expect(await stale.json()).toEqual({});
    expect(stale.headers.get("set-cookie")).toMatch(/^gh-session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0$/);
  });

  it("signs in with a password and out, and sets the cookie only with HttpOnly and SameSite", async () => {
    await registered("anna");
    const response = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ANNA", password: "geheim-anna-1" }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^gh-session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=34560000$/);
    const token = sessionFrom(cookie) as string;
    expect((await getJson(base, "/api/me", token)).body).toEqual({ user: { id: expect.any(Number), kind: "account", username: "anna", name: "anna", role: "player", language: null, theme: null } });
    expect((await postJson(base, "/api/logout", {}, token)).status).toBe(200);
    expect((await getJson(base, "/api/me", token)).body).toEqual({});
  });

  it("sets a secure __Host- cookie behind a trusted proxy with HTTPS and reads only that one", async () => {
    await running.close();
    await start({ trustProxy: true });
    await registered("anna");
    const response = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ username: "anna", password: "geheim-anna-1" }),
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^__Host-gh-session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=34560000; Secure$/);
    const token = sessionFrom(cookie) as string;
    const me = (cookieName: string, proto: string) =>
      fetch(`${base}/api/me`, { headers: { cookie: `${cookieName}=${token}`, "x-forwarded-proto": proto } }).then((answer) => answer.json());
    expect(await me("__Host-gh-session", "https")).toMatchObject({ user: { username: "anna" } });
    expect(await me("gh-session", "https")).toEqual({});
  });

  it("rate-limits failed attempts per address, even for correct passwords", async () => {
    await registered("anna");
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await postJson(base, "/api/login", { username: `niemand${attempt}`, password: "falsch-falsch" })).status).toBe(401);
    }
    const blocked = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "anna", password: "geheim-anna-1" }),
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("900");
  });

  it("counts concurrent login attempts per address before the password is checked", async () => {
    await registered("anna");
    const statuses = await Promise.all(
      Array.from({ length: 40 }, (_, attempt) => postJson(base, "/api/login", { username: `niemand${attempt}`, password: "falsch-falsch" }).then((answer) => answer.status)),
    );
    expect(statuses.filter((status) => status === 401)).toHaveLength(10);
    expect(statuses.filter((status) => status === 429)).toHaveLength(30);
  });

  it("does not count successful logins as failed attempts and slows down guessing on a password change", async () => {
    const anna = await registered("anna");
    for (let attempt = 0; attempt < 12; attempt++) {
      expect((await postJson(base, "/api/login", { username: "anna", password: "geheim-anna-1" })).status).toBe(200);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await postJson(base, "/api/me/password", { current: "falsch-falsch", password: "neues-passwort-1" }, anna.token)).status).toBe(400);
    }
    expect((await postJson(base, "/api/me/password", { current: "geheim-anna-1", password: "neues-passwort-1" }, anna.token)).status).toBe(429);
  });

  it("rejects POSTs from other sites and without JSON", async () => {
    const { token } = account(setup, "Anna");
    const evil = await postJson(base, "/api/rooms", { game: "mau-mau" }, token, { origin: "https://evil.example" });
    expect(evil).toMatchObject({ status: 403, body: { code: "forbidden" } });
    const crossSite = await postJson(base, "/api/rooms", { game: "mau-mau" }, token, { "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);
    const sameOrigin = await postJson(base, "/api/rooms", { game: "mau-mau" }, token, { origin: base, "sec-fetch-site": "same-origin" });
    expect(sameOrigin.status).toBe(201);
    const form = await fetch(`${base}/api/rooms`, { method: "POST", headers: { cookie: `gh-session=${token}`, "content-type": "text/plain" }, body: "{}" });
    expect(form.status).toBe(400);
  });

  it("rejects WebSockets from other sites", async () => {
    const { token } = account(setup, "Anna");
    const status = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${running.port}/ws`, { headers: { origin: "https://evil.example", cookie: `gh-session=${token}` } });
      socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.on("open", () => resolve(101));
    });
    expect(status).toBe(403);
    const same = await Client.connect(running.port, { token, headers: { origin: base } });
    same.send({ type: "hello", room: "ZZZZZZ" });
    expect(await same.error()).toMatchObject({ code: "unknown-room" });
    same.close();
  });
});

describe("Rooms and guests over HTTP", () => {
  it("lets only accounts create rooms", async () => {
    expect((await postJson(base, "/api/rooms", { game: "mau-mau" })).body).toMatchObject({ code: "not-signed-in" });
    const visitor = guest(setup, "Gast");
    expect(await postJson(base, "/api/rooms", { game: "mau-mau" }, visitor.token)).toMatchObject({ status: 403, body: { code: "account-required" } });
    const anna = account(setup, "Anna");
    expect(await postJson(base, "/api/rooms", { game: "mau-mau" }, anna.token)).toMatchObject({ status: 201, body: { code: expect.stringMatching(/^[A-Z2-9]{6}$/) } });
  });

  it("creates a guest when joining without a cookie and leaves none behind on errors", async () => {
    const anna = account(setup, "Anna");
    const code = String((await postJson(base, "/api/rooms", { game: "mau-mau" }, anna.token)).body["code"]);
    const guests = () => (setup.db.prepare("SELECT COUNT(*) AS count FROM users WHERE kind = 'guest'").get() as { count: number }).count;
    expect((await postJson(base, `/api/rooms/${code}/join`, { name: " " })).body).toMatchObject({ code: "bad-name" });
    expect((await postJson(base, "/api/rooms/ZZZZZZ/join", { name: "Ben" })).status).toBe(404);
    expect(guests()).toBe(0);
    const ben = await postJson(base, `/api/rooms/${code.toLowerCase()}/join`, { name: "Ben" });
    expect(ben).toMatchObject({ status: 201, body: { code }, cookie: expect.any(String) });
    expect(guests()).toBe(1);
    expect((await postJson(base, "/api/rooms/ZZZZZZ/join", { name: "Mallory" }, ben.cookie)).status).toBe(404);
    expect((await postJson(base, `/api/rooms/${code}/join`, { name: "x".repeat(25) }, ben.cookie)).body).toMatchObject({ code: "bad-name" });
    expect((await getJson(base, "/api/me", ben.cookie)).body).toMatchObject({ user: { name: "Ben" } });
    const again = await postJson(base, `/api/rooms/${code}/join`, { name: "Benjamin" }, ben.cookie);
    expect(again).toMatchObject({ status: 201, cookie: undefined });
    expect((await getJson(base, "/api/me", ben.cookie)).body).toMatchObject({ user: { kind: "guest", name: "Benjamin" } });
    const rooms = await getJson(base, "/api/me/rooms", ben.cookie);
    expect(rooms.body).toEqual({ rooms: [{ code, gameId: "mau-mau", game: "Mau-Mau", status: "lobby", round: 1, members: 2, host: false, yourTurn: false, muted: false, screen: false, updatedAt: expect.any(Number) }] });
    expect((await getJson(base, "/api/me/rooms")).status).toBe(401);
  });

  it('shows in "My rooms" whose turn it is', async () => {
    const anna = account(setup, "Anna");
    const code = String((await postJson(base, "/api/rooms", { game: "mau-mau" }, anna.token)).body["code"]);
    const ben = await postJson(base, `/api/rooms/${code}/join`, { name: "Ben" });
    await setup.rooms.start(code, anna.user);
    const turns = [anna.token, ben.cookie as string].map(async (token) => ((await getJson(base, "/api/me/rooms", token)).body["rooms"] as { yourTurn: boolean }[])[0]?.yourTurn);
    expect(await Promise.all(turns)).toEqual([true, false]);
  });

  it("requires a session and a member for hello", async () => {
    const anna = account(setup, "Anna");
    const { code } = setup.rooms.createRoom("mau-mau", anna.user);
    const nobody = await Client.connect(running.port);
    nobody.send({ type: "hello", room: code });
    expect(await nobody.error()).toMatchObject({ code: "not-signed-in" });
    const stranger = await Client.connect(running.port, { token: guest(setup, "Fremd").token });
    stranger.send({ type: "hello", room: code });
    expect(await stranger.error()).toMatchObject({ code: "not-member" });
    nobody.close();
    stranger.close();
  });

  it("disconnects connections of an ended session and shows new names right away", async () => {
    const anna = account(setup, "Anna");
    const { code } = setup.rooms.createRoom("mau-mau", anna.user);
    const client = await Client.connect(running.port, { token: anna.token });
    client.send({ type: "hello", room: code });
    await client.room();
    setup.accounts.rename(anna.user, "Anni");
    expect((await client.room((room) => room.members[0]?.name === "Anni")).you.name).toBe("Anni");
    await postJson(base, "/api/logout", {}, anna.token);
    expect(await client.error()).toMatchObject({ code: "signed-out" });
    expect((await client.closed).code).toBe(4000);
  });
});

describe("Links", () => {
  it("sets up the first admin via the setup link", async () => {
    const setupToken = setup.accounts.ensureSetupLink() as string;
    expect((await postJson(base, "/api/links/inspect", { token: setupToken, kind: "setup" })).body).toMatchObject({ kind: "setup", role: "admin" });
    expect((await postJson(base, "/api/links/inspect", { token: setupToken, kind: "invite" })).body).toMatchObject({ kind: "setup" });
    expect((await postJson(base, "/api/links/inspect", { token: setupToken, kind: "reset" })).status).toBe(404);
    expect((await postJson(base, "/api/links/inspect", { token: setupToken, kind: "kaputt" })).status).toBe(400);
    const created = await postJson(base, "/api/invites/accept", { token: setupToken, username: "anna", name: "Anna", password: "geheim-anna-1" });
    expect(created).toMatchObject({ status: 201, body: { user: { role: "admin", kind: "account" }, upgraded: false }, cookie: expect.any(String) });
    expect(setup.accounts.ensureSetupLink()).toBeUndefined();
  });

  it("turns a guest into an account with the same rooms via an invite", async () => {
    const anna = account(setup, "Anna");
    const { code } = setup.rooms.createRoom("mau-mau", anna.user);
    const ben = await postJson(base, `/api/rooms/${code}/join`, { name: "Ben" });
    const { token } = setup.accounts.createInvite(anna.user, { role: "player" });
    const upgraded = await postJson(base, "/api/invites/accept", { token, username: "ben", name: "Ben", password: "geheim-ben-12" }, ben.cookie);
    expect(upgraded).toMatchObject({ status: 201, body: { user: { kind: "account", username: "ben" }, upgraded: true } });
    expect((await getJson(base, "/api/me", ben.cookie)).body).toEqual({});
    expect(((await getJson(base, "/api/me/rooms", upgraded.cookie)).body["rooms"] as { code: string }[]).map((room) => room.code)).toEqual([code]);
    const signedIn = await postJson(base, "/api/invites/accept", { token: setup.accounts.createInvite(undefined, { role: "player" }).token, username: "x-y-z", name: "X", password: "geheim-xyz-1" }, upgraded.cookie);
    expect(signedIn).toMatchObject({ status: 403, body: { code: "signed-in" } });
  });

  it("resets passwords via a link and rate-limits guessing links", async () => {
    const anna = await registered("anna");
    const reset = setup.accounts.createResetLink(anna.id);
    expect((await postJson(base, "/api/links/inspect", { token: reset, kind: "reset" })).body).toMatchObject({ kind: "reset", username: "anna" });
    expect(await postJson(base, "/api/reset", { token: reset, password: "neues-anna-passwort" })).toMatchObject({ status: 200, body: { username: "anna" } });
    expect((await getJson(base, "/api/me", anna.token)).body).toEqual({});
    expect((await postJson(base, "/api/login", { username: "anna", password: "neues-anna-passwort" })).status).toBe(200);
    for (let attempt = 0; attempt < 30; attempt++) {
      expect((await postJson(base, "/api/links/inspect", { token: `falsch${attempt}`, kind: "invite" })).status).toBe(404);
    }
    const valid = setup.accounts.createInvite(undefined, { role: "player" }).token;
    expect((await postJson(base, "/api/links/inspect", { token: valid, kind: "invite" })).status).toBe(429);
  });

  it("exchanges room tokens from step 5 for a session", async () => {
    const anna = account(setup, "Anna");
    const { code } = setup.rooms.createRoom("mau-mau", anna.user);
    const old = setup.accounts.createGuest("Ben alt");
    setup.db.prepare("INSERT INTO members (room_code, user_id, legacy_token_hash, joined_at) VALUES (?, ?, ?, 1)").run(code, old.id, createHash("sha256").update("altes-token").digest("hex"));
    expect((await postJson(base, "/api/claim", { tokens: "kein-array" })).status).toBe(400);
    expect((await postJson(base, "/api/claim", { tokens: Array(31).fill("x") })).status).toBe(400);
    const claimed = await postJson(base, "/api/claim", { tokens: ["altes-token", "unbekannt"] });
    expect(claimed).toMatchObject({ status: 200, body: { claimed: [code], user: { id: old.id, kind: "guest", name: "Ben alt" } }, cookie: expect.any(String) });
    expect((await postJson(base, "/api/claim", { tokens: ["altes-token"] })).body).toEqual({ claimed: [] });
  });
});

describe("Commands in the container", () => {
  it("prints an admin link and a reset link", async () => {
    const admin = runAdminCommand(["admin-link", "--url", "https://games.example.org/"], setup.accounts);
    expect(admin.ok).toBe(true);
    const token = /https:\/\/games.example\.org\/invite#([A-Za-z0-9_-]+)/.exec(admin.output)?.[1] as string;
    expect(setup.accounts.inspectLink(token, ["invite"])).toMatchObject({ role: "admin" });
    expect(setup.accounts.invites()[0]?.expiresAt).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
    await registered("anna");
    const reset = runAdminCommand(["reset-link", "ANNA"], setup.accounts);
    expect(reset).toEqual({ ok: true, output: expect.stringMatching(/for anna .*\n\/reset#[A-Za-z0-9_-]+$/) });
    expect(runAdminCommand(["reset-link", "niemand"], setup.accounts)).toEqual({ ok: false, output: "There is no account niemand" });
    expect(runAdminCommand(["admin-link", "--url"], setup.accounts).ok).toBe(false);
    expect(runAdminCommand(["delete"], setup.accounts)).toMatchObject({ ok: false, output: expect.stringContaining("Usage:") });
  });
});

describe("Own account", () => {
  it("changes name and password and signs out other devices", async () => {
    const anna = await registered("anna");
    const phone = (await postJson(base, "/api/login", { username: "anna", password: "geheim-anna-1" })).cookie as string;
    expect((await postJson(base, "/api/me/name", { name: "  Anni " }, anna.token)).body).toMatchObject({ user: { name: "Anni" } });
    expect((await postJson(base, "/api/me/name", { name: "" }, anna.token)).body).toMatchObject({ code: "bad-name" });
    expect((await postJson(base, "/api/me/password", { current: "falsch-falsch", password: "neues-passwort-1" }, anna.token)).body).toMatchObject({ code: "wrong-password" });
    expect((await postJson(base, "/api/me/password", { current: "geheim-anna-1", password: "neues-passwort-1" }, anna.token)).status).toBe(200);
    expect((await getJson(base, "/api/me", phone)).body).toEqual({});
    expect((await getJson(base, "/api/me", anna.token)).body).toMatchObject({ user: { name: "Anni" } });
    expect((await postJson(base, "/api/me/name", { name: "X" })).status).toBe(401);
  });

  it("lists devices and signs out one or all", async () => {
    const anna = await registered("anna");
    const phone = (await postJson(base, "/api/login", { username: "anna", password: "geheim-anna-1" }, undefined, { "user-agent": "Mozilla/5.0 (iPhone) Safari/604.1" })).cookie as string;
    const list = (await getJson(base, "/api/me/sessions", anna.token)).body["sessions"] as { id: number; browser?: string; system?: string; current: boolean }[];
    expect(list.map((session) => session.current).sort()).toEqual([false, true]);
    const other = list.find((session) => !session.current) as { id: number; browser?: string; system?: string };
    expect(other).toMatchObject({ browser: "Safari", system: "iOS" });
    expect(other).not.toHaveProperty("device");
    const ben = await registered("ben");
    expect((await postJson(base, `/api/me/sessions/${other.id}/end`, {}, ben.token)).status).toBe(404);
    expect((await postJson(base, `/api/me/sessions/${other.id}/end`, {}, anna.token)).status).toBe(200);
    expect((await getJson(base, "/api/me", phone)).body).toEqual({});
    const second = (await postJson(base, "/api/login", { username: "anna", password: "geheim-anna-1" })).cookie as string;
    const everywhere = await fetch(`${base}/api/me/sessions/end-all`, { method: "POST", headers: { "content-type": "application/json", cookie: `gh-session=${anna.token}` }, body: "{}" });
    expect(everywhere.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await getJson(base, "/api/me", anna.token)).body).toEqual({});
    expect((await getJson(base, "/api/me", second)).body).toEqual({});
  });

  it("asks after login whether to take over the guest's seats", async () => {
    await registered("anna");
    const host = account(setup, "Cem");
    const first = setup.rooms.createRoom("mau-mau", host.user).code;
    const second = setup.rooms.createRoom("mau-mau", host.user).code;
    const visitor = await postJson(base, `/api/rooms/${first}/join`, { name: "Anna am Handy" });
    await postJson(base, `/api/rooms/${second}/join`, {}, visitor.cookie);
    const login = await postJson(base, "/api/login", { username: "anna", password: "geheim-anna-1" }, visitor.cookie);
    const me = (await getJson(base, "/api/me", login.cookie)).body;
    expect(me).toMatchObject({ user: { username: "anna" }, adopt: { name: "Anna am Handy", rooms: [{ code: expect.any(String) }, { code: expect.any(String) }] } });
    expect((await getJson(base, "/api/me", visitor.cookie)).body).toEqual({});
    expect(await postJson(base, "/api/me/adopt", { take: true }, login.cookie)).toMatchObject({ status: 200, body: { moved: expect.arrayContaining([first, second]) } });
    expect((await getJson(base, "/api/me", login.cookie)).body).not.toHaveProperty("adopt");
    const annaRooms = (await getJson(base, "/api/me/rooms", login.cookie)).body["rooms"] as { code: string }[];
    expect(annaRooms.map((room) => room.code).sort()).toEqual([first, second].sort());
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM users WHERE kind = 'guest'").get()).toEqual({ count: 0 });
  });

  it("leaves the guest in place when the takeover is declined, and never takes over twice", async () => {
    const anna = await registered("anna");
    const host = account(setup, "Cem");
    const shared = setup.rooms.createRoom("mau-mau", host.user).code;
    const own = setup.rooms.createRoom("mau-mau", host.user).code;
    await postJson(base, `/api/rooms/${shared}/join`, {}, anna.token);
    const visitor = await postJson(base, `/api/rooms/${shared}/join`, { name: "Kind" });
    await postJson(base, `/api/rooms/${own}/join`, {}, visitor.cookie);
    const declined = await postJson(base, "/api/login", { username: "anna", password: "geheim-anna-1" }, visitor.cookie);
    expect((await postJson(base, "/api/me/adopt", { take: false }, declined.cookie)).body).toEqual({ moved: [] });
    expect((await getJson(base, "/api/me", declined.cookie)).body).not.toHaveProperty("adopt");
    expect((await postJson(base, "/api/me/adopt", { take: true }, declined.cookie)).body).toEqual({ moved: [] });
    const kid = setup.db.prepare("SELECT id FROM users WHERE kind = 'guest'").get() as { id: number };
    expect(setup.rooms.rooms(kid.id)).toHaveLength(2);

    const again = setup.accounts.createSession(kid.id);
    const taken = await postJson(base, "/api/login", { username: "anna", password: "geheim-anna-1" }, again.token);
    expect((await postJson(base, "/api/me/adopt", { take: true }, taken.cookie)).body).toEqual({ moved: [own] });
    const view = await setup.rooms.view(shared, anna.id);
    expect(view.members.map((member) => member.name)).toEqual(["Cem", "anna"]);
  });
});

describe("Review: sessions and connections", () => {
  it("disconnects the old session's connections on login on the same device", async () => {
    const anna = account(setup, "Anna");
    await registered("bert");
    const { code } = setup.rooms.createRoom("mau-mau", anna.user);
    const client = await Client.connect(running.port, { token: anna.token });
    client.send({ type: "hello", room: code });
    await client.room();
    expect((await postJson(base, "/api/login", { username: "bert", password: "geheim-bert-1" }, anna.token)).status).toBe(200);
    expect(await client.error()).toMatchObject({ code: "signed-out" });
    expect((await client.closed).code).toBe(4000);
  });

  it("disconnects the guest on login and still shows the account its room after the takeover", async () => {
    await registered("anna");
    const host = account(setup, "Cem");
    const { code } = setup.rooms.createRoom("mau-mau", host.user);
    const visitor = await postJson(base, `/api/rooms/${code}/join`, { name: "Gast" });
    const old = await Client.connect(running.port, { token: visitor.cookie as string });
    old.send({ type: "hello", room: code });
    await old.room();
    const login = await postJson(base, "/api/login", { username: "anna", password: "geheim-anna-1" }, visitor.cookie);
    expect(await old.error()).toMatchObject({ code: "signed-out" });
    await postJson(base, "/api/me/adopt", { take: true }, login.cookie);
    const fresh = await Client.connect(running.port, { token: login.cookie as string });
    fresh.send({ type: "hello", room: code });
    expect((await fresh.room()).you.name).toBe("anna");
    await setup.rooms.joinRoom(code, guest(setup, "Dora").user);
    expect((await fresh.room((room) => room.members.length === 3)).you.name).toBe("anna");
    expect(fresh.received.filter((message) => message.type === "error")).toEqual([]);
    fresh.close();
  });

  it("closes connections without a session right away and limits connections per address", async () => {
    await running.close();
    running = await startServer({ rooms: setup.rooms, accounts: setup.accounts, library: setup.library, port: 0, host: "127.0.0.1", limits: { maxConnections: 5, maxConnectionsPerAddress: 3 } });
    const anonymous = await Promise.all(Array.from({ length: 5 }, () => Client.connect(running.port)));
    for (const client of anonymous) {
      expect(await client.error()).toMatchObject({ code: "not-signed-in" });
      expect((await client.closed).code).toBe(4000);
    }
    const anna = account(setup, "Anna");
    const { code } = setup.rooms.createRoom("mau-mau", anna.user);
    const clients = await Promise.all(Array.from({ length: 3 }, () => Client.connect(running.port, { token: anna.token })));
    for (const client of clients) {
      client.send({ type: "hello", room: code });
      await client.room();
    }
    const fourth = await Client.connect(running.port, { token: anna.token });
    expect(await fourth.error()).toMatchObject({ code: "too-many-connections" });
  });

  it("disconnects connections whose session expired during cleanup", async () => {
    const ended: number[] = [];
    setup.accounts.on({ sessionsEnded: (ids) => ended.push(...ids) });
    const anna = await registered("anna");
    setup.db.prepare("UPDATE sessions SET expires_at = 1").run();
    setup.accounts.sweep();
    expect(ended).toHaveLength(1);
    expect((await getJson(base, "/api/me", anna.token)).body).toEqual({});
  });
});

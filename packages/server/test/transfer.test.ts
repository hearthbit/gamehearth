import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountService, normalizeTransferCode } from "../src/accounts";
import { PushService } from "../src/push/service";
import { startServer, type RunningServer } from "../src/transport";
import { Client, getJson, postJson } from "./client";
import { newSubscriptionKeys } from "./fake-push";
import { account, cheapPasswords, createSetup, guest, mauMauDir, type Setup } from "./helpers";

let setup: Setup;
let running: RunningServer;
let base: string;
let push: PushService;

beforeEach(async () => {
  setup = await createSetup();
  await setup.library.install(mauMauDir);
  push = new PushService(setup.db, { log: (message) => setup.logs.push(message) });
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
  push.close();
  await running.close();
  await setup.cleanup();
});

async function codeFor(token: string): Promise<string> {
  const created = await postJson(base, "/api/me/transfer", {}, token);
  expect(created.status).toBe(200);
  return created.body["code"] as string;
}

describe("Transfer code", () => {
  it("has 8 characters without confusable ones, is valid for 10 minutes and accepts input loosely", async () => {
    const ben = guest(setup, "Ben");
    const before = Date.now();
    const created = await postJson(base, "/api/me/transfer", {}, ben.token);
    expect(created.body["code"]).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(created.body["expiresAt"]).toBeGreaterThanOrEqual(before + 10 * 60 * 1000);
    expect(created.body["expiresAt"]).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
    const code = created.body["code"] as string;
    const sloppy = ` ${code.toLowerCase().replace("-", " ")} `;
    const redeemed = await postJson(base, "/api/transfer", { code: sloppy });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body["user"]).toMatchObject({ id: ben.user, kind: "guest", name: "Ben" });
    expect(redeemed.cookie).toBeDefined();
    expect((await getJson(base, "/api/me", redeemed.cookie)).body).toMatchObject({ user: { id: ben.user } });
    expect((await getJson(base, "/api/me", ben.token)).body).toMatchObject({ user: { id: ben.user } });
    const sessions = (await getJson(base, "/api/me/sessions", ben.token)).body["sessions"] as unknown[];
    expect(sessions).toHaveLength(2);
  });

  it("is valid only once, and a new code replaces the old one", async () => {
    const anna = account(setup, "Anna");
    const first = await codeFor(anna.token);
    const second = await codeFor(anna.token);
    expect((await postJson(base, "/api/transfer", { code: first })).body).toMatchObject({ code: "unknown-code" });
    expect((await postJson(base, "/api/transfer", { code: second })).status).toBe(200);
    const again = await postJson(base, "/api/transfer", { code: second });
    expect(again).toMatchObject({ status: 404, body: { code: "unknown-code" } });
  });

  it("expires after 10 minutes", () => {
    let now = Date.now();
    const accounts = new AccountService(setup.db, { clock: () => now, passwordCost: cheapPasswords });
    const ben = accounts.createGuest("Ben");
    const session = accounts.createSession(ben.id).session;
    const { code } = accounts.createTransferCode(session);
    now += 10 * 60 * 1000;
    expect(() => accounts.redeemTransferCode(code, undefined)).toThrow(expect.objectContaining({ code: "unknown-code" }));
    const fresh = accounts.createTransferCode(session);
    now += 10 * 60 * 1000 - 1;
    expect(accounts.redeemTransferCode(fresh.code, undefined).session.user.id).toBe(ben.id);
  });

  it("becomes invalid when the session ends, the account is locked or the password is reset", async () => {
    const ben = guest(setup, "Ben");
    const newer = setup.accounts.createSession(ben.user).token;
    const loggedOut = await codeFor(newer);
    await postJson(base, "/api/me/sessions/end-all", {}, ben.token);
    expect((await postJson(base, "/api/transfer", { code: loggedOut })).body).toMatchObject({ code: "unknown-code" });

    const anna = account(setup, "Anna");
    const locked = await codeFor(anna.token);
    setup.accounts.updateUser(anna.user, { locked: true });
    expect((await postJson(base, "/api/transfer", { code: locked })).body).toMatchObject({ code: "unknown-code" });

    const cem = account(setup, "Cem");
    const before = await codeFor(cem.token);
    setup.db.prepare("INSERT INTO credentials (user_id, kind, secret, created_at) VALUES (?, 'password', 'x', 0)").run(cem.user);
    const reset = setup.accounts.createResetLink(cem.user);
    await setup.accounts.resetPassword(reset, "ganz-neues-passwort");
    expect((await postJson(base, "/api/transfer", { code: before })).body).toMatchObject({ code: "unknown-code" });
  });

  it("requires a session to create one and rate-limits creating and guessing", async () => {
    expect((await postJson(base, "/api/me/transfer", {})).status).toBe(401);
    let last = 0;
    for (let attempt = 0; attempt < 31; attempt++) {
      last = (await postJson(base, "/api/transfer", { code: "AAAA-AAAA" })).status;
    }
    expect(last).toBe(429);
    const ben = guest(setup, "Ben");
    const code = await codeFor(ben.token);
    expect((await postJson(base, "/api/transfer", { code })).status).toBe(429);
  });

  it("rate-limits creating per address", async () => {
    const ben = guest(setup, "Ben");
    let last = 0;
    for (let attempt = 0; attempt < 31; attempt++) {
      last = (await postJson(base, "/api/me/transfer", {}, ben.token)).status;
    }
    expect(last).toBe(429);
  });

  it("normalizes input strictly", () => {
    expect(normalizeTransferCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizeTransferCode("ABCD EFGH")).toBe("ABCDEFGH");
    expect(normalizeTransferCode("ABCD-EFG0")).toBeUndefined();
    expect(normalizeTransferCode("ABCDEFGHJ")).toBeUndefined();
    expect(normalizeTransferCode(42)).toBeUndefined();
    expect(normalizeTransferCode("A".repeat(100))).toBeUndefined();
  });
});

describe("Redeeming on a device with a session", () => {
  it("asks about a guest's seats, even when the target is a guest, and removes the duplicate seat in the lobby", async () => {
    const anna = account(setup, "Anna");
    const { code: lobby } = setup.rooms.createRoom("mau-mau", anna.user);
    const { code: other } = setup.rooms.createRoom("mau-mau", anna.user);
    const ben = guest(setup, "Ben");
    await setup.rooms.joinRoom(lobby, ben.user);
    const ghost = guest(setup, "Ben am Handy");
    await setup.rooms.joinRoom(lobby, ghost.user);
    await setup.rooms.joinRoom(other, ghost.user);
    expect((await setup.rooms.view(lobby, anna.user)).members).toHaveLength(3);

    const code = await codeFor(ben.token);
    const redeemed = await postJson(base, "/api/transfer", { code }, ghost.token);
    expect(redeemed.body["user"]).toMatchObject({ id: ben.user });
    const me = await getJson(base, "/api/me", redeemed.cookie);
    expect(me.body["adopt"]).toMatchObject({ name: "Ben am Handy" });
    expect((me.body["adopt"] as { rooms: { code: string }[] }).rooms.map((room) => room.code)).toEqual([other]);
    expect((me.body["adopt"] as { duplicates: { code: string }[] }).duplicates.map((room) => room.code)).toEqual([lobby]);
    expect((await getJson(base, "/api/me", ghost.token)).body).toEqual({});

    const moved = await postJson(base, "/api/me/adopt", { take: true }, redeemed.cookie);
    expect(moved.body["moved"]).toEqual([other]);
    const lobbyView = await setup.rooms.view(lobby, anna.user);
    expect(lobbyView.members.map((member) => member.name).sort()).toEqual(["Anna", "Ben"]);
    expect(setup.rooms.codes(ben.user).sort()).toEqual([lobby, other].sort());
    expect(() => setup.accounts.user(ghost.user)).toThrow();
  });

  it("does not ask when the code belongs to the same user", async () => {
    const ben = guest(setup, "Ben");
    const second = setup.accounts.createSession(ben.user).token;
    const code = await codeFor(ben.token);
    const redeemed = await postJson(base, "/api/transfer", { code }, second);
    expect(redeemed.status).toBe(200);
    expect((await getJson(base, "/api/me", redeemed.cookie)).body).toEqual({ user: expect.objectContaining({ id: ben.user }) });
  });

  it("ends an account session on the device without asking", async () => {
    const anna = account(setup, "Anna");
    const ben = guest(setup, "Ben");
    const code = await codeFor(ben.token);
    const redeemed = await postJson(base, "/api/transfer", { code }, anna.token);
    expect((await getJson(base, "/api/me", redeemed.cookie)).body).toEqual({ user: expect.objectContaining({ id: ben.user }) });
    expect((await getJson(base, "/api/me", anna.token)).body).toEqual({});
  });
});

describe("Review of the transfer", () => {
  it("does not let a guest's later device sign out the original one", async () => {
    const ben = guest(setup, "Ben");
    const code = await codeFor(ben.token);
    const thief = (await postJson(base, "/api/transfer", { code })).cookie as string;
    const sessions = (await getJson(base, "/api/me/sessions", thief)).body["sessions"] as { id: number; current: boolean }[];
    const original = sessions.find((session) => !session.current) as { id: number };
    expect(await postJson(base, `/api/me/sessions/${original.id}/end`, {}, thief)).toMatchObject({ status: 403, body: { code: "forbidden" } });
    expect((await postJson(base, "/api/me/sessions/end-all", {}, thief)).status).toBe(200);
    expect((await getJson(base, "/api/me", ben.token)).body).toMatchObject({ user: { id: ben.user } });
    expect((await postJson(base, "/api/me/sessions/end-all", {}, ben.token)).status).toBe(200);
    expect((await getJson(base, "/api/me", thief)).body).toEqual({});
  });

  it("gives admins no code, because it would grant admin rights without a password", async () => {
    const admin = account(setup, "Admin", "admin");
    expect(await postJson(base, "/api/me/transfer", {}, admin.token)).toMatchObject({ status: 403, body: { code: "forbidden" } });
  });

  it("offers no takeover when the guest is still signed in on another device", async () => {
    const anna = account(setup, "Anna");
    const { code: room } = setup.rooms.createRoom("mau-mau", anna.user);
    const ben = guest(setup, "Ben");
    await setup.rooms.joinRoom(room, ben.user);
    const benApp = setup.accounts.createSession(ben.user).token;
    const cem = guest(setup, "Cem");
    const code = await codeFor(cem.token);
    const redeemed = await postJson(base, "/api/transfer", { code }, ben.token);
    const me = await getJson(base, "/api/me", redeemed.cookie);
    expect(me.body["adopt"]).toBeUndefined();
    await postJson(base, "/api/me/adopt", { take: true }, redeemed.cookie);
    expect((await getJson(base, "/api/me", benApp)).body).toMatchObject({ user: { id: ben.user } });
    expect(setup.rooms.codes(ben.user)).toEqual([room]);
  });

  it("names separately in the prompt which seats move and which duplicates are dropped", async () => {
    const anna = account(setup, "Anna");
    const { code: shared } = setup.rooms.createRoom("mau-mau", anna.user);
    const { code: own } = setup.rooms.createRoom("mau-mau", anna.user);
    const ben = guest(setup, "Ben");
    await setup.rooms.joinRoom(shared, ben.user);
    const ghost = guest(setup, "Ben am Handy");
    await setup.rooms.joinRoom(shared, ghost.user);
    await setup.rooms.joinRoom(own, ghost.user);
    const code = await codeFor(ben.token);
    const redeemed = await postJson(base, "/api/transfer", { code }, ghost.token);
    const adopt = (await getJson(base, "/api/me", redeemed.cookie)).body["adopt"] as { rooms: { code: string }[]; duplicates: { code: string }[] };
    expect(adopt.rooms.map((room) => room.code)).toEqual([own]);
    expect(adopt.duplicates.map((room) => room.code)).toEqual([shared]);
  });

  it("does not store the code as a plain hash that could be reversed from a backup", async () => {
    const ben = guest(setup, "Ben");
    const code = (await codeFor(ben.token)).replace("-", "");
    const row = setup.db.prepare("SELECT code_hash FROM transfer_codes").get() as { code_hash: string };
    expect(row.code_hash).not.toBe(createHash("sha256").update(code).digest("hex"));
    expect(row.code_hash).not.toBe(createHash("sha256").update(code).digest("base64url"));
  });

  it("becomes invalid on sign-out, deletion and expiry of the guest", async () => {
    const ben = guest(setup, "Ben");
    const loggedOut = await codeFor(ben.token);
    await postJson(base, "/api/logout", {}, ben.token);
    expect((await postJson(base, "/api/transfer", { code: loggedOut })).body).toMatchObject({ code: "unknown-code" });
    const cem = guest(setup, "Cem");
    const deleted = await codeFor(cem.token);
    setup.accounts.deleteUser(cem.user);
    expect((await postJson(base, "/api/transfer", { code: deleted })).body).toMatchObject({ code: "unknown-code" });
    const dora = guest(setup, "Dora");
    const expired = await codeFor(dora.token);
    setup.db.prepare("UPDATE users SET active_at = 0 WHERE id = ?").run(dora.user);
    for (const id of setup.accounts.expiredGuests()) {
      setup.rooms.removeUser(id);
      setup.accounts.deleteUser(id);
    }
    expect((await postJson(base, "/api/transfer", { code: expired })).body).toMatchObject({ code: "unknown-code" });
  });

  it("disconnects the replaced session's WebSockets on redeeming and removes its push subscription", async () => {
    const anna = account(setup, "Anna");
    const { code: room } = setup.rooms.createRoom("mau-mau", anna.user);
    const ghost = guest(setup, "Ben am Handy");
    await setup.rooms.joinRoom(room, ghost.user);
    const ghostSession = setup.accounts.session(ghost.token)?.id as number;
    push.subscribe(ghostSession, { endpoint: "https://fcm.googleapis.com/fcm/send/geist", keys: newSubscriptionKeys().keys }, "https://x.example");
    const socket = await Client.connect(running.port, { token: ghost.token });
    socket.send({ type: "hello", room });
    await socket.room();
    const ben = guest(setup, "Ben");
    const code = await codeFor(ben.token);
    await postJson(base, "/api/transfer", { code }, ghost.token);
    expect((await socket.error()).code).toBe("signed-out");
    expect((await socket.closed).code).toBe(4000);
    expect(push.count()).toBe(0);
  });

  it("signs out a guest's other devices when an invite is redeemed, so a stolen code does not stay in the new account", async () => {
    const ben = guest(setup, "Ben");
    const app = setup.accounts.createSession(ben.user).token;
    const { token } = setup.accounts.createInvite(undefined, { role: "player" });
    const accepted = await postJson(base, "/api/invites/accept", { token, username: "ben", name: "Ben", password: "geheim-geheim-1" }, ben.token);
    expect(accepted.status).toBe(201);
    expect((await getJson(base, "/api/me", app)).body).toEqual({});
    expect((await getJson(base, "/api/me", accepted.cookie)).body).toMatchObject({ user: { id: ben.user, kind: "account" } });
  });
});

describe("Devices of a guest", () => {
  it("signs out other devices, but never the own one", async () => {
    const ben = guest(setup, "Ben");
    const phone = setup.accounts.createSession(ben.user).token;
    const sessions = (await getJson(base, "/api/me/sessions", ben.token)).body["sessions"] as { id: number; current: boolean }[];
    const own = sessions.find((session) => session.current) as { id: number };
    const ownEnd = await postJson(base, `/api/me/sessions/${own.id}/end`, {}, ben.token);
    expect(ownEnd).toMatchObject({ status: 403, body: { code: "forbidden" } });
    const all = await postJson(base, "/api/me/sessions/end-all", {}, ben.token);
    expect(all.status).toBe(200);
    expect((await getJson(base, "/api/me", ben.token)).body).toMatchObject({ user: { id: ben.user } });
    expect((await getJson(base, "/api/me", phone)).body).toEqual({});
  });

  it("still lets accounts sign out everywhere", async () => {
    const anna = account(setup, "Anna");
    const sessions = (await getJson(base, "/api/me/sessions", anna.token)).body["sessions"] as { id: number }[];
    expect((await postJson(base, `/api/me/sessions/${(sessions[0] as { id: number }).id}/end`, {}, anna.token)).status).toBe(200);
    expect((await getJson(base, "/api/me", anna.token)).body).toEqual({});
  });
});

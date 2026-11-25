import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountError, AccountService, describeDevice, hashPassword, passwordSlots, type Session } from "../src/accounts";
import { openDatabase } from "../src/db";

const day = 24 * 60 * 60 * 1000;
const cheap = { N: 1024, r: 8, p: 1 };
let dir: string;
let db: DatabaseSync;
let now: number;
let accounts: AccountService;
let ended: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gamehearth-accounts-"));
  db = openDatabase(join(dir, "test.sqlite"));
  now = 1_000_000;
  accounts = new AccountService(db, { clock: () => now, passwordCost: cheap });
  ended = [];
  accounts.on({ sessionsEnded: (ids) => ended.push(...ids) });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function rejects(promise: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(AccountError);
    expect((error as AccountError).code).toBe(code);
    return;
  }
  throw new Error(`expected: ${code}`);
}

async function caught(promise: Promise<unknown>): Promise<AccountError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AccountError);
    return error as AccountError;
  }
  throw new Error("expected: error");
}

async function admin(username = "anna", password = "geheim-anna-1"): Promise<Session> {
  const setup = accounts.ensureSetupLink() ?? accounts.createInvite(undefined, { role: "admin" }).token;
  return (await accounts.acceptInvite(setup, { username, name: "Anna", password }, undefined)).session;
}

async function player(username: string, password = `geheim-${username}-1`): Promise<Session> {
  const { token } = accounts.createInvite(undefined, { role: "player" });
  return (await accounts.acceptInvite(token, { username, name: username, password }, undefined)).session;
}

describe("Setup", () => {
  it("issues a setup link while there is no admin, and closes it afterwards", async () => {
    const first = accounts.ensureSetupLink() as string;
    const second = accounts.ensureSetupLink() as string;
    expect(second).not.toBe(first);
    await rejects(() => accounts.inspectLink(first, ["setup"]), "unknown-link");
    expect(accounts.inspectLink(second, ["setup"])).toMatchObject({ kind: "setup", role: "admin" });
    await rejects(() => accounts.inspectLink(second, ["invite"]), "unknown-link");
    const created = await accounts.acceptInvite(second, { username: "Anna", name: "Anna", password: "geheim-anna-1" }, undefined);
    expect(created.session.user).toEqual({ id: created.session.user.id, kind: "account", username: "Anna", name: "Anna", role: "admin", locked: false, language: null, theme: null });
    expect(accounts.hasAdmin()).toBe(true);
    expect(accounts.ensureSetupLink()).toBeUndefined();
    await rejects(accounts.acceptInvite(second, { username: "mallory", name: "M", password: "geheim-mallory" }, undefined), "unknown-link");
  });

  it("rejects an old setup link once an admin exists", async () => {
    const setup = accounts.ensureSetupLink() as string;
    await admin("bert");
    await rejects(accounts.acceptInvite(setup, { username: "mallory", name: "M", password: "geheim-mallory" }, undefined), "unknown-link");
  });
});

describe("Invites", () => {
  it("creates exactly one account with role and suggestions and is valid for seven days", async () => {
    const anna = await admin();
    const { token, invite } = accounts.createInvite(anna.user.id, { role: "player", note: "für Oma", username: "oma", name: "Oma Gerda" });
    expect(invite).toEqual({ id: invite.id, role: "player", note: "für Oma", username: "oma", name: "Oma Gerda", createdAt: now, expiresAt: now + 7 * day, createdBy: "anna" });
    expect(accounts.inspectLink(token, ["invite"])).toEqual({ kind: "invite", role: "player", expiresAt: now + 7 * day, username: "oma", name: "Oma Gerda" });
    const oma = await accounts.acceptInvite(token, { username: "Oma", name: "Gerda", password: "geheim-gerda-1" }, undefined, "Mozilla/5.0 (Linux; Android 14) Chrome/130.0");
    expect(oma.session.user).toMatchObject({ kind: "account", username: "Oma", name: "Gerda", role: "player" });
    expect(oma.upgraded).toBe(false);
    expect(accounts.session(oma.token)?.user.id).toBe(oma.session.user.id);
    expect(accounts.invites()).toEqual([]);
    await rejects(accounts.acceptInvite(token, { username: "zwei", name: "Z", password: "geheim-zwei-1" }, undefined), "unknown-link");

    const late = accounts.createInvite(anna.user.id, { role: "admin" });
    now += 7 * day;
    expect(accounts.invites()).toEqual([]);
    await rejects(accounts.acceptInvite(late.token, { username: "spaet", name: "S", password: "geheim-spaet-1" }, undefined), "unknown-link");
  });

  it("can be revoked", async () => {
    const { token, invite } = accounts.createInvite(undefined, { role: "player" });
    accounts.revokeInvite(invite.id);
    await rejects(() => accounts.revokeInvite(invite.id), "unknown-link");
    await rejects(accounts.acceptInvite(token, { username: "ben", name: "Ben", password: "geheim-ben-12" }, undefined), "unknown-link");
  });

  it("checks name and password without using up the link", async () => {
    await admin();
    const { token } = accounts.createInvite(undefined, { role: "player" });
    await rejects(accounts.acceptInvite(token, { username: "ANNA", name: "Anna", password: "geheim-anna-2" }, undefined), "username-taken");
    await rejects(accounts.acceptInvite(token, { username: "a", name: "A", password: "geheim-a-1234" }, undefined), "bad-username");
    await rejects(accounts.acceptInvite(token, { username: "an na", name: "A", password: "geheim-a-1234" }, undefined), "bad-username");
    await rejects(accounts.acceptInvite(token, { username: "ben", name: " ", password: "geheim-ben-12" }, undefined), "bad-name");
    await rejects(accounts.acceptInvite(token, { username: "ben", name: "Ben", password: "kurz" }, undefined), "bad-password");
    await rejects(() => accounts.createInvite(undefined, { role: "player", note: "x".repeat(81) }), "bad-name");
    expect((await accounts.acceptInvite(token, { username: "ben", name: "Ben", password: "geheim-ben-12" }, undefined)).session.user.username).toBe("ben");
  });

  it("turns a guest into an account and keeps them, but ends their guest session", async () => {
    const guest = accounts.createGuest("Gast Carla");
    const guestSession = accounts.createSession(guest.id);
    expect(accounts.session(guestSession.token)?.user).toEqual({ id: guest.id, kind: "guest", name: "Gast Carla", role: "player", locked: false, language: null, theme: null });
    const { token } = accounts.createInvite(undefined, { role: "player" });
    const upgraded = await accounts.acceptInvite(token, { username: "carla", name: "Carla", password: "geheim-carla-1" }, guestSession.session);
    expect(upgraded.upgraded).toBe(true);
    expect(upgraded.session.user).toMatchObject({ id: guest.id, kind: "account", username: "carla", name: "Carla" });
    expect(accounts.session(guestSession.token)).toBeUndefined();
    expect(ended).toEqual([guestSession.session.id]);
  });

  it("rejects invites when an account is already signed in", async () => {
    const anna = await admin();
    const { token } = accounts.createInvite(undefined, { role: "player" });
    await rejects(accounts.acceptInvite(token, { username: "ben", name: "Ben", password: "geheim-ben-12" }, anna), "signed-in");
    expect(accounts.inspectLink(token, ["invite"]).kind).toBe("invite");
  });
});

describe("Sign-in", () => {
  it("signs in with a case-insensitive username and rejects wrong input right away", async () => {
    await admin("Anna", "geheim-anna-1");
    const login = await accounts.login("aNNa", "geheim-anna-1", undefined, "Mozilla/5.0 (Windows NT 10.0) Firefox/133.0");
    expect(login.session.user.username).toBe("Anna");
    expect(accounts.sessions(login.session.user.id, login.session.id).find((session) => session.current)).toMatchObject({ browser: "Firefox", system: "Windows" });
    await rejects(accounts.login("anna", "falsch-falsch", undefined), "wrong-login");
    await rejects(accounts.login("niemand", "geheim-anna-1", undefined), "wrong-login");
    await rejects(accounts.login("x", "geheim-anna-1", undefined), "wrong-login");
  });

  it("slows down after five failed attempts with a growing wait, without locking", async () => {
    await admin("anna", "geheim-anna-1");
    for (let attempt = 0; attempt < 5; attempt++) {
      await rejects(accounts.login("anna", "falsch-falsch", undefined), "wrong-login");
    }
    await rejects(accounts.login("ANNA", "geheim-anna-1", undefined), "login-throttled");
    now += 30_000;
    await rejects(accounts.login("anna", "falsch-falsch", undefined), "wrong-login");
    now += 30_000;
    await rejects(accounts.login("anna", "geheim-anna-1", undefined), "login-throttled");
    expect((await caught(accounts.login("anna", "geheim-anna-1", undefined))).retryAfterMs).toBe(30_000);
    now += 30_000;
    expect((await accounts.login("anna", "geheim-anna-1", undefined)).session.user.username).toBe("anna");
    await rejects(accounts.login("anna", "falsch-falsch", undefined), "wrong-login");
    expect((await accounts.login("anna", "geheim-anna-1", undefined)).session.user.username).toBe("anna");

    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await accounts.login("anna", "falsch-falsch", undefined);
      } catch {
        now += 15 * 60 * 1000;
      }
    }
    await rejects(accounts.login("anna", "falsch-falsch", undefined), "wrong-login");
    expect((await caught(accounts.login("anna", "geheim-anna-1", undefined))).retryAfterMs).toBe(15 * 60 * 1000);
  });

  it("remembers a guest on the device at sign-in and ends their session", async () => {
    await admin("anna", "geheim-anna-1");
    const guest = accounts.createGuest("Anna als Gast");
    const guestSession = accounts.createSession(guest.id);
    const login = await accounts.login("anna", "geheim-anna-1", guestSession.session);
    expect(login.session.adoptGuest).toBe(guest.id);
    expect(accounts.session(login.token)?.adoptGuest).toBe(guest.id);
    expect(accounts.session(guestSession.token)).toBeUndefined();
    accounts.clearAdoption(login.session.id);
    expect(accounts.session(login.token)?.adoptGuest).toBeUndefined();
    expect(accounts.user(guest.id).kind).toBe("guest");
  });

  it("rejects locked accounts only after the correct password", async () => {
    const anna = await admin();
    const ben = await player("ben");
    const benLogin = await accounts.login("ben", "geheim-ben-1", undefined);
    accounts.updateUser(ben.user.id, { locked: true });
    expect(accounts.session(benLogin.token)).toBeUndefined();
    await rejects(accounts.login("ben", "falsch-falsch", undefined), "wrong-login");
    await rejects(accounts.login("ben", "geheim-ben-1", undefined), "account-locked");
    accounts.updateUser(ben.user.id, { locked: false });
    expect((await accounts.login("ben", "geheim-ben-1", undefined)).session.user.locked).toBe(false);
    expect(anna.user.role).toBe("admin");
  });

  it("rehashes passwords with new costs at the next login", async () => {
    await admin("anna", "geheim-anna-1");
    const stronger = new AccountService(db, { clock: () => now, passwordCost: { N: 2048, r: 8, p: 1 } });
    await stronger.login("anna", "geheim-anna-1", undefined);
    const secret = (db.prepare("SELECT secret FROM credentials").get() as { secret: string }).secret;
    expect(secret.startsWith("scrypt$2048$8$1$")).toBe(true);
    expect((await accounts.login("anna", "geheim-anna-1", undefined)).session.user.username).toBe("anna");
  });
});

describe("Sessions", () => {
  it("last a sliding 90 days for accounts and never expire for guests", async () => {
    await admin("anna", "geheim-anna-1");
    const login = await accounts.login("anna", "geheim-anna-1", undefined);
    const guest = accounts.createSession(accounts.createGuest("Gast").id);
    now += 89 * day;
    expect(accounts.session(login.token)).toBeDefined();
    now += 89 * day;
    expect(accounts.session(login.token)).toBeDefined();
    now += 90 * day;
    expect(accounts.session(login.token)).toBeUndefined();
    expect(accounts.session(guest.token)?.user.kind).toBe("guest");
    expect(accounts.session("unbekannt")).toBeUndefined();
    expect(accounts.session(undefined)).toBeUndefined();
  });

  it("lists devices and signs out one or all", async () => {
    await admin("anna", "geheim-anna-1");
    const phone = await accounts.login("anna", "geheim-anna-1", undefined, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1");
    now += 1000;
    const laptop = await accounts.login("anna", "geheim-anna-1", undefined, "Mozilla/5.0 (Macintosh) Chrome/130.0 Safari/537.36");
    const ben = await player("ben");
    const list = accounts.sessions(laptop.session.user.id, laptop.session.id);
    expect(list.map((session) => [session.browser, session.system, session.current])).toEqual([
      ["Chrome", "macOS", true],
      ["Safari", "iOS", false],
      [undefined, undefined, false],
    ]);
    await rejects(() => accounts.endSession(phone.session.id, ben.user.id), "unknown-session");
    accounts.endSession(phone.session.id, laptop.session.user.id);
    expect(accounts.session(phone.token)).toBeUndefined();
    const all = accounts.endAllSessions(laptop.session.user.id);
    expect(all).toHaveLength(2);
    expect(accounts.session(laptop.token)).toBeUndefined();
    expect(ended).toEqual([phone.session.id, ...all]);
  });

  it("ends all other sessions on a password change", async () => {
    await admin("anna", "geheim-anna-1");
    const one = await accounts.login("anna", "geheim-anna-1", undefined);
    const two = await accounts.login("anna", "geheim-anna-1", undefined);
    await rejects(accounts.changePassword(one.session, "falsch-falsch", "neues-passwort-1"), "wrong-password");
    await rejects(accounts.changePassword(one.session, "geheim-anna-1", "kurz"), "bad-password");
    await accounts.changePassword(one.session, "geheim-anna-1", "neues-passwort-1");
    expect(accounts.session(one.token)).toBeDefined();
    expect(accounts.session(two.token)).toBeUndefined();
    await rejects(accounts.login("anna", "geheim-anna-1", undefined), "wrong-login");
    expect((await accounts.login("anna", "neues-passwort-1", undefined)).session.user.username).toBe("anna");
  });

  it("renames and reports the change", async () => {
    const changed: number[] = [];
    accounts.on({ userChanged: (id) => changed.push(id) });
    const guest = accounts.createGuest("Gast");
    expect(accounts.rename(guest.id, "  Carla  ").name).toBe("Carla");
    await rejects(() => accounts.rename(guest.id, "x".repeat(25)), "bad-name");
    expect(changed).toEqual([guest.id]);
  });
});

describe("Reset and management", () => {
  it("resets once with a link and ends all sessions", async () => {
    const anna = await admin();
    const ben = await player("ben");
    const login = await accounts.login("ben", "geheim-ben-1", undefined);
    const first = accounts.createResetLink(ben.user.id, anna.user.id);
    const link = accounts.createResetLink(ben.user.id, anna.user.id);
    await rejects(() => accounts.inspectLink(first, ["reset"]), "unknown-link");
    expect(accounts.inspectLink(link, ["reset"])).toMatchObject({ kind: "reset", username: "ben", name: "ben" });
    await rejects(() => accounts.inspectLink(link, ["invite", "setup"]), "unknown-link");
    await rejects(accounts.resetPassword(link, "kurz"), "bad-password");
    expect((await accounts.resetPassword(link, "neues-ben-passwort")).username).toBe("ben");
    expect(accounts.session(login.token)).toBeUndefined();
    await rejects(accounts.resetPassword(link, "noch-ein-passwort"), "unknown-link");
    expect((await accounts.login("ben", "neues-ben-passwort", undefined)).session.user.username).toBe("ben");
    await rejects(() => accounts.createResetLink(accounts.createGuest("Gast").id), "unknown-user");
    const late = accounts.createResetLink(ben.user.id);
    now += day;
    await rejects(accounts.resetPassword(late, "neues-ben-passwort-2"), "unknown-link");
  });

  it("protects the last admin", async () => {
    const anna = await admin();
    await rejects(() => accounts.updateUser(anna.user.id, { role: "player" }), "last-admin");
    await rejects(() => accounts.updateUser(anna.user.id, { locked: true }), "last-admin");
    await rejects(() => accounts.requireDeletable(anna.user.id), "last-admin");
    const ben = await player("ben");
    accounts.updateUser(ben.user.id, { role: "admin" });
    expect(accounts.updateUser(anna.user.id, { role: "player" }).role).toBe("player");
    await rejects(() => accounts.updateUser(ben.user.id, { locked: true }), "last-admin");
    expect(accounts.users().map((user) => [user.username, user.role])).toEqual([
      ["anna", "player"],
      ["ben", "admin"],
    ]);
  });

  it("changes usernames only to unique ones and deletes together with sessions", async () => {
    await admin();
    const ben = await player("ben");
    await rejects(() => accounts.updateUser(ben.user.id, { username: "ANNA" }), "username-taken");
    expect(accounts.updateUser(ben.user.id, { username: "benni" }).username).toBe("benni");
    const login = await accounts.login("benni", "geheim-ben-1", undefined);
    accounts.deleteUser(ben.user.id);
    expect(accounts.session(login.token)).toBeUndefined();
    await rejects(() => accounts.user(ben.user.id), "unknown-user");
    expect(ended).toContain(login.session.id);
  });

  it("finds guests who have done nothing for 30 days", () => {
    const old = accounts.createGuest("Alt");
    now += 20 * day;
    const fresh = accounts.createGuest("Neu");
    now += 11 * day;
    expect(accounts.expiredGuests()).toEqual([old.id]);
    const session = accounts.createSession(old.id);
    now += 2 * 60 * 60 * 1000;
    accounts.session(session.token);
    expect(accounts.expiredGuests()).toEqual([]);
    expect(fresh.kind).toBe("guest");
  });
});

describe("Devices", () => {
  it("names browser and system as codes the UI translates, and nothing for an unknown device", () => {
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0")).toEqual({ browser: "Edge", system: "Windows" });
    expect(describeDevice("Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0")).toEqual({ browser: "Firefox", system: "Linux" });
    expect(describeDevice("Mozilla/5.0 (X11; Linux x86_64)")).toEqual({ system: "Linux" });
    expect(describeDevice("curl/8.0")).toEqual({});
  });
});

describe("Review: rate limiting", () => {
  it("counts concurrent failed attempts before the password is checked", async () => {
    await admin("anna", "geheim-anna-1");
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => accounts.login("anna", "falsch-falsch", undefined, "", "10.0.0.1")));
    const codes = results.map((result) => (result.status === "rejected" ? (result.reason as AccountError).code : "ok"));
    expect(codes.filter((code) => code === "wrong-login")).toHaveLength(5);
    expect(codes.filter((code) => code === "login-throttled")).toHaveLength(15);
  });

  it("does not lock out the owner when someone guesses from another address", async () => {
    await admin("anna", "geheim-anna-1");
    for (let round = 0; round < 12; round++) {
      try {
        await accounts.login("anna", "falsch-falsch", undefined, "", "6.6.6.6");
      } catch {
        now += 15 * 60 * 1000;
      }
      expect((await accounts.login("anna", "geheim-anna-1", undefined, "", "192.168.1.5")).session.user.username).toBe("anna");
    }
  });

  it("slows down distributed guessing of one name across all addresses", async () => {
    await admin("anna", "geheim-anna-1");
    for (let address = 0; address < 50; address++) {
      await rejects(accounts.login("anna", "falsch-falsch", undefined, "", `10.0.${address}.1`), "wrong-login");
    }
    await rejects(accounts.login("anna", "geheim-anna-1", undefined, "", "192.168.1.5"), "login-throttled");
    now += 60 * 60 * 1000;
    expect((await accounts.login("anna", "geheim-anna-1", undefined, "", "192.168.1.5")).session.user.username).toBe("anna");
  });

  it("slows down guessing the current password on a password change", async () => {
    const anna = await admin("anna", "geheim-anna-1");
    for (let attempt = 0; attempt < 5; attempt++) {
      await rejects(accounts.changePassword(anna, "falsch-falsch", "neues-passwort-1", "10.0.0.1"), "wrong-password");
    }
    await rejects(accounts.changePassword(anna, "geheim-anna-1", "neues-passwort-1", "10.0.0.1"), "login-throttled");
  });

  it("forgets old failed attempts on cleanup", async () => {
    await admin("anna", "geheim-anna-1");
    for (let attempt = 0; attempt < 6; attempt++) {
      await accounts.login(`niemand${attempt}`, "falsch-falsch", undefined, "", "10.0.0.1").catch(() => undefined);
    }
    expect(accounts.throttleEntries()).toBeGreaterThan(0);
    now += 2 * 60 * 60 * 1000;
    accounts.sweep();
    expect(accounts.throttleEntries()).toBe(0);
  });

  it("computes at most two password hashes at a time", async () => {
    passwordSlots.resetPeak();
    await Promise.all(Array.from({ length: 6 }, () => hashPassword("geheim-geheim", cheap)));
    expect(passwordSlots.peak).toBe(2);
  });
});

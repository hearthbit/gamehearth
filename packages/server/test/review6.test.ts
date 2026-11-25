import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountError } from "../src/accounts";
import { backupIfDue, listBackups, writeBackup } from "../src/backup";
import { clientIp } from "../src/http";
import { account, createSetup, hostRoom, joinRoom, mauMauDir, type Setup } from "./helpers";

let setup: Setup;

beforeEach(async () => {
  setup = await createSetup();
  await setup.library.install(mauMauDir);
});

afterEach(async () => {
  await setup.cleanup();
});

function linkCode(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return error instanceof AccountError ? error.code : String(error);
  }
  return "valid";
}

describe("Review step 6: links", () => {
  it("invalidates links when their creator is deleted, locked or demoted", () => {
    const anna = account(setup, "Anna", "admin");
    const mallory = account(setup, "Mallory", "admin");
    const bert = account(setup, "Bert", "admin");
    const reset = setup.accounts.createResetLink(anna.user, mallory.user);
    const invite = setup.accounts.createInvite(mallory.user, { role: "admin" }).token;
    const fromBert = setup.accounts.createInvite(bert.user, { role: "player" }).token;
    const keep = setup.accounts.createInvite(anna.user, { role: "player" }).token;
    setup.rooms.removeUser(mallory.user);
    setup.accounts.deleteUser(mallory.user);
    expect(linkCode(() => setup.accounts.inspectLink(reset, ["reset"]))).toBe("unknown-link");
    expect(linkCode(() => setup.accounts.inspectLink(invite, ["invite"]))).toBe("unknown-link");
    setup.accounts.updateUser(bert.user, { role: "player" });
    expect(linkCode(() => setup.accounts.inspectLink(fromBert, ["invite"]))).toBe("unknown-link");
    const lockedAdmin = account(setup, "Lena", "admin");
    const fromLena = setup.accounts.createInvite(lockedAdmin.user, { role: "player" }).token;
    setup.accounts.updateUser(lockedAdmin.user, { locked: true });
    expect(linkCode(() => setup.accounts.inspectLink(fromLena, ["invite"]))).toBe("unknown-link");
    expect(linkCode(() => setup.accounts.inspectLink(keep, ["invite"]))).toBe("valid");
  });

  it("invalidates reset links when the target changes their password or is locked", async () => {
    const { token } = setup.accounts.createInvite(undefined, { role: "admin" });
    const anna = (await setup.accounts.acceptInvite(token, { username: "anna", name: "Anna", password: "geheim-anna-1" }, undefined)).session;
    const reset = setup.accounts.createResetLink(anna.user.id);
    await setup.accounts.changePassword(anna, "geheim-anna-1", "neues-anna-passwort");
    expect(linkCode(() => setup.accounts.inspectLink(reset, ["reset"]))).toBe("unknown-link");
    const ben = account(setup, "Ben");
    const other = account(setup, "Admin", "admin");
    const benReset = setup.accounts.createResetLink(ben.user, other.user);
    setup.accounts.updateUser(ben.user, { locked: true });
    expect(linkCode(() => setup.accounts.inspectLink(benReset, ["reset"]))).toBe("unknown-link");
  });

  it("shows an invite's note only to the admin, not to the invited person", () => {
    const { token, invite } = setup.accounts.createInvite(undefined, { role: "player", note: "die nervige Tante", name: "Tante" });
    expect(invite.note).toBe("die nervige Tante");
    expect(setup.accounts.inspectLink(token, ["invite"])).not.toHaveProperty("note");
    expect(setup.accounts.inspectLink(token, ["invite"])).toMatchObject({ name: "Tante" });
  });
});

describe("Review step 6: deleted seats", () => {
  it("does not count deleted seats in finished rooms as members", async () => {
    const anna = hostRoom(setup, "mau-mau", "Anna");
    const ben = await joinRoom(setup, anna.code, "Ben");
    await joinRoom(setup, anna.code, "Cem");
    await setup.rooms.start(anna.code, anna.user);
    setup.rooms.removeUser(ben.user);
    setup.accounts.deleteUser(ben.user);
    setup.db.prepare("UPDATE rooms SET status = 'finished' WHERE code = ?").run(anna.code);
    expect(setup.rooms.rooms(anna.user)[0]?.members).toBe(2);
    expect((await setup.rooms.view(anna.code, anna.user)).members.map((member) => member.name)).toEqual(["Anna", "", "Cem"]);
  });
});

describe("Review step 6: backups", () => {
  it("does not let manual backups push out the daily ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "gamehearth-review-backup-"));
    try {
      const day = 24 * 60 * 60 * 1000;
      const start = Date.UTC(2026, 10, 17, 9, 0, 0);
      backupIfDue(setup.db, dir, start);
      for (let index = 1; index <= 8; index++) {
        writeBackup(setup.db, dir, "manual", start + index * 60_000);
      }
      backupIfDue(setup.db, dir, start + 2 * 60 * 60 * 1000);
      expect(listBackups(dir).filter((backup) => backup.kind === "daily")).toHaveLength(1);
      expect(backupIfDue(setup.db, dir, start + day)?.kind).toBe("daily");
      expect(listBackups(dir).filter((backup) => backup.kind === "manual")).toHaveLength(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Review step 6: address behind the proxy", () => {
  const request = (forwarded: string | undefined, remote = "127.0.0.1") =>
    ({ headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded }, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;

  it("takes the address the trusted proxy appended and groups IPv6 per /64", () => {
    expect(clientIp(request("6.6.6.6, 203.0.113.9"), true)).toBe("203.0.113.9");
    expect(clientIp(request("203.0.113.9"), true)).toBe("203.0.113.9");
    expect(clientIp(request("6.6.6.6"), false)).toBe("127.0.0.1");
    expect(clientIp(request(undefined, "::ffff:192.168.1.5"), false)).toBe("192.168.1.5");
    expect(clientIp(request("2001:db8:1:2:3:4:5:6"), true)).toBe("2001:db8:1:2::/64");
    expect(clientIp(request("2001:db8:1:2::ffff"), true)).toBe("2001:db8:1:2::/64");
    expect(clientIp(request("2001:db8::1"), true)).toBe("2001:db8:0:0::/64");
    expect(clientIp(request(undefined, "::1"), false)).toBe("0:0:0:0::/64");
  });
});

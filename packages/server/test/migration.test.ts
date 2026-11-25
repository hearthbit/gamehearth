import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db";
import { account, createSetup, mauMauDir, type Setup } from "./helpers";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
let dir: string;
let setup: Setup;

function stepFiveDatabase(build: string): void {
  const db = new DatabaseSync(join(dir, "test.sqlite"));
  migrate(db, 2);
  const room = db.prepare("INSERT INTO rooms (code, game_id, build, status, version, created_at, updated_at, round) VALUES (?, 'mau-mau', ?, ?, 0, 1, 1, 1)");
  room.run("AAAAAA", build, "lobby");
  room.run("BBBBBB", build, "lobby");
  room.run("CCCCCC", build, "lobby");
  const member = db.prepare("INSERT INTO members (room_code, name, token_hash, host, seat, joined_at) VALUES (?, ?, ?, ?, NULL, ?)");
  member.run("AAAAAA", "Anna", hash("anna-a"), 1, 10);
  member.run("AAAAAA", "Ben", hash("ben-a"), 0, 11);
  member.run("BBBBBB", "Ben", hash("ben-b"), 1, 12);
  member.run("CCCCCC", "Cem", hash("cem-c"), 1, 13);
  member.run("CCCCCC", "Benni", hash("ben-c"), 0, 14);
  db.close();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gamehearth-migration-"));
  stepFiveDatabase("platzhalter");
  setup = await createSetup(dir);
  const installed = await setup.library.install(mauMauDir);
  setup.db.prepare("UPDATE rooms SET build = ?").run(installed.build);
});

afterEach(async () => {
  await setup.cleanup();
});

describe("Migration from step 5", () => {
  it("turns every old member into a guest with their name and keeps host and order", async () => {
    const users = setup.db.prepare("SELECT id, kind, username, display_name FROM users ORDER BY id").all();
    expect(users).toEqual([
      { id: 1, kind: "guest", username: null, display_name: "Anna" },
      { id: 2, kind: "guest", username: null, display_name: "Ben" },
      { id: 3, kind: "guest", username: null, display_name: "Ben" },
      { id: 4, kind: "guest", username: null, display_name: "Cem" },
      { id: 5, kind: "guest", username: null, display_name: "Benni" },
    ]);
    const view = await setup.rooms.view("AAAAAA", 1);
    expect(view.members.map((member) => [member.name, member.host, member.guest])).toEqual([
      ["Anna", true, true],
      ["Ben", false, true],
    ]);
    expect(setup.accounts.expiredGuests()).toEqual([]);
    const fresh = setup.accounts.createGuest("Neu");
    expect(fresh.id).toBe(6);
  });

  it("exchanges tokens without a session for the first old guest and attaches the other seats to it", async () => {
    const result = setup.rooms.claim(["unbekannt", "ben-a", "ben-b", "ben-c"], undefined);
    expect(result).toEqual({ userId: 2, codes: ["AAAAAA", "BBBBBB", "CCCCCC"] });
    expect(setup.rooms.rooms(2).map((room) => room.code).sort()).toEqual(["AAAAAA", "BBBBBB", "CCCCCC"]);
    expect(setup.db.prepare("SELECT id FROM users WHERE id IN (3, 5)").all()).toEqual([]);
    expect(setup.rooms.claim(["ben-a", "ben-b"], undefined)).toEqual({ userId: undefined, codes: [] });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM members WHERE legacy_token_hash IS NOT NULL").get()).toEqual({ count: 2 });
  });

  it("attaches exchanged seats to a signed-in account and skips rooms it already sits in", async () => {
    const anna = account(setup, "Anna");
    await setup.rooms.joinRoom("BBBBBB", anna.user);
    const result = setup.rooms.claim(["anna-a", "ben-b"], anna.user);
    expect(result).toEqual({ userId: anna.user, codes: ["AAAAAA"] });
    expect((await setup.rooms.view("AAAAAA", anna.user)).members[0]).toMatchObject({ name: "Anna", host: true, guest: false, you: true });
    expect(setup.db.prepare("SELECT id FROM users WHERE id = 1").all()).toEqual([]);
    expect(setup.db.prepare("SELECT legacy_token_hash IS NOT NULL AS open FROM members WHERE room_code = 'BBBBBB' AND user_id = 3").get()).toEqual({ open: 1 });
  });

  it("expires old guests after 30 days without an exchange", () => {
    const later = new (setup.accounts.constructor as typeof import("../src/accounts").AccountService)(setup.db, {
      clock: () => Date.now() + 31 * 24 * 60 * 60 * 1000,
    });
    expect(later.expiredGuests()).toEqual([1, 2, 3, 4, 5]);
  });
});

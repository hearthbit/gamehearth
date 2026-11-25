import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { account, createSetup, guest, hostRoom, joinRoom, mauMauDir, type Setup } from "./helpers";

let setup: Setup;
let events: string[];

beforeEach(async () => {
  setup = await createSetup();
  await setup.library.install(mauMauDir);
  events = [];
  setup.rooms.on({
    removed: (code, ids) => events.push(`removed ${code} ${ids.join(",")}`),
    closed: (code) => events.push(`closed ${code}`),
  });
});

afterEach(async () => {
  await setup.cleanup();
});

function remove(userId: number): void {
  setup.rooms.removeUser(userId);
  setup.accounts.deleteUser(userId);
}

describe("Deleting users", () => {
  it("acts like leaving in the lobby and never passes the host role to a deleted member", async () => {
    const anna = hostRoom(setup, "mau-mau", "Anna");
    const ben = await joinRoom(setup, anna.code, "Ben");
    const cem = await joinRoom(setup, anna.code, "Cem");
    remove(ben.user);
    setup.rooms.leave(anna.code, anna.user);
    const view = await setup.rooms.view(anna.code, cem.user);
    expect(view.members.map((member) => [member.name, member.host, member.deleted])).toEqual([["Cem", true, false]]);
    expect(view.you.host).toBe(true);
  });

  it("also skips members whose user vanished without cleanup", async () => {
    const anna = hostRoom(setup, "mau-mau", "Anna");
    const ben = await joinRoom(setup, anna.code, "Ben");
    const cem = await joinRoom(setup, anna.code, "Cem");
    setup.accounts.deleteUser(ben.user);
    setup.rooms.leave(anna.code, anna.user);
    const view = await setup.rooms.view(anna.code, cem.user);
    expect(view.you.host).toBe(true);
    expect(view.canStart).toBe(false);
    setup.rooms.leave(anna.code, cem.user);
    expect(events.at(-1)).toBe(`closed ${anna.code}`);
  });

  it("passes on the host role when the host is deleted, and closes empty rooms", async () => {
    const anna = hostRoom(setup, "mau-mau", "Anna");
    const ben = await joinRoom(setup, anna.code, "Ben");
    const alone = hostRoom(setup, "mau-mau", "Dora");
    remove(anna.user);
    expect((await setup.rooms.view(anna.code, ben.user)).you.host).toBe(true);
    remove(alone.user);
    expect(() => setup.rooms.member(alone.code, alone.user)).toThrow(/There is no room/);
    expect(events).toContain(`closed ${alone.code}`);
  });

  it("keeps the seat as deleted in running matches until the round ends", async () => {
    const anna = hostRoom(setup, "mau-mau", "Anna");
    const ben = await joinRoom(setup, anna.code, "Ben");
    const cem = await joinRoom(setup, anna.code, "Cem");
    await setup.rooms.start(anna.code, anna.user);
    remove(anna.user);
    let view = await setup.rooms.view(anna.code, ben.user);
    expect(view.status).toBe("running");
    expect(view.members.map((member) => [member.name, member.seat, member.host, member.deleted])).toEqual([
      ["", "p1", false, true],
      ["Ben", "p2", true, false],
      ["Cem", "p3", false, false],
    ]);
    setup.rooms.abort(anna.code, ben.user);
    view = await setup.rooms.view(anna.code, ben.user);
    expect(view.members.map((member) => member.name)).toEqual(["Ben", "Cem"]);
    expect(view.canStart).toBe(true);
    expect(cem.user).toBeGreaterThan(0);
  });

  it("closes a running match with nobody left", async () => {
    const anna = hostRoom(setup, "mau-mau", "Anna");
    const ben = await joinRoom(setup, anna.code, "Ben");
    await setup.rooms.start(anna.code, anna.user);
    remove(ben.user);
    remove(anna.user);
    expect(events.at(-1)).toBe(`closed ${anna.code}`);
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM rooms").get()).toEqual({ count: 0 });
  });

  it("cleans up finished rooms like leaving", async () => {
    const anna = hostRoom(setup, "mau-mau", "Anna");
    const ben = await joinRoom(setup, anna.code, "Ben");
    setup.db.prepare("UPDATE rooms SET status = 'finished' WHERE code = ?").run(anna.code);
    remove(anna.user);
    const view = await setup.rooms.view(anna.code, ben.user);
    expect(view.members.map((member) => [member.name, member.host])).toEqual([["Ben", true]]);
    expect(events.some((event) => event.startsWith(`removed ${anna.code} `))).toBe(true);
  });

  it("counts memberships and lists all rooms for admins", async () => {
    const anna = hostRoom(setup, "mau-mau", "Anna");
    const ben = guest(setup, "Ben");
    await setup.rooms.joinRoom(anna.code, ben.user);
    const other = account(setup, "Cem");
    expect(setup.rooms.membershipCounts().get(ben.user)).toBe(1);
    expect(setup.rooms.membershipCounts().get(other.user)).toBeUndefined();
    expect(setup.rooms.allRooms()).toEqual([
      {
        code: anna.code,
        game: "Mau-Mau",
        status: "lobby",
        round: 1,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
        members: [
          { name: "Anna", host: true, guest: false, deleted: false },
          { name: "Ben", host: false, guest: true, deleted: false },
        ],
      },
    ]);
    setup.rooms.close(anna.code.toLowerCase());
    expect(setup.rooms.allRooms()).toEqual([]);
    expect(() => setup.rooms.close(anna.code)).toThrow(/There is no room/);
  });
});

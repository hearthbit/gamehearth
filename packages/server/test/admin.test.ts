import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackupInfo } from "../src/backup";
import { startServer, type RunningServer } from "../src/transport";
import { Client, getJson, postJson } from "./client";
import { account, createSetup, guest, mauMauDir, type Setup } from "./helpers";

let setup: Setup;
let running: RunningServer;
let base: string;
let backups: BackupInfo[];

beforeEach(async () => {
  setup = await createSetup();
  await setup.library.install(mauMauDir);
  backups = [];
  running = await startServer({
    rooms: setup.rooms,
    accounts: setup.accounts,
    library: setup.library,
    port: 0,
    host: "127.0.0.1",
    log: (message) => setup.logs.push(message),
    quarantine: () => [{ build: "kaputt/1.0.0+abc", since: 5, reason: "3 hard and 0 soft aborts in 10 minutes", hardAborts: 3, softAborts: 0, windowMinutes: 10 }],
    backups: {
      list: () => backups,
      create: () => {
        const backup: BackupInfo = { file: `gamehearth-${backups.length}-manual.sqlite`, kind: "manual", createdAt: 1, bytes: 10 };
        backups.unshift(backup);
        return backup;
      },
    },
  });
  base = `http://127.0.0.1:${running.port}`;
});

afterEach(async () => {
  await running.close();
  await setup.cleanup();
});

describe("Admin area", () => {
  it("is only for admins", async () => {
    expect((await getJson(base, "/api/admin/users")).status).toBe(401);
    expect(await getJson(base, "/api/admin/users", account(setup, "Ben").token)).toMatchObject({ status: 403, body: { code: "not-admin" } });
    expect((await getJson(base, "/api/admin/users", guest(setup, "Gast").token)).status).toBe(403);
    expect((await postJson(base, "/api/admin/invites", { role: "admin" }, account(setup, "Cem").token)).status).toBe(403);
    expect((await getJson(base, "/api/admin/nichts", account(setup, "Admin", "admin").token)).status).toBe(404);
  });

  it("manages users: role, lock, username, reset and the last admin", async () => {
    const admin = account(setup, "Anna", "admin");
    const ben = account(setup, "Ben");
    const { code } = setup.rooms.createRoom("mau-mau", ben.user);
    guest(setup, "Gast");
    const users = (await getJson(base, "/api/admin/users", admin.token)).body["users"] as { id: number; name: string; rooms: number; role: string }[];
    expect(users.map((user) => [user.name, user.role, user.rooms])).toEqual([
      ["Anna", "admin", 0],
      ["Ben", "player", 1],
    ]);
    expect((await postJson(base, `/api/admin/users/${admin.user}`, { role: "player" }, admin.token)).body).toMatchObject({ code: "last-admin" });
    expect((await postJson(base, `/api/admin/users/${ben.user}`, { role: "chef" }, admin.token)).status).toBe(400);
    expect((await postJson(base, `/api/admin/users/${ben.user}`, { username: "benni" }, admin.token)).body).toMatchObject({ user: { username: "benni" } });

    const client = await Client.connect(running.port, { token: ben.token });
    client.send({ type: "hello", room: code });
    await client.room();
    expect((await postJson(base, `/api/admin/users/${ben.user}`, { locked: true }, admin.token)).body).toMatchObject({ user: { locked: true } });
    expect(await client.error()).toMatchObject({ code: "signed-out" });
    expect((await getJson(base, "/api/me", ben.token)).body).toEqual({});
    expect(setup.rooms.member(code, ben.user).host).toBe(true);

    const reset = await postJson(base, `/api/admin/users/${ben.user}/reset`, {}, admin.token);
    expect(setup.accounts.inspectLink(String(reset.body["token"]), ["reset"])).toMatchObject({ username: "benni" });
    expect((await postJson(base, "/api/admin/users/999/reset", {}, admin.token)).status).toBe(404);
    expect((await postJson(base, "/api/admin/users/abc/reset", {}, admin.token)).status).toBe(404);
  });

  it("deletes users with their seats, but never the last admin", async () => {
    const admin = account(setup, "Anna", "admin");
    const ben = account(setup, "Ben");
    const { code } = setup.rooms.createRoom("mau-mau", admin.user);
    await setup.rooms.joinRoom(code, ben.user);
    const client = await Client.connect(running.port, { token: ben.token });
    client.send({ type: "hello", room: code });
    await client.room();
    expect((await postJson(base, `/api/admin/users/${admin.user}/delete`, {}, admin.token)).body).toMatchObject({ code: "last-admin" });
    expect((await postJson(base, `/api/admin/users/${ben.user}/delete`, {}, admin.token)).status).toBe(200);
    expect((await client.error()).code).toMatch(/removed|signed-out/);
    expect((await setup.rooms.view(code, admin.user)).members.map((member) => member.name)).toEqual(["Anna"]);
    expect(() => setup.accounts.user(ben.user)).toThrow();
  });

  it("creates, lists and revokes invites", async () => {
    const admin = account(setup, "Anna", "admin");
    const created = await postJson(base, "/api/admin/invites", { role: "admin", note: "für Oma", username: "oma", name: "Oma" }, admin.token);
    expect(created).toMatchObject({ status: 201, body: { token: expect.any(String), invite: { role: "admin", note: "für Oma", username: "oma", name: "Oma" } } });
    expect((await postJson(base, "/api/admin/invites", { role: "chef" }, admin.token)).status).toBe(400);
    expect((await postJson(base, "/api/admin/invites", { role: "player", username: "a b" }, admin.token)).body).toMatchObject({ code: "bad-username" });
    const listed = (await getJson(base, "/api/admin/invites", admin.token)).body["invites"] as { id: number }[];
    expect(listed).toHaveLength(1);
    expect((await postJson(base, `/api/admin/invites/${listed[0]?.id}/revoke`, {}, admin.token)).status).toBe(200);
    expect((await postJson(base, `/api/admin/invites/${listed[0]?.id}/revoke`, {}, admin.token)).status).toBe(404);
    expect((await getJson(base, "/api/admin/invites", admin.token)).body).toEqual({ invites: [] });
  });

  it("shows all rooms and closes one on request", async () => {
    const admin = account(setup, "Anna", "admin");
    const ben = account(setup, "Ben");
    const { code } = setup.rooms.createRoom("mau-mau", ben.user);
    const client = await Client.connect(running.port, { token: ben.token });
    client.send({ type: "hello", room: code });
    await client.room();
    expect((await getJson(base, "/api/admin/rooms", admin.token)).body).toEqual({
      rooms: [{ code, game: "Mau-Mau", status: "lobby", round: 1, createdAt: expect.any(Number), updatedAt: expect.any(Number), members: [{ name: "Ben", host: true, guest: false, deleted: false }] }],
    });
    expect((await postJson(base, `/api/admin/rooms/${code}/close`, {}, admin.token)).status).toBe(200);
    expect(await client.error()).toMatchObject({ code: "room-closed" });
    expect((await postJson(base, `/api/admin/rooms/${code}/close`, {}, admin.token)).status).toBe(404);
  });

  it("shows quarantined builds and backups and backs up on request", async () => {
    const admin = account(setup, "Anna", "admin");
    expect((await getJson(base, "/api/admin/builds", admin.token)).body).toEqual({
      quarantined: [{ build: "kaputt/1.0.0+abc", since: 5, reason: "3 hard and 0 soft aborts in 10 minutes", hardAborts: 3, softAborts: 0, windowMinutes: 10 }],
    });
    expect((await getJson(base, "/api/admin/backups", admin.token)).body).toEqual({ backups: [], enabled: true });
    expect((await postJson(base, "/api/admin/backups", {}, admin.token)).status).toBe(201);
    expect(((await getJson(base, "/api/admin/backups", admin.token)).body["backups"] as unknown[]).length).toBe(1);
  });
});

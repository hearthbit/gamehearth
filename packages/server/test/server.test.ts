import { SeededRandom, randomStateFromSeed } from "@gamehearth/sdk/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/transport";
import { Client, getJson, postJson } from "./client";
import { account, createSetup, guest, mauMauDir, type Setup } from "./helpers";

let setup: Setup;
let running: RunningServer;
let base: string;

beforeEach(async () => {
  setup = await createSetup();
  await setup.library.install(mauMauDir);
  running = await startServer({
    rooms: setup.rooms,
    accounts: setup.accounts,
    library: setup.library,
    port: 0,
    host: "127.0.0.1",
    log: (message) => setup.logs.push(message),
  });
  base = `http://127.0.0.1:${running.port}`;
});

afterEach(async () => {
  await running.close();
  await setup.cleanup();
});

const post = (path: string, body: unknown, token?: string) => postJson(base, path, body, token);
const connect = (token?: string) => Client.connect(running.port, token === undefined ? {} : { token });
const users = () => (setup.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;

async function hostedRoom(name: string): Promise<{ code: string; token: string }> {
  const host = account(setup, name);
  const created = await post("/api/rooms", { game: "mau-mau" }, host.token);
  expect(created.status).toBe(201);
  return { code: String(created.body["code"]), token: host.token };
}

async function joinedGuest(code: string, name: string): Promise<{ code: string; token: string }> {
  const joined = await post(`/api/rooms/${code}/join`, { name });
  expect(joined.status).toBe(201);
  expect(joined.cookie).toEqual(expect.any(String));
  return { code: String(joined.body["code"]), token: joined.cookie as string };
}

describe("HTTP", () => {
  it("reports health and lists installed games", async () => {
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });
    expect(await (await fetch(`${base}/api/games`)).json()).toEqual([
      { id: "mau-mau", name: "Mau-Mau", version: "0.1.0", mode: "turn-based", players: { min: 2, max: 6 }, roles: { player: { inputs: ["touch", "mouse"], screen: "small" } } },
    ]);
  });

  it("creates rooms with an account, lets guests join by cookie and reports errors with a matching status", async () => {
    const anna = account(setup, "Anna");
    const created = await post("/api/rooms", { game: "mau-mau" }, anna.token);
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ code: expect.stringMatching(/^[A-Z2-9]{6}$/) });
    expect(created.cookie).toBeUndefined();
    const code = String(created.body["code"]);

    const joined = await post(`/api/rooms/${code.toLowerCase()}/join`, { name: "  Ben  " });
    expect(joined).toMatchObject({ status: 201, body: { code }, cookie: expect.any(String) });
    expect((await getJson(base, "/api/me", joined.cookie)).body).toMatchObject({ user: { kind: "guest", name: "Ben" } });
    expect(await post(`/api/rooms/${code}/join`, {}, joined.cookie)).toMatchObject({ status: 201, body: { code }, cookie: undefined });
    expect(await post(`/api/rooms/${code}/join`, {}, anna.token)).toMatchObject({ status: 201, body: { code }, cookie: undefined });
    expect((await setup.rooms.view(code, anna.user)).members.map((member) => member.name)).toEqual(["Anna", "Ben"]);

    expect(await post("/api/rooms", { game: "mau-mau" })).toMatchObject({ status: 401, body: { code: "not-signed-in" } });
    expect(await post("/api/rooms", { game: "mau-mau" }, joined.cookie)).toMatchObject({ status: 403, body: { code: "account-required" } });
    expect(await post("/api/rooms", { game: "schach" }, anna.token)).toMatchObject({ status: 404, body: { code: "unknown-game" } });
    const before = users();
    expect(await post("/api/rooms/ZZZZZZ/join", { name: "Cem" })).toMatchObject({ status: 404, body: { code: "unknown-room" }, cookie: undefined });
    expect(users()).toBe(before);

    const broken = await fetch(`${base}/api/rooms`, {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json", cookie: `gh-session=${anna.token}` },
    });
    expect(broken.status).toBe(400);
    const plain = await fetch(`${base}/api/rooms`, { method: "POST", body: JSON.stringify({ game: "mau-mau" }), headers: { cookie: `gh-session=${anna.token}` } });
    expect(plain.status).toBe(400);
    expect(await plain.json()).toMatchObject({ code: "bad-message" });
    expect((await fetch(`${base}/api/nichts`)).status).toBe(404);
    expect(await post("/api/rooms", { game: "x".repeat(10_000) }, anna.token)).toMatchObject({ status: 400, body: { code: "bad-message" } });
  });

  it("checks the name of a new guest on joining and creates none on errors", async () => {
    const { code } = await hostedRoom("Anna");
    const before = users();
    for (const name of ["", "   ", "x".repeat(25), "Anna\u0000"]) {
      expect(await post(`/api/rooms/${code}/join`, { name })).toMatchObject({ status: 400, body: { code: "bad-name" }, cookie: undefined });
    }
    expect(await post(`/api/rooms/${code}/join`, {})).toMatchObject({ status: 400, body: { code: "bad-name" }, cookie: undefined });
    expect(users()).toBe(before);
    const longest = await joinedGuest(code, "x".repeat(24));
    expect((await getJson(base, "/api/me", longest.token)).body).toMatchObject({ user: { name: "x".repeat(24) } });
  });

  it("rejects requests and connections from other sites", async () => {
    const anna = account(setup, "Anna");
    const foreign = await postJson(base, "/api/rooms", { game: "mau-mau" }, anna.token, { origin: "http://evil.example" });
    expect(foreign).toMatchObject({ status: 403, body: { code: "forbidden" } });
    await expect(Client.connect(running.port, { token: anna.token, origin: "http://evil.example" })).rejects.toThrow(/403/);
    const sameHost = await Client.connect(running.port, { token: anna.token, origin: `http://127.0.0.1:${running.port}` });
    const withoutOrigin = await connect(anna.token);
    const { code } = await hostedRoom("Ben");
    for (const client of [sameHost, withoutOrigin]) {
      client.send({ type: "hello", room: code });
      expect(await client.error()).toMatchObject({ code: "not-member" });
      client.close();
    }
  });
});

describe("WebSocket", () => {
  it("requires sign-in and hello before anything else works", async () => {
    const anonymous = await connect();
    expect(await anonymous.error()).toMatchObject({ code: "not-signed-in" });
    expect((await anonymous.closed).code).toBe(4000);

    const forged = await connect("gibt-es-nicht");
    expect(await forged.error()).toMatchObject({ code: "not-signed-in" });
    expect((await forged.closed).code).toBe(4000);

    const { code } = await hostedRoom("Anna");
    const stranger = await connect(guest(setup, "Mallory").token);
    stranger.send({ type: "start" });
    expect(await stranger.error()).toMatchObject({ code: "not-joined" });
    stranger.send({ type: "hallo" });
    expect(await stranger.error()).toMatchObject({ code: "bad-message" });
    stranger.socket.send("not json");
    expect(await stranger.error()).toMatchObject({ code: "bad-message" });
    stranger.send({ type: "hello", room: "ZZZZZZ" });
    expect(await stranger.error()).toMatchObject({ code: "unknown-room" });
    stranger.send({ type: "hello", room: code });
    expect(await stranger.error()).toMatchObject({ code: "not-member" });
    stranger.send({ type: "start" });
    expect(await stranger.error()).toMatchObject({ code: "not-joined" });
    stranger.close();
  });

  it("shows the lobby with connection status and starts at the host's request", async () => {
    const anna = await hostedRoom("Anna");
    const annaClient = await connect(anna.token);
    annaClient.send({ type: "hello", room: anna.code.toLowerCase() });
    expect(await annaClient.room()).toMatchObject({ status: "lobby", canStart: false, members: [{ name: "Anna", connected: true }] });

    const ben = await joinedGuest(anna.code, "Ben");
    const lobby = await annaClient.room((room) => room.members.length === 2);
    expect(lobby.members.map((member) => [member.name, member.connected, member.guest])).toEqual([
      ["Anna", true, false],
      ["Ben", false, true],
    ]);
    expect(lobby.canStart).toBe(true);

    const benClient = await connect(ben.token);
    benClient.send({ type: "hello", room: anna.code });
    await annaClient.room((room) => room.members[1]?.connected === true);
    benClient.send({ type: "start" });
    expect(await benClient.error()).toMatchObject({ code: "not-host" });
    annaClient.send({ type: "start" });
    const started = await benClient.room((room) => room.status === "running");
    expect(started.snapshot?.player).toBe("p2");
    annaClient.close();
    benClient.close();
  });

  it("plays a whole match over WebSocket without revealing other players' cards, and survives reconnecting", async () => {
    const anna = await hostedRoom("Anna");
    const ben = await joinedGuest(anna.code, "Ben");
    const tokens = [anna.token, ben.token];
    let clients = await Promise.all(tokens.map((token) => connect(token)));
    clients.forEach((client) => client.send({ type: "hello", room: anna.code }));
    await Promise.all(clients.map((client) => client.room()));
    clients[0]!.send({ type: "start" });
    let views = await Promise.all(clients.map((client) => client.room((room) => room.status === "running")));

    const bot = new SeededRandom(randomStateFromSeed("websocket-partie"));
    for (let step = 0; step < 2000 && views[0]!.status === "running"; step++) {
      for (const [index, view] of views.entries()) {
        const otherHand = (views[1 - index]!.snapshot?.me as { hand: string[] }).hand;
        for (const card of otherHand) {
          expect(JSON.stringify(view)).not.toContain(`"${card}"`);
        }
      }
      if (step === 10) {
        clients[1]!.close();
        clients[1] = await connect(ben.token);
        clients[1].send({ type: "hello", room: anna.code });
        views[1] = await clients[1].room();
      }
      const index = views.findIndex((view) => (view.snapshot?.moves.length ?? 0) > 0);
      const view = views[index]!;
      const version = view.snapshot?.version ?? 0;
      clients[index]!.send({ type: "move", action: bot.pick(view.snapshot?.moves ?? []), expectedVersion: version });
      views = await Promise.all(clients.map((client) => client.room((room) => (room.snapshot?.version ?? 0) > version)));
    }
    expect(views[0]!.status).toBe("finished");
    expect(views[0]!.snapshot?.result?.winners).toEqual(views[1]!.snapshot?.result?.winners);
    clients.forEach((client) => client.close());
  });

  it("reports invalid and stale moves only to the sender", async () => {
    const anna = await hostedRoom("Anna");
    const ben = await joinedGuest(anna.code, "Ben");
    const annaClient = await connect(anna.token);
    const benClient = await connect(ben.token);
    annaClient.send({ type: "hello", room: anna.code });
    benClient.send({ type: "hello", room: anna.code });
    await annaClient.room((room) => room.members.length === 2 && room.members.every((member) => member.connected));
    annaClient.send({ type: "start" });
    const view = await annaClient.room((room) => room.status === "running");
    await benClient.room((room) => room.status === "running");
    annaClient.send({ type: "move", action: { type: "play", card: "gibt-es-nicht" } });
    expect(await annaClient.error()).toMatchObject({ code: "illegal-move" });
    annaClient.send({ type: "move", action: view.snapshot?.moves[0], expectedVersion: 7 });
    expect(await annaClient.error()).toMatchObject({ code: "stale" });
    benClient.send({ type: "move", action: { type: "draw" } });
    expect(await benClient.error()).toMatchObject({ code: "not-your-turn" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(benClient.received.filter((message) => message.type === "error")).toEqual([]);
    expect(annaClient.received.filter((message) => message.type === "error")).toEqual([]);
    annaClient.close();
    benClient.close();
  });
});

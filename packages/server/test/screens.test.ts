import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol";
import type { ScreenView } from "../src/rooms";
import { startServer, type RunningServer } from "../src/transport";
import { Client, postJson } from "./client";
import { ScreenPairing } from "../src/screens";
import { account, createSetup, mauMauDir, wettlaufDir, type Setup } from "./helpers";

let setup: Setup;
let running: RunningServer;
let base: string;

beforeEach(async () => {
  setup = await createSetup(undefined, {}, { clock: Date.now, realtime: { graceMs: 150, countdownMs: 150 } });
  await setup.library.install(wettlaufDir);
  await setup.library.install(mauMauDir);
  running = await startServer({
    rooms: setup.rooms,
    accounts: setup.accounts,
    library: setup.library,
    port: 0,
    host: "127.0.0.1",
    limits: { realtimeHeartbeatMs: 200 },
    log: (message) => setup.logs.push(message),
  });
  base = `http://127.0.0.1:${running.port}`;
});

afterEach(async () => {
  await running.close();
  await setup.cleanup();
});

function tvCookie(response: Response): string | undefined {
  return /(?:^|\s)gh-tv=([^;]*)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
}

async function newTv(): Promise<{ token: string; client: Client }> {
  const response = await fetch(`${base}/api/tv`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(response.status).toBe(200);
  const token = tvCookie(response) as string;
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const client = await Client.connect(running.port, { headers: { cookie: `gh-tv=${token}` } });
  return { token, client };
}

async function pairingCode(client: Client): Promise<string> {
  client.send({ type: "screen" });
  const message = (await client.next((candidate) => candidate.type === "pairing")) as { code: string; expiresAt: number };
  expect(message.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  return message.code;
}

async function screenRoom(client: Client, match: (room: ScreenView) => boolean = () => true): Promise<ScreenView> {
  const message = await client.next((candidate) => candidate.type === "screen-room" && match(candidate.room));
  return (message as { type: "screen-room"; room: ScreenView }).room;
}

async function party(): Promise<{ code: string; host: { token: string; client: Client }; guest: { token: string; client: Client } }> {
  const anna = account(setup, "Anna");
  const created = await postJson(base, "/api/rooms", { game: "wettlauf" }, anna.token);
  const code = String(created.body["code"]);
  const joined = await postJson(base, `/api/rooms/${code}/join`, { name: "Ben" });
  const host = await Client.connect(running.port, { token: anna.token });
  const guest = await Client.connect(running.port, { token: joined.cookie as string });
  host.send({ type: "hello", room: code });
  guest.send({ type: "hello", room: code });
  await host.room();
  await guest.room();
  return { code, host: { token: anna.token, client: host }, guest: { token: joined.cookie as string, client: guest } };
}

describe("Pairing TVs", () => {
  it("gives a new device a cookie and a code and pairs it with the room by code", async () => {
    const { code, host } = await party();
    const tv = await newTv();
    const again = await fetch(`${base}/api/tv`, { method: "POST", headers: { "content-type": "application/json", cookie: `gh-tv=${tv.token}` }, body: "{}" });
    expect(tvCookie(again)).toBeUndefined();
    const pairing = await pairingCode(tv.client);
    const paired = await postJson(base, `/api/rooms/${code}/screens`, { code: pairing.toLowerCase() }, host.token);
    expect(paired.status).toBe(201);
    const view = await screenRoom(tv.client);
    expect(view).toMatchObject({ code, status: "lobby", game: { id: "wettlauf", roles: ["screen", "controller"] } });
    expect(view.members.map((member) => member.name)).toEqual(["Anna", "Ben"]);
    const hostView = await host.client.room((room) => room.screens.length === 1 && room.screens[0]?.connected === true);
    expect(hostView.canStart).toBe(true);
    const reused = await postJson(base, `/api/rooms/${code}/screens`, { code: pairing }, host.token);
    expect(reused.status).toBe(404);
  });

  it("rejects wrong codes and pairs only in games with a TV", async () => {
    const { code, host } = await party();
    expect((await postJson(base, `/api/rooms/${code}/screens`, { code: "AAAA-AAAA" }, host.token)).body).toMatchObject({ code: "unknown-code" });
    const tv = await newTv();
    const pairing = await pairingCode(tv.client);
    const cleo = account(setup, "Cleo");
    const mau = await postJson(base, "/api/rooms", { game: "mau-mau" }, cleo.token);
    expect((await postJson(base, `/api/rooms/${String(mau.body["code"])}/screens`, { code: pairing }, cleo.token)).body).toMatchObject({ code: "no-screen-role" });
    expect((await postJson(base, `/api/rooms/${code}/screens`, { code: pairing })).status).toBe(401);
  });

  it("pairs the own device directly as a TV", async () => {
    const { code, host } = await party();
    const response = await fetch(`${base}/api/rooms/${code}/screens/self`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `gh-session=${host.token}` },
      body: "{}",
    });
    expect(response.status).toBe(201);
    const token = tvCookie(response) as string;
    const tv = await Client.connect(running.port, { headers: { cookie: `gh-tv=${token}` } });
    tv.send({ type: "screen" });
    expect((await screenRoom(tv)).code).toBe(code);
  });

  it("lets a connection with only a TV cookie join no room", async () => {
    const { code } = await party();
    const tv = await newTv();
    tv.client.send({ type: "hello", room: code });
    expect((await tv.client.error()).code).toBe("not-signed-in");
    const bare = await Client.connect(running.port);
    expect((await bare.error()).code).toBe("not-signed-in");
  });

  it("sends the TV back to pairing when the host removes it", async () => {
    const { code, host } = await party();
    const tv = await newTv();
    await postJson(base, `/api/rooms/${code}/screens`, { code: await pairingCode(tv.client) }, host.token);
    const view = await screenRoom(tv.client);
    host.client.send({ type: "remove-screen", screen: view.screen, id: 1 });
    await host.client.next((message) => message.type === "ack" && message.id === 1);
    await tv.client.next((message) => message.type === "pairing");
    await host.client.room((room) => room.screens.length === 0);
  });
});

describe("Review: TV access", () => {
  it("Review 1: counts unknown rooms when pairing as a failed attempt, so room codes cannot be guessed", async () => {
    const tv = await newTv();
    const pairing = await pairingCode(tv.client);
    const mallory = account(setup, "Mallory");
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push((await postJson(base, `/api/rooms/ZZZZ${String(i).padStart(2, "2").replace(/[01]/g, "3")}/screens`, { code: pairing }, mallory.token)).status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 404)).toBe(true);
    expect(statuses[30]).toBe(429);
    const self = await fetch(`${base}/api/rooms/ZZZZZZ/screens/self`, { method: "POST", headers: { "content-type": "application/json", cookie: `gh-session=${mallory.token}` }, body: "{}" });
    expect(self.status).toBe(429);
  });

  it("Review 2: lets at most 4 unpaired TVs wait per address", async () => {
    const waiting: Client[] = [];
    for (let i = 0; i < 4; i++) {
      const tv = await Client.connect(running.port, { headers: { cookie: `gh-tv=zufall${i}` } });
      await pairingCode(tv);
      waiting.push(tv);
    }
    const fifth = await Client.connect(running.port, { headers: { cookie: "gh-tv=zufall5" } });
    fifth.send({ type: "screen" });
    expect((await fifth.error()).code).toBe("too-many-connections");
    expect((await fifth.closed).code).toBe(4000);
    waiting[0]?.close();
    await waiting[0]?.closed;
    const later = await Client.connect(running.port, { headers: { cookie: "gh-tv=zufall6" } });
    await pairingCode(later);
  });

  it("Review 4: does not disconnect a TV when the session on the same device ends", async () => {
    const { code, host } = await party();
    const response = await fetch(`${base}/api/rooms/${code}/screens/self`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `gh-session=${host.token}` },
      body: "{}",
    });
    const token = /gh-tv=([^;]*)/.exec(response.headers.get("set-cookie") ?? "")?.[1] as string;
    const tv = await Client.connect(running.port, { headers: { cookie: `gh-tv=${token}; gh-session=${host.token}` } });
    tv.send({ type: "screen" });
    await screenRoom(tv);
    expect((await postJson(base, "/api/logout", {}, host.token)).status).toBe(200);
    await host.client.closed;
    const guestJoin = await postJson(base, `/api/rooms/${code}/join`, { name: "Cleo" });
    expect(guestJoin.status).toBe(201);
    expect((await screenRoom(tv, (room) => room.members.some((member) => member.name === "Cleo"))).code).toBe(code);
  });

  it("Review 5: does not push out valid codes when the list is full, but gives new devices none", () => {
    let now = 0;
    const pairing = new ScreenPairing({ maxPending: 2, clock: () => now });
    const first = pairing.code("gerät-a");
    expect(pairing.code("gerät-b")).toBeDefined();
    expect(pairing.code("gerät-c")).toBeUndefined();
    expect(pairing.peek(first?.code)).toBe("gerät-a");
    now += 11 * 60 * 1000;
    expect(pairing.code("gerät-c")).toBeDefined();
  });

  it("Review 6: names the remaining time of the code, so a wrong clock on the TV does not matter", async () => {
    const tv = await newTv();
    tv.client.send({ type: "screen" });
    const message = (await tv.client.next((candidate) => candidate.type === "pairing")) as { expiresAt: number; expiresInMs: number };
    expect(message.expiresInMs).toBe(10 * 60 * 1000);
  });
});

describe("Realtime over the WebSocket", () => {
  it("sends TVs and phones their snapshot every tick and accepts inputs", async () => {
    const { code, host, guest } = await party();
    const tv = await newTv();
    await postJson(base, `/api/rooms/${code}/screens`, { code: await pairingCode(tv.client) }, host.token);
    await screenRoom(tv.client);
    await host.client.room((room) => room.canStart);
    host.client.send({ type: "start", id: 1 });
    await host.client.next((message) => message.type === "ack" && message.id === 1);
    expect((await screenRoom(tv.client, (room) => room.status === "running")).live?.state).toBe("countdown");
    const screenFrame = (await tv.client.next((message) => message.type === "frame")) as Extract<ServerMessage, { snapshot: unknown }>;
    expect(Object.keys(screenFrame.snapshot).sort()).toEqual(["players", "public", "tick", "version"]);
    guest.client.send({ type: "move", action: { type: "run" }, id: 2 });
    await guest.client.next((message) => message.type === "ack" && message.id === 2);
    const moving = (await guest.client.next(
      (message) => message.type === "frame" && "snapshot" in message && ((message.snapshot as { public: { pos: Record<string, number> } }).public.pos["p2"] ?? 0) >= 3,
    )) as Extract<ServerMessage, { snapshot: unknown }>;
    expect(moving.snapshot).toMatchObject({ player: "p2", moves: [{ type: "stop" }], me: { presses: 1 } });
  });

  it("pauses when a phone becomes invisible and continues after the countdown", async () => {
    const { code, host, guest } = await party();
    const tv = await newTv();
    await postJson(base, `/api/rooms/${code}/screens`, { code: await pairingCode(tv.client) }, host.token);
    await host.client.room((room) => room.canStart);
    host.client.send({ type: "start" });
    await host.client.room((room) => room.live?.state === "running");
    guest.client.send({ type: "visibility", visible: false });
    const paused = await host.client.room((room) => room.live?.state === "paused");
    expect(paused.live).toMatchObject({ missingSeats: ["p2"], screenMissing: false });
    guest.client.send({ type: "move", action: { type: "run" }, id: 3 });
    expect(await guest.client.next((message) => "id" in message && message.id === 3)).toEqual({ type: "ack", id: 3 });
    guest.client.send({ type: "visibility", visible: true });
    await host.client.room((room) => room.live?.state === "countdown");
    await host.client.room((room) => room.live?.state === "running");
    tv.client.close();
    expect((await host.client.room((room) => room.live?.state === "paused")).live).toMatchObject({ screenMissing: true });
  });

  it("notices quickly in realtime rooms when a phone stops answering, and pauses", async () => {
    const { code, host, guest } = await party();
    const tv = await newTv();
    await postJson(base, `/api/rooms/${code}/screens`, { code: await pairingCode(tv.client) }, host.token);
    await host.client.room((room) => room.canStart);
    host.client.send({ type: "start" });
    await host.client.room((room) => room.live?.state === "running");
    const silent = await Client.connect(running.port, { token: guest.token, autoPong: false });
    silent.send({ type: "hello", room: code });
    await silent.room();
    guest.client.close();
    await silent.closed;
    expect((await host.client.room((room) => room.live?.state === "paused")).live?.missingSeats).toEqual(["p2"]);
  });

  it("lets the host pause and resume, but nobody else", async () => {
    const { code, host, guest } = await party();
    const tv = await newTv();
    await postJson(base, `/api/rooms/${code}/screens`, { code: await pairingCode(tv.client) }, host.token);
    await host.client.room((room) => room.canStart);
    host.client.send({ type: "start" });
    await host.client.room((room) => room.live?.state === "running");
    guest.client.send({ type: "pause", id: 4 });
    expect(await guest.client.next((message) => message.type === "error" && message.id === 4)).toMatchObject({ code: "not-host" });
    host.client.send({ type: "pause" });
    expect((await host.client.room((room) => room.live?.state === "paused")).live?.byHost).toBe(true);
    host.client.send({ type: "resume" });
    await host.client.room((room) => room.live?.state === "running");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PushService } from "../src/push/service";
import { startServer, type RunningServer } from "../src/transport";
import { Client, getJson, postJson, settle } from "./client";
import { startFakePushService, type FakePushService, type TestSubscription } from "./fake-push";
import { account, createSetup, guest, zaehlenV1, type Setup } from "./helpers";

let setup: Setup;
let fake: FakePushService;
let push: PushService;
let running: RunningServer;
let base: string;
const clients: Client[] = [];

beforeEach(async () => {
  setup = await createSetup();
  await setup.library.install(zaehlenV1);
  fake = await startFakePushService();
  push = new PushService(setup.db, { hosts: [fake.origin], log: (message) => setup.logs.push(message), limits: { coalesceMs: 200 } });
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
  for (const client of clients.splice(0)) {
    client.close();
  }
  push.close();
  await running.close();
  await fake.close();
  await setup.cleanup();
});

interface Player {
  user: number;
  token: string;
  subscription: TestSubscription;
}

async function enable(member: { user: number; token: string }, name: string): Promise<Player> {
  const subscription = fake.subscription(name);
  const response = await postJson(base, "/api/me/push", { subscription: { endpoint: subscription.endpoint, keys: subscription.keys } }, member.token);
  expect(response.status).toBe(200);
  return { ...member, subscription };
}

async function connect(member: { token: string }, code: string, visible?: boolean): Promise<Client> {
  const client = await Client.connect(running.port, { token: member.token });
  clients.push(client);
  client.send(visible === undefined ? { type: "hello", room: code } : { type: "hello", room: code, visible });
  await client.room();
  return client;
}

async function room(): Promise<{ code: string; anna: Player; ben: Player }> {
  const anna = await enable(account(setup, "Anna"), "anna");
  const ben = await enable(guest(setup, "Ben"), "ben");
  const { code } = setup.rooms.createRoom("zaehlen", anna.user);
  await setup.rooms.joinRoom(code, ben.user);
  return { code, anna, ben };
}

function pushesTo(name: string): unknown[] {
  return fake.received.filter((received) => received.path === `/push/${name}`).map((received) => received.payload);
}

async function delivered(): Promise<void> {
  await settle(50);
  await push.idle();
}

describe("Your turn", () => {
  it("pushes to the first seat at the start and to the next one after each move, not to the one who just moved", async () => {
    const { code, anna, ben } = await room();
    await setup.rooms.start(code, anna.user);
    await delivered();
    expect(pushesTo("anna")).toEqual([{ kind: "turn", room: code, game: "Zählen", lang: "en" }]);
    expect(pushesTo("ben")).toEqual([]);
    await setup.rooms.move(code, anna.user, { type: "add" });
    await delivered();
    expect(pushesTo("ben")).toEqual([{ kind: "turn", room: code, game: "Zählen", lang: "en" }]);
    expect(pushesTo("anna")).toHaveLength(1);
    for (const received of fake.received) {
      expect(received.problem).toBeUndefined();
      expect(received.headers["urgency"]).toBe("high");
    }
  });

  it("does not push while a connection of the member in the room is visible, on any device", async () => {
    const { code, anna, ben } = await room();
    const phone = setup.accounts.createSession(ben.user).token;
    await connect({ token: phone }, code, false);
    const pc = await connect(ben, code, true);
    await setup.rooms.start(code, anna.user);
    await setup.rooms.move(code, anna.user, { type: "add" });
    await delivered();
    expect(pushesTo("ben")).toEqual([]);
    pc.send({ type: "visibility", visible: false });
    await settle(50);
    await setup.rooms.move(code, ben.user, { type: "add" });
    await setup.rooms.move(code, anna.user, { type: "add" });
    await settle(250);
    await delivered();
    expect(pushesTo("ben")).toEqual([{ kind: "turn", room: code, game: "Zählen", lang: "en" }]);
  });

  it("counts a connection without a value as visible, like UIs before step 6b", async () => {
    const { code, anna, ben } = await room();
    await connect(ben, code);
    await setup.rooms.start(code, anna.user);
    await setup.rooms.move(code, anna.user, { type: "add" });
    await delivered();
    expect(pushesTo("ben")).toEqual([]);
  });

  it("pushes as soon as the visible connection is closed", async () => {
    const { code, anna, ben } = await room();
    const visible = await connect(ben, code, true);
    visible.close();
    await visible.closed;
    await settle(50);
    await setup.rooms.start(code, anna.user);
    await setup.rooms.move(code, anna.user, { type: "add" });
    await delivered();
    expect(pushesTo("ben")).toHaveLength(1);
  });

  it("being visible in another room does not hold back the push", async () => {
    const { code, anna, ben } = await room();
    const other = setup.rooms.createRoom("zaehlen", anna.user).code;
    await setup.rooms.joinRoom(other, ben.user);
    await connect(ben, other, true);
    await setup.rooms.start(code, anna.user);
    await setup.rooms.move(code, anna.user, { type: "add" });
    await delivered();
    expect(pushesTo("ben")).toHaveLength(1);
  });

  it("sends nothing when the move was already made before the delayed sending", async () => {
    const { code, anna, ben } = await room();
    await setup.rooms.start(code, anna.user);
    await setup.rooms.move(code, anna.user, { type: "add" });
    await setup.rooms.move(code, ben.user, { type: "add" });
    await setup.rooms.move(code, anna.user, { type: "add" });
    await setup.rooms.move(code, ben.user, { type: "add" });
    await settle(300);
    await delivered();
    expect(pushesTo("ben")).toHaveLength(1);
  });
});

describe("Match is over", () => {
  it("goes to all members with a seat who are not watching, with normal urgency", async () => {
    const { code, anna, ben } = await room();
    await connect(anna, code, true);
    await setup.rooms.start(code, anna.user);
    for (let move = 0; move < 6; move++) {
      await setup.rooms.move(code, move % 2 === 0 ? anna.user : ben.user, { type: "add" });
      await settle(250);
    }
    await delivered();
    const toBen = pushesTo("ben");
    expect(toBen.at(-1)).toEqual({ kind: "finished", room: code, game: "Zählen", lang: "en" });
    expect(pushesTo("anna")).toEqual([]);
    const finished = fake.received.find((received) => (received.payload as { kind: string }).kind === "finished");
    expect(finished?.headers["urgency"]).toBe("normal");
  });

  it("abort and new round do not push", async () => {
    const { code, anna } = await room();
    await setup.rooms.start(code, anna.user);
    await delivered();
    const before = fake.received.length;
    setup.rooms.abort(code, anna.user);
    await delivered();
    expect(fake.received.length).toBe(before);
  });
});

describe("Muting", () => {
  it("holds back pushes for a room and applies on all of the user's devices", async () => {
    const { code, anna, ben } = await room();
    const phone = await enable({ user: ben.user, token: setup.accounts.createSession(ben.user).token }, "ben-handy");
    const muted = await postJson(base, `/api/rooms/${code}/mute`, { muted: true }, phone.token);
    expect(muted).toMatchObject({ status: 200, body: { muted: true } });
    const view = await connect(ben, code, false);
    expect((await getJson(base, "/api/me/rooms", ben.token)).body["rooms"]).toEqual([expect.objectContaining({ code, muted: true })]);
    await setup.rooms.start(code, anna.user);
    await setup.rooms.move(code, anna.user, { type: "add" });
    await delivered();
    expect(pushesTo("ben")).toEqual([]);
    expect(pushesTo("ben-handy")).toEqual([]);
    view.send({ type: "hello", room: code });
    expect((await view.room()).muted).toBe(true);
    await postJson(base, `/api/rooms/${code}/mute`, { muted: false }, ben.token);
    await setup.rooms.move(code, ben.user, { type: "add" });
    await setup.rooms.move(code, anna.user, { type: "add" });
    await delivered();
    expect(pushesTo("ben")).toHaveLength(1);
    expect(pushesTo("ben-handy")).toHaveLength(1);
  });

  it("also mutes when the push is already waiting", async () => {
    const { code, anna, ben } = await room();
    await setup.rooms.start(code, anna.user);
    await setup.rooms.move(code, anna.user, { type: "add" });
    await setup.rooms.move(code, ben.user, { type: "add" });
    await setup.rooms.move(code, anna.user, { type: "add" });
    setup.rooms.setMuted(code, ben.user, true);
    await settle(300);
    await delivered();
    expect(pushesTo("ben")).toHaveLength(1);
  });

  it("is rate-limited and sends an update only to the own connections", async () => {
    const { code, anna, ben } = await room();
    const other = await connect(anna, code, true);
    const own = await connect(ben, code, true);
    await settle(100);
    other.received.length = 0;
    own.received.length = 0;
    expect((await postJson(base, `/api/rooms/${code}/mute`, { muted: true }, ben.token)).status).toBe(200);
    expect((await own.room()).muted).toBe(true);
    await settle(150);
    expect(other.received.filter((message) => message.type === "room")).toEqual([]);
    let last = 0;
    for (let attempt = 0; attempt < 21; attempt++) {
      last = (await postJson(base, `/api/rooms/${code}/mute`, { muted: attempt % 2 === 0 }, ben.token)).status;
    }
    expect(last).toBe(429);
  });

  it("works only for members and only with true or false", async () => {
    const { code } = await room();
    const stranger = guest(setup, "Fremd");
    expect((await postJson(base, `/api/rooms/${code}/mute`, { muted: true }, stranger.token)).body).toMatchObject({ code: "not-member" });
    expect((await postJson(base, `/api/rooms/${code}/mute`, { muted: "ja" }, stranger.token)).body).toMatchObject({ code: "bad-message" });
    expect((await postJson(base, `/api/rooms/${code}/mute`, { muted: true })).status).toBe(401);
  });
});

describe("Subscription over HTTP", () => {
  it("reports key and state of the device, turns on and off", async () => {
    const anna = account(setup, "Anna");
    const before = await getJson(base, "/api/me/push", anna.token);
    expect(before.body).toEqual({ publicKey: push.publicKey(), enabled: false });
    await enable(anna, "anna");
    expect((await getJson(base, "/api/me/push", anna.token)).body).toMatchObject({ enabled: true });
    expect((await postJson(base, "/api/me/push/off", {}, anna.token)).body).toEqual({ enabled: false });
    expect(push.count()).toBe(0);
    expect((await getJson(base, "/api/me/push")).status).toBe(401);
  });

  it("rejects foreign addresses and broken subscriptions with 400", async () => {
    const anna = account(setup, "Anna");
    const { keys } = fake.subscription();
    const local = await postJson(base, "/api/me/push", { subscription: { endpoint: `${base}/api/admin/users`, keys } }, anna.token);
    expect(local).toMatchObject({ status: 400, body: { code: "push-host-not-allowed" } });
    const broken = await postJson(base, "/api/me/push", { subscription: { endpoint: `${fake.origin}/push/x`, keys: { p256dh: "x", auth: "y" } } }, anna.token);
    expect(broken).toMatchObject({ status: 400, body: { code: "bad-subscription" } });
    expect(push.count()).toBe(0);
  });

  it("removes the subscription on sign-out", async () => {
    const { code, anna, ben } = await room();
    await postJson(base, "/api/logout", {}, ben.token);
    expect(push.count()).toBe(1);
    await setup.rooms.start(code, anna.user);
    await setup.rooms.move(code, anna.user, { type: "add" });
    await delivered();
    expect(pushesTo("ben")).toEqual([]);
  });

  it("removes all subscriptions on lock", async () => {
    const anna = await enable(account(setup, "Anna"), "anna");
    setup.accounts.updateUser(anna.user, { locked: true });
    expect(push.count()).toBe(0);
  });

  it('shows in "My devices" which session has push', async () => {
    const anna = await enable(account(setup, "Anna"), "anna");
    const other = setup.accounts.createSession(anna.user).token;
    const sessions = (await getJson(base, "/api/me/sessions", other)).body["sessions"] as { current: boolean; push: boolean }[];
    expect(sessions.map((session) => ({ current: session.current, push: session.push })).sort((a, b) => Number(a.current) - Number(b.current))).toEqual([
      { current: false, push: true },
      { current: true, push: false },
    ]);
  });

  it("sends a test message only to this device and at most once a minute", async () => {
    const anna = await enable(account(setup, "Anna"), "anna");
    await enable({ user: anna.user, token: setup.accounts.createSession(anna.user).token }, "anna-handy");
    expect((await postJson(base, "/api/me/push/test", {}, anna.token)).status).toBe(200);
    const again = await postJson(base, "/api/me/push/test", {}, anna.token);
    expect(again).toMatchObject({ status: 429, body: { code: "rate-limited" } });
    await delivered();
    expect(pushesTo("anna")).toEqual([{ kind: "test", lang: "en" }]);
    expect(pushesTo("anna-handy")).toEqual([]);
    const none = guest(setup, "Ohne");
    expect(await postJson(base, "/api/me/push/test", {}, none.token)).toMatchObject({ status: 409, body: { code: "push-off" } });
  });

  it("takes the https origin of the page as contact", async () => {
    const anna = account(setup, "Anna");
    const subscription = fake.subscription("anna");
    const origin = `https://127.0.0.1:${running.port}`;
    await postJson(base, "/api/me/push", { subscription: { endpoint: subscription.endpoint, keys: subscription.keys } }, anna.token, { origin });
    await postJson(base, "/api/me/push/test", {}, anna.token);
    await delivered();
    expect(fake.received[0]?.vapid?.sub).toBe(origin);
  });

  it("renews a subscription only if this session still has the old one", async () => {
    const anna = await enable(account(setup, "Anna"), "anna-alt");
    const fresh = fake.subscription("anna-neu");
    const renewed = await postJson(base, "/api/me/push/renew", { oldEndpoint: anna.subscription.endpoint, subscription: { endpoint: fresh.endpoint, keys: fresh.keys } }, anna.token);
    expect(renewed).toMatchObject({ status: 200, body: { renewed: true } });
    await postJson(base, "/api/me/push/test", {}, anna.token);
    await delivered();
    expect(fake.received.map((received) => received.path)).toEqual(["/push/anna-neu"]);
    const ben = guest(setup, "Ben");
    const other = fake.subscription("ben");
    const stranger = await postJson(base, "/api/me/push/renew", { oldEndpoint: fresh.endpoint, subscription: { endpoint: other.endpoint, keys: other.keys } }, ben.token);
    expect(stranger).toMatchObject({ status: 200, body: { renewed: false } });
    expect((await getJson(base, "/api/me/push", ben.token)).body).toMatchObject({ enabled: false });
    expect((await getJson(base, "/api/me/push", anna.token)).body).toMatchObject({ enabled: true });
  });

  it("rate-limits frequent turning on and off per address", async () => {
    const anna = account(setup, "Anna");
    let last = 0;
    for (let attempt = 0; attempt < 21; attempt++) {
      last = (await postJson(base, "/api/me/push/off", {}, anna.token)).status;
    }
    expect(last).toBe(429);
  });
});

describe("Visibility in the protocol", () => {
  it("rejects nonsense as visible", async () => {
    const anna = account(setup, "Anna");
    const { code } = setup.rooms.createRoom("zaehlen", anna.user);
    const client = await Client.connect(running.port, { token: anna.token });
    clients.push(client);
    client.send({ type: "hello", room: code, visible: "ja" });
    expect((await client.error()).code).toBe("bad-message");
    client.send({ type: "visibility" });
    expect((await client.error()).code).toBe("bad-message");
  });
});

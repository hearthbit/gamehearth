import { applyJsonDelta, canonicalJson } from "@gamehearth/sdk/platform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawData } from "ws";
import { startServer, type RunningServer } from "../src/transport";
import { Client, postJson } from "./client";
import { account, createSetup, wachsend, type Setup } from "./helpers";

let setup: Setup;
let running: RunningServer;
let base: string;

beforeEach(async () => {
  setup = await createSetup(undefined, {}, { clock: Date.now, realtime: { graceMs: 150, countdownMs: 150 } });
  await setup.library.install(wachsend);
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

type Snapshot = { version: number; public: { drawing: string } };

interface Frame {
  bytes: number;
  delta: boolean;
  applied: boolean;
}

class Mirror {
  snapshot: Snapshot | undefined;
  readonly frames: Frame[] = [];
  readonly problems: string[] = [];
  checked = 0;
  ahead = 0;
  resyncs = 0;
  #waiting = false;

  constructor(
    readonly client: Client,
    readonly view: "room" | "screen-room",
    readonly resync = false,
  ) {
    client.socket.on("message", (data: RawData) => this.#receive(data.toString()));
  }

  #receive(text: string): void {
    const message = JSON.parse(text) as Record<string, unknown>;
    if (message["type"] === this.view) {
      const snapshot = (message["room"] as { snapshot?: Snapshot }).snapshot;
      if (snapshot !== undefined && this.snapshot !== undefined) {
        this.ahead += snapshot.version > this.snapshot.version ? 1 : 0;
        if (snapshot.version === this.snapshot.version) {
          this.checked++;
          if (canonicalJson(snapshot) !== canonicalJson(this.snapshot)) {
            this.problems.push(`version ${snapshot.version} differs from the room`);
          }
        }
      }
      this.snapshot = snapshot;
      this.#waiting = false;
      return;
    }
    if (message["type"] !== "frame") {
      return;
    }
    const bytes = Buffer.byteLength(text);
    if ("snapshot" in message) {
      this.snapshot = message["snapshot"] as Snapshot;
      this.#waiting = false;
      this.frames.push({ bytes, delta: false, applied: true });
      return;
    }
    const applied = message["base"] === this.snapshot?.version ? applyJsonDelta(this.snapshot, message["delta"]) : undefined;
    if (applied?.ok === true) {
      this.snapshot = applied.value as Snapshot;
      this.frames.push({ bytes, delta: true, applied: true });
      return;
    }
    this.frames.push({ bytes, delta: true, applied: false });
    if (!this.resync) {
      this.problems.push(`delta for version ${String(message["base"])} on ${String(this.snapshot?.version)}`);
    } else if (!this.#waiting) {
      this.#waiting = true;
      this.resyncs++;
      this.client.send({ type: "resync" });
    }
  }
}

async function tv(code: string, hostToken: string, deltas: boolean): Promise<Client> {
  const response = await fetch(`${base}/api/tv`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const token = /(?:^|\s)gh-tv=([^;]*)/.exec(response.headers.get("set-cookie") ?? "")?.[1] as string;
  const client = await Client.connect(running.port, { headers: { cookie: `gh-tv=${token}` } });
  client.send(deltas ? { type: "screen", deltas: true } : { type: "screen" });
  const pairing = (await client.next((message) => message.type === "pairing")) as { code: string };
  expect((await postJson(base, `/api/rooms/${code}/screens`, { code: pairing.code }, hostToken)).status).toBe(201);
  await client.next((message) => message.type === "screen-room");
  return client;
}

async function party(deltas = { host: true, guest: true, tv: true }) {
  const anna = account(setup, "Anna");
  const created = await postJson(base, "/api/rooms", { game: "wachsend" }, anna.token);
  const code = String(created.body["code"]);
  const joined = await postJson(base, `/api/rooms/${code}/join`, { name: "Ben" });
  const host = await Client.connect(running.port, { token: anna.token });
  const guest = await Client.connect(running.port, { token: joined.cookie as string });
  host.send({ type: "hello", room: code, ...(deltas.host ? { deltas: true } : {}) });
  guest.send({ type: "hello", room: code, ...(deltas.guest ? { deltas: true } : {}) });
  await host.room();
  await guest.room();
  const screen = await tv(code, anna.token, deltas.tv);
  return { code, host, guest, screen, guestToken: joined.cookie as string };
}

async function frames(mirrors: Mirror[], count: number): Promise<void> {
  const targets = mirrors.map((mirror) => mirror.frames.length + count);
  await vi.waitFor(() => expect(mirrors.every((mirror, index) => mirror.frames.length >= (targets[index] as number))).toBe(true), { timeout: 5000, interval: 20 });
}

async function command(client: Client, message: Record<string, unknown>, id: number): Promise<void> {
  client.send({ ...message, id });
  expect(await client.next((answer) => "id" in answer && answer.id === id)).toEqual({ type: "ack", id });
}

describe("Delta frames over the WebSocket", () => {
  it("sends phones and TVs only the growing part of a 10 KB drawing, and old UIs the whole snapshot", async () => {
    const { code, host, guest, screen, guestToken } = await party();
    const old = await Client.connect(running.port, { token: guestToken });
    old.send({ type: "hello", room: code });
    await old.room();
    const mirrors = [new Mirror(host, "room"), new Mirror(guest, "room"), new Mirror(screen, "screen-room")];
    const legacy = new Mirror(old, "room");
    await command(host, { type: "start" }, 1);
    await frames([...mirrors, legacy], 20);
    expect(JSON.stringify(mirrors[0]!.snapshot).length).toBeGreaterThan(10_000);
    for (const mirror of mirrors) {
      expect(mirror.problems).toEqual([]);
      expect(mirror.frames.every((frame) => frame.delta && frame.applied)).toBe(true);
      expect(Math.max(...mirror.frames.map((frame) => frame.bytes))).toBeLessThan(500);
    }
    expect(legacy.frames.every((frame) => !frame.delta && frame.bytes > 10_000)).toBe(true);
    expect(mirrors[2]!.snapshot).not.toHaveProperty("player");
  });

  it("takes the snapshot of every room message as the new base, also one newer than the last frame", async () => {
    const { host, guest, screen } = await party();
    const mirrors = [new Mirror(host, "room"), new Mirror(guest, "room"), new Mirror(screen, "screen-room")];
    await command(host, { type: "start" }, 1);
    await frames(mirrors, 5);
    for (let id = 10; id < 13; id++) {
      await command(host, { type: "move", action: { type: "tap" } }, id);
    }
    await vi.waitFor(() => expect(mirrors.every((mirror) => mirror.ahead > 0)).toBe(true), { timeout: 5000, interval: 20 });
    await frames(mirrors, 5);
    await command(host, { type: "pause" }, 2);
    await vi.waitFor(() => expect(mirrors.every((mirror) => mirror.checked > 0)).toBe(true), { timeout: 5000, interval: 20 });
    await command(host, { type: "resume" }, 3);
    await frames(mirrors, 10);
    for (const mirror of mirrors) {
      expect(mirror.problems).toEqual([]);
      expect(mirror.frames.every((frame) => frame.delta && frame.applied && frame.bytes < 500)).toBe(true);
    }
    expect((mirrors[0]!.snapshot as unknown as { me: { taps: number } }).me.taps).toBe(3);
  }, 20_000);

  it("sends the whole snapshot again after resync, so a client that lost track recovers", async () => {
    const { host, guest } = await party();
    const mirror = new Mirror(guest, "room", true);
    await command(host, { type: "start" }, 1);
    await frames([mirror], 5);
    const stale = mirror.snapshot as Snapshot;
    await frames([mirror], 3);
    mirror.snapshot = stale;
    await vi.waitFor(() => expect(mirror.frames.some((frame) => !frame.delta)).toBe(true), { timeout: 5000, interval: 20 });
    await frames([mirror], 5);
    const full = mirror.frames.findIndex((frame) => !frame.delta);
    expect(mirror.frames[full]!.bytes).toBeGreaterThan(10_000);
    expect(mirror.frames.slice(0, full).filter((frame) => !frame.applied).length).toBeGreaterThan(0);
    expect(mirror.frames.slice(full + 1).every((frame) => frame.delta && frame.applied && frame.bytes < 500)).toBe(true);
    expect(mirror.resyncs).toBe(1);
  });

  it("keeps old TVs on whole snapshots", async () => {
    const { host, screen } = await party({ host: true, guest: true, tv: false });
    const mirror = new Mirror(screen, "screen-room");
    await command(host, { type: "start" }, 1);
    await frames([mirror], 5);
    expect(mirror.frames.every((frame) => !frame.delta && frame.bytes > 10_000)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { connect, createTimeline, lerp, type MessageEventLike, type TimelineSource } from "../src/client";
import { parsePlatformMessage } from "../src/platform";

type Listener = (event: MessageEventLike) => void;

function fakePlatform() {
  const sent: unknown[] = [];
  const listeners = new Set<Listener>();
  const parent = { postMessage: (message: unknown) => sent.push(message) };
  const events = {
    addEventListener: (_type: "message", listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: "message", listener: Listener) => listeners.delete(listener),
  };
  const deliver = (data: unknown) => {
    for (const listener of [...listeners]) {
      listener({ data, source: parent });
    }
  };
  return { parent, events, sent, listeners, deliver };
}

const players = { p1: { name: "Anna", connected: true, you: false } };

function screenUpdate(tick: number) {
  return { gamehearth: 1, type: "update", seat: null, role: "screen", snapshot: { players: ["p1"], public: { x: tick }, version: tick, tick }, players, online: true };
}

function controllerUpdate(tick: number) {
  return {
    gamehearth: 1,
    type: "update",
    seat: "p1",
    role: "controller",
    snapshot: { player: "p1", players: ["p1"], public: { x: tick }, me: {}, moves: [], version: tick, tick },
    players,
    online: true,
  };
}

describe("connect with roles", () => {
  it("gives a TV a connection without a seat and without moves", async () => {
    const platform = fakePlatform();
    const pending = connect<{ public: { x: number }; players: Record<string, object>; secret: object }, never>({
      parent: platform.parent,
      events: platform.events,
      screen: true,
    });
    platform.deliver(screenUpdate(4));
    const game = await pending;
    expect(game.role).toBe("screen");
    if (game.role !== "screen") {
      throw new Error("expected a TV");
    }
    expect(game.current.snapshot).toEqual({ players: ["p1"], public: { x: 4 }, version: 4, tick: 4 });
    expect("move" in game).toBe(false);
    const seen: number[] = [];
    game.onUpdate((update) => seen.push(update.snapshot.public.x));
    platform.deliver(screenUpdate(5));
    platform.deliver(controllerUpdate(6));
    expect(seen).toEqual([4, 5]);
  });

  it("rejects the TV role when the game does not know it", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events });
    platform.deliver(screenUpdate(1));
    await expect(pending).rejects.toThrow("connect({ screen: true })");
    expect(platform.listeners.size).toBe(0);
  });

  it("passes the platform's tick duration on to the updates", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events, screen: true });
    platform.deliver({ ...screenUpdate(1), tickMs: 100 });
    const game = await pending;
    expect(game.current.tickMs).toBe(100);
    const seen: (number | undefined)[] = [];
    game.onUpdate((update) => seen.push(update.tickMs));
    platform.deliver(screenUpdate(2));
    expect(seen).toEqual([100, undefined]);
  });

  it("tells controllers their role and seat", async () => {
    const platform = fakePlatform();
    const pending = connect({ parent: platform.parent, events: platform.events, screen: true });
    platform.deliver(controllerUpdate(2));
    const game = await pending;
    expect(game.role).toBe("controller");
    expect(game.role !== "screen" && game.seat).toBe("p1");
  });
});

describe("parsePlatformMessage with roles", () => {
  it("requires seat null for TVs and a seat otherwise", () => {
    expect(parsePlatformMessage(screenUpdate(1))).toMatchObject({ role: "screen", seat: null });
    expect(parsePlatformMessage({ ...screenUpdate(1), seat: "p1" })).toBeUndefined();
    expect(parsePlatformMessage({ ...controllerUpdate(1), seat: null })).toBeUndefined();
    expect(parsePlatformMessage({ ...controllerUpdate(1), role: "zuschauer" })).toBeUndefined();
  });

  it("takes a tick duration only if it is a number above 0 and at most 10 s", () => {
    expect(parsePlatformMessage({ ...screenUpdate(1), tickMs: 200 })).toMatchObject({ tickMs: 200 });
    for (const tickMs of [0, -50, 20_000, "200", Number.NaN]) {
      const parsed = parsePlatformMessage({ ...screenUpdate(1), tickMs });
      expect(parsed).toMatchObject({ type: "update" });
      expect(parsed && "tickMs" in parsed).toBe(false);
    }
  });

  it("discards a tick number that is not an integer of at least 0", () => {
    expect(parsePlatformMessage({ ...screenUpdate(1), snapshot: { version: 1, tick: -1 } })).toBeUndefined();
    expect(parsePlatformMessage({ ...screenUpdate(1), snapshot: { version: 1, tick: 1.5 } })).toBeUndefined();
  });
});

type Snap = { tick?: number; x: number };

function source() {
  let listener: ((update: { snapshot: Snap; tickMs?: number }) => void) | undefined;
  let current: Snap | undefined;
  const feed: TimelineSource<Snap> & { push(snapshot: Snap, tickMs?: number): void; listening(): boolean } = {
    onUpdate(next) {
      listener = next;
      if (current !== undefined) {
        next({ snapshot: current });
      }
      return () => {
        listener = undefined;
      };
    },
    push(snapshot, tickMs) {
      current = snapshot;
      listener?.(tickMs === undefined ? { snapshot } : { snapshot, tickMs });
    },
    listening: () => listener !== undefined,
  };
  return feed;
}

describe("createTimeline", () => {
  it("blends between the two snapshots around the time 100 ms before the newest", () => {
    let now = 0;
    const feed = source();
    const timeline = createTimeline(feed, { now: () => now });
    expect(timeline.frame()).toBeUndefined();
    for (let tick = 0; tick <= 4; tick++) {
      now = tick * 50;
      feed.push({ tick, x: tick * 10 });
    }
    const frame = timeline.frame(225);
    expect(frame?.from.tick).toBe(2);
    expect(frame?.to.tick).toBe(3);
    expect(frame?.alpha).toBeCloseTo(0.5);
    expect(lerp(frame?.from.x ?? 0, frame?.to.x ?? 0, frame?.alpha ?? 0)).toBeCloseTo(25);
  });

  it("stops at the newest snapshot when none follows", () => {
    let now = 0;
    const feed = source();
    const timeline = createTimeline(feed, { now: () => now });
    feed.push({ tick: 0, x: 0 });
    now = 50;
    feed.push({ tick: 1, x: 10 });
    expect(timeline.frame(10_000)).toEqual({ from: { tick: 1, x: 10 }, to: { tick: 1, x: 10 }, alpha: 1 });
  });

  it("realigns after a pause instead of sticking to the old timing", () => {
    let now = 0;
    const feed = source();
    const timeline = createTimeline(feed, { now: () => now });
    for (let tick = 0; tick <= 3; tick++) {
      now = tick * 50;
      feed.push({ tick, x: tick });
    }
    for (let tick = 4; tick <= 6; tick++) {
      now = 5000 + (tick - 4) * 50;
      feed.push({ tick, x: tick });
    }
    const frame = timeline.frame(5100 + 25);
    expect(frame?.from.tick).toBe(4);
    expect(frame?.alpha).toBeCloseTo(0.5);
  });

  it("takes the earlier arrival timing when snapshots arrived late", () => {
    let now = 0;
    const feed = source();
    const timeline = createTimeline(feed, { now: () => now });
    now = 40;
    feed.push({ tick: 0, x: 0 });
    now = 50;
    feed.push({ tick: 1, x: 1 });
    now = 100;
    feed.push({ tick: 2, x: 2 });
    expect(timeline.frame(150)?.from.tick).toBe(1);
    expect(timeline.frame(150)?.alpha).toBeCloseTo(0);
  });

  it("starts over when the tick number jumps back (new round)", () => {
    let now = 0;
    const feed = source();
    const timeline = createTimeline(feed, { now: () => now });
    for (let tick = 10; tick <= 12; tick++) {
      now = tick * 50;
      feed.push({ tick, x: tick });
    }
    now = 1000;
    feed.push({ tick: 0, x: 0 });
    expect(timeline.frame(1000)).toEqual({ from: { tick: 0, x: 0 }, to: { tick: 0, x: 0 }, alpha: 1 });
  });

  it("follows the platform's tick duration in slow motion", () => {
    let now = 0;
    const feed = source();
    const timeline = createTimeline(feed, { now: () => now });
    for (let tick = 0; tick <= 4; tick++) {
      now = tick * 200;
      feed.push({ tick, x: tick * 10 }, 200);
    }
    const frame = timeline.frame(900);
    expect(frame?.from.tick).toBe(2);
    expect(frame?.to.tick).toBe(3);
    expect(frame?.alpha).toBeCloseTo(0.5);
  });

  it("never jumps backwards when switching into slow motion and back", () => {
    let now = 0;
    const feed = source();
    const timeline = createTimeline(feed, { now: () => now });
    const shown: number[] = [];
    let tick = 0;
    let due = 0;
    const paceAt = (time: number) => (time < 1000 ? 50 : time < 3000 ? 200 : 50);
    for (now = 0; now <= 4000; now += 10) {
      if (now >= due) {
        const pace = paceAt(now);
        feed.push({ tick, x: tick }, pace === 50 ? undefined : pace);
        tick++;
        due = now + pace;
      }
      const frame = timeline.frame(now);
      if (frame !== undefined) {
        shown.push(lerp(frame.from.x, frame.to.x, frame.alpha));
      }
    }
    for (let index = 1; index < shown.length; index++) {
      expect(shown[index]).toBeGreaterThanOrEqual(shown[index - 1] as number);
    }
    expect(shown.at(-1)).toBeGreaterThan(tick - 4);
  });

  it("shows snapshots without a tick number unchanged and unsubscribes", () => {
    const feed = source();
    feed.push({ x: 5 });
    const timeline = createTimeline(feed, { now: () => 0 });
    expect(timeline.latest).toEqual({ x: 5 });
    expect(timeline.frame()).toEqual({ from: { x: 5 }, to: { x: 5 }, alpha: 1 });
    timeline.dispose();
    expect(feed.listening()).toBe(false);
  });
});

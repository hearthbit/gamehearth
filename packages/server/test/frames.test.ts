import { applyJsonDelta } from "@gamehearth/sdk/platform";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { frameBase, frameSender, type FrameReceiver, type Snapshot } from "../src/frames";
import { parseClientMessage } from "../src/protocol";

const diffs = vi.hoisted(() => ({ count: 0 }));

vi.mock("@gamehearth/sdk/platform", async (original) => {
  const actual = await original<typeof import("@gamehearth/sdk/platform")>();
  return {
    ...actual,
    jsonDelta: (base: unknown, next: unknown) => {
      diffs.count++;
      return actual.jsonDelta(base, next);
    },
  };
});

class Receiver implements FrameReceiver {
  readonly sent: string[] = [];
  readonly socket = { readyState: 1, bufferedAmount: 0, send: (data: string) => this.sent.push(data) };
  frameBase: FrameReceiver["frameBase"];
  snapshot: Snapshot | undefined;

  constructor(
    readonly deltas = true,
    shown?: { code: string; seat: string | null; snapshot: Snapshot },
  ) {
    this.frameBase = shown === undefined ? undefined : frameBase(shown.code, shown.seat, shown.snapshot);
    this.snapshot = shown === undefined ? undefined : (JSON.parse(JSON.stringify(shown.snapshot)) as Snapshot);
  }

  last(): Record<string, unknown> {
    return JSON.parse(this.sent.at(-1) as string) as Record<string, unknown>;
  }

  receive(): void {
    const frame = this.last();
    if ("snapshot" in frame) {
      this.snapshot = frame["snapshot"] as Snapshot;
      return;
    }
    expect(frame["base"]).toBe(this.snapshot?.version);
    const applied = applyJsonDelta(this.snapshot, frame["delta"]);
    if (!applied.ok) {
      throw new Error(applied.message);
    }
    this.snapshot = applied.value as Snapshot;
  }
}

function snapshot(version: number, drawing: string, seat: string | null = "p1"): Snapshot {
  const common = { players: ["p1", "p2"], public: { drawing, word: "Haus" }, version, tick: version };
  return seat === null ? common : { ...common, player: seat, me: { taps: 0 }, moves: [{ type: "tap" }] };
}

const sketch = "M1,2L3,4".repeat(1500);

beforeEach(() => {
  diffs.count = 0;
});

describe("Delta frames", () => {
  it("sends the full snapshot without a base and afterwards only the changes", () => {
    const receiver = new Receiver();
    frameSender("ABC234", () => snapshot(1, sketch), 65_536)(receiver, "p1");
    expect(receiver.last()).toEqual({ type: "frame", snapshot: snapshot(1, sketch) });
    receiver.receive();
    frameSender("ABC234", () => snapshot(2, `${sketch}L5,6`), 65_536)(receiver, "p1");
    expect(receiver.last()).toEqual({
      type: "frame",
      base: 1,
      delta: [
        { op: "append", path: ["public", "drawing"], text: "L5,6" },
        { op: "set", path: ["version"], value: 2 },
        { op: "set", path: ["tick"], value: 2 },
      ],
    });
    receiver.receive();
    expect(receiver.snapshot).toEqual(snapshot(2, `${sketch}L5,6`));
  });

  it("computes each delta once per seat and base and shares it between connections", () => {
    const before = snapshot(1, sketch);
    const tv = snapshot(1, sketch, null);
    const phones = [new Receiver(true, { code: "ABC234", seat: "p1", snapshot: before }), new Receiver(true, { code: "ABC234", seat: "p1", snapshot: before })];
    phones[1]!.frameBase = phones[0]!.frameBase;
    const tvs = [new Receiver(true, { code: "ABC234", seat: null, snapshot: tv }), new Receiver(true, { code: "ABC234", seat: null, snapshot: tv })];
    tvs[1]!.frameBase = tvs[0]!.frameBase;
    const calls: (string | null)[] = [];
    const deliver = frameSender(
      "ABC234",
      (seat) => {
        calls.push(seat);
        return snapshot(2, `${sketch}L5,6`, seat);
      },
      65_536,
    );
    for (const receiver of phones) {
      deliver(receiver, "p1");
    }
    for (const receiver of tvs) {
      deliver(receiver, null);
    }
    expect(calls).toEqual(["p1", null]);
    expect(diffs.count).toBe(2);
    for (const receiver of [...phones, ...tvs]) {
      expect(receiver.last()).toMatchObject({ type: "frame", base: 1 });
      receiver.receive();
    }
    expect(tvs[0]!.snapshot).toEqual(snapshot(2, `${sketch}L5,6`, null));
    expect(phones[0]!.frameBase).toEqual(phones[1]!.frameBase);
  });

  it("keeps the base of a connection whose frame was skipped, and the next delta covers both ticks", () => {
    const receiver = new Receiver(true, { code: "ABC234", seat: "p1", snapshot: snapshot(1, sketch) });
    receiver.socket.bufferedAmount = 70_000;
    frameSender("ABC234", () => snapshot(2, `${sketch}L5,6`), 65_536)(receiver, "p1");
    expect(receiver.sent).toEqual([]);
    expect(receiver.frameBase?.snapshot.version).toBe(1);
    receiver.socket.bufferedAmount = 0;
    frameSender("ABC234", () => snapshot(3, `${sketch}L5,6L7,8`), 65_536)(receiver, "p1");
    expect(receiver.last()).toMatchObject({ base: 1, delta: [{ op: "append", path: ["public", "drawing"], text: "L5,6L7,8" }, {}, {}] });
    receiver.receive();
    expect(receiver.snapshot).toEqual(snapshot(3, `${sketch}L5,6L7,8`));
  });

  it("sends the full snapshot when the delta would not be smaller", () => {
    const receiver = new Receiver(true, { code: "ABC234", seat: "p1", snapshot: snapshot(1, "M0,0") });
    const next = { ...snapshot(2, "L1,1"), public: { other: [1, 2, 3] } } as Snapshot;
    frameSender("ABC234", () => next, 65_536)(receiver, "p1");
    expect(receiver.last()).toEqual({ type: "frame", snapshot: next });
    expect(receiver.frameBase?.snapshot).toBe(next);
  });

  it("sends old UIs without delta support only full snapshots", () => {
    const receiver = new Receiver(false, { code: "ABC234", seat: "p1", snapshot: snapshot(1, sketch) });
    frameSender("ABC234", () => snapshot(2, `${sketch}L5,6`), 65_536)(receiver, "p1");
    expect(receiver.last()).toEqual({ type: "frame", snapshot: snapshot(2, `${sketch}L5,6`) });
    expect(receiver.sent[0]!.length).toBeGreaterThan(12_000);
    expect(diffs.count).toBe(0);
  });

  it("never takes a base from another seat or room", () => {
    const seat = new Receiver(true, { code: "ABC234", seat: "p2", snapshot: snapshot(1, sketch, "p2") });
    const room = new Receiver(true, { code: "XYZ789", seat: "p1", snapshot: snapshot(1, sketch) });
    const deliver = frameSender("ABC234", () => snapshot(2, `${sketch}L5,6`), 65_536);
    deliver(seat, "p1");
    deliver(room, "p1");
    expect(seat.last()).toHaveProperty("snapshot");
    expect(room.last()).toHaveProperty("snapshot");
  });

  it("reads the optional deltas flag of hello and screen, and resync", () => {
    expect(parseClientMessage('{"type":"hello","room":"ABC234","visible":true,"deltas":true}')).toEqual({ type: "hello", room: "ABC234", visible: true, deltas: true });
    expect(parseClientMessage('{"type":"hello","room":"ABC234"}')).toEqual({ type: "hello", room: "ABC234" });
    expect(parseClientMessage('{"type":"hello","room":"ABC234","deltas":"yes"}')).toBe("deltas must be true or false");
    expect(parseClientMessage('{"type":"screen","deltas":true}')).toEqual({ type: "screen", deltas: true });
    expect(parseClientMessage('{"type":"screen"}')).toEqual({ type: "screen" });
    expect(parseClientMessage('{"type":"screen","deltas":1}')).toBe("deltas must be true or false");
    expect(parseClientMessage('{"type":"resync"}')).toEqual({ type: "resync" });
  });

  it("sends nothing to closed connections and when there is no live match", () => {
    const closed = new Receiver();
    closed.socket.readyState = 3;
    frameSender("ABC234", () => snapshot(1, sketch), 65_536)(closed, "p1");
    const idle = new Receiver();
    frameSender("ABC234", () => undefined, 65_536)(idle, "p1");
    expect([closed.sent, idle.sent]).toEqual([[], []]);
    expect([closed.frameBase, idle.frameBase]).toEqual([undefined, undefined]);
  });
});

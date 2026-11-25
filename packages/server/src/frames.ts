import { jsonDelta, type PlayerSnapshot, type ScreenSnapshot } from "@gamehearth/sdk/platform";
import { WebSocket } from "ws";
import type { ServerMessage } from "./protocol";

export type Snapshot = PlayerSnapshot<unknown, unknown, unknown> | ScreenSnapshot<unknown>;

export interface FrameBase {
  key: string;
  snapshot: Snapshot;
}

export interface FrameReceiver {
  readonly socket: { readonly readyState: number; readonly bufferedAmount: number; send(data: string): void };
  deltas: boolean;
  frameBase: FrameBase | undefined;
}

interface Frames {
  key: string;
  snapshot: Snapshot;
  full: string;
  deltas: Map<Snapshot, string>;
}

export function frameKey(code: string, seat: string | null): string {
  return `${code}/${seat ?? ""}`;
}

export function frameBase(code: string, seat: string | null, snapshot: Snapshot | undefined): FrameBase | undefined {
  return snapshot === undefined ? undefined : { key: frameKey(code, seat), snapshot };
}

export function frameSender(code: string, snapshotFor: (seat: string | null) => Snapshot | undefined, dropBytes: number): (receiver: FrameReceiver, seat: string | null) => void {
  const cache = new Map<string, Frames | undefined>();
  const framesFor = (seat: string | null) => {
    const key = frameKey(code, seat);
    if (!cache.has(key)) {
      const snapshot = snapshotFor(seat);
      cache.set(key, snapshot === undefined ? undefined : { key, snapshot, full: JSON.stringify({ type: "frame", snapshot } satisfies ServerMessage), deltas: new Map() });
    }
    return cache.get(key);
  };
  const textFor = (receiver: FrameReceiver, frames: Frames) => {
    const base = receiver.frameBase;
    if (!receiver.deltas || base === undefined || base.key !== frames.key) {
      return frames.full;
    }
    let text = frames.deltas.get(base.snapshot);
    if (text === undefined) {
      const delta = JSON.stringify({ type: "frame", base: base.snapshot.version, delta: jsonDelta(base.snapshot, frames.snapshot) } satisfies ServerMessage);
      text = delta.length < frames.full.length ? delta : frames.full;
      frames.deltas.set(base.snapshot, text);
    }
    return text;
  };
  return (receiver, seat) => {
    const frames = framesFor(seat);
    const socket = receiver.socket;
    if (frames === undefined || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > dropBytes) {
      return;
    }
    socket.send(textFor(receiver, frames));
    receiver.frameBase = { key: frames.key, snapshot: frames.snapshot };
  };
}

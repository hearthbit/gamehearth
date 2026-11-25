import type { Expected, GameFeatures, GuestFunction, SandboxOptions, SandboxResult } from "gamehearth/sandbox";

export type WorkerRequest =
  | { id: number; kind: "register"; build: string; code: string; catalog?: string }
  | { id: number; kind: "verify"; build: string; code: string; catalog?: string }
  | { id: number; kind: "call"; room: string; build: string; fn: GuestFunction; input: string; expected: Expected }
  | { id: number; kind: "forget"; room: string }
  | { id: number; kind: "features"; build: string };

export type WorkerReply = { id: number; result: SandboxResult | { ok: true } | { ok: true; features: GameFeatures } };

export interface WorkerSetup {
  guestRunner: string;
  wasm: WebAssembly.Module;
  current: Int32Array;
  startedAt: Float64Array;
  idleMs: number;
  maxSandboxes: number;
  sandbox: Partial<SandboxOptions>;
}

export const heartbeat = { request: 0, phase: 1 } as const;
export const phases = { call: 0, load: 1 } as const;

export function monotonicMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

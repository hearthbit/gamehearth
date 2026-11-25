export const heartbeatSlots = { beats: 0, job: 1, step: 2, phase: 3, seat: 4, replaying: 5, forbidden: 6 } as const;

export const phaseCodes = ["setup", "legalMoves", "apply", "result", "tick", "bot"] as const;

export const forbiddenCalls = [
  "Math.random()",
  "Date()",
  "new Date() without an argument",
  "Date.now()",
  "Date.parse()",
  "new Date(...) with text or several arguments",
  "a date method with local time",
  "performance.now()",
  "crypto.getRandomValues()",
  "crypto.randomUUID()",
] as const;

export type HeartbeatPhase = (typeof phaseCodes)[number];

export function createHeartbeat(startJob = 0): Int32Array {
  const heartbeat = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 7));
  Atomics.store(heartbeat, heartbeatSlots.job, startJob);
  Atomics.store(heartbeat, heartbeatSlots.seat, -1);
  return heartbeat;
}

export interface HeartbeatReading {
  beats: number;
  job: number;
  step: number;
  phase: HeartbeatPhase | undefined;
  seat: number;
  replaying: boolean;
}

export function readHeartbeat(heartbeat: Int32Array): HeartbeatReading {
  const phaseIndex = Atomics.load(heartbeat, heartbeatSlots.phase);
  return {
    beats: Atomics.load(heartbeat, heartbeatSlots.beats),
    job: Atomics.load(heartbeat, heartbeatSlots.job),
    step: Atomics.load(heartbeat, heartbeatSlots.step),
    phase: phaseIndex > 0 ? phaseCodes[phaseIndex - 1] : undefined,
    seat: Atomics.load(heartbeat, heartbeatSlots.seat),
    replaying: Atomics.load(heartbeat, heartbeatSlots.replaying) === 1,
  };
}

export function takeForbiddenCall(heartbeat: Int32Array): string | undefined {
  const code = Atomics.exchange(heartbeat, heartbeatSlots.forbidden, 0);
  return code > 0 ? forbiddenCalls[code - 1] : undefined;
}

import { levels } from "./levels";

export const levelCount = levels.length;

export interface Run {
  start: number;
  level: number;
  elapsedMs: number;
  levelMs: number;
}

export interface Save {
  format: 1;
  unlocked: number;
  run: Run | null;
}

export interface Finished {
  totalMs: number;
  ranked: boolean;
}

export function freshSave(): Save {
  return { format: 1, unlocked: 1, run: null };
}

function whole(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function readSave(raw: unknown): Save {
  if (raw === null || typeof raw !== "object") {
    return freshSave();
  }
  const save = raw as Partial<Save>;
  if (save.format !== 1 || !whole(save.unlocked, 1, levelCount)) {
    return freshSave();
  }
  const run = save.run;
  if (run === null || run === undefined) {
    return { format: 1, unlocked: save.unlocked, run: null };
  }
  const levelMs = run.levelMs ?? 0;
  if (!whole(run.start, 0, levelCount - 1) || !whole(run.level, run.start, levelCount - 1) || !whole(run.elapsedMs, 0, Number.MAX_SAFE_INTEGER) || !whole(levelMs, 0, Number.MAX_SAFE_INTEGER)) {
    return { format: 1, unlocked: save.unlocked, run: null };
  }
  return { format: 1, unlocked: Math.max(save.unlocked, run.level + 1), run: { start: run.start, level: run.level, elapsedMs: run.elapsedMs, levelMs } };
}

export function canStart(save: Save, level: number): boolean {
  return Number.isInteger(level) && level >= 0 && level < save.unlocked;
}

export function startRun(save: Save, level: number): Save {
  if (!canStart(save, level)) {
    throw new Error(`Level ${level + 1} is not unlocked yet`);
  }
  return { ...save, run: { start: level, level, elapsedMs: 0, levelMs: 0 } };
}

export function withLevelTime(save: Save, levelMs: number): Save {
  return save.run === null ? save : { ...save, run: { ...save.run, levelMs: Math.max(0, Math.round(levelMs)) } };
}

export function finishLevel(save: Save, levelMs: number): { save: Save; finished: Finished | undefined } {
  const run = save.run;
  if (run === null) {
    throw new Error("There is no run in progress");
  }
  const elapsedMs = run.elapsedMs + Math.max(0, Math.round(levelMs));
  const next = run.level + 1;
  const unlocked = Math.min(levelCount, Math.max(save.unlocked, next + 1));
  if (next >= levelCount) {
    return { save: { format: 1, unlocked, run: null }, finished: { totalMs: elapsedMs, ranked: run.start === 0 } };
  }
  return { save: { format: 1, unlocked, run: { start: run.start, level: next, elapsedMs, levelMs: 0 } }, finished: undefined };
}

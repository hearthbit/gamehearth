import type { CatalogSpec, GameOptions, Move } from "@gamehearth/sdk/platform";
import { Worker } from "node:worker_threads";
import type { Finding } from "./findings";
import { createHeartbeat, readHeartbeat, type HeartbeatReading } from "./heartbeat";
import type { GameRun } from "./runner";
import type { Job, WorkerInput, WorkerMessage } from "./worker";

export interface PoolOptions {
  maxMoves: number;
  maxTicks?: number;
  realtime?: boolean;
  away?: boolean;
  catalog?: CatalogSpec;
  timeoutMs: number;
  maxHangs?: number;
  maxTooLong?: number;
  streamMoves?: boolean;
  forwardOutput?: boolean;
  onRun?: (run: GameRun) => void;
}

export type StopReason = "hangs" | "too-long" | "load";

export interface PoolResult {
  runs: GameRun[];
  findings: Finding[];
  stoppedEarly?: StopReason;
  hasBot?: boolean;
}

type Stop =
  | { kind: "done"; skipped: boolean }
  | { kind: "invalid" }
  | { kind: "crashed"; message: string; stack?: string; reading: HeartbeatReading }
  | { kind: "hang"; reading: HeartbeatReading };

const pollMs = 50;

export async function runJobs(workerFile: string, jobs: readonly Job[], options: PoolOptions): Promise<PoolResult> {
  const runs: GameRun[] = [];
  const findings: Finding[] = [];
  const streamed = new Map<number, Move<unknown>[]>();
  const game: { bot?: boolean } = {};
  const maxHangs = options.maxHangs ?? 2;
  let hangs = 0;
  let start = 0;
  const finish = (stoppedEarly?: StopReason): PoolResult => {
    const list = runs.filter((run) => run !== undefined);
    return {
      runs: list,
      findings,
      ...(stoppedEarly === undefined ? {} : { stoppedEarly }),
      ...(game.bot === undefined ? {} : { hasBot: game.bot }),
    };
  };
  while (start < jobs.length) {
    const stop = await runUntilStop(workerFile, jobs, start, options, runs, streamed, game);
    if (stop.kind === "done") {
      return finish(stop.skipped ? "too-long" : undefined);
    }
    if (stop.kind === "invalid") {
      findings.push({
        severity: "error",
        kind: "load",
        message: "src/index.ts must export a game as default: export default defineGame({ setup, legalMoves, apply, result })",
      });
      return finish("load");
    }
    const job = jobs[stop.reading.job] as Job;
    if (stop.kind === "crashed") {
      findings.push(inUnit(crashFinding(stop, job), options));
      if (stop.reading.phase === undefined) {
        return finish("load");
      }
    } else {
      findings.push(inUnit(hangFinding(stop.reading, job, options.timeoutMs), options));
      hangs += 1;
    }
    runs[stop.reading.job] = {
      ...jobWhere(job),
      moves: streamed.get(stop.reading.job) ?? [],
      ending: "failed",
      findings: [],
    };
    start = stop.reading.job + 1;
    if (hangs >= maxHangs && start < jobs.length) {
      return finish("hangs");
    }
  }
  return finish();
}

function runUntilStop(
  workerFile: string,
  jobs: readonly Job[],
  startIndex: number,
  options: PoolOptions,
  runs: GameRun[],
  streamed: Map<number, Move<unknown>[]>,
  game: { bot?: boolean },
): Promise<Stop> {
  const heartbeat = createHeartbeat(startIndex);
  const input: WorkerInput = { jobs: [...jobs], startIndex, maxMoves: options.maxMoves, heartbeat };
  if (options.streamMoves === true) input.streamMoves = true;
  if (options.maxTooLong !== undefined) input.maxTooLong = options.maxTooLong;
  if (options.maxTicks !== undefined) input.maxTicks = options.maxTicks;
  if (options.realtime !== undefined) input.realtime = options.realtime;
  if (options.away === true) input.away = true;
  if (options.catalog !== undefined) input.catalog = options.catalog;
  const worker = new Worker(workerFile, {
    workerData: input,
    stdout: true,
    stderr: true,
    execArgv: [...process.execArgv, "--enable-source-maps"],
  });
  if (options.forwardOutput === true) {
    worker.stdout.pipe(process.stderr);
    worker.stderr.pipe(process.stderr);
  } else {
    worker.stdout.resume();
    worker.stderr.resume();
  }
  return new Promise<Stop>((resolve) => {
    let settled = false;
    let completed: Stop | undefined;
    let lastBeats = -1;
    let lastChange = Date.now();
    const finish = (stop: Stop) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(timer);
      void worker.terminate();
      resolve(stop);
    };
    const timer = setInterval(() => {
      const reading = readHeartbeat(heartbeat);
      if (reading.beats !== lastBeats) {
        lastBeats = reading.beats;
        lastChange = Date.now();
      } else if (Date.now() - lastChange > options.timeoutMs) {
        finish({ kind: "hang", reading });
      }
    }, pollMs);
    worker.on("message", (message: WorkerMessage) => {
      lastChange = Date.now();
      if (message.type === "game") {
        game.bot = message.bot;
      } else if (message.type === "run") {
        runs[message.index] = message.run;
        options.onRun?.(message.run);
      } else if (message.type === "move") {
        const list = streamed.get(message.index) ?? [];
        list.push(message.move);
        streamed.set(message.index, list);
      } else if (message.type === "invalid") {
        finish({ kind: "invalid" });
      } else {
        completed = { kind: "done", skipped: message.skipped };
        setTimeout(() => finish(completed ?? { kind: "done", skipped: false }), 2000).unref();
      }
    });
    worker.on("error", (error) => {
      const reading = readHeartbeat(heartbeat);
      finish(
        error.stack === undefined
          ? { kind: "crashed", message: error.message, reading }
          : { kind: "crashed", message: error.message, stack: error.stack, reading },
      );
    });
    worker.on("exit", (code) => {
      finish(completed ?? { kind: "crashed", message: `The check thread exited with code ${code}`, reading: readHeartbeat(heartbeat) });
    });
  });
}

function inUnit(finding: Finding, options: PoolOptions): Finding {
  return options.realtime === true && finding.step !== undefined ? { ...finding, unit: "tick" } : finding;
}

function crashFinding(stop: Extract<Stop, { kind: "crashed" }>, job: Job): Finding {
  const { reading } = stop;
  if (reading.phase === undefined) {
    const finding: Finding = { severity: "error", kind: "load", message: `The game cannot be loaded: ${stop.message}` };
    if (stop.stack !== undefined) finding.stack = stop.stack;
    return finding;
  }
  const finding: Finding = {
    severity: "error",
    kind: "game-error",
    message: `Game code crashed the check thread: ${stop.message}`,
    ...jobWhere(job),
    step: reading.step,
    phase: reading.phase,
  };
  if (reading.seat >= 0) finding.player = `p${reading.seat + 1}`;
  if (stop.stack !== undefined) finding.stack = stop.stack;
  return finding;
}

function jobWhere(job: Job): { playerCount: number; seed: string; options?: GameOptions; bots?: true } {
  return {
    playerCount: job.playerCount,
    seed: job.seed,
    ...(job.options === undefined || Object.keys(job.options).length === 0 ? {} : { options: job.options }),
    ...(job.bots === true ? { bots: true as const } : {}),
  };
}

function hangFinding(reading: HeartbeatReading, job: Job, timeoutMs: number): Finding {
  const player = reading.seat >= 0 ? `p${reading.seat + 1}` : undefined;
  const what =
    reading.phase === undefined
      ? "Loading the game"
      : (reading.phase === "legalMoves" || reading.phase === "bot") && player !== undefined
        ? `${reading.phase} for ${player}`
        : reading.phase;
  const when = reading.replaying ? " while repeating the match" : "";
  const finding: Finding = {
    severity: "error",
    kind: "hang",
    message: `${what} has not responded${when} for ${timeoutMs} ms, probably an endless loop. Loops need an exit condition that changes in every pass.`,
    ...jobWhere(job),
    step: reading.step,
  };
  if (reading.phase !== undefined) {
    finding.phase = reading.phase;
  }
  if (player !== undefined) {
    finding.player = player;
  }
  return finding;
}

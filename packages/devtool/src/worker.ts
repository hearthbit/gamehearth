import { hasBot, hasPlaceholder, type CatalogSpec, type GameOptions, type Move, type Random } from "@gamehearth/sdk/platform";
import { parentPort, workerData } from "node:worker_threads";
import type { Finding } from "./findings";
import { heartbeatSlots, phaseCodes, takeForbiddenCall, type HeartbeatPhase } from "./heartbeat";
import { findLeaks } from "./leaks";
import { playGame, type AnyGame, type GameRun } from "./runner";

export interface Job {
  playerCount: number;
  seed: string;
  options?: GameOptions;
  decoyPlayerCount?: number;
  bots?: true;
}

export interface WorkerInput {
  jobs: Job[];
  startIndex: number;
  maxMoves: number;
  maxTicks?: number;
  realtime?: boolean;
  away?: boolean;
  catalog?: CatalogSpec;
  heartbeat: Int32Array;
  streamMoves?: boolean;
  maxTooLong?: number;
}

export type WorkerMessage =
  | { type: "game"; bot: boolean }
  | { type: "run"; index: number; run: GameRun }
  | { type: "move"; index: number; move: Move<unknown> }
  | { type: "invalid" }
  | { type: "done"; skipped: boolean };

export function startWorker(candidate: unknown): void {
  const input = workerData as WorkerInput;
  const port = parentPort;
  if (port === null) {
    throw new Error("startWorker only runs in a worker thread");
  }
  if (!isGame(candidate)) {
    port.postMessage({ type: "invalid" } satisfies WorkerMessage);
    return;
  }
  const { heartbeat } = input;
  port.postMessage({ type: "game", bot: hasBot(candidate) } satisfies WorkerMessage);
  let tooLong = 0;
  for (let index = input.startIndex; index < input.jobs.length; index++) {
    const job = input.jobs[index] as Job;
    Atomics.store(heartbeat, heartbeatSlots.job, index);
    takeForbiddenCall(heartbeat);
    const players = Array.from({ length: job.playerCount }, (_, seat) => `p${seat + 1}`);
    const usage = { setupUsedRandom: false, placeholders: false };
    const game = instrument(candidate, heartbeat, players, usage);
    const where = {
      playerCount: job.playerCount,
      seed: job.seed,
      ...(job.options === undefined || Object.keys(job.options).length === 0 ? {} : { options: job.options }),
      ...(job.bots === true ? { bots: true as const } : {}),
    };
    if (job.bots === true && !hasBot(candidate)) {
      const message =
        "The game has no function bot, so there is no match in which the game's bot plays every seat. Without bot, the platform offers no bots for this game; add bot(state, player, moves, ctx) to defineGame (see Bots in the README of the SDK).";
      port.postMessage({ type: "run", index, run: { ...where, moves: [], ending: "failed", findings: [{ severity: "error", kind: "bot", message, ...where }] } } satisfies WorkerMessage);
      continue;
    }
    const options = {
      ...(job.options === undefined ? {} : { gameOptions: job.options }),
      maxMoves: input.maxMoves,
      ...(input.maxTicks === undefined ? {} : { maxTicks: input.maxTicks }),
      ...(input.realtime === undefined ? {} : { realtime: input.realtime }),
      ...(input.catalog === undefined ? {} : { catalog: input.catalog }),
      ...(job.bots === true ? { bots: true } : {}),
      ...(input.away === true ? { away: true } : {}),
      inspect: (match: Parameters<typeof findLeaks>[1], step: number, profiles: Parameters<typeof findLeaks>[3], typed: ReadonlySet<string>) => [
        ...forbiddenFindings(heartbeat, { ...where, step }),
        ...findLeaks(game, match, { ...where, step }, profiles, typed),
      ],
      beforeStep: (step: number, replaying: boolean) => {
        Atomics.store(heartbeat, heartbeatSlots.step, step);
        Atomics.store(heartbeat, heartbeatSlots.replaying, replaying ? 1 : 0);
        Atomics.add(heartbeat, heartbeatSlots.beats, 1);
      },
      ...(input.streamMoves === true
        ? { onMove: (move: Move<unknown>) => port.postMessage({ type: "move", index, move } satisfies WorkerMessage) }
        : {}),
      ...(job.decoyPlayerCount === undefined ? {} : { decoyPlayerCount: job.decoyPlayerCount }),
    };
    const run = playGame(game, job.playerCount, job.seed, options);
    run.setupUsedRandom = usage.setupUsedRandom;
    if (usage.placeholders) {
      run.placeholders = true;
    }
    port.postMessage({ type: "run", index, run } satisfies WorkerMessage);
    if (run.ending === "too-long") {
      tooLong += 1;
      if (input.maxTooLong !== undefined && tooLong >= input.maxTooLong && index + 1 < input.jobs.length) {
        port.postMessage({ type: "done", skipped: true } satisfies WorkerMessage);
        return;
      }
    }
  }
  port.postMessage({ type: "done", skipped: false } satisfies WorkerMessage);
}

function forbiddenFindings(heartbeat: Int32Array, where: { playerCount: number; seed: string; options?: GameOptions; bots?: true; step: number }): Finding[] {
  const call = takeForbiddenCall(heartbeat);
  if (call === undefined) {
    return [];
  }
  return [
    {
      severity: "error",
      kind: "forbidden",
      message: `${call} was called in the game, but the error was caught (try/catch). The call is blocked on the server too, so the game computes with a value it never gets. Randomness comes from ctx.random, the time from ctx.now, date values from the UTC methods.`,
      ...where,
    },
  ];
}

function instrument(game: AnyGame, heartbeat: Int32Array, players: readonly string[], usage: { setupUsedRandom: boolean; placeholders: boolean }): AnyGame {
  const enter = (phase: HeartbeatPhase, player?: string) => {
    Atomics.store(heartbeat, heartbeatSlots.phase, phaseCodes.indexOf(phase) + 1);
    Atomics.store(heartbeat, heartbeatSlots.seat, player === undefined ? -1 : players.indexOf(player));
    Atomics.add(heartbeat, heartbeatSlots.beats, 1);
  };
  return {
    setup: (ctx) => {
      enter("setup");
      return game.setup({ ...ctx, random: ctx.players.length === players.length ? watched(ctx.random, usage) : ctx.random });
    },
    legalMoves: (state, player, ctx) => {
      enter("legalMoves", player);
      const moves = game.legalMoves(state, player, ctx);
      if (!usage.placeholders && hasPlaceholder(moves)) {
        usage.placeholders = true;
      }
      return moves;
    },
    apply: (state, action, ctx) => {
      enter("apply", ctx.player);
      return game.apply(state, action, ctx);
    },
    result: (state) => {
      enter("result");
      return game.result(state);
    },
    ...(typeof game.tick === "function"
      ? {
          tick: (state: Parameters<NonNullable<AnyGame["tick"]>>[0], dt: number, ctx: Parameters<NonNullable<AnyGame["tick"]>>[2]) => {
            enter("tick");
            return game.tick?.(state, dt, ctx);
          },
        }
      : {}),
    ...(typeof game.bot === "function"
      ? {
          bot: (
            state: Parameters<NonNullable<AnyGame["bot"]>>[0],
            player: string,
            moves: Parameters<NonNullable<AnyGame["bot"]>>[2],
            ctx: Parameters<NonNullable<AnyGame["bot"]>>[3],
          ) => {
            enter("bot", player);
            return game.bot?.(state, player, moves, ctx);
          },
        }
      : {}),
  };
}

function watched(random: Random, usage: { setupUsedRandom: boolean }): Random {
  return {
    next: () => {
      usage.setupUsedRandom = true;
      return random.next();
    },
    int: (min, max) => {
      usage.setupUsedRandom = true;
      return random.int(min, max);
    },
    pick: (items) => {
      usage.setupUsedRandom = true;
      return random.pick(items);
    },
    shuffle: (items) => {
      usage.setupUsedRandom = true;
      return random.shuffle(items);
    },
    weighted: (entries) => {
      usage.setupUsedRandom = true;
      return random.weighted(entries);
    },
  };
}

function isGame(value: unknown): value is AnyGame {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const game = value as Record<string, unknown>;
  return ["setup", "legalMoves", "apply", "result"].every((name) => typeof game[name] === "function");
}

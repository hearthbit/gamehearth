import { canonicalJson, seatIds, type AnyGameState, type CatalogSpec, type GameOptions, type Match } from "@gamehearth/sdk/platform";
import type { Finding } from "./findings";
import { ProfileSim, stepFingerprintText } from "./profile-sim";
import { awayAt, awayDetail, fingerprint, realtimeStep, type GameRun } from "./runner";
import { buildGuestRunner } from "./sandbox/build";
import { Sandbox, sandboxDefaults, workerStackSizeBytes, type SandboxResult } from "./sandbox/sandbox";

const serverHint = `Missing there are, among others, console, structuredClone, Intl, TextEncoder, atob and URL; eval, the Function constructor and date methods with local time are blocked, and a call may take at most ${sandboxDefaults.callTimeoutMs} ms.`;

const divergence =
  "On the server (QuickJS) the same match ends up in a different state than here in Node. Common causes: Math.sin, Math.cos, Math.exp, Math.pow, Math.hypot and related functions compute the last digits differently; localeCompare and toLocaleString know no locale there; a comparator for sort does not consistently return negative, 0 or positive. On the server every match stays repeatable in itself, but check has not checked exactly these matches there.";

export const slowTickAverageMs = 10;
export const slowTickMaxMs = 40;

export async function replayInQuickJs(
  code: string,
  runs: readonly GameRun[],
  catalog?: CatalogSpec,
  onRun?: () => void,
): Promise<Finding[]> {
  const catalogJson = catalog === undefined ? undefined : JSON.stringify(catalog);
  const runner = await buildGuestRunner();
  const findings: Finding[] = [];
  const timings: number[] = [];
  for (const run of runs) {
    const fingerprints = run.fingerprints ?? [];
    if (fingerprints.length === 0) {
      onRun?.();
      continue;
    }
    const where = {
      playerCount: run.playerCount,
      seed: run.seed,
      ...(run.options === undefined ? {} : { options: run.options }),
      ...(run.bots === true ? { bots: true as const } : {}),
    };
    let sandbox: Sandbox;
    const fresh = () => Sandbox.create(runner, code, { maxStackSizeBytes: workerStackSizeBytes }, catalogJson);
    try {
      sandbox = await fresh();
    } catch (error) {
      findings.push({
        severity: "error",
        kind: "engine",
        message: `On the server (QuickJS) the game cannot be loaded: ${error instanceof Error ? error.message : String(error)}. ${serverHint}`,
      });
      return findings;
    }
    try {
      const finding = await replayOne(
        () => sandbox,
        async () => {
          sandbox.dispose();
          sandbox = await fresh();
          return sandbox;
        },
        run,
        fingerprints,
        where,
        timings,
        catalog,
      );
      if (finding !== undefined) {
        findings.push(finding);
        if (finding.severity === "error") {
          return findings;
        }
      }
    } finally {
      sandbox.dispose();
      onRun?.();
    }
  }
  const slow = slowTicks(timings, runs[0]?.playerCount);
  if (slow !== undefined) {
    findings.push(slow);
  }
  return findings;
}

function slowTicks(timings: readonly number[], playerCount: number | undefined): Finding | undefined {
  if (timings.length === 0) {
    return undefined;
  }
  const average = timings.reduce((sum, value) => sum + value, 0) / timings.length;
  const sorted = [...timings].sort((a, b) => a - b);
  const high = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
  if (average <= slowTickAverageMs && high <= slowTickMaxMs) {
    return undefined;
  }
  const finding: Finding = {
    severity: "warning",
    kind: "engine",
    message: `A tick takes long on the server (QuickJS). At 20 ticks per second, there are 50 ms for all rooms of the server; above ${slowTickAverageMs} ms on average or ${slowTickMaxMs} ms at peaks it stutters as soon as several rooms are running. Keep the state small (few objects, grids as text or a list of numbers) and do not recompute anything unnecessarily in tick and legalMoves.`,
    detail: `on average ${average.toFixed(1)} ms, at peaks ${high.toFixed(1)} ms per tick including inputs`,
  };
  if (playerCount !== undefined) {
    finding.playerCount = playerCount;
  }
  return finding;
}

async function replayOne(
  current: () => Sandbox,
  renew: () => Promise<Sandbox>,
  run: GameRun,
  fingerprints: readonly string[],
  where: { playerCount: number; seed: string; options?: GameOptions; bots?: true },
  timings: number[],
  catalog: CatalogSpec | undefined,
): Promise<Finding | undefined> {
  const players = seatIds(run.playerCount);
  const realtime = run.ticks !== undefined;
  const options = run.options === undefined ? {} : { options: run.options };
  const sim = new ProfileSim(catalog, players, run.profiles ?? { start: {}, removals: [] });
  const profiles = () => sim.input().profiles;
  let result = current().run("createMatch", JSON.stringify({ playerCount: run.playerCount, seed: run.seed, ...options, profiles: profiles() }), {
    seed: run.seed,
    players,
    ...options,
    version: 0,
    ...(realtime ? { tick: 0 } : {}),
  });
  for (let step = 0; step < fingerprints.length; step++) {
    if (step > 0 && realtime) {
      const match = matchOf(result) as Match<AnyGameState, unknown>;
      for (const removal of sim.removalsAt(step)) {
        sim.remove(removal);
      }
      const stepped = realtimeStep(run.moves, step, run.away, run.bots === true ? players : undefined);
      const input = JSON.stringify({ match, step: stepped, profiles: profiles() });
      const expected = { seed: run.seed, players, ...options, version: match.version + 1, tick: (match.tick ?? 0) + 1, inputs: stepped.inputs.length };
      const started = performance.now();
      result = current().run("stepMatch", input, expected);
      if (!result.ok && result.failure.kind === "timeout") {
        const retried = await renew();
        const again = performance.now();
        result = retried.run("stepMatch", input, expected);
        timings.push(performance.now() - again);
      } else {
        timings.push(performance.now() - started);
      }
    } else if (step > 0) {
      let match = matchOf(result) as Match<AnyGameState, unknown>;
      const removals = sim.removalsAt(step);
      if (removals.length > 0) {
        for (const removal of removals) {
          sim.remove(removal);
        }
        const refreshed = current().run("refreshMatch", JSON.stringify({ match, profiles: profiles() }), { seed: run.seed, players, ...options, version: match.version + 1 });
        const problem = failureOf(refreshed);
        if (problem !== undefined) {
          return { severity: "error", kind: "engine", message: `On the server (QuickJS) recomputing the moves fails, here in Node it does not: ${problem}. ${serverHint}`, ...where, step };
        }
        match = matchOf(refreshed) as Match<AnyGameState, unknown>;
      }
      const move = run.moves[step - 1];
      if (run.bots === true && move !== undefined) {
        const asked = current().run("botMove", JSON.stringify({ match, player: move.player, now: move.now, profiles: profiles() }), { seed: run.seed, players, ...options, version: match.version });
        const problem = failureOf(asked);
        if (problem !== undefined) {
          return { severity: "error", kind: "engine", message: `On the server (QuickJS) asking the bot fails, here in Node it does not: ${problem}. ${serverHint}`, ...where, step, phase: "bot", player: move.player };
        }
        const bot = asked.ok && asked.outcome.ok ? asked.outcome.bot : undefined;
        if (bot !== undefined && bot.action !== undefined && canonicalJson(bot.action) !== canonicalJson(move.action)) {
          return bot.problem === undefined
            ? { severity: "warning", kind: "engine", message: botDivergence, detail: `bot for ${move.player}: here ${short(move.action)}, on the server ${short(bot.action)}`, ...where, step, phase: "bot", player: move.player }
            : { severity: "error", kind: "engine", message: `On the server (QuickJS) the bot fails, here in Node it does not: ${bot.problem}. ${serverHint}`, ...where, step, phase: "bot", player: move.player };
        }
      }
      result = current().run("applyMove", JSON.stringify({ match, move, profiles: profiles() }), { seed: run.seed, players, ...options, version: match.version + 1 });
    }
    const failed = failureOf(result);
    if (failed !== undefined) {
      const during = realtime ? awayDetail(awayAt(run.away, step)) : undefined;
      return {
        severity: "error",
        kind: "engine",
        message: `On the server (QuickJS) the match fails, here in Node it does not: ${failed}. ${serverHint}`,
        ...where,
        step,
        ...(realtime ? { unit: "tick" as const } : {}),
        ...(during === undefined ? {} : { detail: during }),
      };
    }
    const changes = result.ok && result.outcome.ok ? result.outcome.changes : undefined;
    if (fingerprint(stepFingerprintText(matchOf(result), changes)) !== fingerprints[step]) {
      return { severity: "warning", kind: "engine", message: divergence, ...where, step, ...(realtime ? { unit: "tick" as const } : {}) };
    }
    sim.apply(changes);
  }
  return undefined;
}

const botDivergence =
  "On the server (QuickJS) the game's bot picks a different move than here in Node. Common causes: a comparator for sort that does not consistently return negative, 0 or positive; Math.sin, Math.exp, Math.pow and related functions, which compute the last digits differently; localeCompare and toLocaleString, which know no locale there.";

function short(value: unknown): string {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function matchOf(result: SandboxResult): unknown {
  return result.ok && result.outcome.ok ? result.outcome.match : undefined;
}

function failureOf(result: SandboxResult): string | undefined {
  if (!result.ok) {
    return result.failure.message;
  }
  return result.outcome.ok ? undefined : result.outcome.error.message;
}

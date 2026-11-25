import {
  allowedPlayerCounts,
  defaultOptions,
  isPlayerCountAllowed,
  type GameOptions,
  type OptionsSpec,
  type OptionValue,
  type PlayerCountSpec,
} from "@gamehearth/sdk/platform";
import { rmSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildWorker, bundleGameModule, verifyGameBuild } from "./bundle";
import { inspectClient, type ClientFile } from "./client-files";
import { coverProblems } from "./cover";
import { replayInQuickJs } from "./engine";
import { FindingCollector, type Finding } from "./findings";
import { checkIdsLock, idsLockMode, type IdsLockMode } from "./ids-lock";
import { catalogOf, minimumPlaceholderSdk, sdkBelow, untranslatedTexts, validateManifest, type Manifest } from "./manifest";
import { runJobs, type PoolResult } from "./pool";
import { scanSoloClient } from "./solo-scan";
import { defaultMaxSeconds, type GameRun } from "./runner";
import { tickRate } from "@gamehearth/sdk/platform";
import type { Job } from "./worker";

export interface CheckOptions {
  games?: number;
  maxMoves?: number;
  maxSeconds?: number;
  maxTestedPlayers?: number;
  seed?: string;
  players?: number;
  options?: Record<string, string>;
  timeoutMs?: number;
  quickjsGames?: number;
  botGames?: number;
  bots?: boolean;
  idsLock?: IdsLockMode;
  onProgress?: (playerCount: number, done: number, total: number) => void;
  onBotProgress?: (playerCount: number, done: number, total: number) => void;
  onReplay?: (done: number, total: number) => void;
}

export interface CountSummary {
  playerCount: number;
  bots?: true;
  games: number;
  finished: number;
  tooLong: number;
  failed: number;
  averageMoves: number;
  longest: number;
  averageSeconds?: number;
  longestSeconds?: number;
  wins: Record<string, number>;
  withoutWinner: number;
  shared: number;
}

export interface CheckReport {
  gameDir: string;
  manifest?: Manifest;
  settings: { maxMoves: number; maxSeconds: number; timeoutMs: number };
  notes: string[];
  findings: Finding[];
  summaries: CountSummary[];
  replay?: GameRun;
}

export const defaultGames = 200;
export const defaultRealtimeGames = 20;
export const defaultRealtimeQuickJsGames = 2;
export { defaultMaxSeconds };
export const defaultMaxMoves = 5000;
export const defaultMaxTestedPlayers = 8;
export const defaultTimeoutMs = 3000;
export const maxTooLongPerCount = 3;
export const defaultQuickJsGames = 10;
export const defaultBotGames = 10;
export const defaultRealtimeBotGames = 2;
export const botQuickJsGames = 2;
export const realtimeBotQuickJsGames = 1;

export async function checkGame(gameDir: string, options: CheckOptions = {}): Promise<CheckReport> {
  const dir = resolve(gameDir);
  const settings = {
    maxMoves: options.maxMoves ?? defaultMaxMoves,
    maxSeconds: options.maxSeconds ?? defaultMaxSeconds,
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
  };
  const report: CheckReport = { gameDir: dir, settings, notes: [], findings: [], summaries: [] };
  const findings = new FindingCollector();
  const done = () => {
    report.findings = findings.list();
    return report;
  };

  const manifest = await readManifest(dir, findings);
  if (manifest === undefined) {
    return done();
  }
  report.manifest = manifest;
  const lock = await checkIdsLock(dir, manifest, options.idsLock ?? idsLockMode());
  findings.addAll(lock.findings);
  report.notes.push(...lock.notes);
  const catalog = catalogOf(manifest);
  const client = await inspectClient(dir, manifest.client);
  if (!client.ok) {
    for (const problem of client.problems) {
      findings.add({ severity: "error", kind: "client", message: problem });
    }
  } else if (manifest.cover !== undefined) {
    for (const problem of await checkCover(client.dir, client.files, manifest.cover, manifest.client)) {
      findings.add({ severity: "error", kind: "cover", message: problem });
    }
  }
  const untranslated = untranslatedTexts(manifest);
  if (untranslated.length > 0) {
    findings.add({
      severity: "warning",
      kind: "manifest",
      message: `manifest.json: ${untranslated.length === 1 ? "this text is" : "these texts are"} not translated, although the game has the languages ${(manifest.languages ?? []).join(", ")}: ${untranslated.join(", ")}. Give ${untranslated.length === 1 ? "it" : "each"} one text per language, e.g. { ${(manifest.languages ?? []).map((language) => `"${language}": "…"`).join(", ")} }. A text that is the same in every language (a number, a proper name) is fine as it is.`,
    });
  }
  if (!manifest.server) {
    report.notes.push("The game has no reducer (server: false). There are no bot matches; check looks at the manifest, the client and the source code for things that fail in the sandboxed iframe.");
    for (const finding of await scanSoloClient(dir, manifest)) {
      findings.add(finding);
    }
    return done();
  }
  const realtime = manifest.mode === "realtime";
  if (options.players !== undefined && !isPlayerCountAllowed(manifest.players, options.players, Number.MAX_SAFE_INTEGER)) {
    findings.add({
      severity: "error",
      kind: "players",
      message: `According to manifest.json, ${options.players} ${options.players === 1 ? "player is" : "players are"} not allowed (players: ${JSON.stringify(manifest.players)}).`,
    });
    return done();
  }
  const chosen = chosenOptions(manifest.options, options.options ?? {});
  if (typeof chosen === "string") {
    findings.add({ severity: "error", kind: "options", message: chosen });
    return done();
  }
  try {
    await verifyGameBuild(dir);
  } catch (error) {
    findings.add({ severity: "error", kind: "load", message: `The game cannot be built: ${describe(error)}` });
    return done();
  }

  const workDir = await mkdtemp(join(tmpdir(), "gamehearth-check-"));
  const cleanup = () => rmSync(workDir, { recursive: true, force: true });
  process.once("exit", cleanup);
  try {
    const workerFile = join(workDir, "worker.mjs");
    try {
      await buildWorker(dir, workerFile);
    } catch (error) {
      findings.add({ severity: "error", kind: "load", message: buildProblem(error) });
      return done();
    }
    const away = realtime && manifest.away === "play-on";
    const pool = { ...settings, maxTooLong: maxTooLongPerCount, maxTicks: settings.maxSeconds * tickRate, realtime, catalog, ...(away ? { away: true } : {}) };

    if (options.seed !== undefined) {
      const playerCount = options.players ?? manifest.players.min;
      const job: Job = {
        playerCount,
        seed: options.seed,
        decoyPlayerCount: decoyFor(playerCount, manifest.players),
        ...jobOptions(chosen ?? defaultOptions(manifest.options)),
        ...(options.bots === true ? { bots: true as const } : {}),
      };
      const result = await runJobs(workerFile, [job], {
        ...pool,
        streamMoves: true,
        forwardOutput: true,
      });
      findings.addAll(result.findings);
      const run = result.runs[0];
      if (run !== undefined) {
        findings.addAll(run.findings);
        report.replay = run;
        if ((options.quickjsGames ?? (realtime ? defaultRealtimeQuickJsGames : defaultQuickJsGames)) > 0) {
          findings.addAll(await replayInQuickJs(await bundleGameModule(dir), [run], catalog));
        }
      }
      return done();
    }

    const cap = options.maxTestedPlayers ?? defaultMaxTestedPlayers;
    const counts = options.players !== undefined ? [options.players] : countsToTest(manifest.players, cap);
    if (counts.length === 0) {
      findings.add({ severity: "error", kind: "players", message: "According to manifest.json, no player count is allowed; no match could be checked." });
      return done();
    }
    if (options.players === undefined && counts.some((count) => count > cap)) {
      report.notes.push(`Between ${cap} and ${Math.max(...counts)} players, only the minimum and maximum are checked.`);
    } else if (options.players === undefined && manifest.players.max === undefined) {
      report.notes.push(`The manifest names no maximum; at most ${cap} players are checked.`);
    }
    const variants = chosen === undefined ? optionVariants(manifest.options) : [chosen];
    const games = Math.max(options.games ?? (realtime ? defaultRealtimeGames : defaultGames), variants.length);
    if (variants.length > 1) {
      report.notes.push(
        `Options: for each player count, ${variants.length} variants take turns: once all options at their default, then every other value of an option once, with the rest at their default.`,
      );
    }
    if (Object.keys(catalog.items ?? {}).length + Object.keys(catalog.stats ?? {}).length + Object.keys(catalog.flags ?? {}).length > 0) {
      report.notes.push(
        `Profiles: every seat starts with an empty profile (like new players and guests) or one filled at random from the catalog.${Object.keys(catalog.items ?? {}).length > 0 ? ` Between moves, check now and then takes items away, as a parallel match of the same player does${realtime ? "" : ", and has the moves recomputed"}.` : ""}`,
      );
    }
    if (realtime) {
      report.notes.push(
        `Realtime: in every tick, bots press a random legal input with a probability of 20%; a match may last at most ${settings.maxSeconds} seconds of game time.`,
      );
    }
    if (away) {
      report.notes.push(
        'Away: the game plays on without seats that are away ("away": "play-on"). In the random matches, seats go away now and then and come back a few seconds later (at least one seat stays); away seats press nothing, and the game sees them in ctx.away.',
      );
    }
    const botGames = options.botGames ?? (realtime ? defaultRealtimeBotGames : defaultBotGames);
    const outcomes = await Promise.all(
      counts.map(async (playerCount, countIndex) => {
        const decoyPlayerCount = decoyFor(playerCount, manifest.players);
        const jobs: Job[] = Array.from({ length: games }, (_, index) => ({
          playerCount,
          seed: `check-${playerCount}-${index}`,
          decoyPlayerCount,
          ...jobOptions(variants[index % variants.length] as GameOptions),
        }));
        let finished = 0;
        const random = await runJobs(workerFile, jobs, {
          ...pool,
          onRun: () => {
            finished += 1;
            options.onProgress?.(playerCount, finished, games);
          },
        });
        if (botGames === 0 || random.hasBot !== true) {
          return { random };
        }
        const botJobs: Job[] = Array.from({ length: botGames }, (_, index) => ({
          playerCount,
          seed: `check-bots-${playerCount}-${index}`,
          decoyPlayerCount,
          bots: true,
          ...jobOptions(variants[(index + countIndex * botGames) % variants.length] as GameOptions),
        }));
        let played = 0;
        const bots = await runJobs(workerFile, botJobs, {
          ...pool,
          onRun: () => {
            played += 1;
            options.onBotProgress?.(playerCount, played, botGames);
          },
        });
        return { random, bots };
      }),
    );
    const results = outcomes.map((outcome) => outcome.random);
    results.forEach((result, index) => {
      collect(counts[index] as number, result, games, report, findings);
    });
    const botResults = outcomes.flatMap((outcome, index) => (outcome.bots === undefined ? [] : [{ playerCount: counts[index] as number, result: outcome.bots }]));
    if (botResults.length > 0) {
      report.notes.push(
        `Bots: the game has bot, so for every player count ${botGames} more ${botGames === 1 ? "match runs" : "matches run"} in which bot plays every seat${realtime ? " (asked in every tick)" : ""}; problems of bot and matches that do not end there are errors.`,
      );
    }
    for (const { playerCount, result } of botResults) {
      collect(playerCount, result, botGames, report, findings, true);
    }
    if (results.some((result) => result.runs.some((run) => run.placeholders === true)) && sdkBelow(manifest.sdk, minimumPlaceholderSdk)) {
      findings.add({
        severity: "error",
        kind: "manifest",
        message: `legalMoves uses placeholders (text() or int()), so sdk in manifest.json must be at least "^${minimumPlaceholderSdk}"; older servers do not know placeholders.`,
      });
    }
    const quickjsGames = options.quickjsGames ?? (realtime ? defaultRealtimeQuickJsGames : defaultQuickJsGames);
    if (quickjsGames > 0) {
      const code = await bundleGameModule(dir);
      const botReplays = Math.min(quickjsGames, realtime ? realtimeBotQuickJsGames : botQuickJsGames);
      const selected = [
        ...quickjsRuns(
          results.map((result) => result.runs),
          quickjsGames,
        ),
        ...botResults.map(({ result }) => [...result.runs].sort((a, b) => a.seed.localeCompare(b.seed, "en", { numeric: true })).slice(0, botReplays)),
      ];
      const total = selected.reduce((sum, runs) => sum + runs.length, 0);
      let replayed = 0;
      for (const runs of selected) {
        findings.addAll(
          await replayInQuickJs(code, runs, catalog, () => {
            replayed += 1;
            options.onReplay?.(replayed, total);
          }),
        );
      }
      report.notes.push(`${total} matches also replayed in QuickJS, the JS engine of the server.`);
    }
    return done();
  } finally {
    process.removeListener("exit", cleanup);
    await rm(workDir, { recursive: true, force: true });
  }
}

function collect(playerCount: number, result: PoolResult, games: number, report: CheckReport, findings: FindingCollector, bots = false): void {
  const counted = summarize(playerCount, result.runs);
  const summary: CountSummary = bots ? { ...counted, bots: true } : counted;
  const matches = bots ? "matches with the game's bot" : "matches";
  const variantOf = (run: GameRun) => JSON.stringify(run.options ?? {});
  const runsByVariant = new Map<string, GameRun[]>();
  for (const run of result.runs) {
    runsByVariant.set(variantOf(run), [...(runsByVariant.get(variantOf(run)) ?? []), run]);
  }
  const mostlyEndless = new Set(
    [...runsByVariant].filter(([, runs]) => {
      const tooLong = runs.filter((run) => run.ending === "too-long").length;
      return tooLong > 0 && tooLong * 2 >= runs.length;
    }).map(([variant]) => variant),
  );
  findings.addAll(result.findings);
  for (const run of result.runs) {
    for (const finding of run.findings) {
      findings.add(finding.kind === "never-ends" && mostlyEndless.has(variantOf(run)) ? { ...finding, severity: "error" } : finding);
    }
  }
  if (result.stoppedEarly === "hangs") {
    report.notes.push(`With ${playerCount} players, the remaining ${matches} were skipped after repeated hangs.`);
  }
  if (result.stoppedEarly === "too-long") {
    report.notes.push(
      `With ${playerCount} players, the remaining ${games - summary.games}${bots ? ` ${matches}` : ""} were skipped after ${maxTooLongPerCount} matches without an end.`,
    );
  }
  const byVariant = new Map<string, GameRun[]>();
  for (const run of result.runs) {
    if (run.setupFingerprint !== undefined) {
      const key = JSON.stringify(run.options ?? {});
      byVariant.set(key, [...(byVariant.get(key) ?? []), run]);
    }
  }
  const sameStart = [...byVariant.values()].some(
    (setups) => setups.length >= 3 && setups.every((run) => run.setupUsedRandom === true) && new Set(setups.map((run) => run.setupFingerprint)).size === 1,
  );
  if (sameStart) {
    findings.add({
      severity: "warning",
      kind: "suspicious",
      message:
        "setup uses ctx.random, but returns the same start state for every seed. Usually the result is discarded: random.shuffle(list) does not shuffle the list itself, it returns a shuffled copy.",
      playerCount,
    });
  }
  report.summaries.push(summary);
}

export function quickjsRuns(runsPerCount: readonly (readonly GameRun[])[], count: number): GameRun[][] {
  const variantOf = (run: GameRun) => JSON.stringify(run.options ?? {});
  const sortedPerCount = runsPerCount.map((runs) => [...runs].sort((a, b) => a.seed.localeCompare(b.seed, "en", { numeric: true })));
  const picked = sortedPerCount.map((sorted) => new Set(sorted.slice(0, count)));
  const variants = new Set(picked.flatMap((runs) => [...runs].map(variantOf)));
  const fewestPlayersFirst = sortedPerCount
    .map((sorted, index) => ({ sorted, index }))
    .sort((a, b) => (a.sorted[0]?.playerCount ?? 0) - (b.sorted[0]?.playerCount ?? 0));
  for (const { sorted, index } of fewestPlayersFirst) {
    for (const run of sorted) {
      if (!variants.has(variantOf(run))) {
        variants.add(variantOf(run));
        picked[index]?.add(run);
      }
    }
  }
  return sortedPerCount.map((sorted, index) => sorted.filter((run) => picked[index]?.has(run) === true));
}

export function optionVariants(spec: OptionsSpec | undefined): GameOptions[] {
  const base = defaultOptions(spec);
  const variants: GameOptions[] = [base];
  for (const [name, option] of Object.entries(spec ?? {})) {
    const values: OptionValue[] = option.type === "boolean" ? [true, false] : option.choices.map((choice) => choice.value);
    for (const value of values) {
      if (value !== option.default) {
        variants.push({ ...base, [name]: value });
      }
    }
  }
  return variants;
}

export function chosenOptions(spec: OptionsSpec | undefined, raw: Readonly<Record<string, string>>): GameOptions | undefined | string {
  const names = Object.keys(raw);
  if (names.length === 0) {
    return undefined;
  }
  const chosen: Record<string, OptionValue> = { ...defaultOptions(spec) };
  for (const name of names) {
    const option = spec !== undefined && Object.hasOwn(spec, name) ? spec[name] : undefined;
    const text = raw[name] as string;
    if (option === undefined) {
      const known = Object.keys(spec ?? {});
      return known.length === 0
        ? `--option ${name}: the game has no options (options in manifest.json).`
        : `--option ${name}: there is no such option; known options are ${known.join(", ")}.`;
    }
    const values: OptionValue[] = option.type === "boolean" ? [true, false] : option.choices.map((choice) => choice.value);
    const value = values.find((candidate) => String(candidate) === text);
    if (value === undefined) {
      return `--option ${name}=${text}: there is no such value; possible values are ${values.map(String).join(", ")}.`;
    }
    chosen[name] = value;
  }
  return chosen;
}

function jobOptions(options: GameOptions): { options?: GameOptions } {
  return Object.keys(options).length === 0 ? {} : { options };
}

export function countsToTest(spec: PlayerCountSpec, cap: number): number[] {
  const upper = Math.max(cap, spec.max ?? spec.min, spec.min);
  const all = allowedPlayerCounts(spec, upper);
  const first = all[0];
  const last = spec.max === undefined ? undefined : all.at(-1);
  return all.filter((count) => count <= cap || count === first || count === last);
}

function decoyFor(playerCount: number, spec: PlayerCountSpec): number {
  const options = allowedPlayerCounts(spec, Math.max(spec.max ?? spec.min, spec.min, defaultMaxTestedPlayers));
  return options.find((count) => count !== playerCount) ?? playerCount;
}

async function readManifest(dir: string, findings: FindingCollector): Promise<Manifest | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, "manifest.json"), "utf8");
  } catch {
    findings.add({ severity: "error", kind: "manifest", message: `manifest.json is missing in ${dir}` });
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    findings.add({ severity: "error", kind: "manifest", message: `manifest.json is not valid JSON: ${describe(error)}` });
    return undefined;
  }
  const checked = validateManifest(raw);
  if (!checked.ok) {
    for (const problem of checked.problems) {
      findings.add({ severity: "error", kind: "manifest", message: `manifest.json: ${problem}` });
    }
    return undefined;
  }
  return checked.manifest;
}

async function checkCover(clientDir: string, files: readonly ClientFile[], cover: string, clientPath: string): Promise<string[]> {
  const listed = files.some((file) => file.path === cover);
  const data = listed ? await readFile(join(clientDir, ...cover.split("/"))) : undefined;
  return coverProblems(cover, data, clientPath);
}

function buildProblem(error: unknown): string {
  const message = describe(error);
  if (/default/.test(message) && /export/i.test(message)) {
    return "src/index.ts has no default export. The game must be exported like this: export default defineGame({ setup, legalMoves, apply, result })";
  }
  return `The game cannot be built: ${message}`;
}

function summarize(playerCount: number, runs: readonly GameRun[]): CountSummary {
  const finished = runs.filter((run) => run.ending === "finished");
  const lengths = runs.map((run) => run.moves.length);
  const seconds = runs.filter((run) => run.ticks !== undefined).map((run) => (run.ticks ?? 0) / tickRate);
  const wins: Record<string, number> = {};
  let withoutWinner = 0;
  let shared = 0;
  for (const run of finished) {
    const winners = run.result?.winners ?? [];
    if (winners.length === 0) {
      withoutWinner += 1;
    }
    if (winners.length > 1) {
      shared += 1;
    }
    for (const winner of winners) {
      wins[winner] = (wins[winner] ?? 0) + 1;
    }
  }
  return {
    playerCount,
    games: runs.length,
    finished: finished.length,
    tooLong: runs.filter((run) => run.ending === "too-long").length,
    failed: runs.filter((run) => run.ending === "failed").length,
    averageMoves: lengths.length === 0 ? 0 : Math.round(lengths.reduce((sum, length) => sum + length, 0) / lengths.length),
    longest: Math.max(0, ...lengths),
    ...(seconds.length === 0
      ? {}
      : { averageSeconds: Math.round(seconds.reduce((sum, value) => sum + value, 0) / seconds.length), longestSeconds: Math.round(Math.max(...seconds)) }),
    wins,
    withoutWinner,
    shared,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import {
  SeededRandom,
  applyMove,
  botMove,
  canonicalJson,
  createMatch,
  legalMoveFor,
  placeholderTexts,
  randomStateFromSeed,
  refreshMatch,
  sampleMove,
  seatIds,
  stepMatch,
  tickMs,
  tickRate,
  type AnyGameState,
  type CatalogSpec,
  type GameDefinition,
  type GameOptions,
  type GameResult,
  type Match,
  type MatchError,
  type Move,
  type ProfileChange,
  type ProfileData,
} from "@gamehearth/sdk/platform";
import type { Finding } from "./findings";
import { ProfileSim, removalRandom, stepFingerprintText, type ProfileTrace } from "./profile-sim";

export type AnyGame = GameDefinition<AnyGameState, unknown>;
export type AnyMatch = Match<AnyGameState, unknown>;

export type Ending = "finished" | "too-long" | "failed";

export interface AwayChange {
  tick: number;
  seats: string[];
}

export interface GameRun {
  playerCount: number;
  seed: string;
  options?: GameOptions;
  bots?: true;
  moves: Move<unknown>[];
  ticks?: number;
  away?: AwayChange[];
  ending: Ending;
  result?: GameResult;
  setupFingerprint?: string;
  setupUsedRandom?: boolean;
  placeholders?: boolean;
  fingerprints?: string[];
  profiles?: ProfileTrace;
  findings: Finding[];
}

export interface RunOptions {
  gameOptions?: GameOptions;
  maxMoves: number;
  maxTicks?: number;
  realtime?: boolean;
  bots?: boolean;
  away?: boolean;
  decoyPlayerCount?: number;
  catalog?: CatalogSpec;
  inspect?: (match: AnyMatch, step: number, profiles: Record<string, ProfileData>, typed: ReadonlySet<string>) => Finding[];
  beforeStep?: (step: number, replaying: boolean) => void;
  onMove?: (move: Move<unknown>) => void;
}

export const clockStart = 1_767_225_600_000;
export const botInputChance = 0.2;
export const realtimeInspectEvery = 10;
export const defaultMaxSeconds = 600;
export const awayChance = 1 / 200;
export const backChance = 1 / 40;

const snapshotBudget = 20_000_000;

function randomMove(template: unknown, random: SeededRandom, typed?: Set<string>): unknown {
  const action = sampleMove(template, random);
  if (typed !== undefined) {
    placeholderTexts(template, action, typed);
  }
  return action;
}

export function playGame(game: AnyGame, playerCount: number, seed: string, options: RunOptions): GameRun {
  const bot = new SeededRandom(randomStateFromSeed(`bot:${seed}`));
  const moves: Move<unknown>[] = [];
  const typed = new Set<string>();
  const findings: Finding[] = [];
  const where = runWhere(playerCount, seed, options.gameOptions, options.bots);
  const reported = new Set<string>();

  const sim = ProfileSim.fresh(options.catalog, seatIds(playerCount), seed);
  const traced = withTrace(sim);
  const removals = removalRandom(seed);
  options.beforeStep?.(0, false);
  const created = createMatch(game, { ...matchSetup(playerCount, seed, options.gameOptions), ...sim.input() });
  if (!created.ok) {
    findings.push(fromMatchError(created.error, { ...where, step: 0 }));
    return { ...where, moves, ending: "failed", fingerprints: [], ...traced(), findings };
  }
  let match = created.match;
  const mismatch = modeMismatch(match, options, where);
  if (mismatch !== undefined) {
    return { ...where, moves, ending: "failed", fingerprints: [], ...traced(), findings: [mismatch] };
  }
  if (match.tick !== undefined) {
    return playRealtime(game, match, playerCount, seed, options, sim);
  }
  const history = new History();
  history.add(match);
  const setupFingerprint = fingerprint(JSON.stringify(match.state));
  findings.push(...(options.inspect?.(match, 0, sim.current(), typed) ?? []));

  while (match.result === undefined && moves.length < options.maxMoves) {
    const removal = sim.pickRemoval(removals, moves.length + 1);
    if (removal !== undefined) {
      sim.remove(removal);
      const refreshed = refreshMatch(game, JSON.parse(JSON.stringify(match)) as AnyMatch, sim.input());
      if (!refreshed.ok) {
        findings.push({ ...fromMatchError(refreshed.error, { ...where, step: moves.length }), detail: removalDetail(removal) });
        return { ...where, moves, ending: "failed", setupFingerprint, fingerprints: history.fingerprints, ...traced(), findings };
      }
      match = refreshed.match;
    }
    const active = match.players.filter((player) => (match.moves[player] ?? []).length > 0);
    const player = bot.pick(active);
    const now = clockStart + moves.length * 1000;
    let action: unknown;
    if (options.bots === true) {
      options.beforeStep?.(moves.length + 1, false);
      const choice = botMove(game, JSON.parse(JSON.stringify(match)) as AnyMatch, player, { now, ...sim.input() });
      if (choice.problem !== undefined) {
        const finding = botFinding(choice.problem, player, { ...where, step: moves.length + 1 }, reported);
        if (finding !== undefined) {
          findings.push(finding);
        }
      }
      action = choice.action ?? randomMove(bot.pick(match.moves[player] ?? []), bot);
      noteTyped(match.moves[player] ?? [], action, typed);
    } else {
      action = randomMove(bot.pick(match.moves[player] ?? []), bot, typed);
    }
    const move: Move<unknown> = { player, action, now, expectedVersion: match.version };
    moves.push(move);
    options.onMove?.(move);
    options.beforeStep?.(moves.length, false);
    const before = JSON.stringify(match.state);
    const stored = JSON.parse(JSON.stringify(match)) as AnyMatch;
    const outcome = applyMove(game, stored, JSON.parse(JSON.stringify(move)) as Move<unknown>, sim.input());
    if (!outcome.ok) {
      findings.push(
        outcome.error.code === "missing-item"
          ? missingItem(outcome.error.message, player, move.action, { ...where, step: moves.length })
          : fromMatchError(outcome.error, { ...where, step: moves.length }),
      );
      return { ...where, moves, ending: "failed", setupFingerprint, fingerprints: history.fingerprints, ...traced(), findings };
    }
    match = outcome.match;
    const changed = sim.apply(outcome.changes);
    if (changed !== undefined) {
      findings.push({ severity: "error", kind: "game-error", message: `A profile change cannot be applied: ${changed}`, ...where, step: moves.length, player });
      return { ...where, moves, ending: "failed", setupFingerprint, fingerprints: history.fingerprints, ...traced(), findings };
    }
    if (JSON.stringify(match.state) === before && (outcome.changes ?? []).length === 0) {
      findings.push({
        severity: "warning",
        kind: "suspicious",
        message:
          "A legal move does not change the state at all. Usually apply lacks the handling of this move, e.g. a case in the switch. If the move really should do nothing, it does not belong in legalMoves.",
        detail: `${player} ${JSON.stringify(move.action)}`,
        ...where,
        step: moves.length,
        player,
      });
    }
    history.add(match, outcome.changes);
    findings.push(...(options.inspect?.(match, moves.length, sim.current(), typed) ?? []));
  }

  if (match.result === undefined) {
    findings.push(
      options.bots === true
        ? {
            severity: "error",
            kind: "never-ends",
            message: `Matches in which the game's bot plays every seat do not end after ${options.maxMoves} moves. Usually bot keeps picking moves that do not bring the match forward (for example drawing instead of playing a card it could play); let it prefer moves that lead to the end, because bots can fill whole tables on the platform.`,
            ...where,
            step: moves.length,
          }
        : {
            severity: "warning",
            kind: "never-ends",
            message: `Matches do not end after ${options.maxMoves} moves with random bots. Check whether result detects the end or whether the match can go round in circles.`,
            ...where,
            step: moves.length,
          },
    );
  }

  const divergence = replayDivergence(game, playerCount, seed, moves, history, options, sim.trace);
  if (divergence !== undefined) {
    findings.push(nondeterministic(where, divergence));
  }

  const base = { ...where, moves, setupFingerprint, fingerprints: history.fingerprints, ...traced(), findings };
  return match.result === undefined
    ? { ...base, ending: "too-long" }
    : { ...base, ending: "finished", result: match.result };
}

type Where = { playerCount: number; seed: string; options?: GameOptions; bots?: true };

function runWhere(playerCount: number, seed: string, options: GameOptions | undefined, bots: boolean | undefined): Where {
  return {
    playerCount,
    seed,
    ...(options === undefined || Object.keys(options).length === 0 ? {} : { options }),
    ...(bots === true ? { bots: true as const } : {}),
  };
}

function noteTyped(templates: readonly unknown[], action: unknown, typed: Set<string>): void {
  for (const template of templates) {
    if (legalMoveFor([template], action) !== undefined) {
      placeholderTexts(template, action, typed);
      return;
    }
  }
}

type BotTrouble = "throws" | "changes" | "illegal" | "refused";

function botTrouble(problem: string): BotTrouble {
  if (/^the move of the bot was refused/.test(problem)) {
    return "refused";
  }
  if (/chose a move that is not legal/.test(problem)) {
    return "illegal";
  }
  if (/read[- ]only|not extensible|Cannot (assign|add|delete|define)|ctx\.profile\.\w+ does not exist/i.test(problem)) {
    return "changes";
  }
  return "throws";
}

const botFallback = "On the platform the seat then gets a random legal move instead (in realtime: no input in this tick), and the problem goes to the log.";

const botMessages: Record<BotTrouble, string> = {
  throws: `bot threw an error. ${botFallback}`,
  changes: `bot tried to change the state, its moves or the profiles. They are read-only in bot: compute on copies (e.g. [...moves].sort(…)), and change the state only in apply and tick. ${botFallback}`,
  illegal: `bot returned a move that is not legal for this seat right now. Return one of the moves bot gets (with placeholders filled in), or undefined to leave the choice to the platform. ${botFallback}`,
  refused: "The move that bot chose was legal before the step, but apply refused it. Usually the profile no longer allows it (missing-item); let bot pick only moves the profile allows.",
};

export function botFinding(problem: string, player: string, where: Where & { step: number; unit?: "tick" }, reported: Set<string>): Finding | undefined {
  const trouble = botTrouble(problem);
  const key = `${trouble}:${player}`;
  if (reported.has(key)) {
    return undefined;
  }
  reported.add(key);
  return { severity: "error", kind: "bot", message: botMessages[trouble], detail: problem, ...where, phase: "bot", player };
}

export function awayAt(changes: readonly AwayChange[] | undefined, tick: number): string[] {
  let seats: string[] = [];
  for (const change of changes ?? []) {
    if (change.tick > tick) {
      break;
    }
    seats = change.seats;
  }
  return seats;
}

export function nextAway(random: SeededRandom, players: readonly string[], away: readonly string[]): string[] {
  const next = new Set(away);
  for (const player of players) {
    const roll = random.next();
    if (next.has(player)) {
      if (roll < backChance) {
        next.delete(player);
      }
    } else if (roll < awayChance && next.size + 1 < players.length) {
      next.add(player);
    }
  }
  return players.filter((player) => next.has(player));
}

export function awayDetail(away: readonly string[]): string | undefined {
  if (away.length === 0) {
    return undefined;
  }
  return `This happened while ${away.join(", ")} ${away.length === 1 ? "was" : "were"} away (ctx.away: ${JSON.stringify(away)}). With "away": "play-on" the match goes on without seats whose phone is locked, and check lets seats go away and come back at random; apply, tick and bot have to cope with away seats.`;
}

function matchSetup(playerCount: number, seed: string, options: GameOptions | undefined): { playerCount: number; seed: string; options?: GameOptions } {
  return options === undefined ? { playerCount, seed } : { playerCount, seed, options };
}

function withTrace(sim: ProfileSim): () => { profiles?: ProfileTrace } {
  return () => (sim.catalog === undefined || !hasIds(sim.catalog) ? {} : { profiles: sim.trace });
}

function hasIds(catalog: CatalogSpec): boolean {
  return Object.keys(catalog.items ?? {}).length + Object.keys(catalog.stats ?? {}).length + Object.keys(catalog.flags ?? {}).length > 0;
}

function removalDetail(removal: { player: string; item: string; count: number }): string {
  return `Before that, check took ${removal.count} × ${removal.item} away from ${removal.player}, as a parallel match of the same player can; after that, the server recomputes the legal moves.`;
}

function missingItem(message: string, player: string, action: unknown, where: Where & { step: number }): Finding {
  return {
    severity: "error",
    kind: "profile",
    message:
      "legalMoves offers a move for which an item is missing in the profile; apply rejects it at ctx.profile.use, and the player never gets anywhere with this move. legalMoves should only offer moves the profile allows, e.g. only with (ctx.profiles[player]?.items.potion ?? 0) > 0.",
    detail: `${player} ${JSON.stringify(action)}: ${message}`,
    ...where,
    player,
  };
}

function modeMismatch(match: AnyMatch, options: RunOptions, where: Where): Finding | undefined {
  if (options.realtime === undefined || options.realtime === (match.tick !== undefined)) {
    return undefined;
  }
  return {
    severity: "error",
    kind: "manifest",
    message: options.realtime
      ? 'According to manifest.json the game is mode "realtime", but it has no function tick. Realtime games export defineGame({ setup, legalMoves, apply, tick, result }).'
      : 'The game has a function tick, but according to manifest.json it is not mode "realtime". Either set mode to "realtime" or remove tick.',
    ...where,
    step: 0,
  };
}

function playRealtime(game: AnyGame, created: AnyMatch, playerCount: number, seed: string, options: RunOptions, sim: ProfileSim): GameRun {
  const traced = withTrace(sim);
  const removals = removalRandom(seed);
  let reportedMissing = false;
  const bot = new SeededRandom(randomStateFromSeed(`bot:${seed}`));
  const maxTicks = options.maxTicks ?? defaultMaxSeconds * tickRate;
  const typed = new Set<string>();
  const moves: Move<unknown>[] = [];
  const findings: Finding[] = [];
  const where = runWhere(playerCount, seed, options.gameOptions, options.bots);
  const reported = new Set<string>();
  const awayRandom = options.away === true ? new SeededRandom(randomStateFromSeed(`away:${seed}`)) : undefined;
  const awayChanges: AwayChange[] = [];
  let away: string[] = [];
  const withAway = () => (awayChanges.length === 0 ? {} : { away: awayChanges });
  let match = created;
  let ticks = 0;
  const history = new History();
  history.add(match);
  const setupFingerprint = fingerprint(JSON.stringify(match.state));
  findings.push(...tickFindings(options.inspect?.(match, 0, sim.current(), typed) ?? []));

  while (match.result === undefined && ticks < maxTicks) {
    const removal = sim.pickRemoval(removals, ticks + 1);
    if (removal !== undefined) {
      sim.remove(removal);
    }
    const now = clockStart + ticks * tickMs;
    if (awayRandom !== undefined) {
      const next = nextAway(awayRandom, match.players, away);
      if (next.join(",") !== away.join(",")) {
        away = next;
        awayChanges.push({ tick: ticks + 1, seats: next });
      }
    }
    const inputs: { player: string; action: unknown }[] = [];
    if (options.bots !== true) {
      for (const player of match.players) {
        const legal = match.moves[player] ?? [];
        if (legal.length > 0 && bot.next() < botInputChance && !away.includes(player)) {
          inputs.push({ player, action: randomMove(bot.pick(legal), bot, typed) });
        }
      }
    }
    ticks += 1;
    for (const input of inputs) {
      const move: Move<unknown> = { player: input.player, action: input.action, now };
      moves.push(move);
      options.onMove?.(move);
    }
    options.beforeStep?.(ticks, false);
    const stored = JSON.parse(JSON.stringify(match)) as AnyMatch;
    const step = {
      inputs: JSON.parse(JSON.stringify(inputs)) as typeof inputs,
      now,
      dt: tickMs,
      ...(away.length === 0 ? {} : { away: [...away] }),
      ...(options.bots === true ? { bots: match.players.filter((player) => !away.includes(player)) } : {}),
    };
    const outcome = stepMatch(game, stored, step, sim.input());
    if (!outcome.ok) {
      const failed: Finding = { ...fromMatchError(outcome.error, { ...where, step: ticks }), unit: "tick" };
      const during = awayDetail(away);
      findings.push(during === undefined ? failed : { ...failed, detail: during });
      return { ...where, moves, ticks, ...withAway(), ending: "failed", setupFingerprint, fingerprints: history.fingerprints, ...traced(), findings };
    }
    for (const problem of outcome.bots ?? []) {
      const finding = botFinding(problem.message, problem.player, { ...where, step: ticks, unit: "tick" }, reported);
      if (finding !== undefined) {
        findings.push(finding);
      }
    }
    match = outcome.match;
    if (removal === undefined && !reportedMissing) {
      const missing = outcome.results.findIndex((result, index) => !result.ok && result.code === "missing-item" && outcome.results.slice(0, index).every((before) => !before.ok));
      const input = inputs[missing];
      const result = outcome.results[missing];
      if (input !== undefined && result !== undefined && !result.ok) {
        reportedMissing = true;
        findings.push({ ...missingItem(result.message, input.player, input.action, { ...where, step: ticks }), unit: "tick" });
      }
    }
    const changed = sim.apply(outcome.changes);
    if (changed !== undefined) {
      findings.push({ severity: "error", kind: "game-error", message: `A profile change cannot be applied: ${changed}`, ...where, step: ticks, unit: "tick" });
      return { ...where, moves, ticks, ...withAway(), ending: "failed", setupFingerprint, fingerprints: history.fingerprints, ...traced(), findings };
    }
    history.add(match, outcome.changes);
    if (ticks % realtimeInspectEvery === 0 || match.result !== undefined) {
      findings.push(...tickFindings(options.inspect?.(match, ticks, sim.current(), typed) ?? []));
    }
  }

  if (match.result === undefined) {
    findings.push({
      severity: "error",
      kind: "never-ends",
      message:
        options.bots === true
          ? `Matches in which the game's bot plays every seat do not end after ${Math.round(maxTicks / tickRate)} seconds of game time (${maxTicks} ticks). Realtime games need an end that does not depend on what the players do, e.g. a time limit that tick counts down.`
          : `Matches do not end after ${Math.round(maxTicks / tickRate)} seconds of game time (${maxTicks} ticks) with random bots. Realtime games need an end, e.g. a time limit that tick counts down.`,
      ...where,
      step: ticks,
      unit: "tick",
    });
  }

  const divergence = replayRealtimeDivergence(game, playerCount, seed, moves, ticks, history, options, sim.trace, awayChanges);
  if (divergence !== undefined) {
    findings.push({ ...nondeterministic(where, divergence), unit: "tick" });
  }

  const base = { ...where, moves, ticks, ...withAway(), setupFingerprint, fingerprints: history.fingerprints, ...traced(), findings };
  return match.result === undefined ? { ...base, ending: "too-long" } : { ...base, ending: "finished", result: match.result };
}

function tickFindings(findings: Finding[]): Finding[] {
  return findings.map((finding) => (finding.step === undefined ? finding : { ...finding, unit: "tick" }));
}

export function stepInputs(moves: readonly Move<unknown>[], tick: number): { player: string; action: unknown }[] {
  const now = clockStart + (tick - 1) * tickMs;
  return moves.filter((move) => move.now === now).map((move) => ({ player: move.player, action: move.action }));
}

export interface RealtimeStep {
  inputs: { player: string; action: unknown }[];
  now: number;
  dt: number;
  away?: string[];
  bots?: string[];
}

export function realtimeStep(moves: readonly Move<unknown>[], tick: number, awayChanges: readonly AwayChange[] | undefined, bots: readonly string[] | undefined): RealtimeStep {
  const away = awayAt(awayChanges, tick);
  return {
    inputs: stepInputs(moves, tick),
    now: clockStart + (tick - 1) * tickMs,
    dt: tickMs,
    ...(away.length === 0 ? {} : { away: [...away] }),
    ...(bots === undefined ? {} : { bots: bots.filter((seat) => !away.includes(seat)) }),
  };
}

function replayRealtimeDivergence(
  game: AnyGame,
  playerCount: number,
  seed: string,
  moves: readonly Move<unknown>[],
  ticks: number,
  history: History,
  options: RunOptions,
  trace: ProfileTrace,
  awayChanges: readonly AwayChange[],
): Divergence | undefined {
  const decoy = new Decoy(game, options.decoyPlayerCount ?? playerCount, seed, options.gameOptions, options.catalog);
  const sim = new ProfileSim(options.catalog, seatIds(playerCount), trace);
  const diverged = (step: number, actual: AnyMatch | undefined, changes?: readonly ProfileChange[]): Divergence => {
    const detail = history.describe(step, actual, changes);
    return detail === undefined ? { step } : { step, detail };
  };
  options.beforeStep?.(0, true);
  const created = createMatch(game, { ...matchSetup(playerCount, seed, options.gameOptions), ...sim.input() });
  if (!created.ok) {
    return { step: 0, detail: `on the repeat, setup reports: ${created.error.message}` };
  }
  let match = created.match;
  if (!history.matches(0, match)) {
    return diverged(0, match);
  }
  decoy.advance();
  for (let tick = 1; tick <= ticks; tick++) {
    decoy.advance();
    options.beforeStep?.(tick, true);
    for (const removal of sim.removalsAt(tick)) {
      sim.remove(removal);
    }
    const outcome = stepMatch(game, match, realtimeStep(moves, tick, awayChanges, options.bots === true ? match.players : undefined), sim.input());
    if (!outcome.ok) {
      return { step: tick, detail: `on the repeat, the tick fails: ${outcome.error.message}` };
    }
    if (!history.matches(tick, outcome.match, outcome.changes)) {
      return diverged(tick, outcome.match, outcome.changes);
    }
    sim.apply(outcome.changes);
    match = outcome.match;
  }
  return undefined;
}

function nondeterministic(where: Where, divergence: Divergence): Finding {
  const finding: Finding = {
    severity: "error",
    kind: "nondeterministic",
    message:
      divergence.bot === true
        ? "The game's bot picks a different move when the same match is repeated. bot may depend only on state, moves and ctx, and take randomness only from ctx.random, not from variables outside the functions that change between calls. On the server, many matches run at the same time in the same module."
        : "The same match ends up in a different state when repeated. The game depends on something other than state, move and ctx: e.g. on variables outside the functions that setup remembers or that change between matches. On the server, many matches run at the same time in the same module.",
    ...where,
    step: divergence.step,
  };
  if (divergence.bot === true) {
    finding.phase = "bot";
  }
  if (divergence.detail !== undefined) {
    finding.detail = divergence.detail;
  }
  return finding;
}

class History {
  readonly #fingerprints: string[] = [];
  readonly #snapshots: (string | undefined)[] = [];
  #size = 0;

  get fingerprints(): string[] {
    return [...this.#fingerprints];
  }

  add(match: AnyMatch, changes?: readonly ProfileChange[]): void {
    const text = stepFingerprintText(match, changes);
    this.#fingerprints.push(fingerprint(text));
    if (this.#size + text.length <= snapshotBudget) {
      this.#snapshots.push(text);
      this.#size += text.length;
    } else {
      this.#snapshots.push(undefined);
    }
  }

  matches(step: number, match: AnyMatch, changes?: readonly ProfileChange[]): boolean {
    return this.#fingerprints[step] === fingerprint(stepFingerprintText(match, changes));
  }

  describe(step: number, actual: AnyMatch | undefined, changes?: readonly ProfileChange[]): string | undefined {
    const expected = this.#snapshots[step];
    if (expected === undefined || actual === undefined) {
      return undefined;
    }
    return firstDifference(JSON.parse(expected), JSON.parse(stepFingerprintText(actual, changes)), "match");
  }
}

interface Divergence {
  step: number;
  detail?: string;
  bot?: true;
}

function replayDivergence(
  game: AnyGame,
  playerCount: number,
  seed: string,
  moves: readonly Move<unknown>[],
  history: History,
  options: RunOptions,
  trace: ProfileTrace,
): Divergence | undefined {
  const decoy = new Decoy(game, options.decoyPlayerCount ?? playerCount, seed, options.gameOptions, options.catalog);
  const sim = new ProfileSim(options.catalog, seatIds(playerCount), trace);
  const diverged = (step: number, actual: AnyMatch | undefined, changes?: readonly ProfileChange[]): Divergence => {
    const detail = history.describe(step, actual, changes);
    return detail === undefined ? { step } : { step, detail };
  };
  options.beforeStep?.(0, true);
  const created = createMatch(game, { ...matchSetup(playerCount, seed, options.gameOptions), ...sim.input() });
  if (!created.ok) {
    return { step: 0, detail: `on the repeat, setup reports: ${created.error.message}` };
  }
  let match = created.match;
  if (!history.matches(0, match)) {
    return diverged(0, match);
  }
  decoy.advance();
  for (let step = 1; step <= moves.length; step++) {
    decoy.advance();
    options.beforeStep?.(step, true);
    const removals = sim.removalsAt(step);
    if (removals.length > 0) {
      for (const removal of removals) {
        sim.remove(removal);
      }
      const refreshed = refreshMatch(game, match, sim.input());
      if (!refreshed.ok) {
        return { step, detail: `on the repeat, recomputing the moves fails: ${refreshed.error.message}` };
      }
      match = refreshed.match;
    }
    const recorded = moves[step - 1] as Move<unknown>;
    if (options.bots === true) {
      const again = botMove(game, JSON.parse(JSON.stringify(match)) as AnyMatch, recorded.player, { now: recorded.now, ...sim.input() });
      if (again.chosen === "bot" && canonicalJson(again.action) !== canonicalJson(recorded.action)) {
        return { step, bot: true, detail: `bot for ${recorded.player}: on the first run ${short(recorded.action)}, on the repeat ${short(again.action)}` };
      }
    }
    const outcome = applyMove(game, match, recorded, sim.input());
    if (!outcome.ok) {
      return { step, detail: `on the repeat, the move is rejected: ${outcome.error.message}` };
    }
    if (!history.matches(step, outcome.match, outcome.changes)) {
      return diverged(step, outcome.match, outcome.changes);
    }
    sim.apply(outcome.changes);
    match = outcome.match;
  }
  return undefined;
}

class Decoy {
  readonly #game: AnyGame;
  readonly #playerCount: number;
  readonly #seed: string;
  readonly #bot: SeededRandom;
  readonly #options: GameOptions | undefined;
  readonly #catalog: { catalog?: CatalogSpec };
  #match: AnyMatch | undefined;
  #round = 0;

  constructor(game: AnyGame, playerCount: number, seed: string, options: GameOptions | undefined, catalog: CatalogSpec | undefined) {
    this.#game = game;
    this.#playerCount = playerCount;
    this.#seed = seed;
    this.#options = options;
    this.#catalog = catalog === undefined ? {} : { catalog };
    this.#bot = new SeededRandom(randomStateFromSeed(`decoy:${seed}`));
  }

  advance(): void {
    try {
      if (this.#match === undefined || this.#match.result !== undefined) {
        this.#round += 1;
        const created = createMatch(this.#game, { ...matchSetup(this.#playerCount, `decoy:${this.#seed}:${this.#round}`, this.#options), ...this.#catalog });
        this.#match = created.ok ? created.match : undefined;
        return;
      }
      const match = this.#match;
      if (match.tick !== undefined) {
        const inputs = match.players
          .filter((player) => (match.moves[player] ?? []).length > 0 && this.#bot.next() < botInputChance)
          .map((player) => ({ player, action: randomMove(this.#bot.pick(match.moves[player] ?? []), this.#bot) }));
        const stepped = stepMatch(this.#game, match, { inputs, now: clockStart, dt: tickMs }, this.#catalog);
        this.#match = stepped.ok ? stepped.match : undefined;
        return;
      }
      const active = match.players.filter((player) => (match.moves[player] ?? []).length > 0);
      const player = this.#bot.pick(active);
      const outcome = applyMove(
        this.#game,
        match,
        {
          player,
          action: randomMove(this.#bot.pick(match.moves[player] ?? []), this.#bot),
          now: clockStart,
        },
        this.#catalog,
      );
      this.#match = outcome.ok ? outcome.match : undefined;
    } catch {
      this.#match = undefined;
    }
  }
}

export function firstDifference(expected: unknown, actual: unknown, path: string): string | undefined {
  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    return undefined;
  }
  const isObject = (value: unknown) => value !== null && typeof value === "object";
  if (isObject(expected) && isObject(actual) && Array.isArray(expected) === Array.isArray(actual)) {
    const a = expected as Record<string, unknown>;
    const b = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of keys) {
      const childPath = Array.isArray(expected) ? `${path}[${key}]` : `${path}.${key}`;
      const difference = firstDifference(a[key], b[key], childPath);
      if (difference !== undefined) {
        return difference;
      }
    }
  }
  return `${path}: on the first run ${short(expected)}, on the repeat ${short(actual)}`;
}

function short(value: unknown): string {
  const text = value === undefined ? "not present" : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export function fromMatchError(error: MatchError, where: Where & { step: number }): Finding {
  const finding: Finding = {
    severity: "error",
    kind: "game-error",
    message: error.code === "game-error" ? error.message : `Unexpected rejection (${error.code}): ${error.message}`,
    ...where,
  };
  if (error.phase !== undefined) {
    finding.phase = error.phase;
  }
  if (error.player !== undefined) {
    finding.player = error.player;
  }
  if (error.stack !== undefined) {
    finding.stack = gameFrames(error.stack);
  }
  return finding;
}

const platformFrame = /[\\/](sdk|devtool)[\\/]src[\\/]|[\\/]@gamehearth[\\/](sdk|devtool)[\\/]|[\\/]node_modules[\\/]gamehearth[\\/]|gamehearth-check-/;

export function gameFrames(stack: string): string {
  const lines = stack.split("\n");
  const kept = lines.filter((line, index) => index === 0 || !line.trim().startsWith("at ") || !platformFrame.test(line));
  return kept.length > 1 ? kept.join("\n") : stack;
}

export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

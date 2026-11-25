import type { GameDefinition, GameResult } from "./game";
import { canonicalJson, cloneJson, deepFreeze, findNonJson } from "./json";
import { optionsProblem, type GameOptions, type OptionsShape } from "./options";
import { fillPlaceholders, hasPlaceholder, longestFill, placeholderProblem, sampleMove } from "./placeholder";
import type { AnyCatalog, CatalogIds, CatalogInput, ProfileChange, Profiles } from "./profile";
import { ProfileSession, forbiddenWriter } from "./profile-session";
import { SeededRandom, randomStateFromSeed, type RandomState } from "./random";
import { describeStateProblem, seatIds, type AnyGameState, type PlayerId } from "./state";

export const matchFormat = 1;
export const maxActionLength = 16_384;
export const maxActionDepth = 32;
export const tickRate = 20;
export const tickMs = 1000 / tickRate;

export interface Match<S extends AnyGameState, A> {
  format: typeof matchFormat;
  seed: string;
  players: PlayerId[];
  options?: GameOptions;
  state: S;
  moves: Record<PlayerId, A[]>;
  randomState: RandomState;
  version: number;
  tick?: number;
  result?: GameResult;
}

export interface ProfileInput {
  catalog?: CatalogInput;
  profiles?: Readonly<Record<PlayerId, unknown>>;
}

export interface CreateMatchOptions<O extends OptionsShape<O> = GameOptions> extends ProfileInput {
  playerCount: number;
  seed: string;
  options?: O;
}

export interface Move<A> {
  player: PlayerId;
  action: A;
  now: number;
  expectedVersion?: number;
}

export type MatchErrorCode = "game-over" | "unknown-player" | "stale" | "not-your-turn" | "illegal-move" | "missing-item" | "game-error";

export type GamePhase = "setup" | "legalMoves" | "apply" | "result" | "tick" | "bot";

export interface StepInput<A> {
  player: PlayerId;
  action: A;
}

export interface Step<A> {
  inputs: readonly StepInput<A>[];
  now: number;
  dt: number;
  away?: readonly PlayerId[];
  bots?: readonly PlayerId[];
}

export interface BotProblem {
  player: PlayerId;
  message: string;
}

export interface BotInput extends ProfileInput {
  now: number;
  away?: readonly PlayerId[];
}

export type BotOutcome<A> = { ok: true; action?: A; chosen: "bot" | "random" | "none"; problem?: string };

export type InputResult = { ok: true } | { ok: false; code: MatchErrorCode; message: string };

export type StepOutcome<S extends AnyGameState, A> =
  | { ok: true; match: Match<S, A>; results: InputResult[]; changes?: ProfileChange[]; bots?: BotProblem[] }
  | { ok: false; error: MatchError };

export interface MatchError {
  code: MatchErrorCode;
  message: string;
  phase?: GamePhase;
  player?: PlayerId;
  stack?: string;
}

export type MatchOutcome<S extends AnyGameState, A> =
  | { ok: true; match: Match<S, A>; changes?: ProfileChange[] }
  | { ok: false; error: MatchError };

type Failure = { ok: false; error: MatchError };
type Attempt<T> = { ok: true; value: T } | Failure;

interface Draft {
  seed: string;
  players: PlayerId[];
  options?: GameOptions;
  state: unknown;
  randomState: RandomState;
  version: number;
  tick?: number;
  actor?: PlayerId;
}

export function createMatch<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog>(
  game: GameDefinition<S, A, O, C>,
  options: CreateMatchOptions<NoInfer<O>>,
): MatchOutcome<S, A> {
  if (!Number.isSafeInteger(options.playerCount) || options.playerCount < 1) {
    throw new RangeError(`playerCount must be an integer of at least 1, got ${options.playerCount}`);
  }
  if (typeof options.seed !== "string" || options.seed.length === 0) {
    throw new TypeError("seed must be a non-empty string");
  }
  if (options.options !== undefined) {
    const problem = optionsProblem(options.options);
    if (problem !== undefined) {
      throw new TypeError(problem);
    }
  }
  const chosen = options.options === undefined || Object.keys(options.options).length === 0 ? undefined : (cloneJson(options.options) as GameOptions);
  const players = seatIds(options.playerCount);
  const random = new SeededRandom(randomStateFromSeed(options.seed));
  const profiles = new ProfileSession(players, options.catalog, options.profiles).snapshot() as Profiles<C>;
  const setup = runGameCode("setup", undefined, () =>
    game.setup(withForbiddenWriter({ players: [...players], random, options: readOptions<O>(chosen), profiles }, "setup")),
  );
  if (!setup.ok) {
    return setup;
  }
  return settle(game, "setup", profiles, {
    seed: options.seed,
    players,
    ...withOptions(chosen),
    state: setup.value,
    randomState: random.state,
    version: 0,
    ...(isRealtime(game) ? { tick: 0 } : {}),
  });
}

export function applyMove<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog>(
  game: GameDefinition<S, A, O, C>,
  match: Match<S, A>,
  move: Move<A>,
  profiles: ProfileInput = {},
): MatchOutcome<S, A> {
  if (match.format !== matchFormat) {
    throw new Error(`Unknown match format ${String(match.format)}, expected ${matchFormat}`);
  }
  if (typeof move.now !== "number" || !Number.isFinite(move.now)) {
    throw new RangeError(`now must be a point in time in milliseconds, got ${String(move.now)}`);
  }
  const checked = checkMove(match, move);
  if (!checked.ok) {
    return checked;
  }
  const session = new ProfileSession(match.players, profiles.catalog, profiles.profiles);
  const applied = applyChecked(game, match, move.player, checked.action, move.now, match.version + 1, session, []);
  return applied.ok ? withChanges(applied.match, session.changes) : applied;
}

export function refreshMatch<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog>(
  game: GameDefinition<S, A, O, C>,
  match: Match<S, A>,
  profiles: ProfileInput = {},
): MatchOutcome<S, A> {
  if (match.format !== matchFormat) {
    throw new Error(`Unknown match format ${String(match.format)}, expected ${matchFormat}`);
  }
  if (match.result !== undefined) {
    throw new Error("The match is already over, its moves cannot be recomputed");
  }
  if (match.tick !== undefined) {
    throw new Error("Realtime matches recompute their moves with every tick and don't need refreshMatch");
  }
  const session = new ProfileSession(match.players, profiles.catalog, profiles.profiles);
  return settle(game, "refresh", session.snapshot() as Profiles<C>, {
    seed: match.seed,
    players: [...match.players],
    ...withOptions(match.options),
    state: cloneJson(match.state),
    randomState: match.randomState,
    version: match.version + 1,
  });
}

export function stepMatch<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog>(
  game: GameDefinition<S, A, O, C>,
  match: Match<S, A>,
  step: Step<A>,
  profiles: ProfileInput = {},
): StepOutcome<S, A> {
  if (match.format !== matchFormat) {
    throw new Error(`Unknown match format ${String(match.format)}, expected ${matchFormat}`);
  }
  const tick = game.tick;
  if (match.tick === undefined || typeof tick !== "function") {
    throw new Error("stepMatch exists only for realtime matches of a game with tick");
  }
  if (match.result !== undefined) {
    throw new Error("The match is already over, there is no further tick");
  }
  if (typeof step.now !== "number" || !Number.isFinite(step.now)) {
    throw new RangeError(`now must be a point in time in milliseconds, got ${String(step.now)}`);
  }
  if (typeof step.dt !== "number" || !Number.isFinite(step.dt) || step.dt <= 0) {
    throw new RangeError(`dt must be a positive number of milliseconds, got ${String(step.dt)}`);
  }
  const away = seatList(step.away, match.players, "away");
  const bots = seatList(step.bots, match.players, "bots");
  let current = match;
  let session = new ProfileSession(match.players, profiles.catalog, profiles.profiles);
  const changes: ProfileChange[] = [];
  const results: InputResult[] = [];
  const problems: BotProblem[] = [];
  const run = (player: PlayerId, action: unknown): InputResult | Failure => {
    const checked = checkMove(current, { player, action: action as A, now: step.now });
    if (!checked.ok) {
      return { ok: false, code: checked.error.code, message: checked.error.message };
    }
    const attempt = session.fork();
    const applied = applyChecked(game, current, player, checked.action, step.now, match.version, attempt, away);
    if (!applied.ok && applied.error.code === "missing-item") {
      return { ok: false, code: applied.error.code, message: applied.error.message };
    }
    if (!applied.ok) {
      return applied;
    }
    current = applied.match;
    session = attempt;
    changes.push(...attempt.changes);
    return { ok: true };
  };
  for (const input of step.inputs) {
    const outcome = run(input.player, input.action);
    if ("error" in outcome) {
      return outcome;
    }
    results.push(outcome);
  }
  for (const player of bots) {
    if (current.result !== undefined) {
      break;
    }
    const choice = chooseBotMove(game, current, player, { now: step.now, away, profiles: session.snapshot() as Profiles<C> }, "none");
    if (choice.problem !== undefined) {
      problems.push({ player, message: choice.problem });
    }
    if (choice.action === undefined) {
      continue;
    }
    const outcome = run(player, choice.action);
    if ("error" in outcome) {
      return outcome;
    }
    if (!outcome.ok) {
      problems.push({ player, message: `the move of the bot was refused: ${outcome.message}` });
    }
  }
  const version = match.version + 1;
  const ticks = match.tick + 1;
  if (current.result !== undefined) {
    return stepResult({ ...current, version, tick: ticks }, results, changes, problems);
  }
  const random = new SeededRandom(current.randomState);
  const draft = cloneJson(current.state);
  const ticking = session.fork();
  const ticked = runGameCode("tick", undefined, () =>
    tick.call(game, draft, step.dt, {
      players: [...current.players],
      random,
      options: readOptions<O>(current.options),
      now: step.now,
      away: [...away],
      profiles: ticking.live() as Profiles<C>,
      profile: ticking.writer("tick"),
    }),
  );
  const tickFailure = profileFailure(ticking, "tick", undefined);
  if (tickFailure !== undefined) {
    return tickFailure;
  }
  if (!ticked.ok) {
    return ticked;
  }
  changes.push(...ticking.changes);
  const settled = settle(game, "tick", ticking.snapshot() as Profiles<C>, {
    seed: current.seed,
    players: [...current.players],
    ...withOptions(current.options),
    state: ticked.value === undefined ? draft : ticked.value,
    randomState: random.state,
    version,
    tick: ticks,
  });
  return settled.ok ? stepResult(settled.match, results, changes, problems) : settled;
}

export function botMove<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog>(
  game: GameDefinition<S, A, O, C>,
  match: Match<S, A>,
  player: PlayerId,
  input: BotInput,
): BotOutcome<A> {
  if (match.format !== matchFormat) {
    throw new Error(`Unknown match format ${String(match.format)}, expected ${matchFormat}`);
  }
  if (!match.players.includes(player)) {
    throw new RangeError(`${String(player)} is not a seat in this match`);
  }
  if (typeof input.now !== "number" || !Number.isFinite(input.now)) {
    throw new RangeError(`now must be a point in time in milliseconds, got ${String(input.now)}`);
  }
  const away = seatList(input.away, match.players, "away");
  const session = new ProfileSession(match.players, input.catalog, input.profiles);
  return chooseBotMove(game, match, player, { now: input.now, away, profiles: session.snapshot() as Profiles<C> }, match.tick === undefined ? "random" : "none");
}

export function hasBot(game: { bot?: unknown }): boolean {
  return typeof game.bot === "function";
}

function chooseBotMove<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog>(
  game: GameDefinition<S, A, O, C>,
  match: Match<S, A>,
  player: PlayerId,
  context: { now: number; away: readonly PlayerId[]; profiles: Profiles<C> },
  fallback: "random" | "none",
): BotOutcome<A> {
  const available = match.moves[player] ?? [];
  if (match.result !== undefined || available.length === 0) {
    return { ok: true, chosen: "none" };
  }
  const random = new SeededRandom(randomStateFromSeed(`${match.seed}:bot:${player}:${match.version}:${match.tick ?? 0}`));
  const replace = (problem: string | undefined): BotOutcome<A> => {
    if (fallback === "none") {
      return problem === undefined ? { ok: true, chosen: "none" } : { ok: true, chosen: "none", problem };
    }
    const action = sampleMove(available[random.int(0, available.length - 1)], random) as A;
    return problem === undefined ? { ok: true, action, chosen: "random" } : { ok: true, action, chosen: "random", problem };
  };
  const bot = game.bot;
  if (typeof bot !== "function") {
    return replace(undefined);
  }
  const state = deepFreeze(cloneJson(match.state));
  const moves = deepFreeze(cloneJson(available)) as A[];
  const context2 = withForbiddenWriter(
    {
      players: [...match.players],
      random,
      options: readOptions<O>(match.options),
      profiles: context.profiles,
      now: context.now,
      away: Object.freeze([...context.away]),
    },
    "bot",
  );
  const chosen = runGameCode("bot", player, () => bot.call(game, state, player, moves, context2));
  if (!chosen.ok) {
    return replace(`bot for ${player} failed: ${chosen.error.message}`);
  }
  if (chosen.value === undefined || chosen.value === null) {
    return replace(undefined);
  }
  const legal = legalMoveFor(available, chosen.value);
  if (legal === undefined) {
    let shown: string;
    try {
      shown = String(JSON.stringify(chosen.value)).slice(0, 200);
    } catch {
      shown = "a value that is not JSON";
    }
    return replace(`bot for ${player} chose a move that is not legal right now: ${shown}`);
  }
  return { ok: true, action: cloneJson(legal.action) as A, chosen: "bot" };
}

function seatList(list: readonly PlayerId[] | undefined, players: readonly PlayerId[], name: string): PlayerId[] {
  if (list === undefined) {
    return [];
  }
  if (!Array.isArray(list) || list.some((seat) => !players.includes(seat)) || new Set(list).size !== list.length) {
    throw new RangeError(`${name} must be a list of distinct seats of this match`);
  }
  return players.filter((seat) => list.includes(seat));
}

function stepResult<S extends AnyGameState, A>(
  match: Match<S, A>,
  results: InputResult[],
  changes: ProfileChange[],
  bots: BotProblem[] = [],
): StepOutcome<S, A> {
  const base = changes.length === 0 ? { ok: true as const, match, results } : { ok: true as const, match, results, changes: [...changes] };
  return bots.length === 0 ? base : { ...base, bots };
}

function withChanges<S extends AnyGameState, A>(match: Match<S, A>, changes: ProfileChange[]): MatchOutcome<S, A> {
  return changes.length === 0 ? { ok: true, match } : { ok: true, match, changes: [...changes] };
}

function withForbiddenWriter<T extends object>(context: T, where: string): T {
  Object.defineProperty(context, "profile", { value: forbiddenWriter(where), enumerable: false });
  return context;
}

function profileFailure(session: ProfileSession, phase: "apply" | "tick", player: PlayerId | undefined): Failure | undefined {
  const failed = session.failure;
  if (failed === undefined) {
    return undefined;
  }
  if (failed.kind === "missing") {
    return failure("missing-item", failed.message);
  }
  return gameError(phase, player, failed.message, failed.stack);
}

function applyChecked<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog>(
  game: GameDefinition<S, A, O, C>,
  match: Match<S, A>,
  player: PlayerId,
  chosen: A,
  now: number,
  version: number,
  session: ProfileSession,
  away: readonly PlayerId[],
): MatchOutcome<S, A> {
  const random = new SeededRandom(match.randomState);
  const draft = cloneJson(match.state);
  const applied = runGameCode("apply", player, () =>
    game.apply(draft, cloneJson(chosen), {
      players: [...match.players],
      random,
      options: readOptions<O>(match.options),
      player,
      now,
      away: [...away],
      profiles: session.live() as Profiles<C>,
      profile: session.writer("apply"),
    }),
  );
  const failed = profileFailure(session, "apply", player);
  if (failed !== undefined) {
    return failed;
  }
  if (!applied.ok) {
    return applied;
  }
  return settle(game, "apply", session.snapshot() as Profiles<C>, {
    seed: match.seed,
    players: [...match.players],
    ...withOptions(match.options),
    state: applied.value === undefined ? draft : applied.value,
    randomState: random.state,
    version,
    ...(match.tick === undefined ? {} : { tick: match.tick }),
    actor: player,
  });
}

function isRealtime(game: { tick?: unknown }): boolean {
  return typeof game.tick === "function";
}

function readOptions<O>(options: GameOptions | undefined): O {
  return deepFreeze(cloneJson(options ?? {})) as O;
}

function withOptions(options: GameOptions | undefined): { options?: GameOptions } {
  return options === undefined ? {} : { options: cloneJson(options) };
}

export function checkMove<S extends AnyGameState, A>(
  match: Match<S, A>,
  move: Move<A>,
): { ok: true; action: A } | { ok: false; error: MatchError } {
  if (match.result !== undefined) {
    return failure("game-over", "the match is already over");
  }
  if (!match.players.includes(move.player)) {
    return failure("unknown-player", `${String(move.player)} is not a seat in this match`);
  }
  if (move.expectedVersion !== undefined && move.expectedVersion !== match.version) {
    return failure(
      "stale",
      `the move refers to version ${move.expectedVersion}, the match is already at version ${match.version}`,
    );
  }
  const available = match.moves[move.player] ?? [];
  if (available.length === 0) {
    return failure("not-your-turn", `${move.player} cannot move right now`);
  }
  const wanted = canonicalAction(move.action);
  if (!wanted.ok) {
    return wanted;
  }
  const chosen = findLegal(available, wanted.value);
  if (chosen === undefined) {
    return failure("illegal-move", `this move is not allowed for ${move.player} right now`);
  }
  return { ok: true, action: chosen.action as A };
}

export function legalMoveFor(available: readonly unknown[], action: unknown): { action: unknown } | undefined {
  const wanted = canonicalAction(action);
  return wanted.ok ? findLegal(available, wanted.value) : undefined;
}

function findLegal(available: readonly unknown[], canonical: string): { action: unknown } | undefined {
  let parsed: unknown;
  for (const candidate of available) {
    if (!hasPlaceholder(candidate)) {
      if (canonicalJson(candidate) === canonical) {
        return { action: candidate };
      }
      continue;
    }
    parsed ??= JSON.parse(canonical);
    const filled = fillPlaceholders(candidate, parsed);
    if (filled.ok && JSON.stringify(filled.value).length <= maxActionLength) {
      return { action: filled.value };
    }
  }
  return undefined;
}

function canonicalAction(action: unknown): Attempt<string> {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(action);
  } catch {
    return failure("illegal-move", "the move is not a valid JSON value");
  }
  if (serialized === undefined) {
    return failure("illegal-move", "the move is missing");
  }
  if (serialized.length > maxActionLength) {
    return failure("illegal-move", `the move is longer than ${maxActionLength} characters`);
  }
  const problem = findNonJson(action, "action", maxActionDepth);
  if (problem !== undefined) {
    return failure("illegal-move", `${problem.path} ${problem.reason}`);
  }
  return { ok: true, value: canonicalJson(action) };
}

type SettlePhase = "setup" | "apply" | "tick" | "refresh";

function gamePhase(phase: SettlePhase): GamePhase {
  return phase === "refresh" ? "legalMoves" : phase;
}

function settle<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog>(
  game: GameDefinition<S, A, O, C>,
  phase: SettlePhase,
  profiles: Profiles<C>,
  draft: Draft,
): MatchOutcome<S, A> {
  try {
    return settleUnguarded(game, phase, profiles, draft);
  } catch (error) {
    return gameError(
      gamePhase(phase),
      draft.actor,
      `an unexpected error occurred after ${phase}: ${errorMessage(error)}`,
      errorStack(error),
    );
  }
}

function settleUnguarded<S extends AnyGameState, A, O extends OptionsShape<O> = GameOptions, C extends CatalogIds = AnyCatalog>(
  game: GameDefinition<S, A, O, C>,
  phase: SettlePhase,
  profiles: Profiles<C>,
  draft: Draft,
): MatchOutcome<S, A> {
  const stateProblem = describeStateProblem(draft.state, draft.players);
  if (stateProblem !== undefined) {
    return gameError(gamePhase(phase), draft.actor, `${phase} returned an invalid state: ${stateProblem}`);
  }
  const state = cloneJson(draft.state) as S;
  const readOnly = deepFreeze(cloneJson(state));
  const base = {
    format: matchFormat,
    seed: draft.seed,
    players: draft.players,
    ...withOptions(draft.options),
    state,
    randomState: draft.randomState,
    version: draft.version,
    ...(draft.tick === undefined ? {} : { tick: draft.tick }),
  } as const;

  const result = runGameCode("result", undefined, () => game.result(readOnly));
  if (!result.ok) {
    return result;
  }
  if (result.value !== undefined && result.value !== null) {
    const resultProblem = describeResultProblem(result.value, draft.players);
    if (resultProblem !== undefined) {
      return gameError("result", undefined, `result returned an invalid result: ${resultProblem}`);
    }
    const moves = Object.fromEntries(draft.players.map((player) => [player, [] as A[]]));
    return { ok: true, match: { ...base, moves, result: { winners: [...result.value.winners] } } };
  }

  const moves: Record<PlayerId, A[]> = {};
  const context = deepFreeze(withForbiddenWriter({ players: [...draft.players], options: readOptions<O>(draft.options), profiles }, "legalMoves"));
  for (const player of draft.players) {
    const legal = runGameCode("legalMoves", player, () => game.legalMoves(readOnly, player, context));
    if (!legal.ok) {
      return legal;
    }
    if (!Array.isArray(legal.value)) {
      return gameError("legalMoves", player, `legalMoves for ${player} must return an array`);
    }
    const problem = findNonJson(legal.value, `legalMoves(${player})`, maxActionDepth);
    if (problem !== undefined) {
      return gameError("legalMoves", player, `${problem.path} ${problem.reason}`);
    }
    const placeholder = placeholderProblem(legal.value, `legalMoves(${player})`);
    if (placeholder !== undefined) {
      return gameError("legalMoves", player, placeholder);
    }
    const tooLarge = legal.value.findIndex((candidate) => JSON.stringify(candidate).length > maxActionLength);
    if (tooLarge !== -1) {
      return gameError(
        "legalMoves",
        player,
        `legalMoves(${player})[${tooLarge}] is longer than ${maxActionLength} characters and could never be sent`,
      );
    }
    const tooLong = legal.value.findIndex((candidate) => hasPlaceholder(candidate) && longestFill(candidate) > maxActionLength);
    if (tooLong !== -1) {
      return gameError(
        "legalMoves",
        player,
        `legalMoves(${player})[${tooLong}] could become longer than ${maxActionLength} characters when its placeholders are filled (a text character can take 2); lower max of its text() placeholders`,
      );
    }
    moves[player] = cloneJson(legal.value);
  }
  if (draft.tick === undefined && draft.players.every((player) => (moves[player] ?? []).length === 0)) {
    return gameError(
      gamePhase(phase),
      draft.actor,
      phase === "refresh"
        ? "with the changed profiles nobody can move anymore, but result reports no end; the match would hang forever"
        : `after ${phase} nobody can move, but result reports no end; the match would hang forever`,
    );
  }
  return { ok: true, match: { ...base, moves } };
}

function describeResultProblem(result: unknown, players: readonly PlayerId[]): string | undefined {
  if (typeof result !== "object" || result === null || !Array.isArray((result as GameResult).winners)) {
    return "expected an object of the form { winners: [...] }";
  }
  const winners = (result as GameResult).winners;
  for (const winner of winners) {
    if (typeof winner !== "string" || !players.includes(winner)) {
      return `winners contains ${JSON.stringify(winner)}, which is not a seat in this match (seats: ${players.join(", ")})`;
    }
  }
  if (new Set(winners).size !== winners.length) {
    return "winners contains a seat more than once";
  }
  return undefined;
}

function runGameCode<T>(phase: GamePhase, player: PlayerId | undefined, run: () => T): Attempt<T> {
  const label = phase === "legalMoves" && player !== undefined ? `legalMoves for ${player}` : phase;
  try {
    const value = run();
    if (isThenable(value)) {
      Promise.resolve(value).catch(() => undefined);
      return gameError(phase, player, `${label} must not be async or return a Promise`);
    }
    return { ok: true, value };
  } catch (error) {
    return gameError(phase, player, `${label} threw an error: ${errorMessage(error)}`, errorStack(error));
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}

function errorStack(error: unknown): string | undefined {
  try {
    if (error instanceof Error && typeof error.stack === "string") {
      return error.stack.split("\n").slice(0, 8).join("\n");
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function gameError(phase: GamePhase, player: PlayerId | undefined, message: string, stack?: string): Failure {
  const error: MatchError = { code: "game-error", message, phase };
  if (player !== undefined) {
    error.player = player;
  }
  if (stack !== undefined) {
    error.stack = stack;
  }
  return { ok: false, error };
}

function failure(code: MatchErrorCode, message: string): Failure {
  return { ok: false, error: { code, message } };
}

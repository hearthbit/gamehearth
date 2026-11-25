import {
  changeProblem,
  maxActionDepth,
  maxActionLength,
  maxChangesPerCall,
  maxStateDepth,
  type GameOptions,
  type GameResult,
  type InputResult,
  type MatchError,
  type ProfileChange,
} from "@gamehearth/sdk/platform";

export const maxOutputChars = 256 * 1024;
export const maxOutputBytes = 256 * 1024;
export const maxOutputNodes = 20_000;
export const maxMessageChars = 2000;
export const maxStackChars = 4000;

const errorCodes = new Set(["game-over", "unknown-player", "stale", "not-your-turn", "illegal-move", "missing-item", "game-error"]);
const phases = new Set(["setup", "legalMoves", "apply", "result", "tick"]);

export interface Expected {
  seed: string;
  players: readonly string[];
  options?: GameOptions;
  version: number;
  tick?: number;
  inputs?: number;
  bots?: number;
}

export interface GuestMatch {
  format: 1;
  seed: string;
  players: string[];
  options?: GameOptions;
  state: { public: unknown; players: Record<string, unknown>; secret: unknown };
  randomState: [number, number, number, number];
  version: number;
  tick?: number;
  moves: Record<string, unknown[]>;
  result?: GameResult;
}

export interface BotChoice {
  chosen: "bot" | "random" | "none";
  action?: unknown;
  problem?: string;
}

export interface BotNote {
  player: string;
  message: string;
}

export type GuestOutcome =
  | { ok: true; match: GuestMatch; results?: InputResult[]; changes?: ProfileChange[]; bot?: BotChoice; bots?: BotNote[]; hasBot?: boolean }
  | { ok: false; error: MatchError };

export type CheckedOutcome = { ok: true; outcome: GuestOutcome } | { ok: false; problem: string };

export function checkOutcome(json: string, expected: Expected): CheckedOutcome {
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maxOutputBytes) {
    return { ok: false, problem: `the output has ${bytes} bytes, allowed are ${maxOutputBytes}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, problem: "the output is not JSON" };
  }
  if (!isObject(value) || typeof value["ok"] !== "boolean") {
    return { ok: false, problem: "the output lacks the field ok" };
  }
  if (value["ok"] === false) {
    return checkError(value["error"], expected);
  }
  const checked = checkMatch(value["match"], expected);
  if (!checked.ok || !checked.outcome.ok) {
    return checked;
  }
  let outcome: GuestOutcome = checked.outcome;
  if (value["changes"] !== undefined) {
    const changes = checkChanges(value["changes"], expected);
    if (typeof changes === "string") {
      return { ok: false, problem: changes };
    }
    if (changes.length > 0) {
      outcome = { ...outcome, changes };
    }
  }
  if (value["bot"] !== undefined) {
    const bot = checkBot(value["bot"]);
    if (typeof bot === "string") {
      return { ok: false, problem: bot };
    }
    outcome = { ...outcome, bot };
  }
  if (value["hasBot"] !== undefined) {
    if (typeof value["hasBot"] !== "boolean") {
      return { ok: false, problem: "hasBot is not true or false" };
    }
    outcome = { ...outcome, hasBot: value["hasBot"] };
  }
  if (value["bots"] !== undefined) {
    const bots = checkBotNotes(value["bots"], expected.players);
    if (typeof bots === "string") {
      return { ok: false, problem: bots };
    }
    if (bots.length > 0) {
      outcome = { ...outcome, bots };
    }
  }
  if (expected.inputs === undefined) {
    return { ok: true, outcome };
  }
  const results = checkResults(value["results"], expected.inputs);
  return typeof results === "string" ? { ok: false, problem: results } : { ok: true, outcome: { ...outcome, results } };
}

function checkBot(raw: unknown): BotChoice | string {
  if (!isObject(raw) || !["bot", "random", "none"].includes(raw["chosen"] as string)) {
    return "bot has an unknown form";
  }
  const choice: BotChoice = { chosen: raw["chosen"] as BotChoice["chosen"] };
  if (raw["action"] !== undefined) {
    const shape = inspect(raw["action"], maxActionDepth, { nodes: maxOutputNodes });
    if (shape !== undefined || JSON.stringify(raw["action"]).length > maxActionLength) {
      return `the move of the bot is deeper than ${maxActionDepth} levels, too large or not JSON`;
    }
    choice.action = raw["action"];
  }
  if (raw["problem"] !== undefined) {
    if (typeof raw["problem"] !== "string") {
      return "bot.problem is not a text";
    }
    choice.problem = raw["problem"].slice(0, maxMessageChars);
  }
  if ((choice.chosen === "none") !== (choice.action === undefined)) {
    return "bot names a move without choosing one, or chooses one without naming it";
  }
  return choice;
}

function checkBotNotes(raw: unknown, players: readonly string[]): BotNote[] | string {
  if (!Array.isArray(raw) || raw.length > players.length) {
    return `bots must be a list of at most ${players.length} entries`;
  }
  const notes: BotNote[] = [];
  for (const entry of raw) {
    if (!isObject(entry) || !players.includes(entry["player"] as string) || typeof entry["message"] !== "string") {
      return "bots contains an entry of unknown form";
    }
    notes.push({ player: entry["player"] as string, message: entry["message"].slice(0, maxMessageChars) });
  }
  return notes;
}

function checkChanges(raw: unknown, expected: Expected): ProfileChange[] | string {
  const limit = maxChangesPerCall * (1 + (expected.inputs ?? 0) + (expected.bots ?? 0));
  if (!Array.isArray(raw) || raw.length > limit) {
    return `changes must be a list of at most ${limit} profile changes`;
  }
  const changes: ProfileChange[] = [];
  for (const entry of raw) {
    const problem = changeProblem(entry, expected.players);
    if (problem !== undefined) {
      return problem;
    }
    const change = entry as ProfileChange;
    changes.push({ player: change.player, op: change.op, id: change.id, value: change.value });
  }
  return changes;
}

function checkResults(raw: unknown, count: number): InputResult[] | string {
  if (!Array.isArray(raw) || raw.length !== count) {
    return `results does not match the ${count} inputs`;
  }
  const results: InputResult[] = [];
  for (const entry of raw) {
    if (isObject(entry) && entry["ok"] === true) {
      results.push({ ok: true });
    } else if (isObject(entry) && entry["ok"] === false && typeof entry["code"] === "string" && errorCodes.has(entry["code"]) && entry["code"] !== "game-error" && typeof entry["message"] === "string") {
      results.push({ ok: false, code: entry["code"] as MatchError["code"], message: entry["message"].slice(0, maxMessageChars) });
    } else {
      return "results contains an entry of unknown form";
    }
  }
  return results;
}

function checkMatch(match: unknown, expected: Expected): CheckedOutcome {
  if (!isObject(match)) {
    return { ok: false, problem: "match is missing" };
  }
  if (match["format"] !== 1) {
    return { ok: false, problem: "format is not 1" };
  }
  if (match["seed"] !== expected.seed) {
    return { ok: false, problem: "seed was changed" };
  }
  if (!sameList(match["players"], expected.players)) {
    return { ok: false, problem: "players was changed" };
  }
  if (match["version"] !== expected.version) {
    return { ok: false, problem: `version is ${String(match["version"])}, expected ${expected.version}` };
  }
  if (match["tick"] !== expected.tick) {
    return { ok: false, problem: expected.tick === undefined ? "the match has tick, but the game was not started as realtime" : `tick is ${String(match["tick"])}, expected ${expected.tick}` };
  }
  const randomState = match["randomState"];
  if (!Array.isArray(randomState) || randomState.length !== 4 || !randomState.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffffffff)) {
    return { ok: false, problem: "randomState does not have four 32-bit words" };
  }
  const seats = [...expected.players].sort();
  const state = match["state"];
  if (!isObject(state) || !sameList(Object.keys(state).sort(), ["players", "public", "secret"])) {
    return { ok: false, problem: "state does not have exactly public, players and secret" };
  }
  if (!isObject(state["players"]) || !sameList(Object.keys(state["players"]).sort(), seats)) {
    return { ok: false, problem: "state.players does not match the seats" };
  }
  const budget = { nodes: maxOutputNodes };
  const stateShape = inspect(state, maxStateDepth, budget);
  if (stateShape !== undefined) {
    return { ok: false, problem: stateShape === "depth" ? `state is deeper than ${maxStateDepth} levels` : tooManyNodes };
  }
  const moves = match["moves"];
  if (!isObject(moves) || !sameList(Object.keys(moves).sort(), seats)) {
    return { ok: false, problem: "moves does not match the seats" };
  }
  for (const list of Object.values(moves)) {
    if (!Array.isArray(list)) {
      return { ok: false, problem: "moves contains a value that is not a list" };
    }
    for (const action of list) {
      const actionShape = inspect(action, maxActionDepth, budget);
      if (actionShape === "nodes") {
        return { ok: false, problem: tooManyNodes };
      }
      if (actionShape === "depth" || JSON.stringify(action).length > maxActionLength) {
        return { ok: false, problem: `a move is deeper than ${maxActionDepth} levels or longer than ${maxActionLength} characters` };
      }
    }
  }
  let winners: string[] | undefined;
  const result = match["result"];
  if (result !== undefined) {
    if (!isObject(result) || !Array.isArray(result["winners"])) {
      return { ok: false, problem: "result has no winners" };
    }
    const listed = result["winners"] as unknown[];
    if (new Set(listed).size !== listed.length || !listed.every((winner) => expected.players.includes(winner as string))) {
      return { ok: false, problem: "winners contains unknown or duplicate seats" };
    }
    winners = listed as string[];
  }
  const clean: GuestMatch = {
    format: 1,
    seed: expected.seed,
    players: [...expected.players],
    ...(expected.options === undefined || Object.keys(expected.options).length === 0 ? {} : { options: { ...expected.options } }),
    state: state as GuestMatch["state"],
    randomState: randomState as GuestMatch["randomState"],
    version: expected.version,
    ...(expected.tick === undefined ? {} : { tick: expected.tick }),
    moves: moves as GuestMatch["moves"],
    ...(winners === undefined ? {} : { result: { winners } }),
  };
  return { ok: true, outcome: { ok: true, match: clean } };
}

function checkError(error: unknown, expected: Expected): CheckedOutcome {
  if (!isObject(error) || typeof error["code"] !== "string" || !errorCodes.has(error["code"]) || typeof error["message"] !== "string") {
    return { ok: false, problem: "the error of the guest function has an unknown form" };
  }
  if (error["phase"] !== undefined && (typeof error["phase"] !== "string" || !phases.has(error["phase"]))) {
    return { ok: false, problem: "the error of the guest function names an unknown phase" };
  }
  if (error["player"] !== undefined && !expected.players.includes(error["player"] as string)) {
    return { ok: false, problem: "the error of the guest function names an unknown seat" };
  }
  if (error["stack"] !== undefined && typeof error["stack"] !== "string") {
    return { ok: false, problem: "the error of the guest function has an invalid stack" };
  }
  const clean: MatchError = {
    code: error["code"] as MatchError["code"],
    message: (error["message"] as string).slice(0, maxMessageChars),
  };
  if (typeof error["phase"] === "string") {
    clean.phase = error["phase"] as NonNullable<MatchError["phase"]>;
  }
  if (typeof error["player"] === "string") {
    clean.player = error["player"];
  }
  if (typeof error["stack"] === "string") {
    clean.stack = error["stack"].slice(0, maxStackChars);
  }
  return { ok: true, outcome: { ok: false, error: clean } };
}

const tooManyNodes = `State and moves together have more than ${maxOutputNodes} nodes`;

function inspect(value: unknown, depthLimit: number, budget: { nodes: number }): "depth" | "nodes" | undefined {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop() as { value: unknown; depth: number };
    budget.nodes -= 1;
    if (budget.nodes < 0) {
      return "nodes";
    }
    if (frame.value === null || typeof frame.value !== "object") {
      continue;
    }
    if (frame.depth >= depthLimit) {
      return "depth";
    }
    for (const child of Object.values(frame.value)) {
      stack.push({ value: child, depth: frame.depth + 1 });
    }
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameList(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

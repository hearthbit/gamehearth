import { describe, expect, it } from "vitest";
import { connect, type MessageEventLike } from "../src/client";
import {
  applyChange,
  applyMove,
  changeProblem,
  createMatch,
  defineGame,
  emptyProfile,
  maxCatalogItems,
  parsePlatformMessage,
  profileJson,
  profileProblem,
  readProfile,
  refreshMatch,
  stepMatch,
  tickMs,
  validateCatalogSpec,
  type CatalogOf,
  type CatalogSpec,
  type GameState,
  type ProfileData,
} from "../src/platform";
import { expectError, expectMatch } from "./helpers";

const manifest = {
  items: { trank: { label: "Trank" }, muenze: { label: "Münze" }, "alt-schwert": { label: "Altes Schwert", deprecated: true } },
  stats: { siege: { label: "Siege", better: "higher" }, zuege: { label: "Züge" }, bestzeit: { label: "Bestzeit", better: "lower", format: "time" } },
  flags: { held: { label: "Held" }, kapitel: { label: "Kapitel" } },
} as const;

const catalog = manifest as unknown as CatalogSpec;

type Ids = CatalogOf<typeof manifest>;
type State = GameState<{ log: string[]; done: boolean; seen: Record<string, number> }, Record<string, never>, null>;
type Action = { type: "trinken" } | { type: "kaufen" } | { type: "ende" } | { type: "schummeln" } | { type: "abfangen" } | { type: "lesen" };

const game = defineGame<State, Action, Record<string, never>, Ids>({
  setup({ players, profiles }) {
    return {
      public: { log: [], done: false, seen: Object.fromEntries(players.map((player) => [player, profiles[player]?.items.trank ?? 0])) },
      players: Object.fromEntries(players.map((player) => [player, {}])),
      secret: null,
    };
  },
  legalMoves(state, player, { profiles }) {
    if (state.public.done || player !== "p1") {
      return [];
    }
    const moves: Action[] = [{ type: "kaufen" }, { type: "ende" }, { type: "schummeln" }, { type: "abfangen" }, { type: "lesen" }];
    return (profiles[player]?.items.trank ?? 0) > 0 ? [{ type: "trinken" }, ...moves] : moves;
  },
  apply(state, action, { player, profile, profiles }) {
    state.public.log.push(action.type);
    if (action.type === "trinken") {
      profile.use(player, "trank", 1);
      profile.stat(player, "zuege", 1);
    } else if (action.type === "kaufen") {
      profile.use(player, "muenze", 3);
      profile.add(player, "trank", 1);
    } else if (action.type === "ende") {
      profile.stat(player, "siege", 1);
      profile.record(player, "bestzeit", 900);
      profile.flag(player, "held", true);
      profile.flag(player, "kapitel", "3");
      state.public.done = true;
    } else if (action.type === "schummeln") {
      profile.add(player, "trnak" as "trank", 1);
    } else if (action.type === "abfangen") {
      try {
        profile.use(player, "trank", 99);
      } catch {
        state.public.log.push("abgefangen");
      }
    } else {
      profile.add(player, "trank", 2);
      state.public.seen[player] = profiles[player]?.items.trank ?? -1;
    }
  },
  result(state) {
    return state.public.done ? { winners: ["p1"] } : undefined;
  },
});

const now = 1_000;

function profile(items: Record<string, number> = {}, stats: Record<string, number> = {}, flags: Record<string, string | true> = {}): ProfileData {
  return { items, stats, flags };
}

describe("Catalog in the manifest", () => {
  it("accepts items, stats with and without better and flags including deprecated", () => {
    expect(validateCatalogSpec(manifest, false)).toEqual([]);
  });

  it("requires better for best scores of single-player games without a reducer and limits them to 10", () => {
    expect(validateCatalogSpec({ stats: { zuege: { label: "Züge" } } }, true).join()).toMatch(/better is missing/);
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`s${index}`, { label: "x", better: "higher" }]));
    expect(validateCatalogSpec({ stats: many }, true).join()).toMatch(/at most 10/);
    expect(validateCatalogSpec({ stats: many }, false)).toEqual([]);
  });

  it("reports wrong names, fields, display names and too many entries", () => {
    const problems = validateCatalogSpec(
      {
        items: { Gross: { label: "x" }, constructor: { label: "x" }, ok: { label: "" }, extra: { label: "x", wert: 3 } },
        stats: { s: { label: "x", better: "mehr" }, t: { label: "x", format: "datum" } },
        flags: { f: { label: "x", deprecated: "ja" } },
      },
      false,
    ).join("\n");
    expect(problems).toMatch(/items\.Gross: names consist/);
    expect(problems).toMatch(/items\.constructor: this name is already taken in JavaScript/);
    expect(problems).toMatch(/items\.ok\.label/);
    expect(problems).toMatch(/items\.extra\.wert is unknown/);
    expect(problems).toMatch(/stats\.s\.better/);
    expect(problems).toMatch(/stats\.t\.format/);
    expect(problems).toMatch(/flags\.f\.deprecated/);
    const items = Object.fromEntries(Array.from({ length: maxCatalogItems + 1 }, (_, index) => [`i${index}`, { label: "x" }]));
    expect(validateCatalogSpec({ items }, false).join()).toMatch(/at most 1000/);
    expect(validateCatalogSpec({ flags: {} }, false).join()).toMatch(/must not be empty/);
  });
});

describe("Operations on a profile", () => {
  it("counts items up and down and removes empty ones", () => {
    const data = emptyProfile();
    expect(applyChange(data, { op: "add", id: "trank", value: 2 }, catalog)).toBeUndefined();
    expect(applyChange(data, { op: "use", id: "trank", value: 2 }, catalog)).toBeUndefined();
    expect(data.items).toEqual({});
    expect(applyChange(data, { op: "use", id: "trank", value: 1 }, catalog)).toEqual({ kind: "missing", have: 0, message: 'Missing "trank": needed 1, available 0' });
  });

  it("keeps the better value with record depending on better and rejects record on counters", () => {
    const data = emptyProfile();
    applyChange(data, { op: "record", id: "siege", value: 3 }, catalog);
    applyChange(data, { op: "record", id: "siege", value: 2 }, catalog);
    applyChange(data, { op: "record", id: "bestzeit", value: 900 }, catalog);
    applyChange(data, { op: "record", id: "bestzeit", value: 1200 }, catalog);
    expect(data.stats).toEqual({ siege: 3, bestzeit: 900 });
    expect(applyChange(data, { op: "record", id: "zuege", value: 1 }, catalog)?.message).toMatch(/no better in manifest.json and is therefore a counter/);
    applyChange(data, { op: "stat", id: "siege", value: -1 }, catalog);
    expect(data.stats["siege"]).toBe(2);
  });

  it("sets flags with true or text and deletes them with false", () => {
    const data = emptyProfile();
    applyChange(data, { op: "flag", id: "held", value: true }, catalog);
    applyChange(data, { op: "flag", id: "kapitel", value: "3" }, catalog);
    applyChange(data, { op: "flag", id: "held", value: false }, catalog);
    expect(data.flags).toEqual({ kapitel: "3" });
    expect(applyChange(data, { op: "flag", id: "kapitel", value: "" }, catalog)?.kind).toBe("invalid");
    expect(applyChange(data, { op: "flag", id: "kapitel", value: "x".repeat(201) }, catalog)?.kind).toBe("invalid");
  });

  it("rejects unknown names with a suggestion, deprecated ones stay allowed", () => {
    const data = emptyProfile();
    expect(applyChange(data, { op: "add", id: "trnak", value: 1 }, catalog)?.message).toMatch(/did you mean "trank"\?/);
    expect(applyChange(data, { op: "add", id: "alt-schwert", value: 1 }, catalog)).toBeUndefined();
    expect(applyChange(data, { op: "add", id: "trank", value: 0 }, catalog)?.message).toMatch(/integer n of at least 1/);
    expect(applyChange(data, { op: "stat", id: "siege", value: Number.NaN }, catalog)?.kind).toBe("invalid");
    expect(applyChange(data, { op: "flag", id: "held", value: true }, undefined)?.message).toMatch(/nothing is listed there yet/);
  });

  it("checks profiles and changes from outside", () => {
    expect(profileProblem({ items: { trank: 0 }, stats: {}, flags: {} })).toMatch(/at least 1/);
    expect(profileProblem({ items: {}, stats: { s: Infinity }, flags: {} })).toMatch(/finite number/);
    expect(profileProblem({ items: {}, stats: {}, flags: { f: false } })).toMatch(/true or a text/);
    expect(profileProblem({ items: {}, extra: {} })).toMatch(/unknown field/);
    expect(readProfile({ items: { trank: 2 } })).toEqual({ items: { trank: 2 }, stats: {}, flags: {} });
    expect(changeProblem({ player: "p1", op: "add", id: "trank", value: 1 }, ["p1"])).toBeUndefined();
    expect(changeProblem({ player: "p3", op: "add", id: "trank", value: 1 }, ["p1"])).toMatch(/seat that is not in the match/);
    expect(changeProblem({ player: "p1", op: "max", id: "trank", value: 1 }, ["p1"])).toMatch(/unknown operation/);
    expect(profileJson({ items: { b: 1, a: 2 }, stats: {}, flags: {} })).toBe('{"items":{"a":2,"b":1},"stats":{},"flags":{}}');
  });
});

describe("Profiles in matches", () => {
  const start = (profiles: Record<string, ProfileData> = {}) => expectMatch(createMatch(game, { playerCount: 2, seed: "s", catalog, profiles }));

  it("shows setup and legalMoves the profiles of all seats", () => {
    const match = start({ p1: profile({ trank: 2 }), p2: profile({ trank: 5 }) });
    expect(match.state.public.seen).toEqual({ p1: 2, p2: 5 });
    expect(match.moves["p1"]?.[0]).toEqual({ type: "trinken" });
    expect(start().moves["p1"]?.[0]).toEqual({ type: "kaufen" });
  });

  it("returns the changes of a move and computes the moves with the new profile", () => {
    const match = start({ p1: profile({ muenze: 3 }) });
    const bought = applyMove(game, match, { player: "p1", action: { type: "kaufen" }, now }, { catalog, profiles: { p1: profile({ muenze: 3 }) } });
    expect(bought.ok && bought.changes).toEqual([
      { player: "p1", op: "use", id: "muenze", value: 3 },
      { player: "p1", op: "add", id: "trank", value: 1 },
    ]);
    expect(expectMatch(bought).moves["p1"]?.[0]).toEqual({ type: "trinken" });
  });

  it("already shows writes of the same call in ctx.profiles", () => {
    const match = start({ p1: profile({ trank: 1 }) });
    const read = expectMatch(applyMove(game, match, { player: "p1", action: { type: "lesen" }, now }, { catalog, profiles: { p1: profile({ trank: 1 }) } }));
    expect(read.state.public.seen["p1"]).toBe(3);
  });

  it("rejects a move with a missing item as missing-item, even if the game catches the error", () => {
    const match = start({ p1: profile({ trank: 1 }) });
    const gone = expectError(applyMove(game, match, { player: "p1", action: { type: "trinken" }, now }, { catalog, profiles: { p1: profile() } }));
    expect(gone).toEqual({ code: "missing-item", message: 'p1: Missing "trank": needed 1, available 0' });
    const caught = expectError(applyMove(game, match, { player: "p1", action: { type: "abfangen" }, now }, { catalog, profiles: { p1: profile({ trank: 1 }) } }));
    expect(caught.code).toBe("missing-item");
  });

  it("reports unknown names as an error in the game code with the location", () => {
    const match = start();
    const error = expectError(applyMove(game, match, { player: "p1", action: { type: "schummeln" }, now }, { catalog }));
    expect(error.code).toBe("game-error");
    expect(error.phase).toBe("apply");
    expect(error.player).toBe("p1");
    expect(error.message).toMatch(/The item "trnak" is not listed under items in manifest.json; did you mean "trank"\?/);
    expect(error.stack).toMatch(/profile\.test\.ts/);
  });

  it("allows no writing in setup and legalMoves", () => {
    const writing = defineGame<State, Action>({
      ...(game as unknown as Parameters<typeof defineGame<State, Action>>[0]),
      setup(ctx) {
        (ctx as unknown as { profile: { add(...args: unknown[]): void } }).profile.add("p1", "trank", 1);
        return game.setup(ctx as never);
      },
    });
    expect(expectError(createMatch(writing, { playerCount: 1, seed: "s", catalog })).message).toMatch(/ctx\.profile\.add does not exist in setup/);
    const peeking = defineGame<State, Action>({
      ...(game as unknown as Parameters<typeof defineGame<State, Action>>[0]),
      legalMoves(_state, _player, ctx) {
        (ctx as unknown as { profile: { stat(...args: unknown[]): void } }).profile.stat("p1", "siege", 1);
        return [];
      },
    });
    expect(expectError(createMatch(peeking, { playerCount: 1, seed: "s", catalog })).message).toMatch(/ctx\.profile\.stat does not exist in legalMoves/);
  });

  it("writes stats, best scores and flags at the end", () => {
    const match = start({ p1: profile({}, { siege: 4, bestzeit: 1000 }) });
    const ended = applyMove(game, match, { player: "p1", action: { type: "ende" }, now }, { catalog, profiles: { p1: profile({}, { siege: 4, bestzeit: 1000 }) } });
    expect(ended.ok && ended.match.result).toEqual({ winners: ["p1"] });
    const data = readProfile({ items: {}, stats: { siege: 4, bestzeit: 1000 }, flags: {} });
    for (const change of ended.ok ? (ended.changes ?? []) : []) {
      applyChange(data, change, catalog);
    }
    expect(data).toEqual({ items: {}, stats: { siege: 5, bestzeit: 900 }, flags: { held: true, kapitel: "3" } });
  });

  it("recomputes the moves with new profiles and increases the version", () => {
    const match = start({ p1: profile({ trank: 1 }) });
    const refreshed = expectMatch(refreshMatch(game, match, { catalog, profiles: { p1: profile() } }));
    expect(refreshed.version).toBe(match.version + 1);
    expect(refreshed.state).toEqual(match.state);
    expect(refreshed.moves["p1"]?.[0]).toEqual({ type: "kaufen" });
    const ended = expectMatch(applyMove(game, match, { player: "p1", action: { type: "ende" }, now }, { catalog }));
    expect(() => refreshMatch(game, ended, { catalog })).toThrow(/already over/);
  });
});

type TickState = GameState<{ ticks: number; inputs: string[] }, Record<string, never>, null>;
type TickAction = { type: "nimm" } | { type: "trink" };

describe("Profiles in realtime", () => {
  const ticking = defineGame<TickState, TickAction, Record<string, never>, Ids>({
    setup: ({ players }) => ({ public: { ticks: 0, inputs: [] }, players: Object.fromEntries(players.map((player) => [player, {}])), secret: null }),
    legalMoves: (state) => (state.public.ticks < 100 ? [{ type: "nimm" }, { type: "trink" }] : []),
    apply(state, action, { player, profile }) {
      state.public.inputs.push(`${player}:${action.type}`);
      if (action.type === "trink") {
        profile.use(player, "trank", 1);
      } else {
        profile.add(player, "muenze", 1);
      }
    },
    tick(state, _dt, { profile, profiles }) {
      state.public.ticks += 1;
      if ((profiles["p1"]?.items.muenze ?? 0) >= 2) {
        profile.stat("p1", "zuege", 1);
      }
    },
    result: (state) => (state.public.ticks >= 100 ? { winners: [] } : undefined),
  });

  it("skips inputs with a missing item and collects only changes of successful inputs", () => {
    const match = expectMatch(createMatch(ticking, { playerCount: 2, seed: "t", catalog }));
    const stepped = stepMatch(
      ticking,
      match,
      {
        inputs: [
          { player: "p1", action: { type: "nimm" } },
          { player: "p2", action: { type: "trink" } },
          { player: "p1", action: { type: "nimm" } },
        ],
        now,
        dt: tickMs,
      },
      { catalog, profiles: { p1: profile(), p2: profile() } },
    );
    expect(stepped.ok).toBe(true);
    if (!stepped.ok) {
      return;
    }
    expect(stepped.results.map((result) => (result.ok ? "ok" : result.code))).toEqual(["ok", "missing-item", "ok"]);
    expect(stepped.match.state.public.inputs).toEqual(["p1:nimm", "p1:nimm"]);
    expect(stepped.changes).toEqual([
      { player: "p1", op: "add", id: "muenze", value: 1 },
      { player: "p1", op: "add", id: "muenze", value: 1 },
      { player: "p1", op: "stat", id: "zuege", value: 1 },
    ]);
  });

  it("forbids use in tick", () => {
    const greedy = defineGame<TickState, TickAction, Record<string, never>, Ids>({
      ...ticking,
      tick(_state, _dt, { profile }) {
        (profile as unknown as { use(...args: unknown[]): void }).use("p1", "trank", 1);
      },
    });
    const match = expectMatch(createMatch(greedy, { playerCount: 1, seed: "t", catalog }));
    const error = expectError(stepMatch(greedy, match, { inputs: [], now, dt: tickMs }, { catalog, profiles: { p1: profile({ trank: 3 }) } }) as never);
    expect(error.phase).toBe("tick");
    expect(error.message).toMatch(/ctx\.profile\.use exists only in apply, not in tick/);
  });
});

describe("Profile in the client", () => {
  const players = { p1: { name: "Anna", connected: true, you: true } };
  const update = (extra: Record<string, unknown>) => ({
    gamehearth: 1,
    type: "update",
    seat: "p1",
    role: "player",
    snapshot: { player: "p1", players: ["p1"], public: {}, me: {}, moves: [], version: 1 },
    players,
    online: true,
    ...extra,
  });

  it("accepts the own profile and rejects broken profiles and profiles on the TV", () => {
    const parsed = parsePlatformMessage(update({ profile: { items: { trank: 2 }, stats: {}, flags: { held: true } } }));
    expect(parsed?.type === "update" && parsed.profile).toEqual({ items: { trank: 2 }, stats: {}, flags: { held: true } });
    expect(parsePlatformMessage(update({ profile: { items: { trank: -1 }, stats: {}, flags: {} } }))).toBeUndefined();
    expect(parsePlatformMessage(update({ seat: null, role: "screen", profile: emptyProfile() }))).toBeUndefined();
  });

  it("gives the game its own profile frozen, and an empty one without a profile", async () => {
    const listeners = new Set<(event: MessageEventLike) => void>();
    const parent = { postMessage: () => undefined };
    const events = {
      addEventListener: (_type: "message", listener: (event: MessageEventLike) => void) => listeners.add(listener),
      removeEventListener: (_type: "message", listener: (event: MessageEventLike) => void) => listeners.delete(listener),
    };
    const pending = connect<State, Action, Record<string, never>, Ids>({ parent, events });
    for (const listener of [...listeners]) {
      listener({ data: update({}), source: parent });
    }
    const connection = await pending;
    expect(connection.current.profile).toEqual({ items: {}, stats: {}, flags: {} });
    for (const listener of [...listeners]) {
      listener({ data: update({ profile: { items: { trank: 2 }, stats: { siege: 1 }, flags: {} } }), source: parent });
    }
    expect(connection.current.profile.items.trank).toBe(2);
    expect(Object.isFrozen(connection.current.profile.items)).toBe(true);
  });
});

describe("Review 10b", () => {
  it("reports only profile changes with an effect", () => {
    const quiet = defineGame<State, Action, Record<string, never>, Ids>({
      ...game,
      apply(state, _action, { player, profile }) {
        state.public.log.push("still");
        profile.record(player, "siege", 2);
        profile.record(player, "bestzeit", 1500);
        profile.stat(player, "zuege", 0);
        profile.flag(player, "held", true);
        profile.flag(player, "kapitel", false);
        profile.add(player, "muenze", 1);
      },
    });
    const profiles = { p1: profile({}, { siege: 5, bestzeit: 900, zuege: 3 }, { held: true }) };
    const match = expectMatch(createMatch(quiet, { playerCount: 1, seed: "s", catalog, profiles }));
    const applied = applyMove(quiet, match, { player: "p1", action: { type: "kaufen" }, now }, { catalog, profiles });
    expect(applied.ok && applied.changes).toEqual([{ player: "p1", op: "add", id: "muenze", value: 1 }]);
  });
});

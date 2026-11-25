import { describe, expect, it } from "vitest";
import { defineGame, int, isPlaceholder, text, type GameState } from "../src/index";
import {
  SeededRandom,
  applyMove,
  maxActionLength,
  createMatch,
  fillPlaceholders,
  legalMoveFor,
  placeholderTexts,
  randomStateFromSeed,
  sampleMove,
  stepMatch,
  textProblem,
  type Match,
} from "../src/platform";
import { expectError, expectMatch } from "./helpers";

type Action = { type: "guess"; text: string } | { type: "dot"; x: number; y: number; pts: string } | { type: "done" };
type State = GameState<{ guesses: string[]; dots: number[] }, { done: boolean }, Record<string, never>>;

const points = "0123456789abcdef";

function guessGame(legal?: (player: string) => Action[]) {
  return defineGame<State, Action>({
    setup({ players }) {
      return { public: { guesses: [], dots: [] }, players: Object.fromEntries(players.map((p) => [p, { done: false }])), secret: {} };
    },
    legalMoves(state, player) {
      if (legal !== undefined) return legal(player);
      if (state.players[player]?.done) return [];
      return [{ type: "guess", text: text({ min: 1, max: 12 }) }, { type: "dot", x: int({ min: 0, max: 99 }), y: int({ min: -5, max: 5 }), pts: text({ max: 8, chars: points }) }, { type: "done" }];
    },
    apply(state, action, { player }) {
      if (action.type === "guess") state.public.guesses.push(action.text);
      if (action.type === "dot") state.public.dots.push(action.x, action.y, action.pts.length);
      if (action.type === "done") state.players[player]!.done = true;
    },
    result(state) {
      return Object.values(state.players).every((area) => area.done) ? { winners: [] } : undefined;
    },
  });
}

function start(game = guessGame()): Match<State, Action> {
  return expectMatch(createMatch(game, { playerCount: 2, seed: "placeholders" }));
}

function move(match: Match<State, Action>, action: unknown, game = guessGame()) {
  return applyMove(game, match, { player: "p1", action: action as Action, now: 1 });
}

describe("Placeholders in legalMoves", () => {
  it("text() and int() create placeholder objects at runtime", () => {
    expect(text({ max: 5 })).toEqual({ $text: { max: 5 } });
    expect(text({ min: 1, max: 5, chars: "ab" })).toEqual({ $text: { max: 5, min: 1, chars: "ab" } });
    expect(int({ min: 1, max: 3 })).toEqual({ $int: { min: 1, max: 3 } });
    expect(isPlaceholder(text({ max: 5 }))).toBe(true);
    expect(isPlaceholder({ $text: { max: 5 }, other: 1 })).toBe(false);
    expect(isPlaceholder("x")).toBe(false);
  });

  it("stores the placeholders as legal moves", () => {
    const match = start();
    expect(match.moves["p1"]?.[0]).toEqual({ type: "guess", text: { $text: { min: 1, max: 12 } } });
  });

  it("accepts a text within the limits and passes the concrete move to apply", () => {
    const after = expectMatch(move(start(), { type: "guess", text: "Leuchtturm" }));
    expect(after.state.public.guesses).toEqual(["Leuchtturm"]);
  });

  it("normalizes texts to NFC before apply sees them", () => {
    const after = expectMatch(move(start(), { type: "guess", text: "Käse" }));
    expect(after.state.public.guesses).toEqual(["Käse"]);
  });

  it("counts characters, not UTF-16 units", () => {
    expect(expectMatch(move(start(), { type: "guess", text: "🎨".repeat(12) })).state.public.guesses).toHaveLength(1);
    expect(expectError(move(start(), { type: "guess", text: "🎨".repeat(13) })).code).toBe("illegal-move");
  });

  it("rejects texts outside the limits, control characters and broken surrogates", () => {
    for (const bad of ["", "x".repeat(13), "a\nb", "a\u0000b", "a ", "\ud800x", 5, null, ["a"]]) {
      expect(expectError(move(start(), { type: "guess", text: bad })).code).toBe("illegal-move");
    }
  });

  it("rejects extra or missing fields and other types", () => {
    expect(expectError(move(start(), { type: "guess", text: "a", more: 1 })).code).toBe("illegal-move");
    expect(expectError(move(start(), { type: "guess" })).code).toBe("illegal-move");
    expect(expectError(move(start(), { type: "shout", text: "a" })).code).toBe("illegal-move");
  });

  it("never passes a placeholder itself to apply", () => {
    expect(expectError(move(start(), { type: "guess", text: { $text: { min: 1, max: 12 } } })).code).toBe("illegal-move");
  });

  it("checks integers and allowed characters", () => {
    expect(expectMatch(move(start(), { type: "dot", x: 99, y: -5, pts: "0af" })).state.public.dots).toEqual([99, -5, 3]);
    for (const bad of [
      { type: "dot", x: 100, y: 0, pts: "" },
      { type: "dot", x: 1.5, y: 0, pts: "" },
      { type: "dot", x: "1", y: 0, pts: "" },
      { type: "dot", x: 1, y: 6, pts: "" },
      { type: "dot", x: 1, y: 0, pts: "0g" },
    ]) {
      expect(expectError(move(start(), bad)).code).toBe("illegal-move");
    }
  });

  it("keeps exact moves working next to placeholders", () => {
    expect(expectMatch(move(start(), { type: "done" })).state.players["p1"]?.done).toBe(true);
  });

  it("works for realtime inputs", () => {
    const game = defineGame<State, Action>({
      ...guessGame(),
      tick() {},
    });
    const match = expectMatch(createMatch(game, { playerCount: 2, seed: "rt" }));
    const stepped = stepMatch(game, match, {
      inputs: [
        { player: "p1", action: { type: "guess", text: "Turm" } },
        { player: "p2", action: { type: "guess", text: "" } as Action },
      ],
      now: 1,
      dt: 50,
    });
    expect(stepped.ok).toBe(true);
    if (stepped.ok) {
      expect(stepped.match.state.public.guesses).toEqual(["Turm"]);
      expect(stepped.results).toEqual([{ ok: true }, { ok: false, code: "illegal-move", message: "this move is not allowed for p2 right now" }]);
    }
  });

  it("reports broken placeholders as an error in the game code", () => {
    const cases: [unknown, RegExp][] = [
      [{ $text: { max: 0 } }, /max as a whole number from 1 to 8000/],
      [{ $text: { max: 5, min: 6 } }, /min as a whole number from 0 to max/],
      [{ $text: { max: 5, chars: "" } }, /chars in text\(\) must be a non-empty text/],
      [{ $text: { max: 5, chars: "a\n" } }, /control character U\+000A/],
      [{ $text: { max: 5, length: 3 } }, /knows only min, max and chars, not length/],
      [{ $int: { min: 3, max: 1 } }, /min <= max/],
      [{ $text: { max: 5, chars: "ab\u212B" } }, /chars in text\(\) contains "\u212B", which texts never contain because they arrive normalized to NFC; write "\u00C5" instead/],
      [{ $text: { max: 5 }, label: "x" }, /has the key \$text and other keys/],
    ];
    for (const [value, message] of cases) {
      const game = guessGame(() => [{ type: "guess", text: value as string }]);
      const error = expectError(createMatch(game, { playerCount: 2, seed: "broken" }));
      expect(error.code).toBe("game-error");
      expect(error.phase).toBe("legalMoves");
      expect(error.message).toMatch(message);
    }
  });
});

describe("Review 14: placeholders and the length of a move", () => {
  function longGame(max: number) {
    return guessGame(() => [{ type: "guess", text: text({ max }) }]);
  }

  it("never fills a move that NFC makes longer than a move may be", () => {
    const raw = "\u{1D15E}".repeat(4500);
    expect(JSON.stringify({ type: "guess", text: raw }).length).toBeLessThan(maxActionLength);
    expect(JSON.stringify({ type: "guess", text: raw.normalize("NFC") }).length).toBeGreaterThan(maxActionLength);
    expect(legalMoveFor([{ type: "guess", text: { $text: { max: 9000 } } }], { type: "guess", text: raw })).toBeUndefined();
  });

  it("rejects text that NFC stretches beyond max characters with illegal-move", () => {
    const game = longGame(8000);
    const match = expectMatch(createMatch(game, { playerCount: 2, seed: "nfc" }));
    expect(expectError(applyMove(game, match, { player: "p1", action: { type: "guess", text: "\u{1D15E}".repeat(4500) }, now: 1 })).code).toBe("illegal-move");
    expect(expectMatch(applyMove(game, match, { player: "p1", action: { type: "guess", text: "\u{1D15E}".repeat(4000) }, now: 1 })).state.public.guesses[0]).toHaveLength(16000);
  });

  it("allows at most 8,000 characters per text and reports moves that could not be sent when filled", () => {
    expect(expectError(createMatch(longGame(8001), { playerCount: 2, seed: "max" })).message).toMatch(/max as a whole number from 1 to 8000/);
    const twice = guessGame(() => [{ type: "dot", x: 1, y: 1, pts: text({ max: 5000 }), more: text({ max: 5000 }) } as unknown as Action]);
    const error = expectError(createMatch(twice, { playerCount: 2, seed: "twice" }));
    expect(error.phase).toBe("legalMoves");
    expect(error.message).toMatch(/legalMoves\(p1\)\[0\] could become longer than 16384 characters/);
  });

  it("samples moves at the largest allowed text that still fit into a move", () => {
    const random = new SeededRandom(randomStateFromSeed("long"));
    const template = { type: "guess", text: text({ max: 8000 }) };
    for (let i = 0; i < 300; i++) {
      const sampled = sampleMove(template, random);
      expect(JSON.stringify(sampled).length).toBeLessThanOrEqual(maxActionLength);
      expect(legalMoveFor([template], sampled)).toBeDefined();
    }
  });
});

describe("Platform helpers for placeholders", () => {
  it("legalMoveFor returns the concrete move or nothing", () => {
    const legal = [{ type: "guess", text: text({ max: 3 }) }, { type: "done" }];
    expect(legalMoveFor(legal, { text: "ab", type: "guess" })).toEqual({ action: { type: "guess", text: "ab" } });
    expect(legalMoveFor(legal, { type: "done" })).toEqual({ action: { type: "done" } });
    expect(legalMoveFor(legal, { type: "guess", text: "abcd" })).toBeUndefined();
  });

  it("sampled moves always fit their placeholders", () => {
    const random = new SeededRandom(randomStateFromSeed("sample"));
    const templates = [
      { type: "guess", text: text({ min: 1, max: 40 }) },
      { type: "exact", text: text({ min: 3, max: 3 }) },
      { type: "emoji", text: text({ max: 4, chars: "🎨👍🏽ä" }) },
      { type: "dot", at: [int({ min: -3, max: 3 }), int({ min: 0, max: 0 })], pts: text({ max: 2000, chars: points }) },
      text({ max: 1 }),
    ];
    for (let i = 0; i < 400; i++) {
      for (const template of templates) {
        const sampled = sampleMove(template, random);
        expect(fillPlaceholders(template, JSON.parse(JSON.stringify(sampled))).ok).toBe(true);
      }
    }
  });

  it("samples edge lengths and edge values", () => {
    const random = new SeededRandom(randomStateFromSeed("edges"));
    const lengths = new Set<number>();
    const values = new Set<number>();
    for (let i = 0; i < 300; i++) {
      lengths.add([...(sampleMove(text({ min: 2, max: 30 }), random) as string)].length);
      values.add(sampleMove(int({ min: 5, max: 9 }), random) as number);
    }
    expect(lengths.has(2)).toBe(true);
    expect(lengths.has(30)).toBe(true);
    expect([...values].sort()).toEqual([5, 6, 7, 8, 9]);
  });

  it("textProblem explains why a text does not fit", () => {
    expect(textProblem({ max: 2 }, "abc")).toBe("has 3 characters, allowed are 0 to 2");
    expect(textProblem({ max: 2, chars: "ab" }, "ac")).toBe('contains "c", which is not in chars');
    expect(textProblem({ max: 2 }, "ab")).toBeUndefined();
  });

  it("placeholderTexts collects the typed texts of a move", () => {
    const into = new Set<string>();
    placeholderTexts({ type: "guess", text: text({ max: 9 }), n: int({ min: 0, max: 1 }) }, { type: "guess", text: "Turm", n: 1 }, into);
    expect([...into]).toEqual(["Turm"]);
  });
});

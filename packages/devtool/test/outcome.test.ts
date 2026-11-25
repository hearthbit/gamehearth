import { describe, expect, it } from "vitest";
import { checkOutcome, maxOutputBytes } from "../src/sandbox/outcome";

const expected = { seed: "s", players: ["p1", "p2"], version: 1 };

function match(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1,
    seed: "s",
    players: ["p1", "p2"],
    state: { public: {}, players: { p1: {}, p2: {} }, secret: {} },
    randomState: [1, 2, 3, 4],
    version: 1,
    moves: { p1: [{ type: "move" }], p2: [] },
    ...overrides,
  };
}

function problem(value: unknown): string {
  const checked = checkOutcome(JSON.stringify(value), expected);
  return checked.ok ? "ok" : checked.problem;
}

describe("output check on the host", () => {
  it("takes a valid match including its result", () => {
    const checked = checkOutcome(JSON.stringify({ ok: true, match: match({ result: { winners: ["p2"] }, extra: 1 }) }), expected);
    expect(checked).toEqual({ ok: true, outcome: { ok: true, match: match({ result: { winners: ["p2"] } }) } });
  });

  it("rejects broken or incomplete output", () => {
    expect(checkOutcome("{broken", expected)).toMatchObject({ ok: false, problem: "the output is not JSON" });
    expect(problem([])).toBe("the output lacks the field ok");
    expect(problem({ ok: true })).toBe("match is missing");
    expect(checkOutcome(`"${"x".repeat(maxOutputBytes)}"`, expected)).toMatchObject({ ok: false, problem: expect.stringContaining("bytes") });
  });

  it("checks the fields of the match", () => {
    expect(problem({ ok: true, match: match({ format: 2 }) })).toBe("format is not 1");
    expect(problem({ ok: true, match: match({ seed: "other" }) })).toBe("seed was changed");
    expect(problem({ ok: true, match: match({ players: ["p2", "p1"] }) })).toBe("players was changed");
    expect(problem({ ok: true, match: match({ randomState: [1, 2, 3] }) })).toBe("randomState does not have four 32-bit words");
    expect(problem({ ok: true, match: match({ randomState: [1, 2, 3, 2 ** 32] }) })).toBe("randomState does not have four 32-bit words");
    expect(problem({ ok: true, match: match({ state: { public: {}, players: { p1: {} }, secret: {} } }) })).toBe("state.players does not match the seats");
    expect(problem({ ok: true, match: match({ state: { public: {}, players: { p1: {}, p2: {} }, secret: {}, more: 1 } }) })).toBe(
      "state does not have exactly public, players and secret",
    );
    expect(problem({ ok: true, match: match({ moves: { p1: [] } }) })).toBe("moves does not match the seats");
    expect(problem({ ok: true, match: match({ moves: { p1: "move", p2: [] } }) })).toBe("moves contains a value that is not a list");
    expect(problem({ ok: true, match: match({ moves: { p1: [{ text: "x".repeat(20_000) }], p2: [] } }) })).toContain("longer than 16384 characters");
    expect(problem({ ok: true, match: match({ result: { winners: ["p3"] } }) })).toBe("winners contains unknown or duplicate seats");
    expect(problem({ ok: true, match: match({ result: { winners: ["p1", "p1"] } }) })).toBe("winners contains unknown or duplicate seats");
    expect(problem({ ok: true, match: match({ result: {} }) })).toBe("result has no winners");
  });

  it("checks errors of the guest function and shortens them", () => {
    expect(problem({ ok: false, error: { code: "unknown", message: "x" } })).toBe("the error of the guest function has an unknown form");
    expect(problem({ ok: false, error: { code: "game-error", message: "x", phase: "somewhere" } })).toBe("the error of the guest function names an unknown phase");
    expect(problem({ ok: false, error: { code: "game-error", message: "x", player: "p9" } })).toBe("the error of the guest function names an unknown seat");
    expect(problem({ ok: false, error: { code: "game-error", message: "x", stack: 5 } })).toBe("the error of the guest function has an invalid stack");
    const checked = checkOutcome(
      JSON.stringify({ ok: false, error: { code: "game-error", message: "m".repeat(5000), phase: "apply", player: "p1", stack: "s".repeat(9000), more: 1 } }),
      expected,
    );
    expect(checked).toEqual({
      ok: true,
      outcome: { ok: false, error: { code: "game-error", message: "m".repeat(2000), phase: "apply", player: "p1", stack: "s".repeat(4000) } },
    });
  });
});

import { describe, expect, it } from "vitest";
import { canonicalJson, cloneJson, deepFreeze, findNonJson, jsonEquals } from "../src/platform";

describe("findNonJson", () => {
  it("accepts nested JSON values", () => {
    expect(findNonJson({ a: [1, "x", true, null, { b: -0.5 }], c: {} }, "state")).toBeUndefined();
  });

  it("accepts objects without a prototype", () => {
    const bare = Object.create(null) as Record<string, number>;
    bare["x"] = 1;
    expect(findNonJson(bare, "state")).toBeUndefined();
  });

  it("skips fields with undefined in objects", () => {
    expect(findNonJson({ a: undefined }, "state")).toBeUndefined();
  });

  class Card {
    constructor(readonly value: number) {}
  }

  it.each([
    ["Map", new Map(), "is a Map"],
    ["Set", new Set(), "is a Set"],
    ["Date", new Date(0), "is a Date"],
    ["class instance", new Card(1), "is a Card"],
    ["function", () => 1, "is of type function"],
    ["BigInt", 1n, "is of type bigint"],
    ["Symbol", Symbol("x"), "is of type symbol"],
    ["NaN", Number.NaN, "is NaN"],
    ["-Infinity", Number.NEGATIVE_INFINITY, "is -Infinity"],
  ])("reports %s with its path", (_name, value, reason) => {
    expect(findNonJson({ deep: [{ value }] }, "state")).toEqual({
      path: "state.deep[0].value",
      reason: expect.stringContaining(reason),
    });
  });

  it("reports undefined in arrays, because JSON turns it into null", () => {
    expect(findNonJson({ list: [1, undefined] }, "state")).toEqual({
      path: "state.list[1]",
      reason: expect.stringContaining("is undefined"),
    });
  });

  it("reports holes in arrays", () => {
    const sparse: number[] = [];
    sparse[2] = 1;
    expect(findNonJson(sparse, "state")?.path).toBe("state[0]");
  });

  it("reports extra properties on arrays that JSON would drop", () => {
    const hand = Object.assign(["h7", "s8"], { selected: 1 });
    expect(findNonJson({ hand }, "state")).toEqual({
      path: "state.hand.selected",
      reason: expect.stringContaining("extra property on an array"),
    });
  });

  it("reports getters instead of running them", () => {
    let calls = 0;
    const tricky = {
      get value() {
        calls += 1;
        return calls;
      },
    };
    expect(findNonJson({ tricky }, "state")).toEqual({
      path: "state.tricky.value",
      reason: expect.stringContaining("getter"),
    });
    expect(calls).toBe(0);
  });

  it("reports circular references instead of running forever", () => {
    const loop: Record<string, unknown> = {};
    loop["self"] = loop;
    expect(findNonJson(loop, "state")).toEqual({ path: "state.self", reason: expect.stringContaining("circular reference") });
  });

  it("allows the same object in two places as long as it is not a cycle", () => {
    const shared = { x: 1 };
    expect(findNonJson({ a: shared, b: shared }, "state")).toBeUndefined();
  });

  it("reports too deep nesting without blowing the stack", () => {
    let deep: unknown = [];
    for (let i = 0; i < 200_000; i++) {
      deep = [deep];
    }
    expect(findNonJson(deep, "state")?.reason).toContain("deeper than 100 levels");
  });

  it("allows nesting up to the limit", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) {
      deep = [deep];
    }
    expect(findNonJson(deep, "state")).toBeUndefined();
    expect(findNonJson([deep], "state")?.reason).toContain("deeper than 100 levels");
  });
});

describe("cloneJson", () => {
  it("returns objects without a prototype so built-in names are ordinary keys", () => {
    const counts = cloneJson({}) as Record<string, number>;
    for (const word of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      counts[word] = (counts[word] ?? 0) + 1;
    }
    expect(JSON.parse(JSON.stringify(counts))).toEqual({
      constructor: 1,
      toString: 1,
      hasOwnProperty: 1,
      ["__proto__"]: 1,
    });
  });

  it("keeps a key __proto__ as data", () => {
    const source = JSON.parse('{"__proto__": {"x": 1}}') as Record<string, unknown>;
    const copy = cloneJson(source);
    expect(Object.keys(copy)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(copy)).toBeNull();
  });
});

describe("deepFreeze", () => {
  it("makes nested objects and arrays immutable", () => {
    const value = deepFreeze({ a: { b: [1, { c: 2 }] } });
    expect(() => {
      (value.a.b[1] as { c: number }).c = 3;
    }).toThrow(TypeError);
    expect(() => {
      (value.a.b as number[]).push(4);
    }).toThrow(TypeError);
  });
});

describe("canonicalJson", () => {
  it("does not depend on the order of the fields", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(jsonEquals({ type: "play", card: "h7" }, { card: "h7", type: "play" })).toBe(true);
  });

  it("distinguishes the order in arrays", () => {
    expect(jsonEquals([1, 2], [2, 1])).toBe(false);
  });

  it("treats a key __proto__ like any other", () => {
    const a = JSON.parse('{"__proto__": 1, "x": 2}') as unknown;
    const b = JSON.parse('{"x": 2, "__proto__": 1}') as unknown;
    const c = JSON.parse('{"x": 2}') as unknown;
    expect(jsonEquals(a, b)).toBe(true);
    expect(jsonEquals(a, c)).toBe(false);
  });
});

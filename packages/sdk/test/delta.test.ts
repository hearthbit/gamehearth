import { describe, expect, it } from "vitest";
import { applyJsonDelta, canonicalJson, cloneJson, deepFreeze, jsonDelta, type JsonDelta } from "../src/platform";

function applied(base: unknown, delta: unknown): unknown {
  const result = applyJsonDelta(base, delta);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value;
}

function viaWire(base: unknown, next: unknown): unknown {
  const delta = JSON.parse(JSON.stringify(jsonDelta(base, next))) as unknown;
  return applied(JSON.parse(JSON.stringify(base)), delta);
}

function define(object: object, key: string, value: unknown): void {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
}

describe("jsonDelta", () => {
  it("sends only the appended part of a growing text", () => {
    const base = { public: { drawing: "M1,2L3,4".repeat(1250), turn: "p1" }, version: 41 };
    const next = { public: { drawing: `${base.public.drawing}${"L5,6".repeat(10)}`, turn: "p1" }, version: 42 };
    const delta = jsonDelta(base, next);
    expect(delta).toEqual([
      { op: "append", path: ["public", "drawing"], text: "L5,6".repeat(10) },
      { op: "set", path: ["version"], value: 42 },
    ]);
    expect(JSON.stringify(delta).length).toBeLessThan(150);
    expect(JSON.stringify(next).length).toBeGreaterThan(10_000);
    expect(applied(base, delta)).toEqual(next);
  });

  it("sends only the new items of a growing list and truncates a shrinking one", () => {
    const strokes = Array.from({ length: 50 }, (_, index) => ({ color: index % 10, points: `M${index},${index}` }));
    expect(jsonDelta({ strokes }, { strokes: [...strokes, { color: 1, points: "M0,0" }] })).toEqual([{ op: "push", path: ["strokes"], items: [{ color: 1, points: "M0,0" }] }]);
    expect(jsonDelta({ strokes }, { strokes: strokes.slice(0, 49) })).toEqual([{ op: "truncate", path: ["strokes"], length: 49 }]);
  });

  it("deletes removed fields, sets changed values and replaces values of another type", () => {
    const notes = "unchanged ".repeat(50);
    const base = { a: 1, b: "x", c: [1, 2], d: { e: true }, gone: null, notes };
    const next = { a: 2, b: 7, c: { 0: 1 }, d: { e: true, f: [] }, notes, added: "neu" };
    const delta = jsonDelta(base, next);
    expect(delta).toEqual([
      { op: "delete", path: ["gone"] },
      { op: "set", path: ["a"], value: 2 },
      { op: "set", path: ["b"], value: 7 },
      { op: "set", path: ["c"], value: { 0: 1 } },
      { op: "set", path: ["d", "f"], value: [] },
      { op: "set", path: ["added"], value: "neu" },
    ]);
    expect(applied(base, delta)).toEqual(next);
  });

  it("returns no operations for equal values and one for a whole new value", () => {
    expect(jsonDelta({ a: [1, { b: "c" }] }, { a: [1, { b: "c" }] })).toEqual([]);
    expect(jsonDelta("alt", 5)).toEqual([{ op: "set", path: [], value: 5 }]);
    expect(applied("alt", jsonDelta("alt", 5))).toBe(5);
  });

  it("replaces a whole list when that is shorter than changing every item", () => {
    const base = { log: ["Anna: Haus", "Ben: Baum", "Cleo: Boot", "Dana: Brot"] };
    const next = { log: ["Ben: Baum", "Cleo: Boot", "Dana: Brot", "Emil: Bett"] };
    expect(jsonDelta(base, next)).toEqual([{ op: "set", path: ["log"], value: next.log }]);
  });

  it("treats fields with undefined like JSON does, as missing", () => {
    expect(jsonDelta({ a: 1, b: undefined }, { a: 1, c: undefined })).toEqual([]);
    expect(jsonDelta({ a: undefined }, { a: 1 })).toEqual([{ op: "set", path: ["a"], value: 1 }]);
    expect(jsonDelta({ a: 1 }, { a: undefined })).toEqual([{ op: "delete", path: ["a"] }]);
  });
});

describe("applyJsonDelta", () => {
  it("leaves the base unchanged and shares unchanged parts", () => {
    const base = deepFreeze({ public: { drawing: "M0,0", words: ["Haus"] }, me: { hand: [1, 2, 3] }, version: 1 });
    const value = applied(base, [
      { op: "append", path: ["public", "drawing"], text: "L1,1" },
      { op: "push", path: ["public", "words"], items: ["Baum"] },
      { op: "set", path: ["version"], value: 2 },
    ]) as typeof base;
    expect(value).toEqual({ public: { drawing: "M0,0L1,1", words: ["Haus", "Baum"] }, me: { hand: [1, 2, 3] }, version: 2 });
    expect(base).toEqual({ public: { drawing: "M0,0", words: ["Haus"] }, me: { hand: [1, 2, 3] }, version: 1 });
    expect(value.me).toBe(base.me);
  });

  it("does not copy one part twice and does not change values taken from the delta", () => {
    const inserted = { list: [1] };
    const value = applied({ a: {} }, [
      { op: "set", path: ["a", "b"], value: inserted },
      { op: "push", path: ["a", "b", "list"], items: [2] },
      { op: "set", path: ["a", "c"], value: 3 },
    ]);
    expect(value).toEqual({ a: { b: { list: [1, 2] }, c: 3 } });
    expect(inserted).toEqual({ list: [1] });
  });

  it.each([
    ["not a list", { op: "set", path: [], value: 1 }],
    ["an unknown op", [{ op: "move", path: ["a"] }]],
    ["an op that is not an object", [["set", ["a"], 1]]],
    ["a path that is not a list", [{ op: "set", path: "a", value: 1 }]],
    ["a negative index", [{ op: "set", path: [-1], value: 1 }]],
    ["a fractional index", [{ op: "set", path: [0.5], value: 1 }]],
    ["an object in the path", [{ op: "set", path: [{}], value: 1 }]],
    ["set without value", [{ op: "set", path: ["a"] }]],
    ["delete of the whole value", [{ op: "delete", path: [] }]],
    ["append without text", [{ op: "append", path: ["text"], text: 5 }]],
    ["push without items", [{ op: "push", path: ["list"], items: "x" }]],
    ["truncate to a negative length", [{ op: "truncate", path: ["list"], length: -1 }]],
  ])("rejects a delta with %s", (_name, delta) => {
    expect(applyJsonDelta({ a: 1, text: "", list: [1, 2] }, delta)).toMatchObject({ ok: false, message: expect.any(String) });
  });

  it.each([
    ["a missing field on the way", [{ op: "set", path: ["missing", "x"], value: 1 }]],
    ["an index past the end", [{ op: "set", path: ["list", 2], value: 1 }]],
    ["a text key for a list", [{ op: "set", path: ["list", "0"], value: 1 }]],
    ["a number key for an object", [{ op: "set", path: [0], value: 1 }]],
    ["a path through a text", [{ op: "set", path: ["text", "length"], value: 1 }]],
    ["delete of a missing field", [{ op: "delete", path: ["missing"] }]],
    ["delete in a list", [{ op: "delete", path: ["list", 0] }]],
    ["append to a number", [{ op: "append", path: ["a"], text: "x" }]],
    ["push to a text", [{ op: "push", path: ["text"], items: [1] }]],
    ["truncate to the same length", [{ op: "truncate", path: ["list"], length: 2 }]],
    ["a path into a number", [{ op: "set", path: ["x"], value: 1 }], 5],
  ])("rejects a delta that does not fit the base: %s", (_name, delta, base: unknown = { a: 1, text: "abc", list: [1, 2] }) => {
    const before = canonicalJson(base);
    const result = applyJsonDelta(base, delta);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("does not fit") });
    expect(canonicalJson(base)).toBe(before);
  });

  it("applies nothing when a later operation does not fit", () => {
    const base = deepFreeze({ a: 1, b: { c: "x" } });
    expect(applyJsonDelta(base, [{ op: "set", path: ["a"], value: 2 }, { op: "append", path: ["b", "c"], text: "y" }, { op: "append", path: ["a"], text: "z" }])).toMatchObject({ ok: false });
    expect(base).toEqual({ a: 1, b: { c: "x" } });
  });
});

describe("Keys like __proto__ and constructor", () => {
  it("are ordinary data in objects without a prototype and after JSON", () => {
    const notes = JSON.stringify("unchanged ".repeat(50));
    const base = cloneJson(JSON.parse(`{"words":{"__proto__":"Haus","constructor":"Baum","toString":1,"notes":${notes}}}`) as unknown);
    const next = cloneJson(JSON.parse(`{"words":{"__proto__":"Haustür","constructor":{"x":1},"notes":${notes},"hasOwnProperty":2}}`) as unknown);
    const delta = jsonDelta(base, next);
    expect(delta).toEqual([
      { op: "delete", path: ["words", "toString"] },
      { op: "append", path: ["words", "__proto__"], text: "tür" },
      { op: "set", path: ["words", "constructor"], value: { x: 1 } },
      { op: "set", path: ["words", "hasOwnProperty"], value: 2 },
    ]);
    for (const value of [applied(base, delta), viaWire(base, next)]) {
      expect(canonicalJson(value)).toBe(canonicalJson(next));
      const words = (value as { words: object }).words;
      expect(Object.keys(words).sort()).toEqual(["__proto__", "constructor", "hasOwnProperty", "notes"]);
      expect(Object.getOwnPropertyDescriptor(words, "__proto__")?.value).toBe("Haustür");
    }
    expect(Object.getPrototypeOf((applied(base, delta) as { words: object }).words)).toBeNull();
    expect(Object.getPrototypeOf((viaWire(base, next) as { words: object }).words)).toBe(Object.prototype);
  });

  it("never reach the prototype", () => {
    const base = JSON.parse('{"a":{}}') as unknown;
    for (const path of [["__proto__", "polluted"], ["a", "__proto__", "polluted"], ["constructor", "prototype", "polluted"], ["a", "toString", "polluted"]]) {
      expect(applyJsonDelta(base, [{ op: "set", path, value: true }])).toMatchObject({ ok: false });
    }
    const value = applied(base, JSON.parse('[{"op":"set","path":["a","__proto__"],"value":{"polluted":true}},{"op":"set","path":["a","__proto__","polluted"],"value":"yes"}]')) as { a: object };
    expect(Object.getPrototypeOf(value.a)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(value.a, "__proto__")?.value).toEqual({ polluted: "yes" });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const keys = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "", "0", "1", "length", "a", "b", "wörter", "🎨", "a.b"];
const pieces = ["a", "Z", "ß", "é", "é", "🎨", "\ud83c", "\udfa8", "\u0000", "\n", '"', "\\", "L12,34", " "];

class Generator {
  readonly #next: () => number;

  constructor(seed: number) {
    this.#next = random(seed);
  }

  int(max: number): number {
    return Math.floor(this.#next() * max);
  }

  chance(p: number): boolean {
    return this.#next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }

  text(max = 6): string {
    let text = "";
    for (let i = this.int(max + 1); i > 0; i--) {
      text += this.pick(pieces);
    }
    return text;
  }

  value(depth = 0): unknown {
    const kind = depth === 0 ? 5 + this.int(3) : this.int(depth >= 4 ? 5 : 8);
    switch (kind) {
      case 0:
        return null;
      case 1:
        return this.chance(0.5);
      case 2:
        return this.chance(0.5) ? this.int(2000) - 1000 : (this.#next() - 0.5) * 1e6;
      case 3:
        return this.text();
      case 4:
        return this.text(80);
      case 5:
        return Array.from({ length: this.int(9) }, () => this.value(depth + 1));
      default: {
        const object = this.chance(0.5) ? (Object.create(null) as object) : {};
        for (let i = this.int(8); i > 0; i--) {
          define(object, this.pick(keys), this.value(depth + 1));
        }
        return object;
      }
    }
  }

  changed(value: unknown, depth = 0): unknown {
    if (this.chance(depth === 0 ? 0.02 : 0.1)) {
      return this.value(depth);
    }
    if (typeof value === "string") {
      const roll = this.int(4);
      return roll === 0 ? value + this.text(40) : roll === 1 ? value.slice(0, this.int(value.length + 1)) : roll === 2 ? this.text() : value;
    }
    if (Array.isArray(value)) {
      let list = value.map((item) => (this.chance(0.3) ? this.changed(item, depth + 1) : item));
      const roll = this.int(5);
      if (roll === 0) {
        list = [...list, ...Array.from({ length: 1 + this.int(4) }, () => this.value(depth + 1))];
      } else if (roll === 1) {
        list = list.slice(0, this.int(list.length + 1));
      } else if (roll === 2) {
        list = list.slice(1);
      }
      return list;
    }
    if (value !== null && typeof value === "object") {
      const source = value as Record<string, unknown>;
      const object = (this.chance(0.9) === (Object.getPrototypeOf(value) === null) ? Object.create(null) : {}) as object;
      for (const key of Object.keys(source)) {
        if (!this.chance(0.15)) {
          define(object, key, this.chance(0.4) ? this.changed(source[key], depth + 1) : source[key]);
        }
      }
      for (let i = this.int(3); i > 0; i--) {
        define(object, this.pick(keys), this.value(depth + 1));
      }
      return object;
    }
    return this.chance(0.5) ? value : this.value(depth);
  }
}

describe("Review 14: key order", () => {
  it("keeps the order of keys when a game rebuilds an object in a different order", () => {
    const drawing = "0123456789".repeat(100);
    const base = { public: { ranking: { p1: 120, p2: 90, p3: 30 }, drawing } };
    const next = { public: { ranking: { p2: 240, p1: 120, p3: 30 }, drawing: `${drawing}ab` } };
    expect(Object.keys((viaWire(base, next) as typeof next).public.ranking)).toEqual(["p2", "p1", "p3"]);
    expect(JSON.stringify(viaWire(base, next))).toBe(JSON.stringify(next));
  });

  it("still changes single values in place when the order stays", () => {
    const seats = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"];
    const base = { ranking: Object.fromEntries(seats.map((seat) => [seat, 1000])) };
    const next = { ranking: { ...base.ranking, p2: 1500, p10: 10 } };
    expect(jsonDelta(base, next)).toEqual([
      { op: "set", path: ["ranking", "p2"], value: 1500 },
      { op: "set", path: ["ranking", "p10"], value: 10 },
    ]);
    expect(JSON.stringify(viaWire(base, next))).toBe(JSON.stringify(next));
  });
});

describe("Round trip", () => {
  it("rebuilds the next value from the base and the delta for random JSON values", () => {
    const prototype = Object.getOwnPropertyNames(Object.prototype).sort();
    const generator = new Generator(20261124);
    const kinds = new Map<string, number>();
    for (let round = 0; round < 3000; round++) {
      const base = generator.value();
      const next = generator.changed(base);
      const before = canonicalJson(base);
      const delta: JsonDelta = jsonDelta(base, next);
      for (const op of delta) {
        const kind = `${op.op}${op.path.length === 0 ? " at the root" : ""}`;
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
      const direct = applied(deepFreeze(base), deepFreeze(delta));
      expect(JSON.stringify(direct), `round ${round}`).toBe(JSON.stringify(next));
      expect(JSON.stringify(viaWire(base, next)), `round ${round} via JSON`).toBe(JSON.stringify(next));
      expect(canonicalJson(base)).toBe(before);
      expect(JSON.stringify(delta).length).toBeLessThanOrEqual(JSON.stringify({ op: "set", path: [], value: next }).length + 8 * delta.length);
    }
    for (const kind of ["set", "delete", "append", "push", "truncate", "set at the root", "push at the root", "truncate at the root"]) {
      expect(kinds.get(kind) ?? 0, kind).toBeGreaterThanOrEqual(20);
    }
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(prototype);
  });

  it("follows a value over many small steps", () => {
    const generator = new Generator(7);
    let current: unknown = { public: { drawing: "", strokes: [] }, version: 0 };
    let rebuilt: unknown = JSON.parse(JSON.stringify(current));
    for (let step = 1; step <= 500; step++) {
      const next = generator.changed(current);
      rebuilt = applied(rebuilt, JSON.parse(JSON.stringify(jsonDelta(current, next))));
      expect(JSON.stringify(rebuilt), `step ${step}`).toBe(JSON.stringify(next));
      current = next;
    }
  });
});

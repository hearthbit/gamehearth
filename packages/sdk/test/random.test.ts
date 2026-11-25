import { describe, expect, it } from "vitest";
import { SeededRandom, randomStateFromSeed } from "../src/platform";

function sequence(random: SeededRandom, length: number): number[] {
  return Array.from({ length }, () => random.next());
}

function fromSeed(seed: string): SeededRandom {
  return new SeededRandom(randomStateFromSeed(seed));
}

describe("randomStateFromSeed", () => {
  it("returns 128 bits of state as four unsigned 32-bit numbers", () => {
    const state = randomStateFromSeed("partie");
    expect(state).toHaveLength(4);
    for (const word of state) {
      expect(Number.isInteger(word)).toBe(true);
      expect(word).toBeGreaterThanOrEqual(0);
      expect(word).toBeLessThan(2 ** 32);
    }
  });

  it("produces no duplicate states for many different seeds", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) {
      seen.add(randomStateFromSeed(`raum-${i}`).join(","));
    }
    expect(seen.size).toBe(20_000);
  });

  it("distinguishes seeds that differ in only one character", () => {
    const a = randomStateFromSeed("3f2a9c1e7b4d4e0f8a6c2b1d9e7f5a3c");
    const b = randomStateFromSeed("3f2a9c1e7b4d4e0f8a6c2b1d9e7f5a3d");
    expect(a).not.toEqual(b);
  });
});

describe("SeededRandom", () => {
  it("returns the same sequence for the same seed", () => {
    expect(sequence(fromSeed("partie-1"), 50)).toEqual(sequence(fromSeed("partie-1"), 50));
  });

  it("returns a different sequence for a different seed", () => {
    expect(sequence(fromSeed("partie-1"), 20)).not.toEqual(sequence(fromSeed("partie-2"), 20));
  });

  it("continues from a stored state exactly where it stopped", () => {
    const original = fromSeed("fortsetzen");
    sequence(original, 5);
    const saved = JSON.parse(JSON.stringify(original.state)) as SeededRandom["state"];
    const resumed = new SeededRandom(saved);
    expect(sequence(resumed, 20)).toEqual(sequence(original, 20));
  });

  it("rejects a broken state", () => {
    expect(() => new SeededRandom([1, 2, 3] as never)).toThrow(RangeError);
    expect(() => new SeededRandom([1, 2, 3, 0.5])).toThrow(RangeError);
    expect(() => new SeededRandom(42 as never)).toThrow(RangeError);
  });

  it("stays in the range from 0 to below 1 with next and distributes roughly evenly", () => {
    const random = fromSeed("bereich");
    const buckets = new Array<number>(10).fill(0);
    for (const value of sequence(random, 10_000)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      buckets[Math.floor(value * 10)] = (buckets[Math.floor(value * 10)] ?? 0) + 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1150);
    }
  });

  it("hits both bounds with int and never leaves them", () => {
    const random = fromSeed("grenzen");
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      seen.add(random.int(3, 6));
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  it("always returns that value with int when min equals max", () => {
    const random = fromSeed("gleich");
    expect([random.int(7, 7), random.int(7, 7)]).toEqual([7, 7]);
  });

  it("rejects invalid bounds with int", () => {
    const random = fromSeed("ungueltig");
    expect(() => random.int(5, 4)).toThrow(RangeError);
    expect(() => random.int(1.5, 4)).toThrow(RangeError);
    expect(() => random.int(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("shuffles into a permutation without changing the input", () => {
    const random = fromSeed("mischen");
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = random.shuffle(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(input);
    expect(shuffled).not.toEqual(input);
  });

  it("brings every element to every position when shuffling", () => {
    const random = fromSeed("positionen");
    const positions = Array.from({ length: 4 }, () => new Set<number>());
    for (let round = 0; round < 500; round++) {
      random.shuffle([0, 1, 2, 3]).forEach((value, index) => positions[value]?.add(index));
    }
    for (const seen of positions) {
      expect(seen.size).toBe(4);
    }
  });

  it("picks only elements of the list with pick and rejects empty lists", () => {
    const random = fromSeed("waehlen");
    for (let i = 0; i < 100; i++) {
      expect(["a", "b", "c"]).toContain(random.pick(["a", "b", "c"]));
    }
    expect(() => random.pick([])).toThrow(RangeError);
  });

  it("draws the entry itself with weighted, roughly in proportion to the weights", () => {
    const random = fromSeed("gewichte");
    const table = [
      { id: "barsch", weight: 60 },
      { id: "hecht", weight: 25 },
      { id: "nie", weight: 0 },
      { id: "goldfisch", weight: 15 },
    ];
    const counts: Record<string, number> = { barsch: 0, hecht: 0, nie: 0, goldfisch: 0 };
    for (let i = 0; i < 10_000; i++) {
      const entry = random.weighted(table);
      expect(table).toContain(entry);
      counts[entry.id] = (counts[entry.id] ?? 0) + 1;
    }
    expect(counts["nie"]).toBe(0);
    expect(counts["barsch"]).toBeGreaterThan(5700);
    expect(counts["barsch"]).toBeLessThan(6300);
    expect(counts["hecht"]).toBeGreaterThan(2200);
    expect(counts["hecht"]).toBeLessThan(2800);
    expect(counts["goldfisch"]).toBeGreaterThan(1200);
    expect(counts["goldfisch"]).toBeLessThan(1800);
  });

  it("draws the same entry with weighted for the same state and uses exactly one number", () => {
    const table = [
      { id: "a", weight: 1 },
      { id: "b", weight: 2 },
      { id: "c", weight: 3 },
    ];
    const first = fromSeed("gleich");
    const second = fromSeed("gleich");
    const drawn = Array.from({ length: 50 }, () => first.weighted(table).id);
    expect(Array.from({ length: 50 }, () => second.weighted(table).id)).toEqual(drawn);
    const viaInt = fromSeed("gleich");
    const manual = Array.from({ length: 50 }, () => {
      const roll = viaInt.int(0, 5);
      return roll < 1 ? "a" : roll < 3 ? "b" : "c";
    });
    expect(manual).toEqual(drawn);
  });

  it("rejects empty lists, broken weights and only zeros with weighted", () => {
    const random = fromSeed("kaputt");
    expect(() => random.weighted([])).toThrow(RangeError);
    expect(() => random.weighted([{ weight: 1.5 }])).toThrow(/entry 0/);
    expect(() => random.weighted([{ weight: 1 }, { weight: -1 }])).toThrow(/entry 1/);
    expect(() => random.weighted([{ weight: Number.NaN }])).toThrow(RangeError);
    expect(() => random.weighted([{ weight: 0 }, { weight: 0 }])).toThrow(/greater than 0/);
    expect(() => random.weighted([{ weight: 2 ** 31 }, { weight: 2 ** 31 }, { weight: 1 }])).toThrow(/at most/);
    expect(() => random.weighted([null as unknown as { weight: number }])).toThrow(/entry 0/);
  });
});

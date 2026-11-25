export type RandomState = [number, number, number, number];

export interface Random {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  weighted<T extends { readonly weight: number }>(entries: readonly T[]): T;
}

export const maxTotalWeight = 2 ** 32;

export class SeededRandom implements Random {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(state: RandomState) {
    if (!Array.isArray(state) || state.length !== 4 || !state.every((word) => Number.isInteger(word))) {
      throw new RangeError("The state of the random generator must consist of four integers");
    }
    [this.#a, this.#b, this.#c, this.#d] = state.map((word) => word | 0) as RandomState;
  }

  get state(): RandomState {
    return [this.#a >>> 0, this.#b >>> 0, this.#c >>> 0, this.#d >>> 0];
  }

  next(): number {
    const t = (((this.#a + this.#b) | 0) + this.#d) | 0;
    this.#d = (this.#d + 1) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = (this.#c << 21) | (this.#c >>> 11);
    this.#c = (this.#c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
      throw new RangeError(`random.int needs integers with min <= max, got ${min} and ${max}`);
    }
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError("random.pick needs at least one element");
    }
    return items[this.int(0, items.length - 1)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [result[i], result[j]] = [result[j] as T, result[i] as T];
    }
    return result;
  }

  weighted<T extends { readonly weight: number }>(entries: readonly T[]): T {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new RangeError("random.weighted needs a list with at least one entry like { id: \"perch\", weight: 60 }");
    }
    let total = 0;
    entries.forEach((entry, index) => {
      const weight = entry !== null && typeof entry === "object" ? (entry as { weight?: unknown }).weight : undefined;
      if (typeof weight !== "number" || !Number.isSafeInteger(weight) || weight < 0) {
        throw new RangeError(`random.weighted: entry ${index} needs weight as an integer of at least 0, got ${String(weight)}`);
      }
      total += weight;
    });
    if (total === 0) {
      throw new RangeError("random.weighted: at least one entry needs a weight greater than 0");
    }
    if (total > maxTotalWeight) {
      throw new RangeError(`random.weighted: the weights add up to ${total}, at most ${maxTotalWeight} is allowed`);
    }
    let roll = this.int(0, total - 1);
    for (const entry of entries) {
      roll -= entry.weight;
      if (roll < 0) {
        return entry;
      }
    }
    return entries[entries.length - 1] as T;
  }
}

export function randomStateFromSeed(seed: string): RandomState {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  const random = new SeededRandom([h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]);
  for (let i = 0; i < 15; i++) {
    random.next();
  }
  return random.state;
}

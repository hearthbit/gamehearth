export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #clock: () => number;
  readonly #hits = new Map<string, { start: number; count: number }>();

  constructor(limit: number, windowMs: number, clock: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#clock = clock;
  }

  allow(key: string): boolean {
    const now = this.#clock();
    const entry = this.#hits.get(key);
    if (entry === undefined || now - entry.start >= this.#windowMs) {
      this.#hits.set(key, { start: now, count: 1 });
      this.#sweep(now);
      return true;
    }
    entry.count += 1;
    return entry.count <= this.#limit;
  }

  refund(key: string): void {
    const entry = this.#hits.get(key);
    if (entry !== undefined && entry.count > 0) {
      entry.count -= 1;
    }
  }

  blocked(key: string): boolean {
    const entry = this.#hits.get(key);
    return entry !== undefined && this.#clock() - entry.start < this.#windowMs && entry.count >= this.#limit;
  }

  #sweep(now: number): void {
    if (this.#hits.size < 10_000) {
      return;
    }
    for (const [key, entry] of this.#hits) {
      if (now - entry.start >= this.#windowMs) {
        this.#hits.delete(key);
      }
    }
  }
}

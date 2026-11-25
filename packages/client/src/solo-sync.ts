import type { SoloSyncInput, SoloView, StatSpec } from "./protocol";
import type { SoloStore } from "./solo-store";

export interface SyncApi {
  sync(gameId: string, input: SoloSyncInput): Promise<SoloView>;
}

export interface SyncTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const syncDelayMs = 2000;

export class SoloSync {
  readonly #store: SoloStore;
  readonly #api: SyncApi;
  readonly #timers: SyncTimers;
  readonly #stats: (gameId: string) => Record<string, StatSpec> | undefined;
  readonly #listeners = new Set<(gameId: string) => void>();
  readonly #scheduled = new Map<string, unknown>();
  readonly #running = new Map<string, Promise<boolean>>();
  readonly #again = new Set<string>();

  constructor(store: SoloStore, api: SyncApi, stats: (gameId: string) => Record<string, StatSpec> | undefined, timers: SyncTimers = globalThis as unknown as SyncTimers) {
    this.#store = store;
    this.#api = api;
    this.#stats = stats;
    this.#timers = timers;
  }

  onChange(listener: (gameId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  schedule(gameId: string, delayMs = syncDelayMs): void {
    if (this.#scheduled.has(gameId)) {
      return;
    }
    this.#scheduled.set(
      gameId,
      this.#timers.setTimeout(() => {
        this.#scheduled.delete(gameId);
        void this.sync(gameId);
      }, delayMs),
    );
  }

  async flush(): Promise<void> {
    await Promise.all(this.#store.pendingGames().map((gameId) => this.sync(gameId)));
  }

  sync(gameId: string): Promise<boolean> {
    const pending = this.#scheduled.get(gameId);
    if (pending !== undefined) {
      this.#timers.clearTimeout(pending);
      this.#scheduled.delete(gameId);
    }
    const running = this.#running.get(gameId);
    if (running !== undefined) {
      this.#again.add(gameId);
      return running;
    }
    const work = this.#run(gameId).finally(() => {
      this.#running.delete(gameId);
      if (this.#again.delete(gameId)) {
        void this.sync(gameId);
      }
    });
    this.#running.set(gameId, work);
    return work;
  }

  async #run(gameId: string): Promise<boolean> {
    const stats = this.#stats(gameId);
    if (stats === undefined) {
      return false;
    }
    try {
      const view = await this.#api.sync(gameId, this.#store.pending(gameId) ?? {});
      this.#store.apply(gameId, view, stats);
    } catch {
      return false;
    }
    for (const listener of [...this.#listeners]) {
      listener(gameId);
    }
    return true;
  }
}

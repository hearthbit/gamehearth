import type { BoardEntry, OfflineFiles, SoloGameInfo, SoloSyncInput, SoloView, StatSpec } from "./protocol";
import type { KeyValueStore } from "./storage";

const lastUserKey = "gamehearth.solo.last";
const dataKey = (userId: number) => `gamehearth.solo.${userId}`;

export interface LocalUser {
  id: number;
  name: string;
}

interface LocalSave {
  data: unknown;
  savedAt: number;
  synced: boolean;
}

interface LocalBest {
  value: number;
  at: number;
  generation: number;
  synced: boolean;
}

interface LocalGame {
  save?: LocalSave;
  best: Record<string, LocalBest>;
  generations?: Record<string, number>;
  boards: Record<string, BoardEntry[]>;
}

interface LocalData {
  format: 1;
  user: LocalUser;
  games: SoloGameInfo[];
  files: Record<string, { client: string; files: string[] }>;
  ready: Record<string, boolean>;
  state: Record<string, LocalGame>;
}

function defaultStore(): KeyValueStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function isBetter(spec: StatSpec, candidate: number, current: number | undefined): boolean {
  return current === undefined || (spec.better === "higher" ? candidate > current : candidate < current);
}

export function lastUser(store: KeyValueStore | undefined = defaultStore()): LocalUser | undefined {
  try {
    const raw = store?.getItem(lastUserKey);
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as Partial<LocalUser>;
    return typeof parsed.id === "number" && typeof parsed.name === "string" ? { id: parsed.id, name: parsed.name } : undefined;
  } catch {
    return undefined;
  }
}

export class StorageFull extends Error {}

export class SoloStore {
  readonly user: LocalUser;
  readonly #store: KeyValueStore | undefined;
  #data: LocalData;
  #released = false;

  constructor(user: LocalUser, store: KeyValueStore | undefined = defaultStore()) {
    this.user = user;
    this.#store = store;
    this.#data = this.#load();
  }

  remember(): void {
    this.#fresh();
    this.#data.user = this.user;
    this.#write();
    try {
      this.#store?.setItem(lastUserKey, JSON.stringify(this.user));
    } catch {
      return;
    }
  }

  release(): void {
    this.#fresh();
    try {
      if (lastUser(this.#store)?.id === this.user.id) {
        this.#store?.removeItem(lastUserKey);
      }
      if (!this.hasPending()) {
        this.#store?.removeItem(dataKey(this.user.id));
      }
    } catch {
      return;
    } finally {
      this.#released = true;
    }
  }

  games(): SoloGameInfo[] {
    this.#fresh();
    return this.#data.games;
  }

  game(gameId: string): SoloGameInfo | undefined {
    this.#fresh();
    return this.#data.games.find((game) => game.id === gameId);
  }

  setGames(games: SoloGameInfo[]): void {
    this.#fresh();
    this.#data.games = games.map((game) => ({ ...game }));
    const builds = new Set(games.map((game) => game.build));
    for (const build of Object.keys(this.#data.files)) {
      if (!builds.has(build)) {
        delete this.#data.files[build];
        delete this.#data.ready[build];
      }
    }
    this.#write();
  }

  files(build: string): OfflineFiles | undefined {
    this.#fresh();
    const files = this.#data.files[build];
    return files === undefined ? undefined : { build, client: files.client, files: [...files.files] };
  }

  setFiles(files: OfflineFiles): void {
    this.#fresh();
    this.#data.files[files.build] = { client: files.client, files: [...files.files] };
    this.#write();
  }

  isReady(build: string): boolean {
    this.#fresh();
    return this.#data.ready[build] === true;
  }

  setReady(build: string, ready: boolean): void {
    this.#fresh();
    this.#data.ready[build] = ready;
    this.#write();
  }

  saved(gameId: string): unknown {
    this.#fresh();
    const save = this.#data.state[gameId]?.save;
    return save === undefined || save.data === null ? undefined : save.data;
  }

  best(gameId: string): Record<string, number> {
    this.#fresh();
    const best = Object.create(null) as Record<string, number>;
    const game = this.#data.state[gameId];
    for (const [stat, entry] of Object.entries(game?.best ?? {})) {
      if (entry.generation >= this.#generation(game, stat)) {
        best[stat] = entry.value;
      }
    }
    return best;
  }

  boards(gameId: string): Record<string, BoardEntry[]> {
    this.#fresh();
    return this.#data.state[gameId]?.boards ?? {};
  }

  save(gameId: string, data: unknown, now: number): void {
    this.#fresh();
    const game = this.#game(gameId);
    const previous = game.save;
    if (previous !== undefined && previous.data !== null && JSON.stringify(previous.data) === JSON.stringify(data)) {
      return;
    }
    game.save = { data, savedAt: Math.max(now, (previous?.savedAt ?? 0) + 1), synced: false };
    this.#commit(() => {
      if (previous === undefined) {
        delete game.save;
      } else {
        game.save = previous;
      }
    }, "the save");
  }

  deleteSave(gameId: string, now: number): void {
    this.#fresh();
    const game = this.#game(gameId);
    const previous = game.save;
    game.save = { data: null, savedAt: Math.max(now, (previous?.savedAt ?? 0) + 1), synced: false };
    this.#commit(() => {
      if (previous === undefined) {
        delete game.save;
      } else {
        game.save = previous;
      }
    }, "deleting the save");
  }

  record(gameId: string, stat: string, value: number, spec: StatSpec, now: number): boolean {
    this.#fresh();
    const game = this.#game(gameId);
    const generation = this.#generation(game, stat);
    const previous = game.best[stat];
    const current = previous !== undefined && previous.generation >= generation ? previous.value : undefined;
    if (!isBetter(spec, value, current)) {
      return false;
    }
    game.best[stat] = { value, at: now, generation, synced: false };
    this.#commit(() => {
      if (previous === undefined) {
        delete game.best[stat];
      } else {
        game.best[stat] = previous;
      }
    }, "the best score");
    return true;
  }

  pending(gameId: string): SoloSyncInput | undefined {
    this.#fresh();
    return this.#pending(gameId);
  }

  hasPending(): boolean {
    this.#fresh();
    return Object.keys(this.#data.state).some((gameId) => this.#pending(gameId) !== undefined);
  }

  pendingGames(): string[] {
    this.#fresh();
    return Object.keys(this.#data.state).filter((gameId) => this.#pending(gameId) !== undefined);
  }

  apply(gameId: string, view: SoloView, stats: Record<string, StatSpec>): void {
    this.#fresh();
    const game = this.#game(gameId);
    const local = game.save;
    const serverAt = view.savedAt ?? -1;
    const serverData = view.save === null ? null : view.save.data;
    if (local === undefined || local.savedAt <= serverAt || (view.savedAt !== null && JSON.stringify(local.data) === JSON.stringify(serverData))) {
      if (view.savedAt === null) {
        delete game.save;
      } else {
        game.save = { data: serverData, savedAt: view.savedAt, synced: true };
      }
    }
    game.generations = { ...view.generations };
    for (const stat of view.ignored) {
      delete game.best[stat];
    }
    for (const [stat, spec] of Object.entries(stats)) {
      const generation = this.#generation(game, stat);
      const entry = game.best[stat];
      if (entry !== undefined && entry.generation < generation) {
        delete game.best[stat];
      }
      const server = Object.hasOwn(view.best, stat) ? view.best[stat] : undefined;
      if (server === undefined) {
        continue;
      }
      const kept = game.best[stat];
      if (kept === undefined || !isBetter(spec, kept.value, server)) {
        game.best[stat] = { value: server, at: kept?.at ?? 0, generation, synced: true };
      }
    }
    for (const stat of Object.keys(game.best)) {
      if (!Object.hasOwn(stats, stat)) {
        delete game.best[stat];
      }
    }
    game.boards = view.boards;
    this.#write();
  }

  #pending(gameId: string): SoloSyncInput | undefined {
    const game = this.#data.state[gameId];
    if (game === undefined) {
      return undefined;
    }
    const input: SoloSyncInput = {};
    if (game.save !== undefined && !game.save.synced) {
      input.save = game.save.data === null ? { deleted: true, savedAt: game.save.savedAt } : { data: game.save.data, savedAt: game.save.savedAt };
    }
    const best = Object.entries(game.best).filter(([, entry]) => !entry.synced);
    if (best.length > 0) {
      input.best = Object.fromEntries(best.map(([stat, entry]) => [stat, { value: entry.value, at: entry.at, generation: entry.generation }]));
    }
    return input.save === undefined && input.best === undefined ? undefined : input;
  }

  #generation(game: LocalGame | undefined, stat: string): number {
    const generations = game?.generations ?? {};
    return Object.hasOwn(generations, stat) ? (generations[stat] ?? 0) : 0;
  }

  #commit(rollback: () => void, what: string): void {
    if (!this.#write()) {
      rollback();
      throw new StorageFull(`The storage of this device is full; ${what} could not be stored.`);
    }
  }

  #game(gameId: string): LocalGame {
    let game = this.#data.state[gameId];
    if (game === undefined) {
      game = { best: {}, boards: {} };
      this.#data.state[gameId] = game;
    }
    return game;
  }

  #empty(): LocalData {
    return { format: 1, user: this.user, games: [], files: {}, ready: {}, state: {} };
  }

  #fresh(): void {
    if (this.#store !== undefined && !this.#released) {
      this.#data = this.#load();
    }
  }

  #load(): LocalData {
    try {
      const raw = this.#store?.getItem(dataKey(this.user.id));
      if (raw === null || raw === undefined) {
        return this.#empty();
      }
      const parsed = JSON.parse(raw) as Partial<LocalData>;
      if (parsed.format !== 1 || parsed.user?.id !== this.user.id) {
        return this.#empty();
      }
      const state = parsed.state ?? {};
      for (const game of Object.values(state)) {
        for (const entry of Object.values(game.best ?? {})) {
          entry.generation ??= 0;
        }
      }
      return {
        format: 1,
        user: this.user,
        games: Array.isArray(parsed.games) ? parsed.games : [],
        files: parsed.files ?? {},
        ready: parsed.ready ?? {},
        state,
      };
    } catch {
      return this.#empty();
    }
  }

  #write(): boolean {
    if (this.#store === undefined || this.#released) {
      return true;
    }
    try {
      this.#store.setItem(dataKey(this.user.id), JSON.stringify(this.#data));
      return true;
    } catch {
      return false;
    }
  }
}

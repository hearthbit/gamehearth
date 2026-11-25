const legacyRoomsKey = "gamehearth.rooms";
const nameKey = "gamehearth.name";
const pushHintKey = "gamehearth.push-hint";
export const maxLegacyTokens = 30;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): KeyValueStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export class DeviceStorage {
  readonly #store: KeyValueStore | undefined;

  constructor(store: KeyValueStore | undefined = defaultStore()) {
    this.#store = store;
  }

  legacyTokens(): string[] {
    const raw = this.#read(legacyRoomsKey);
    if (raw === undefined) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      const tokens = parsed
        .map((room: unknown) => (room !== null && typeof room === "object" ? (room as Record<string, unknown>)["token"] : undefined))
        .filter((token): token is string => typeof token === "string" && token.length > 0 && token.length <= 100);
      return [...new Set(tokens)].slice(0, maxLegacyTokens);
    } catch {
      return [];
    }
  }

  hasLegacy(): boolean {
    return this.#read(legacyRoomsKey) !== undefined;
  }

  clearLegacy(): void {
    try {
      this.#store?.removeItem(legacyRoomsKey);
    } catch {
      return;
    }
  }

  name(): string {
    return this.#read(nameKey) ?? "";
  }

  saveName(name: string): void {
    this.#write(nameKey, name);
  }

  pushHintDismissed(): boolean {
    return this.#read(pushHintKey) === "later";
  }

  dismissPushHint(): void {
    this.#write(pushHintKey, "later");
  }

  #read(key: string): string | undefined {
    try {
      return this.#store?.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  }

  #write(key: string, value: string): void {
    try {
      this.#store?.setItem(key, value);
    } catch {
      return;
    }
  }
}

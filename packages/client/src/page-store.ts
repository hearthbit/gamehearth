import { tr } from "./language";
import type { GamePage } from "./protocol";
import { locale } from "./texts";
import type { KeyValueStore } from "./storage";

const prefix = "gamehearth.pages.";

function defaultStore(): KeyValueStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function read(user: number, store: KeyValueStore | undefined): Record<string, GamePage> {
  try {
    const raw = store?.getItem(`${prefix}${user}`);
    if (raw === null || raw === undefined) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, GamePage>) : {};
  } catch {
    return {};
  }
}

export function savedPage(user: number, game: string, store: KeyValueStore | undefined = defaultStore()): GamePage | undefined {
  const pages = read(user, store);
  return Object.hasOwn(pages, game) ? pages[game] : undefined;
}

export function savedPages(user: number, store: KeyValueStore | undefined = defaultStore()): GamePage[] {
  return Object.values(read(user, store)).sort((a, b) => tr(a.game.name, a.game.languages).localeCompare(tr(b.game.name, b.game.languages), locale()));
}

export function savePage(user: number, page: GamePage, store: KeyValueStore | undefined = defaultStore()): void {
  const pages = read(user, store);
  pages[page.game.id] = page;
  try {
    store?.setItem(`${prefix}${user}`, JSON.stringify(pages));
  } catch {
    return;
  }
}

export function forgetPages(user: number, store: KeyValueStore | undefined = defaultStore()): void {
  try {
    store?.removeItem(`${prefix}${user}`);
  } catch {
    return;
  }
}

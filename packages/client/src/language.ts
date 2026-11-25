import { localize, pickLanguage, supportsLanguage, type Localized } from "@gamehearth/sdk/platform";
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import { isLanguage, language, setLanguage, texts, type Language } from "./texts";
import type { KeyValueStore } from "./storage";

const languageKey = "gamehearth.language";
const accountLanguageKey = "gamehearth.account-language";

function defaultStore(): KeyValueStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function browserLanguages(): string[] {
  const navigator = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
  const list = navigator?.languages ?? (navigator?.language === undefined ? [] : [navigator.language]);
  return list.filter((entry): entry is string => typeof entry === "string");
}

export function browserLanguage(): Language {
  for (const entry of browserLanguages()) {
    const base = entry.split("-")[0]?.toLowerCase();
    if (isLanguage(base)) {
      return base;
    }
  }
  return "en";
}

function read(key: string, store: KeyValueStore | undefined): Language | undefined {
  try {
    const value = store?.getItem(key);
    return isLanguage(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: Language | undefined, store: KeyValueStore | undefined): void {
  try {
    if (value === undefined) {
      store?.removeItem(key);
    } else {
      store?.setItem(key, value);
    }
  } catch {
    return;
  }
}

export function storedLanguage(store: KeyValueStore | undefined = defaultStore()): Language | undefined {
  return read(languageKey, store);
}

export function storeLanguage(value: Language | undefined, store: KeyValueStore | undefined = defaultStore()): void {
  write(languageKey, value, store);
}

export function storedAccountLanguage(store: KeyValueStore | undefined = defaultStore()): Language | undefined {
  return read(accountLanguageKey, store);
}

export function storeAccountLanguage(value: Language | undefined, store: KeyValueStore | undefined = defaultStore()): void {
  write(accountLanguageKey, value, store);
}

export function deviceLanguage(store?: KeyValueStore): Language {
  return storedLanguage(store) ?? browserLanguage();
}

export function startLanguage(store?: KeyValueStore, deviceOnly = false): Language {
  const chosen = (deviceOnly ? undefined : storedAccountLanguage(store)) ?? deviceLanguage(store);
  setLanguage(chosen);
  return chosen;
}

export const robotSign = "🤖";

export function botName(number: number): string {
  const names = texts.botNames;
  const index = Math.max(0, Math.floor(number) - 1);
  const round = Math.floor(index / names.length);
  const name = names[index % names.length] ?? texts.botBadge;
  return `${name}${round === 0 ? "" : ` ${round + 1}`} ${robotSign}`;
}

export function memberName(member: { name: string; deleted?: boolean; bot?: number }): string {
  if (member.bot !== undefined) {
    return botName(member.bot);
  }
  return member.deleted === true ? texts.deletedMember : member.name;
}

export function seatName(member: { name: string; deleted?: boolean; bot?: number; autopilot?: true }): string {
  return member.autopilot === true && member.bot === undefined ? `${memberName(member)} ${robotSign}` : memberName(member);
}

export function tr(value: Localized, languages?: readonly string[]): string {
  return localize(value, language, languages ?? []);
}

export function gameLanguage(available: readonly string[] | undefined): string | undefined {
  return pickLanguage(available, [language, ...browserLanguages()]);
}

export function lacksLanguage(available: readonly string[] | undefined): boolean {
  return available !== undefined && available.length > 0 && !supportsLanguage(available, language);
}

export function languageNames(codes: readonly string[]): string {
  let names: { of(code: string): string | undefined } | undefined;
  try {
    names = new Intl.DisplayNames([language], { type: "language" });
  } catch {
    names = undefined;
  }
  const list = codes.map((code) => names?.of(code) ?? code);
  try {
    return new Intl.ListFormat([language], { type: "disjunction" }).format(list);
  } catch {
    return list.join(", ");
  }
}

export interface LanguageValue {
  language: Language;
  choose(next: Language): void;
}

export const LanguageContext = createContext<LanguageValue>({ language: "de", choose: () => undefined });

export function useLanguage(): LanguageValue {
  return useContext(LanguageContext);
}

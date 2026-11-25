import { de } from "./texts/de";
import { en } from "./texts/en";

type Widen<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => Widen<R>
  : T extends string
    ? string
    : T extends object
      ? { [K in keyof T]: Widen<T[K]> }
      : T;

export type Texts = Widen<typeof de>;

export const languages = ["de", "en"] as const;
export type Language = (typeof languages)[number];

const tables: Record<Language, Texts> = { de, en };

export let language: Language = "de";
export let texts: Texts = de;

export function setLanguage(next: Language): void {
  language = next;
  texts = tables[next];
  const root = (globalThis as { document?: { documentElement?: { lang: string } } }).document?.documentElement;
  if (root !== undefined) {
    root.lang = next;
  }
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (languages as readonly string[]).includes(value);
}

export function locale(): string {
  return language === "de" ? "de-DE" : "en-GB";
}

export const pushTexts = { de: de.push, en: en.push };

export function errorText(code: string, fallback: string): string {
  if (code === "game-error") {
    return texts.gameError(/\(incident ([^)\s]+)\)/.exec(fallback)?.[1]);
  }
  return Object.hasOwn(texts.errors, code) ? texts.errors[code as keyof Texts["errors"]] : fallback;
}

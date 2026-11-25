export type Localized = string | Readonly<Record<string, string>>;

export const languagePattern = /^[a-z]{2,3}(-[A-Z]{2})?$/;
export const maxLanguages = 20;

export function isLanguage(value: unknown): value is string {
  return typeof value === "string" && languagePattern.test(value);
}

export function validateLanguages(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > maxLanguages) {
    return [`languages must be a list of 1 to ${maxLanguages} language codes, the game's default language first, e.g. ["de", "en"]`];
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  raw.forEach((language, index) => {
    if (!isLanguage(language)) {
      problems.push(`languages[${index}] must be a language code such as "en", "de" or "pt-BR", not ${JSON.stringify(language)}`);
    } else if (seen.has(language)) {
      problems.push(`languages lists ${JSON.stringify(language)} more than once`);
    } else {
      seen.add(language);
    }
  });
  return problems;
}

export function localizedProblem(value: unknown, where: string, maxLength: number, languages: readonly string[] | undefined | null): string | undefined {
  if (typeof value === "string") {
    return value.trim() === "" || value.length > maxLength ? `${where} must be a text with 1 to ${maxLength} characters` : undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `${where} must be a text with 1 to ${maxLength} characters, or an object with one text per language like { "en": "Wins", "de": "Siege" }`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return `${where} must not be an empty object; give one text per language like { "en": "Wins", "de": "Siege" }`;
  }
  if (languages === undefined) {
    return `${where} has one text per language, so the manifest needs "languages" with these languages, default language first, e.g. ["${entries.map(([key]) => key).join('", "')}"]`;
  }
  for (const [language, text] of entries) {
    if (languages === null) {
      if (!isLanguage(language)) {
        return `${where}.${language}: "${language}" is not a language code such as "en", "de" or "pt-BR"`;
      }
    } else if (!languages.includes(language)) {
      return `${where}.${language}: "${language}" is not in languages (${languages.join(", ")}); add it there or remove this text`;
    }
    if (typeof text !== "string" || text.trim() === "" || text.length > maxLength) {
      return `${where}.${language} must be a text with 1 to ${maxLength} characters`;
    }
  }
  const missing = languages === null ? [] : languages.filter((language) => !Object.hasOwn(value, language));
  if (missing.length > 0) {
    return `${where} has no text for ${missing.map((language) => `"${language}"`).join(", ")}; every language in languages needs one (or use a single text that applies to all languages)`;
  }
  return undefined;
}

export function localize(value: Localized, language?: string, fallbacks: readonly string[] = []): string {
  if (typeof value === "string") {
    return value;
  }
  for (const wanted of [language, ...fallbacks]) {
    if (wanted === undefined) {
      continue;
    }
    if (Object.hasOwn(value, wanted)) {
      return value[wanted] as string;
    }
    const base = primaryLanguage(wanted);
    const match = Object.keys(value).find((key) => primaryLanguage(key) === base);
    if (match !== undefined) {
      return value[match] as string;
    }
  }
  const first = Object.values(value)[0];
  return first ?? "";
}

export function pickLanguage(available: readonly string[] | undefined, preferred: readonly (string | undefined)[]): string | undefined {
  if (available === undefined || available.length === 0) {
    return undefined;
  }
  for (const wanted of preferred) {
    if (wanted === undefined) {
      continue;
    }
    if (available.includes(wanted)) {
      return wanted;
    }
    const base = primaryLanguage(wanted);
    const match = available.find((language) => primaryLanguage(language) === base);
    if (match !== undefined) {
      return match;
    }
  }
  return available[0];
}

export function primaryLanguage(language: string): string {
  return language.split("-")[0]?.toLowerCase() ?? language;
}

export function supportsLanguage(available: readonly string[] | undefined, language: string): boolean {
  return available !== undefined && available.some((entry) => primaryLanguage(entry) === primaryLanguage(language));
}

type TextValue = string | ((...args: never[]) => string);
type TextTable = Readonly<Record<string, TextValue>>;
type AllKeys<T> = { [L in keyof T]: keyof T[L] }[keyof T];
type Intersect<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;
type Shared<T, K extends PropertyKey> = Intersect<{ [L in keyof T]: K extends keyof T[L] ? T[L][K] : never }[keyof T]>;
type Complete<T> = { [L in keyof T]: { [K in AllKeys<T>]: Shared<T, K> } };

export type Texts<T> = T[keyof T];

export function defineTexts<T extends Readonly<Record<string, TextTable>>>(texts: T & Complete<T>): (language?: string) => Texts<T> {
  const languages = Object.keys(texts);
  if (languages.length === 0) {
    throw new Error("defineTexts needs the texts of at least one language, e.g. defineTexts({ en: { hello: \"Hello\" } })");
  }
  for (const language of languages) {
    if (!isLanguage(language)) {
      throw new Error(`defineTexts: "${language}" is not a language code such as "en", "de" or "pt-BR"`);
    }
  }
  return (language) => {
    const chosen = pickLanguage(languages, [language]) as string;
    return (texts as T)[chosen] as Texts<T>;
  };
}

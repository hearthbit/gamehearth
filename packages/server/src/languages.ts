import { pickLanguage } from "@gamehearth/sdk/platform";

export const uiLanguages = ["en", "de"] as const;

export type UiLanguage = (typeof uiLanguages)[number];

export const defaultUiLanguage: UiLanguage = "en";

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === "string" && (uiLanguages as readonly string[]).includes(value);
}

export function acceptedLanguages(header: string | string[] | undefined): string[] {
  const text = Array.isArray(header) ? header.join(",") : (header ?? "");
  return text
    .slice(0, 500)
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const quality = params.map((param) => /^\s*q=([0-9.]+)\s*$/.exec(param)?.[1]).find((value) => value !== undefined);
      return { tag: tag.trim(), quality: quality === undefined ? 1 : Number(quality), index };
    })
    .filter((entry) => /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(entry.tag) && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map((entry) => entry.tag);
}

export function requestLanguage(header: string | string[] | undefined): UiLanguage {
  return pickLanguage(uiLanguages, acceptedLanguages(header)) as UiLanguage;
}

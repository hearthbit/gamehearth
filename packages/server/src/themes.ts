export const uiThemes = ["neon", "crt", "front"] as const;

export type UiTheme = (typeof uiThemes)[number];

export function isUiTheme(value: unknown): value is UiTheme {
  return typeof value === "string" && (uiThemes as readonly string[]).includes(value);
}

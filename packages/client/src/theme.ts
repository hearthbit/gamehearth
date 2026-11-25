import { createContext } from "preact";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { saveTheme } from "./api";
import { endIntro } from "./effects";
import type { Me } from "./protocol";
import type { KeyValueStore } from "./storage";

export const themes = ["neon", "crt", "front"] as const;
export type Theme = (typeof themes)[number];
export const defaultTheme: Theme = "neon";

export const themeColors: Record<Theme, string> = { neon: "#07030f", crt: "#0b0b0d", front: "#ff8a1f" };
const colorSchemes: Record<Theme, "dark" | "light"> = { neon: "dark", crt: "dark", front: "light" };

const themeKey = "gamehearth.theme";
const accountThemeKey = "gamehearth.account-theme";

function defaultStore(): KeyValueStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (themes as readonly string[]).includes(value);
}

function read(key: string, store: KeyValueStore | undefined): Theme | undefined {
  try {
    const value = store?.getItem(key);
    return isTheme(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: Theme | undefined, store: KeyValueStore | undefined): void {
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

export function storedTheme(store: KeyValueStore | undefined = defaultStore()): Theme | undefined {
  return read(themeKey, store);
}

export function storeTheme(value: Theme | undefined, store: KeyValueStore | undefined = defaultStore()): void {
  write(themeKey, value, store);
}

export function storedAccountTheme(store: KeyValueStore | undefined = defaultStore()): Theme | undefined {
  return read(accountThemeKey, store);
}

export function storeAccountTheme(value: Theme | undefined, store: KeyValueStore | undefined = defaultStore()): void {
  write(accountThemeKey, value, store);
}

export function deviceTheme(store?: KeyValueStore): Theme {
  return storedTheme(store) ?? defaultTheme;
}

export function applyTheme(theme: Theme, document: Document | undefined = (globalThis as { document?: Document }).document): void {
  if (document === undefined) {
    return;
  }
  document.documentElement.dataset["theme"] = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColors[theme]);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", colorSchemes[theme]);
}

export function startTheme(store?: KeyValueStore, deviceOnly = false): Theme {
  const chosen = (deviceOnly ? undefined : storedAccountTheme(store)) ?? deviceTheme(store);
  applyTheme(chosen);
  return chosen;
}

export interface ThemeValue {
  theme: Theme;
  choose(next: Theme): void;
}

export const ThemeContext = createContext<ThemeValue>({ theme: defaultTheme, choose: () => undefined });

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}

export function useThemeChoice(ready: boolean, user: Me | undefined, deviceOnly: boolean): ThemeValue {
  const [current, setCurrent] = useState<Theme>(() => startTheme(undefined, deviceOnly));
  const chosenSignedOut = useRef<Theme | undefined>(undefined);
  const known = useRef<number | undefined>(undefined);
  const apply = (next: Theme) => {
    applyTheme(next);
    setCurrent(next);
  };
  useEffect(() => {
    if (!ready || deviceOnly) {
      return;
    }
    if (user === undefined) {
      if (known.current !== undefined) {
        known.current = undefined;
        storeAccountTheme(undefined);
        apply(deviceTheme());
      }
      return;
    }
    known.current = user.id;
    const handed = chosenSignedOut.current;
    chosenSignedOut.current = undefined;
    if (isTheme(user.theme)) {
      storeAccountTheme(user.theme);
      if (user.theme !== current) {
        apply(user.theme);
      }
      return;
    }
    storeAccountTheme(undefined);
    if (handed !== undefined) {
      void saveTheme(handed).catch(() => undefined);
      return;
    }
    const own = deviceTheme();
    if (own !== current) {
      apply(own);
    }
  }, [ready, user?.id, user?.theme, deviceOnly]);
  const choose = useCallback(
    (next: Theme) => {
      endIntro();
      apply(next);
      storeTheme(next);
      if (deviceOnly) {
        return;
      }
      if (user === undefined) {
        chosenSignedOut.current = next;
        return;
      }
      storeAccountTheme(next);
      void saveTheme(next).catch(() => undefined);
    },
    [user, deviceOnly],
  );
  return useMemo(() => ({ theme: current, choose }), [current, choose]);
}

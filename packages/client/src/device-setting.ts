import { useEffect, useState } from "preact/hooks";
import type { KeyValueStore } from "./storage";

export interface DeviceSetting {
  get(): boolean;
  set(value: boolean): void;
  subscribe(listener: (value: boolean) => void): () => void;
}

function defaultStore(): KeyValueStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function deviceSetting(key: string, fallback: boolean, store: () => KeyValueStore | undefined = defaultStore): DeviceSetting {
  const listeners = new Set<(value: boolean) => void>();
  let current: boolean | undefined;
  const read = (): boolean => {
    try {
      const raw = store()?.getItem(key);
      return raw === "on" ? true : raw === "off" ? false : fallback;
    } catch {
      return fallback;
    }
  };
  const write = (value: boolean): void => {
    try {
      store()?.setItem(key, value ? "on" : "off");
    } catch {
      return;
    }
  };
  return {
    get: () => current ?? read(),
    set(value) {
      current = value;
      write(value);
      for (const listener of [...listeners]) {
        listener(value);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useDeviceSetting(setting: DeviceSetting): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => setting.get());
  useEffect(() => {
    setValue(setting.get());
    return setting.subscribe(setValue);
  }, [setting]);
  return [value, setting.set];
}

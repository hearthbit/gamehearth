import { useEffect } from "preact/hooks";
import { deviceSetting } from "./device-setting";

export const effects = deviceSetting("gamehearth.effects", true);

export type Scene = "play" | "admin";

export const introMs = 1500;

function root(): HTMLElement | undefined {
  return (globalThis as { document?: Document }).document?.documentElement;
}

export function showEffects(on: boolean, element = root()): void {
  if (element === undefined) {
    return;
  }
  if (on) {
    delete element.dataset["effects"];
  } else {
    element.dataset["effects"] = "off";
  }
}

export function applyEffects(element = root()): () => void {
  showEffects(effects.get(), element);
  return effects.subscribe((on) => showEffects(on, element));
}

export function startIntro(element = root()): void {
  if (element !== undefined) {
    element.dataset["intro"] = "";
  }
}

export function endIntro(element = root()): void {
  if (element !== undefined) {
    delete element.dataset["intro"];
  }
}

export function useIntroEnd(ready: boolean, after = introMs): void {
  useEffect(() => {
    if (!ready) {
      return;
    }
    const timer = setTimeout(() => endIntro(), after);
    return () => clearTimeout(timer);
  }, [ready]);
}

export const idleMs = 20_000;

const wakeEvents = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"] as const;

export function watchIdle(element = root(), after = idleMs, target: EventTarget | undefined = (globalThis as { document?: Document }).document): () => void {
  if (element === undefined || target === undefined) {
    return () => undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = 0;
  const wake = () => {
    const now = Date.now();
    if (element.dataset["idle"] === undefined && now - last < 1000) {
      return;
    }
    last = now;
    delete element.dataset["idle"];
    clearTimeout(timer);
    timer = setTimeout(() => {
      element.dataset["idle"] = "";
    }, after);
  };
  for (const name of wakeEvents) {
    target.addEventListener(name, wake, { capture: true, passive: true });
  }
  wake();
  return () => {
    clearTimeout(timer);
    for (const name of wakeEvents) {
      target.removeEventListener(name, wake, { capture: true });
    }
  };
}

export function useScene(scene: Scene): void {
  useEffect(() => {
    const element = root();
    if (element === undefined) {
      return;
    }
    element.dataset["scene"] = scene;
    return () => {
      if (element.dataset["scene"] === scene) {
        delete element.dataset["scene"];
      }
    };
  }, [scene]);
}

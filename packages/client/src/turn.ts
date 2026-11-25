import { useEffect, useRef } from "preact/hooks";
import type { RoomView } from "./protocol";
import { tr } from "./language";
import { texts } from "./texts";

export function isMyTurn(room: RoomView | undefined): boolean {
  return room?.status === "running" && room.you.autopilot !== true && room.snapshot?.tick === undefined && (room.snapshot?.moves.length ?? 0) > 0;
}

export function pageTitle(room: RoomView | undefined): string {
  if (room === undefined) {
    return texts.appName;
  }
  return isMyTurn(room) ? `● ${texts.yourTurn} · ${tr(room.game.name, room.game.languages)}` : `${tr(room.game.name, room.game.languages)} · ${texts.appName}`;
}

interface WakeLock {
  release(): Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
}

interface BadgeNavigator {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
  vibrate?: (pattern: number | number[]) => boolean;
  wakeLock?: { request(type: "screen"): Promise<WakeLock> };
}

function quietly(work: () => Promise<unknown> | unknown): void {
  try {
    const result = work();
    if (result instanceof Promise) {
      result.catch(() => undefined);
    }
  } catch {
    return;
  }
}

export function useTurnSignals(room: RoomView | undefined): void {
  const myTurn = isMyTurn(room);
  const previous = useRef(false);
  const nav = navigator as unknown as BadgeNavigator;

  useEffect(() => {
    document.title = pageTitle(room);
  }, [room]);

  useEffect(() => {
    if (myTurn) {
      quietly(() => nav.setAppBadge?.(1));
      if (!previous.current && document.visibilityState === "visible") {
        quietly(() => nav.vibrate?.(120));
      }
    } else {
      quietly(() => nav.clearAppBadge?.());
    }
    previous.current = myTurn;
  }, [myTurn]);

  useEffect(
    () => () => {
      document.title = texts.appName;
      quietly(() => nav.clearAppBadge?.());
    },
    [],
  );

  useWakeLock(room?.status === "running");
}

export function useWakeLock(wanted: boolean): void {
  const nav = navigator as unknown as BadgeNavigator;
  useEffect(() => {
    if (!wanted || nav.wakeLock === undefined) {
      return;
    }
    let lock: WakeLock | undefined;
    let requesting = false;
    let active = true;
    const acquire = () => {
      if (!active || requesting || lock !== undefined || document.visibilityState !== "visible") {
        return;
      }
      requesting = true;
      nav.wakeLock
        ?.request("screen")
        .then((granted) => {
          requesting = false;
          if (!active) {
            granted.release().catch(() => undefined);
            return;
          }
          lock = granted;
          granted.addEventListener?.("release", () => {
            if (lock === granted) {
              lock = undefined;
            }
          });
        })
        .catch(() => {
          requesting = false;
        });
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", acquire);
      lock?.release().catch(() => undefined);
    };
  }, [wanted]);
}

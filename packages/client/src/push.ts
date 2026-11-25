import { createContext } from "preact";
import { useCallback, useContext, useEffect, useState } from "preact/hooks";
import { ApiError, pushStatus, subscribePush, testPush, unsubscribePush } from "./api";
import { language } from "./texts";
import { navigate } from "./router";

export type PushSupport = "supported" | "ios-install" | "unsupported";
export type Permission = "default" | "granted" | "denied";

export interface PushSubscriptionLike {
  readonly endpoint: string;
  readonly options?: { readonly applicationServerKey?: ArrayBuffer | null };
  toJSON(): unknown;
  unsubscribe(): Promise<boolean>;
}

export interface RegistrationLike {
  pushManager: {
    getSubscription(): Promise<PushSubscriptionLike | null>;
    subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<PushSubscriptionLike>;
  };
  getNotifications?: (filter?: { tag?: string }) => Promise<{ close(): void }[]>;
}

export interface PushPlatform {
  support(): PushSupport;
  permission(): Permission;
  requestPermission(): Promise<Permission>;
  registration(): Promise<RegistrationLike | undefined>;
}

export type PushView =
  | { state: "loading" }
  | { state: "unsupported" }
  | { state: "ios-install" }
  | { state: "unavailable" }
  | { state: "offline" }
  | { state: "denied" }
  | { state: "off"; publicKey: string }
  | { state: "on"; publicKey: string };

interface BrowserNavigator {
  serviceWorker?: { ready: Promise<RegistrationLike> };
  standalone?: boolean;
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}

interface NotificationApi {
  permission: Permission;
  requestPermission(): Promise<Permission>;
}

const readyTimeoutMs = 4000;
let synced = false;

export function resetPushSync(): void {
  synced = false;
}

export function detectSupport(scope: {
  navigator: BrowserNavigator;
  PushManager?: unknown;
  Notification?: unknown;
  isSecureContext?: boolean;
  matchMedia?: (query: string) => { matches: boolean };
}): PushSupport {
  if (scope.navigator.serviceWorker !== undefined && scope.PushManager !== undefined && scope.Notification !== undefined && scope.isSecureContext !== false) {
    return "supported";
  }
  const ios = /iPad|iPhone|iPod/.test(scope.navigator.userAgent) || (scope.navigator.platform === "MacIntel" && (scope.navigator.maxTouchPoints ?? 0) > 1);
  const standalone = scope.navigator.standalone === true || scope.matchMedia?.("(display-mode: standalone)").matches === true;
  return ios && !standalone ? "ios-install" : "unsupported";
}

export const browserPushPlatform: PushPlatform = {
  support() {
    if (typeof navigator === "undefined") {
      return "unsupported";
    }
    const scope = globalThis as unknown as { PushManager?: unknown; Notification?: unknown; isSecureContext?: boolean; matchMedia?: (query: string) => { matches: boolean } };
    return detectSupport({
      navigator: navigator as unknown as BrowserNavigator,
      PushManager: scope.PushManager,
      Notification: scope.Notification,
      ...(scope.isSecureContext === undefined ? {} : { isSecureContext: scope.isSecureContext }),
      ...(scope.matchMedia === undefined ? {} : { matchMedia: (query: string) => (scope.matchMedia as (query: string) => { matches: boolean })(query) }),
    });
  },
  permission() {
    const api = (globalThis as unknown as { Notification?: NotificationApi }).Notification;
    return api?.permission ?? "denied";
  },
  async requestPermission() {
    const api = (globalThis as unknown as { Notification?: NotificationApi }).Notification;
    return api === undefined ? "denied" : api.requestPermission();
  },
  async registration() {
    const worker = (navigator as unknown as BrowserNavigator).serviceWorker;
    if (worker === undefined) {
      return undefined;
    }
    return Promise.race([worker.ready, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), readyTimeoutMs))]);
  },
};

export const PushPlatformContext = createContext<PushPlatform>(browserPushPlatform);

export function keyBytes(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function sameKey(current: ArrayBuffer | null | undefined, wanted: Uint8Array): boolean {
  if (current === null || current === undefined) {
    return false;
  }
  const bytes = new Uint8Array(current);
  return bytes.length === wanted.length && bytes.every((byte, index) => byte === wanted[index]);
}

export async function loadPushView(platform: PushPlatform): Promise<PushView> {
  const support = platform.support();
  if (support !== "supported") {
    return { state: support };
  }
  let status: { publicKey?: string; enabled: boolean };
  try {
    status = await pushStatus();
  } catch (error) {
    return error instanceof ApiError && error.code === "offline" ? { state: "offline" } : { state: "unavailable" };
  }
  if (status.publicKey === undefined) {
    return { state: "unavailable" };
  }
  const permission = platform.permission();
  if (permission === "denied") {
    return { state: "denied" };
  }
  if (!status.enabled || permission !== "granted") {
    return { state: "off", publicKey: status.publicKey };
  }
  const registration = await platform.registration();
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription === null || subscription === undefined) {
    return { state: "off", publicKey: status.publicKey };
  }
  if (!synced) {
    synced = true;
    await subscribePush(subscription.toJSON(), language).catch(() => undefined);
  }
  return { state: "on", publicKey: status.publicKey };
}

export async function enablePush(platform: PushPlatform, publicKey: string): Promise<void> {
  const permission = await platform.requestPermission();
  if (permission !== "granted") {
    throw new ApiError(permission === "denied" ? "push-denied" : "push-dismissed", "No permission for notifications");
  }
  const registration = await platform.registration();
  if (registration === undefined) {
    throw new ApiError("push-unsupported", "Kein Service Worker");
  }
  const key = keyBytes(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription !== null && !sameKey(subscription.options?.applicationServerKey, key)) {
    await subscription.unsubscribe().catch(() => false);
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await subscribePush(subscription.toJSON(), language);
  synced = true;
}

export async function disablePush(platform: PushPlatform): Promise<void> {
  await unsubscribePush();
  const registration = await platform.registration().catch(() => undefined);
  const subscription = await registration?.pushManager.getSubscription().catch(() => null);
  await subscription?.unsubscribe().catch(() => false);
}

export async function clearRoomNotifications(platform: PushPlatform, code: string): Promise<void> {
  try {
    if (platform.support() !== "supported" || platform.permission() !== "granted") {
      return;
    }
    const registration = await platform.registration();
    for (const notification of (await registration?.getNotifications?.({ tag: code })) ?? []) {
      notification.close();
    }
  } catch {
    return;
  }
}

export function handleWorkerMessage(data: unknown, go: (path: string) => void = navigate): boolean {
  if (data === null || typeof data !== "object") {
    return false;
  }
  const message = data as Record<string, unknown>;
  const path = message["path"];
  if (message["type"] !== "open" || typeof path !== "string" || !/^\/(r\/[A-Za-z0-9]{1,12}|account)?$/.test(path)) {
    return false;
  }
  go(path);
  return true;
}

export interface PushControl {
  view: PushView;
  busy: boolean;
  enable(): Promise<boolean>;
  disable(): Promise<boolean>;
  test(): Promise<boolean>;
  reload(): void;
}

export function usePush(onError: (error: unknown) => void): PushControl {
  const platform = useContext(PushPlatformContext);
  const [view, setView] = useState<PushView>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    loadPushView(platform).then(
      (next) => active && setView(next),
      () => active && setView({ state: "unavailable" }),
    );
    return () => {
      active = false;
    };
  }, [platform, attempt]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const run = async (work: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    try {
      await work();
      return true;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      setBusy(false);
      reload();
    }
  };
  return {
    view,
    busy,
    reload,
    enable: () => run(async () => enablePush(platform, view.state === "off" || view.state === "on" ? view.publicKey : (await pushStatus()).publicKey ?? "")),
    disable: () => run(() => disablePush(platform)),
    test: async () => {
      setBusy(true);
      try {
        await testPush();
        return true;
      } catch (error) {
        onError(error);
        return false;
      } finally {
        setBusy(false);
      }
    },
  };
}

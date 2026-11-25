// @vitest-environment happy-dom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, RoomSummary, RoomView } from "../src/protocol";
import {
  PushPlatformContext,
  clearRoomNotifications,
  detectSupport,
  disablePush,
  enablePush,
  handleWorkerMessage,
  keyBytes,
  loadPushView,
  resetPushSync,
  type Permission,
  type PushPlatform,
  type PushSubscriptionLike,
  type RegistrationLike,
} from "../src/push";
import { AccountScreen } from "../src/screens/account";
import { Home } from "../src/screens/home";
import { Lobby } from "../src/screens/lobby";
import { Play } from "../src/screens/play";
import { SessionContext, type SessionValue } from "../src/session";
import { DeviceStorage, type KeyValueStore } from "../src/storage";

const publicKey = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";

type Route = (body: unknown) => unknown;
let routes: Record<string, Route>;
let calls: { path: string; body: unknown }[];

beforeEach(() => {
  localStorage.clear();
  routes = {};
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ path, body });
      const route = routes[`${init?.method ?? "GET"} ${path}`];
      if (route === undefined) {
        return new Response(JSON.stringify({ code: "not-found", message: "nicht da" }), { status: 404 });
      }
      const result = route(body);
      return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
    }),
  );
});

let container: HTMLElement | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  if (container !== undefined) {
    act(() => render(null, container as HTMLElement));
    container.remove();
    container = undefined;
  }
});

class FakeSubscription implements PushSubscriptionLike {
  readonly endpoint: string;
  readonly options: { applicationServerKey: ArrayBuffer };
  unsubscribed = false;

  constructor(endpoint: string, key: Uint8Array) {
    this.endpoint = endpoint;
    this.options = { applicationServerKey: key.slice().buffer };
  }

  toJSON(): unknown {
    return { endpoint: this.endpoint, keys: { p256dh: "p", auth: "a" } };
  }

  async unsubscribe(): Promise<boolean> {
    this.unsubscribed = true;
    return true;
  }
}

function fakePlatform(options: { permission?: Permission; answer?: Permission; existing?: FakeSubscription | null; support?: ReturnType<PushPlatform["support"]> } = {}) {
  const state = {
    permission: options.permission ?? ("default" as Permission),
    current: options.existing ?? (null as FakeSubscription | null),
    subscribed: [] as Uint8Array[],
    closed: [] as string[],
    tags: [] as (string | undefined)[],
  };
  const registration: RegistrationLike = {
    pushManager: {
      getSubscription: async () => state.current,
      subscribe: async ({ applicationServerKey }) => {
        state.subscribed.push(applicationServerKey);
        state.current = new FakeSubscription(`https://fcm.googleapis.com/fcm/send/${state.subscribed.length}`, applicationServerKey);
        return state.current;
      },
    },
    getNotifications: async (filter) => {
      state.tags.push(filter?.tag);
      return [{ close: () => state.closed.push(filter?.tag ?? "") }];
    },
  };
  const platform: PushPlatform = {
    support: () => options.support ?? "supported",
    permission: () => state.permission,
    requestPermission: async () => {
      state.permission = options.answer ?? "granted";
      return state.permission;
    },
    registration: async () => registration,
  };
  return { platform, state };
}

describe("Detection", () => {
  const chrome = { userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/130", serviceWorker: { ready: new Promise<RegistrationLike>(() => undefined) } };
  const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Safari/604.1" };

  it("tells apart push, iPhone in a Safari tab and browsers without push", () => {
    expect(detectSupport({ navigator: chrome, PushManager: {}, Notification: {} })).toBe("supported");
    expect(detectSupport({ navigator: iphone })).toBe("ios-install");
    expect(detectSupport({ navigator: { ...iphone, standalone: true } })).toBe("unsupported");
    expect(detectSupport({ navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", platform: "MacIntel", maxTouchPoints: 5 } })).toBe("ios-install");
    expect(detectSupport({ navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Firefox/130" } })).toBe("unsupported");
    expect(detectSupport({ navigator: chrome, PushManager: {}, Notification: {}, isSecureContext: false })).toBe("unsupported");
  });

  it("converts the server's key to bytes", () => {
    const bytes = keyBytes(publicKey);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
  });
});

describe("State", () => {
  it("is off as long as the server has no subscription for this session", async () => {
    routes["GET /api/me/push"] = () => ({ publicKey, enabled: false });
    expect(await loadPushView(fakePlatform({ permission: "granted" }).platform)).toEqual({ state: "off", publicKey });
  });

  it("registers an existing subscription again once on first load, in case the browser has renewed it meanwhile", async () => {
    routes["GET /api/me/push"] = () => ({ publicKey, enabled: true });
    routes["POST /api/me/push"] = () => ({ enabled: true });
    resetPushSync();
    const existing = new FakeSubscription("https://fcm.googleapis.com/aktuell", keyBytes(publicKey));
    const { platform } = fakePlatform({ permission: "granted", existing });
    expect(await loadPushView(platform)).toEqual({ state: "on", publicKey });
    expect(await loadPushView(platform)).toEqual({ state: "on", publicKey });
    expect(calls.filter((call) => call.path === "/api/me/push" && call.body !== undefined)).toEqual([
      { path: "/api/me/push", body: { subscription: { endpoint: "https://fcm.googleapis.com/aktuell", keys: { p256dh: "p", auth: "a" } }, language: "de" } },
    ]);
    resetPushSync();
    routes["GET /api/me/push"] = () => ({ publicKey, enabled: false });
    await loadPushView(platform);
    expect(calls.filter((call) => call.body !== undefined)).toHaveLength(1);
  });

  it("is on when server and browser have a subscription", async () => {
    routes["GET /api/me/push"] = () => ({ publicKey, enabled: true });
    const existing = new FakeSubscription("https://fcm.googleapis.com/x", keyBytes(publicKey));
    expect(await loadPushView(fakePlatform({ permission: "granted", existing }).platform)).toEqual({ state: "on", publicKey });
    expect(await loadPushView(fakePlatform({ permission: "granted", existing: null }).platform)).toEqual({ state: "off", publicKey });
  });

  it("reports blocked permission, missing support and servers without push", async () => {
    routes["GET /api/me/push"] = () => ({ publicKey, enabled: true });
    expect(await loadPushView(fakePlatform({ permission: "denied" }).platform)).toEqual({ state: "denied" });
    expect(await loadPushView(fakePlatform({ support: "ios-install" }).platform)).toEqual({ state: "ios-install" });
    routes["GET /api/me/push"] = () => ({ enabled: false });
    expect(await loadPushView(fakePlatform().platform)).toEqual({ state: "unavailable" });
  });
});

describe("Turning on and off", () => {
  it("asks only when turning on, subscribes with the server's key and registers the subscription", async () => {
    routes["POST /api/me/push"] = () => ({ enabled: true });
    const { platform, state } = fakePlatform();
    await enablePush(platform, publicKey);
    expect(state.permission).toBe("granted");
    expect([...(state.subscribed[0] ?? [])]).toEqual([...keyBytes(publicKey)]);
    expect(calls).toEqual([{ path: "/api/me/push", body: { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/1", keys: { p256dh: "p", auth: "a" } }, language: "de" } }]);
  });

  it("replaces a subscription with a foreign key, e.g. after a new server", async () => {
    routes["POST /api/me/push"] = () => ({ enabled: true });
    const old = new FakeSubscription("https://fcm.googleapis.com/alt", new Uint8Array(65).fill(4));
    const { platform, state } = fakePlatform({ permission: "granted", existing: old });
    await enablePush(platform, publicKey);
    expect(old.unsubscribed).toBe(true);
    expect(state.subscribed).toHaveLength(1);
  });

  it("keeps a matching subscription", async () => {
    routes["POST /api/me/push"] = () => ({ enabled: true });
    const existing = new FakeSubscription("https://fcm.googleapis.com/da", keyBytes(publicKey));
    const { platform, state } = fakePlatform({ permission: "granted", existing });
    await enablePush(platform, publicKey);
    expect(state.subscribed).toHaveLength(0);
    expect((calls[0]?.body as { subscription: { endpoint: string } }).subscription.endpoint).toBe("https://fcm.googleapis.com/da");
  });

  it("aborts without permission and sends nothing", async () => {
    await expect(enablePush(fakePlatform({ answer: "denied" }).platform, publicKey)).rejects.toMatchObject({ code: "push-denied" });
    await expect(enablePush(fakePlatform({ answer: "default" }).platform, publicKey)).rejects.toMatchObject({ code: "push-dismissed" });
    expect(calls).toEqual([]);
  });

  it("turns off at the server and cancels the subscription in the browser", async () => {
    routes["POST /api/me/push/off"] = () => ({ enabled: false });
    const existing = new FakeSubscription("https://fcm.googleapis.com/da", keyBytes(publicKey));
    await disablePush(fakePlatform({ permission: "granted", existing }).platform);
    expect(calls.map((call) => call.path)).toEqual(["/api/me/push/off"]);
    expect(existing.unsubscribed).toBe(true);
  });

  it("clears the notifications of a room", async () => {
    const { platform, state } = fakePlatform({ permission: "granted" });
    await clearRoomNotifications(platform, "ABC234");
    expect(state.closed).toEqual(["ABC234"]);
    const blocked = fakePlatform({ permission: "default" });
    await clearRoomNotifications(blocked.platform, "ABC234");
    expect(blocked.state.tags).toEqual([]);
  });
});

describe("Messages from the service worker", () => {
  it("opens only paths of the app", () => {
    const opened: string[] = [];
    const go = (path: string) => opened.push(path);
    expect(handleWorkerMessage({ type: "open", path: "/r/ABC234" }, go)).toBe(true);
    expect(handleWorkerMessage({ type: "open", path: "/account" }, go)).toBe(true);
    expect(handleWorkerMessage({ type: "open", path: "https://boese.example" }, go)).toBe(false);
    expect(handleWorkerMessage({ type: "open", path: "//boese.example" }, go)).toBe(false);
    expect(handleWorkerMessage({ type: "andere" }, go)).toBe(false);
    expect(handleWorkerMessage(null, go)).toBe(false);
    expect(opened).toEqual(["/r/ABC234", "/account"]);
  });
});

function memory(): KeyValueStore {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) };
}

const anna: Me = { id: 1, kind: "account", username: "anna", name: "Anna", role: "player" };
const gast: Me = { id: 2, kind: "guest", name: "Ben", role: "player" };

function session(user: Me): SessionValue {
  return { me: { state: "ready", user }, user, refresh: async () => undefined, setUser: () => undefined, reload: () => undefined };
}

async function mount(element: preact.JSX.Element, user: Me, platform: PushPlatform): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    render(
      <SessionContext.Provider value={session(user)}>
        <PushPlatformContext.Provider value={platform}>{element}</PushPlatformContext.Provider>
      </SessionContext.Provider>,
      container as HTMLElement,
    );
  });
  await settle();
  return container;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const button = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);

async function click(element: HTMLElement | undefined): Promise<void> {
  if (element === undefined) {
    throw new Error("Knopf fehlt");
  }
  await act(async () => {
    element.click();
  });
  await settle();
}

describe("Account page", () => {
  it("turns on, sends a test notification and turns off", async () => {
    let enabled = false;
    routes["GET /api/me/push"] = () => ({ publicKey, enabled });
    routes["POST /api/me/push"] = () => ((enabled = true), { enabled });
    routes["POST /api/me/push/off"] = () => ((enabled = false), { enabled });
    routes["POST /api/me/push/test"] = () => ({});
    routes["GET /api/me/sessions"] = () => ({ sessions: [{ id: 1, device: "Chrome auf Android", createdAt: 0, seenAt: 0, current: true, push: true }] });
    const notes: string[] = [];
    const { platform } = fakePlatform();
    const root = await mount(<AccountScreen notify={(text) => notes.push(text)} />, anna, platform);
    const card = root.querySelector("[data-testid=push-card]") as HTMLElement;
    expect(card.dataset["state"]).toBe("off");
    expect(root.textContent).toContain("Push");
    await click(button(card, "Einschalten"));
    expect(card.dataset["state"]).toBe("on");
    expect(notes).toContain("Benachrichtigungen sind auf diesem Gerät an.");
    await click(button(card, "Testnachricht"));
    expect(calls.some((call) => call.path === "/api/me/push/test")).toBe(true);
    expect(notes).toContain("Testnachricht ist unterwegs.");
    await click(button(card, "Ausschalten"));
    expect(card.dataset["state"]).toBe("off");
  });

  it("keeps the focus on the card when the button disappears", async () => {
    let enabled = false;
    routes["GET /api/me/push"] = () => ({ publicKey, enabled });
    routes["POST /api/me/push"] = () => ((enabled = true), { enabled });
    routes["GET /api/me/sessions"] = () => ({ sessions: [] });
    const root = await mount(<AccountScreen notify={() => undefined} />, anna, fakePlatform().platform);
    const card = root.querySelector("[data-testid=push-card]") as HTMLElement;
    const enable = button(card, "Einschalten") as HTMLElement;
    enable.focus();
    await click(enable);
    expect(card.dataset["state"]).toBe("on");
    expect(document.activeElement).not.toBe(document.body);
    expect(card.contains(document.activeElement)).toBe(true);
  });

  it("offers a code on the iPhone so the installed app takes the seats along", async () => {
    routes["GET /api/me/rooms"] = () => ({ rooms: [summary("running")] });
    routes["GET /api/games"] = () => [];
    routes["POST /api/me/transfer"] = () => ({ code: "ABCD-EFGH", expiresAt: Date.now() + 600_000 });
    const guestRoot = await mount(<Home storage={new DeviceStorage(memory())} notify={() => undefined} />, gast, fakePlatform({ support: "ios-install" }).platform);
    const hint = guestRoot.querySelector("[data-testid=push-hint]") as HTMLElement;
    expect(hint.textContent).toContain("Nimm deine Plätze mit");
    await click(button(hint, "Code für die App"));
    expect(hint.querySelector("[data-testid=transfer-code]")?.textContent).toBe("ABCD-EFGH");
    act(() => render(null, guestRoot));
    guestRoot.remove();
    const accountRoot = await mount(<Home storage={new DeviceStorage(memory())} notify={() => undefined} />, anna, fakePlatform({ support: "ios-install" }).platform);
    expect(accountRoot.querySelector("[data-testid=push-hint]")?.textContent).toContain("neu an");
  });

  it("shows guests the switch, and the iPhone in a Safari tab the instructions", async () => {
    routes["GET /api/me/push"] = () => ({ publicKey, enabled: false });
    const guestRoot = await mount(<AccountScreen notify={() => undefined} />, gast, fakePlatform().platform);
    expect((guestRoot.querySelector("[data-testid=push-card]") as HTMLElement).dataset["state"]).toBe("off");
    act(() => render(null, guestRoot));
    guestRoot.remove();
    const iosRoot = await mount(<AccountScreen notify={() => undefined} />, anna, fakePlatform({ support: "ios-install" }).platform);
    expect(iosRoot.textContent).toContain("Zum Home-Bildschirm");
  });

  it("reports a denied permission", async () => {
    routes["GET /api/me/push"] = () => ({ publicKey, enabled: false });
    const notes: string[] = [];
    const root = await mount(<AccountScreen notify={(text) => notes.push(text)} />, anna, fakePlatform({ answer: "denied" }).platform);
    await click(button(root.querySelector("[data-testid=push-card]") as HTMLElement, "Einschalten"));
    expect(notes).toEqual(["Benachrichtigungen sind für diese Seite blockiert. Erlaube sie in den Einstellungen des Browsers."]);
    expect((root.querySelector("[data-testid=push-card]") as HTMLElement).dataset["state"]).toBe("denied");
  });
});

const summary = (status: RoomSummary["status"]): RoomSummary => ({ code: "ABC234", game: "Mau-Mau", status, round: 1, members: 2, host: true, yourTurn: false, updatedAt: 0 });

describe("Hint", () => {
  it('appears on the home page only with a running match and remembers "Not now" ("Nicht jetzt")', async () => {
    routes["GET /api/me/push"] = () => ({ publicKey, enabled: false });
    routes["GET /api/games"] = () => [];
    routes["GET /api/me/rooms"] = () => ({ rooms: [summary("lobby")] });
    const storage = new DeviceStorage(memory());
    const quiet = await mount(<Home storage={storage} notify={() => undefined} />, anna, fakePlatform().platform);
    expect(quiet.querySelector("[data-testid=push-hint]")).toBeNull();
    act(() => render(null, quiet));
    quiet.remove();
    routes["GET /api/me/rooms"] = () => ({ rooms: [{ ...summary("running"), muted: true }] });
    const root = await mount(<Home storage={storage} notify={() => undefined} />, anna, fakePlatform().platform);
    expect(root.querySelector("[data-testid=push-hint]")).not.toBeNull();
    expect(root.textContent).toContain("stumm");
    await click(button(root, "Nicht jetzt"));
    expect(root.querySelector("[data-testid=push-hint]")).toBeNull();
    expect(storage.pushHintDismissed()).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("disappears in the lobby after turning on", async () => {
    let enabled = false;
    routes["GET /api/me/push"] = () => ({ publicKey, enabled });
    routes["POST /api/me/push"] = () => ((enabled = true), { enabled });
    const root = await mount(<Lobby room={room("lobby")} online command={async () => ({ ok: true })} notify={() => undefined} onLeave={async () => undefined} />, anna, fakePlatform().platform);
    const hint = root.querySelector("[data-testid=push-hint]") as HTMLElement;
    expect(hint).not.toBeNull();
    await click(button(hint, "Einschalten"));
    expect(root.querySelector("[data-testid=push-hint]")).toBeNull();
  });
});

function room(status: RoomView["status"], muted = false): RoomView {
  return {
    code: "ABC234",
    game: { id: "mau-mau", name: "Mau-Mau", version: "0.1.0", client: "/games/mau-mau/0.1.0+abcdefabcdef/" },
    status,
    round: 1,
    players: { min: 2, max: 6 },
    maxMembers: 6,
    members: [{ id: 1, name: "Anna", seat: status === "lobby" ? null : "p1", host: true, guest: false, deleted: false, you: true, connected: true }],
    you: { id: 1, name: "Anna", seat: status === "lobby" ? null : "p1", host: true, guest: false, deleted: false },
    muted,
    canStart: false,
    ...(status === "lobby" ? {} : { snapshot: { player: "p1", players: ["p1"], public: {}, me: {}, moves: [], version: 1 } }),
  };
}

describe("Muting", () => {
  it("mutes and unmutes in the lobby", async () => {
    routes["POST /api/rooms/ABC234/mute"] = (body) => ({ muted: (body as { muted: boolean }).muted });
    const notes: string[] = [];
    const root = await mount(<Lobby room={room("lobby")} online command={async () => ({ ok: true })} notify={(text) => notes.push(text)} onLeave={async () => undefined} />, anna, fakePlatform({ support: "unsupported" }).platform);
    await click(root.querySelector("[aria-label=Menü]") as HTMLElement);
    await click(button(root, "Raum stummschalten"));
    expect(calls.at(-1)).toEqual({ path: "/api/rooms/ABC234/mute", body: { muted: true } });
    expect(notes).toEqual(["Raum stummgeschaltet. Für ihn kommen keine Benachrichtigungen."]);
  });

  it("offers unmuting in the game menu when the room is muted", async () => {
    routes["POST /api/rooms/ABC234/mute"] = (body) => ({ muted: (body as { muted: boolean }).muted });
    const root = await mount(<Play room={room("running", true)} online command={async () => ({ ok: true })} notify={() => undefined} onLeave={async () => undefined} />, anna, fakePlatform({ support: "unsupported" }).platform);
    await click(root.querySelector("[aria-label=Menü]") as HTMLElement);
    await click(button(root, "Stummschaltung aufheben"));
    expect(calls.at(-1)).toEqual({ path: "/api/rooms/ABC234/mute", body: { muted: false } });
  });
});

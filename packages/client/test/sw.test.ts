import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderServiceWorker, shellVersion } from "../sw-plugin";

type Handler = (event: unknown) => void;

interface Stored {
  body: string;
  type: string;
}

class FakeResponse {
  readonly body: string;
  readonly type: string;
  readonly ok: boolean;

  constructor(body: string, init: { type: string; ok?: boolean }) {
    this.body = body;
    this.type = init.type;
    this.ok = init.ok ?? true;
  }

  get headers() {
    return { get: (name: string) => (name.toLowerCase() === "content-type" ? this.type : null) };
  }

  clone(): FakeResponse {
    return new FakeResponse(this.body, { type: this.type, ok: this.ok });
  }

  static error(): FakeResponse {
    return new FakeResponse("", { type: "", ok: false });
  }
}

function loadWorker(shell: string[]) {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, Map<string, Stored>>();
  const network = new Map<string, Stored>();
  const pending: Promise<unknown>[] = [];
  const open = (name: string) => {
    const store = stores.get(name) ?? new Map<string, Stored>();
    stores.set(name, store);
    return {
      addAll: async (paths: string[]) => {
        for (const path of paths) {
          store.set(path, network.get(path) ?? { body: path, type: "text/plain" });
        }
      },
      put: async (path: string, response: FakeResponse) => {
        store.set(path, { body: response.body, type: response.type });
      },
    };
  };
  const match = async (path: string) => {
    for (const store of stores.values()) {
      const hit = store.get(path);
      if (hit !== undefined) {
        return new FakeResponse(hit.body, { type: hit.type });
      }
    }
    return undefined;
  };
  const context = {
    self: {
      location: { origin: "https://games.example" },
      addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
      skipWaiting: async () => undefined,
      clients: { claim: async () => undefined },
    },
    caches: {
      open: (name: string) => {
        const result = Promise.resolve(open(name));
        pending.push(result);
        return result;
      },
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      match,
    },
    fetch: async (request: { url: string }) => {
      const hit = network.get(new URL(request.url).pathname);
      if (hit === undefined) {
        throw new Error("offline");
      }
      return new FakeResponse(hit.body, { type: hit.type });
    },
    Response: FakeResponse,
    URL,
  };
  const source = renderServiceWorker(readFileSync(new URL("../src/sw.js", import.meta.url), "utf8"), shell, "test");
  runInNewContext(source, context);
  const settle = async () => {
    for (let round = 0; round < 5; round++) {
      await Promise.all(pending.splice(0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const dispatch = async (path: string, mode = "no-cors"): Promise<FakeResponse | undefined> => {
    let responded: Promise<FakeResponse> | undefined;
    handlers.get("fetch")?.({
      request: { url: `https://games.example${path}`, method: "GET", mode },
      respondWith: (value: Promise<FakeResponse>) => {
        responded = value;
      },
    });
    const response = responded === undefined ? undefined : await responded;
    await settle();
    return response;
  };
  const install = async () => {
    let done: Promise<unknown> | undefined;
    handlers.get("install")?.({
      waitUntil: (value: Promise<unknown>) => {
        done = value;
      },
    });
    await done;
  };
  const cached = (path: string) => stores.get("gamehearth-test")?.get(path)?.body;
  return { dispatch, install, network, cached };
}

describe("Service Worker", () => {
  it("stores only HTML pages as the home page for offline, no directly opened files", async () => {
    const worker = loadWorker(["/", "/icon.svg"]);
    worker.network.set("/", { body: "<html>alt</html>", type: "text/html; charset=utf-8" });
    worker.network.set("/icon.svg", { body: "<svg/>", type: "image/svg+xml" });
    await worker.install();
    worker.network.set("/icon-512.png", { body: "PNG", type: "image/png" });
    worker.network.set("/r/ABC234", { body: "<html>neu</html>", type: "text/html; charset=utf-8" });
    await worker.dispatch("/icon-512.png", "navigate");
    expect(worker.cached("/")).toBe("<html>alt</html>");
    await worker.dispatch("/r/ABC234", "navigate");
    expect(worker.cached("/")).toBe("<html>neu</html>");
  });

  it("starts offline from the cache and leaves API, WebSocket and games alone", async () => {
    const worker = loadWorker(["/"]);
    worker.network.set("/", { body: "<html>app</html>", type: "text/html" });
    await worker.install();
    worker.network.clear();
    expect((await worker.dispatch("/r/XYZ789", "navigate"))?.body).toBe("<html>app</html>");
    expect(await worker.dispatch("/api/games")).toBeUndefined();
    expect(await worker.dispatch("/games/mau-mau/0.1.0+abcdefabcdef/", "navigate")).toBeUndefined();
    expect(await worker.dispatch("/ws")).toBeUndefined();
  });
});

describe("Service worker version", () => {
  it("changes when only the content of an unhashed file or of the home page changes", () => {
    const base = [
      { path: "/", content: "<html>" },
      { path: "/manifest.webmanifest", content: '{"name":"Gamehearth"}' },
      { path: "/assets/index-abc.js", content: "" },
    ];
    const manifest = base.map((entry) => (entry.path === "/manifest.webmanifest" ? { ...entry, content: '{"name":"Spiele"}' } : entry));
    const page = base.map((entry) => (entry.path === "/" ? { ...entry, content: "<html lang=de>" } : entry));
    expect(shellVersion(manifest)).not.toBe(shellVersion(base));
    expect(shellVersion(page)).not.toBe(shellVersion(base));
    expect(shellVersion([...base].reverse())).toBe(shellVersion(base));
  });
});

interface Shown {
  title: string;
  options: { body: string; tag: string; renotify: boolean; lang: string; data: { path: string } };
}

function loadPushWorker(windows: { url: string }[] = []) {
  const handlers = new Map<string, Handler>();
  const shown: Shown[] = [];
  const badges: unknown[] = [];
  const opened: string[] = [];
  const messages: { client: string; message: unknown }[] = [];
  const focused: string[] = [];
  const posts: { url: string; body: unknown }[] = [];
  const clients = windows.map((window) => ({
    url: window.url,
    postMessage: (message: unknown) => messages.push({ client: window.url, message }),
    focus: async () => {
      focused.push(window.url);
      return undefined;
    },
  }));
  const context = {
    self: {
      location: { origin: "https://games.example" },
      addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
      registration: {
        showNotification: async (title: string, options: Shown["options"]) => void shown.push({ title, options }),
        pushManager: { subscribe: async () => ({ toJSON: () => ({ endpoint: "https://fcm.googleapis.com/neu" }) }) },
      },
      navigator: { setAppBadge: async (count?: number) => void badges.push(count) },
      clients: {
        claim: async () => undefined,
        matchAll: async () => clients,
        openWindow: async (url: string) => void opened.push(url),
      },
    },
    caches: { open: async () => ({}), keys: async () => [], match: async () => undefined },
    fetch: async (url: string, init: { body: string }) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
    URL,
  };
  const source = renderServiceWorker(readFileSync(new URL("../src/sw.js", import.meta.url), "utf8"), ["/"], "test");
  runInNewContext(source, context);
  const fire = async (type: string, event: Record<string, unknown>) => {
    let done: Promise<unknown> | undefined;
    handlers.get(type)?.({ ...event, waitUntil: (value: Promise<unknown>) => (done = value) });
    await done;
  };
  return {
    shown,
    badges,
    opened,
    messages,
    focused,
    posts,
    push: (payload: unknown) => fire("push", { data: payload === undefined ? null : { json: () => (typeof payload === "string" ? JSON.parse(payload) : payload) } }),
    click: (path: unknown) => fire("notificationclick", { notification: { data: { path }, close: () => undefined } }),
    change: (event: Record<string, unknown>) => fire("pushsubscriptionchange", event),
  };
}

describe("Push in the service worker", () => {
  it('shows "Your turn" ("Du bist dran") with game and room, one notification per room, and sets the app badge', async () => {
    const worker = loadPushWorker();
    await worker.push({ kind: "turn", room: "ABC234", game: "Mau-Mau", lang: "de" });
    expect(worker.shown).toEqual([
      {
        title: "Du bist dran",
        options: expect.objectContaining({ body: "Mau-Mau · Raum ABC234", tag: "ABC234", renotify: true, lang: "de", data: { path: "/r/ABC234" } }),
      },
    ]);
    expect(worker.badges).toEqual([undefined]);
  });

  it('shows "Match is over" ("Partie ist vorbei") under the same tag and without a badge', async () => {
    const worker = loadPushWorker();
    await worker.push({ kind: "finished", room: "ABC234", game: "Mau-Mau", lang: "de" });
    expect(worker.shown[0]).toMatchObject({ title: "Partie ist vorbei", options: { tag: "ABC234", body: "Mau-Mau · Raum ABC234" } });
    expect(worker.badges).toEqual([]);
  });

  it("Step 12: shows the notification in the language the server sends, English without one", async () => {
    const worker = loadPushWorker();
    await worker.push({ kind: "turn", room: "ABC234", game: "Mau-Mau", lang: "en" });
    await worker.push({ kind: "finished", room: "ABC234", game: "Mau-Mau" });
    await worker.push({ kind: "test", lang: "xx" });
    expect(worker.shown.map((note) => [note.title, note.options.body, note.options.lang])).toEqual([
      ["Your turn", "Mau-Mau · Room ABC234", "en"],
      ["Match is over", "Mau-Mau · Room ABC234", "en"],
      [expect.any(String), expect.any(String), "en"],
    ]);
  });

  it("shows a notification even for broken or empty content, so the browser does not revoke the subscription", async () => {
    const worker = loadPushWorker();
    await worker.push(undefined);
    await worker.push("{kaputt");
    await worker.push({ kind: "turn", room: "<script>", game: 42 });
    expect(worker.shown).toHaveLength(3);
    expect(worker.shown.map((note) => note.options.data.path)).toEqual(["/", "/", "/"]);
    expect(worker.shown.map((note) => note.options.tag)).toEqual(["gamehearth", "gamehearth", "gamehearth"]);
  });

  it("shows the test notification and leads to the account page", async () => {
    const worker = loadPushWorker();
    await worker.push({ kind: "test", lang: "de" });
    expect(worker.shown[0]).toMatchObject({ title: "Benachrichtigungen funktionieren", options: { data: { path: "/account" } } });
  });

  it("on tap takes a window of the app, not a tab with an API response", async () => {
    const worker = loadPushWorker([{ url: "https://games.example/api/me" }, { url: "https://games.example/r/XYZ789" }]);
    await worker.click("/r/ABC234");
    expect(worker.focused).toEqual(["https://games.example/r/XYZ789"]);
    expect(worker.messages).toEqual([{ client: "https://games.example/r/XYZ789", message: { type: "open", path: "/r/ABC234" } }]);
    const onlyApi = loadPushWorker([{ url: "https://games.example/api/me" }]);
    await onlyApi.click("/r/ABC234");
    expect(onlyApi.opened).toEqual(["/r/ABC234"]);
    expect(onlyApi.messages).toEqual([]);
  });

  it("on tap opens the room in an already open window", async () => {
    const worker = loadPushWorker([{ url: "https://andere.example/" }, { url: "https://games.example/" }]);
    await worker.click("/r/ABC234");
    expect(worker.focused).toEqual(["https://games.example/"]);
    expect(worker.messages).toEqual([{ client: "https://games.example/", message: { type: "open", path: "/r/ABC234" } }]);
    expect(worker.opened).toEqual([]);
  });

  it("opens a new window when none is open, and only paths of the app", async () => {
    const worker = loadPushWorker();
    await worker.click("/r/ABC234");
    await worker.click("https://boese.example/");
    await worker.click("//boese.example/r/X");
    expect(worker.opened).toEqual(["/r/ABC234", "/", "/"]);
  });

  it("reports a renewed subscription only together with the old one, so no other user of the device gets push unasked", async () => {
    const worker = loadPushWorker();
    await worker.change({
      oldSubscription: { endpoint: "https://fcm.googleapis.com/alt", options: { userVisibleOnly: true } },
      newSubscription: { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/x" }) },
    });
    await worker.change({ oldSubscription: { endpoint: "https://fcm.googleapis.com/alt2", options: { userVisibleOnly: true } } });
    await worker.change({ newSubscription: { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/ohne-alt" }) } });
    expect(worker.posts).toEqual([
      { url: "/api/me/push/renew", body: { oldEndpoint: "https://fcm.googleapis.com/alt", subscription: { endpoint: "https://fcm.googleapis.com/x" } } },
      { url: "/api/me/push/renew", body: { oldEndpoint: "https://fcm.googleapis.com/alt2", subscription: { endpoint: "https://fcm.googleapis.com/neu" } } },
    ]);
  });
});

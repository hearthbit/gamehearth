const shell = "__SHELL__";
const cacheName = "gamehearth-__VERSION__";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(cacheName)
      .then((cache) => cache.addAll(shell))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("gamehearth-") && key !== cacheName).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/games/") || url.pathname === "/ws") {
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && (response.headers.get("content-type") ?? "").startsWith("text/html")) {
            const copy = response.clone();
            caches.open(cacheName).then((cache) => cache.put("/", copy));
          }
          return response;
        })
        .catch(() => caches.match("/").then((cached) => cached ?? Response.error())),
    );
    return;
  }
  if (shell.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname).then((cached) => cached ?? fetch(request)));
  }
});

const pushTexts = "__PUSH_TEXTS__";

function notificationFor(data) {
  const lang = typeof data.lang === "string" && Object.hasOwn(pushTexts, data.lang) ? data.lang : "en";
  const words = pushTexts[lang];
  const room = typeof data.room === "string" && /^[A-Z0-9]{1,12}$/.test(data.room) ? data.room : undefined;
  const game = typeof data.game === "string" ? data.game.slice(0, 80) : "";
  if (data.kind === "test") {
    return { lang, title: words.testTitle, body: words.testBody, tag: "gamehearth-test", path: "/account" };
  }
  const title = data.kind === "finished" ? words.finished : words.turn;
  if (room === undefined) {
    return { lang, title, body: game, tag: "gamehearth", path: "/" };
  }
  return { lang, title, body: game === "" ? `${words.room} ${room}` : `${game} · ${words.room} ${room}`, tag: room, path: `/r/${room}` };
}

function readPush(event) {
  try {
    const data = event.data ? event.data.json() : {};
    return data !== null && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

self.addEventListener("push", (event) => {
  const data = readPush(event);
  const note = notificationFor(data);
  const work = [
    self.registration.showNotification(note.title, {
      body: note.body,
      tag: note.tag,
      renotify: true,
      icon: "/icon-192.png",
      lang: note.lang,
      data: { path: note.path },
    }),
  ];
  if (data.kind === "turn" && self.navigator && typeof self.navigator.setAppBadge === "function") {
    work.push(self.navigator.setAppBadge().catch(() => undefined));
  }
  event.waitUntil(Promise.all(work));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const wanted = event.notification.data && event.notification.data.path;
  const path = typeof wanted === "string" && /^\/(r\/[A-Z0-9]{1,12}|account)?$/.test(wanted) ? wanted : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const app = windows.filter((client) => {
        const url = new URL(client.url);
        return url.origin === self.location.origin && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/games/");
      });
      const open = app.find((client) => client.focused) || app[0];
      if (open === undefined) {
        return self.clients.openWindow(path);
      }
      open.postMessage({ type: "open", path });
      return open.focus();
    }),
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  const renew = async () => {
    const old = event.oldSubscription;
    if (!old || typeof old.endpoint !== "string") {
      return;
    }
    const subscription = event.newSubscription || (await self.registration.pushManager.subscribe(old.options));
    await fetch("/api/me/push/renew", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oldEndpoint: old.endpoint, subscription: subscription.toJSON() }),
    });
  };
  event.waitUntil(renew().catch(() => undefined));
});

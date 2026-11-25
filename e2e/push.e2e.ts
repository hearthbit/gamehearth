import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { newSubscriptionKeys, startFakePushService, type FakePushService } from "../packages/server/test/fake-push";
import { acceptInvite, adminAccount, adminLink, canCreateAdmins, createRoomButton, newPlayer, removeTestData, runId } from "./accounts";

const external = process.env["GAMEHEARTH_URL"] !== undefined;
const fakePushPort = 8198;
let fake: FakePushService | undefined;

test.skip(!canCreateAdmins(), "needs GAMEHEARTH_ADMIN_LINK_COMMAND against an external server");

test.beforeAll(async () => {
  if (!external) {
    fake = await startFakePushService({ port: fakePushPort });
  }
});

test.afterAll(async ({ baseURL }) => {
  await fake?.close();
  await removeTestData(baseURL);
});

interface Stub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

function subscriptionFor(name: string): Stub {
  if (fake !== undefined) {
    const subscription = fake.subscription(`${name}-${runId}`);
    return { endpoint: subscription.endpoint, keys: subscription.keys };
  }
  return { endpoint: `https://fcm.googleapis.com/fcm/send/gamehearth-e2e-${name}-${runId}`, keys: newSubscriptionKeys().keys };
}

async function withPush(context: BrowserContext, origin: string, stub: Stub): Promise<void> {
  await context.grantPermissions(["notifications"], { origin });
  await context.addInitScript((subscription: Stub) => {
    const scope = globalThis as unknown as { PushManager?: { prototype: Record<string, unknown> }; Notification?: object };
    if (scope.PushManager === undefined || scope.Notification === undefined) {
      return;
    }
    Object.defineProperty(scope.Notification, "permission", { configurable: true, get: () => "granted" });
    Object.defineProperty(scope.Notification, "requestPermission", { configurable: true, value: async () => "granted" });
    let current: unknown = null;
    scope.PushManager.prototype["getSubscription"] = async () => current;
    scope.PushManager.prototype["subscribe"] = async (options: { applicationServerKey: Uint8Array }) => {
      current = {
        endpoint: subscription.endpoint,
        options: { userVisibleOnly: true, applicationServerKey: new Uint8Array(options.applicationServerKey).buffer },
        toJSON: () => ({ endpoint: subscription.endpoint, expirationTime: null, keys: subscription.keys }),
        unsubscribe: async () => {
          current = null;
          return true;
        },
      };
      return current;
    };
  }, stub);
}

async function pushPlayer(browser: Browser, baseURL: string, name: string): Promise<{ page: Page; stub: Stub }> {
  const page = await newPlayer(browser);
  const stub = subscriptionFor(name);
  await withPush(page.context(), new URL(baseURL).origin, stub);
  return { page, stub };
}

async function pushesTo(stub: Stub, kind: string, timeoutMs = 10_000): Promise<unknown[]> {
  const path = new URL(stub.endpoint).pathname;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (fake?.received ?? []).filter((push) => push.path === path && (push.payload as { kind?: string } | undefined)?.kind === kind);
    if (found.length > 0 || Date.now() > deadline) {
      for (const push of found) {
        expect(push.problem).toBeUndefined();
      }
      return found.map((push) => push.payload);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function enableOnAccountPage(page: Page): Promise<void> {
  await page.goto("/account");
  const card = page.getByTestId("push-card");
  await card.getByRole("button", { name: "Einschalten" }).click();
  await expect(card.getByText("Auf diesem Gerät eingeschaltet.")).toBeVisible();
}

async function playUntil(page: Page, done: () => Promise<boolean>): Promise<void> {
  for (let round = 0; round < 200 && !(await done()); round++) {
    const buttons = await page.frameLocator("iframe").getByRole("group", { name: "Deine Züge" }).getByRole("button").all();
    if (buttons.length > 0) {
      const labels = await Promise.all(buttons.map((button) => button.textContent()));
      const index = labels.findIndex((label) => label?.includes(" legen") === true);
      await buttons[index >= 0 ? index : 0]?.dispatchEvent("click");
    }
    await page.waitForTimeout(250);
  }
  expect(await done()).toBe(true);
}

async function yourTurn(page: Page, code: string): Promise<boolean> {
  const body = (await (await page.request.get("/api/me/rooms")).json()) as { rooms: { code: string; yourTurn: boolean }[] };
  return body.rooms.some((room) => room.code === code && room.yourTurn);
}

interface Shown {
  title?: string;
  options?: { body: string; tag: string; data: { path: string } };
  badge?: boolean;
}

async function inWorker<T, A>(page: Page, work: (arg: A) => T | Promise<T>, arg: A): Promise<T> {
  const run = work as unknown as (arg: unknown) => Promise<T>;
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  for (let attempt = 1; ; attempt++) {
    const workers = page.context().serviceWorkers();
    const worker = workers.at(-1) ?? (await page.context().waitForEvent("serviceworker"));
    try {
      return await worker.evaluate(run, arg as unknown);
    } catch (error) {
      if (attempt >= 5 || !String(error).includes("restarted")) {
        throw error;
      }
      await page.waitForTimeout(300);
    }
  }
}

async function showInWorker(page: Page, payload: unknown): Promise<Shown[]> {
  return inWorker(page, async (data) => {
    const scope = self as unknown as {
      registration: { showNotification: (title: string, options: unknown) => Promise<void> };
      dispatchEvent(event: Event): boolean;
      PushEvent: new (type: string, init: { data: string }) => Event;
    };
    const shown: unknown[] = [];
    scope.registration.showNotification = async (title, options) => {
      shown.push({ title, options });
    };
    Object.defineProperty(self.navigator, "setAppBadge", { configurable: true, value: async () => shown.push({ badge: true }) });
    scope.dispatchEvent(new scope.PushEvent("push", { data: JSON.stringify(data) }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    return shown as Shown[];
  }, payload);
}

async function clickInWorker(page: Page, path: string): Promise<void> {
  await inWorker(page, (wanted) => {
    const scope = self as unknown as { dispatchEvent(event: Event): boolean; ExtendableEvent: new (type: string) => Event };
    const event = new scope.ExtendableEvent("notificationclick");
    Object.defineProperty(event, "notification", { value: { data: { path: wanted }, close: () => undefined } });
    scope.dispatchEvent(event);
  }, path);
}

test("turn on push, get notified on your turn and reach the room with a tap", async ({ browser, baseURL }) => {
  test.skip(external, "needs the local fake push service");
  const base = baseURL as string;
  const { page: anna, stub: annaStub } = await pushPlayer(browser, base, "anna");
  await acceptInvite(anna, adminLink(), "Anna");
  await enableOnAccountPage(anna);
  await anna.getByRole("button", { name: "Testnachricht" }).click();
  expect(await pushesTo(annaStub, "test")).toEqual([{ kind: "test", lang: "de" }]);

  await anna.goto("/");
  await createRoomButton(anna).click();
  await expect(anna).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
  const code = (await anna.getByTestId("room-code").textContent()) ?? "";

  const { page: ben, stub: benStub } = await pushPlayer(browser, base, "ben");
  await ben.goto(`/r/${code}`);
  await ben.getByLabel("Dein Name").fill("Ben");
  await ben.getByRole("button", { name: "Als Gast beitreten" }).click();
  const hint = ben.getByTestId("push-hint");
  await expect(hint).toBeVisible();
  await hint.getByRole("button", { name: "Einschalten" }).click();
  await expect(hint).toBeHidden();

  await ben.goto("/");
  await expect(ben.getByText(`Raumcode ${code}`)).toBeVisible();
  await anna.getByRole("button", { name: "Partie starten" }).click();
  await expect(anna.frameLocator("iframe").locator("#access p").first()).not.toBeEmpty();
  await playUntil(anna, () => yourTurn(ben, code));
  const turn = await pushesTo(benStub, "turn");
  expect(turn).toEqual([{ kind: "turn", room: code, game: "Mau-Mau", lang: "de" }]);
  expect(await pushesTo(annaStub, "turn", 500)).toEqual([]);

  const shown = await showInWorker(ben, turn[0]);
  expect(shown).toEqual([
    { title: "Du bist dran", options: expect.objectContaining({ body: `Mau-Mau · Raum ${code}`, tag: code, data: { path: `/r/${code}` } }) },
    { badge: true },
  ]);
  await clickInWorker(ben, shown[0]?.options?.data.path ?? "");
  await expect(ben).toHaveURL(new RegExp(`/r/${code}$`));
  await expect(ben.frameLocator("iframe").locator("#access p").first()).not.toBeEmpty();
});

test("a muted room sends nothing, and My rooms shows it", async ({ browser, baseURL }) => {
  test.skip(external, "needs the local fake push service");
  const base = baseURL as string;
  const { page: anna } = await adminAccount(browser, "Anna");
  await createRoomButton(anna).click();
  await expect(anna).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
  const code = (await anna.getByTestId("room-code").textContent()) ?? "";

  const { page: ben, stub: benStub } = await pushPlayer(browser, base, "ben-muted");
  await ben.goto(`/r/${code}`);
  await ben.getByLabel("Dein Name").fill("Ben");
  await ben.getByRole("button", { name: "Als Gast beitreten" }).click();
  await ben.getByTestId("push-hint").getByRole("button", { name: "Einschalten" }).click();
  await expect(ben.getByTestId("push-hint")).toBeHidden();
  await ben.getByRole("button", { name: "Menü" }).click();
  await ben.getByRole("menuitem", { name: "Raum stummschalten" }).click();
  await expect(ben.getByText("Raum stummgeschaltet.")).toBeVisible();
  await ben.getByRole("button", { name: "Menü" }).click();
  await expect(ben.getByRole("menuitem", { name: "Stummschaltung aufheben" })).toBeVisible();
  await ben.keyboard.press("Escape");

  await ben.goto("/");
  await expect(ben.getByText(/· stumm/)).toBeVisible();
  await anna.getByRole("button", { name: "Partie starten" }).click();
  await expect(anna.frameLocator("iframe").locator("#access p").first()).not.toBeEmpty();
  await playUntil(anna, () => yourTurn(ben, code));
  expect(await pushesTo(benStub, "turn", 2000)).toEqual([]);
});

test("logging out removes the device's subscription", async ({ browser, baseURL }) => {
  const base = baseURL as string;
  const { page } = await pushPlayer(browser, base, "logout");
  const account = await acceptInvite(page, adminLink(), "Anna");
  await enableOnAccountPage(page);
  await page.reload();
  await expect(page.getByText("Push", { exact: true })).toBeVisible();
  await page.goto("/");
  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect(page.getByRole("heading", { name: "Mit Account anmelden" })).toBeVisible();
  await page.getByLabel("Benutzername").fill(account.username);
  await page.getByLabel("Passwort", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByText("Angemeldet als Anna")).toBeVisible();
  const status = (await (await page.request.get("/api/me/push")).json()) as { enabled: boolean };
  expect(status.enabled).toBe(false);
  await page.goto("/account");
  await expect(page.getByTestId("push-card").getByRole("button", { name: "Einschalten" })).toBeVisible();
  await expect(page.getByText("Push", { exact: true })).toHaveCount(0);
});

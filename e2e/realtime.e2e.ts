import { expect, test, type Browser, type Page } from "@playwright/test";
import { adminAccount, canCreateAdmins, createRoomButton, newPlayer, removeTestData } from "./accounts";

test.skip(!canCreateAdmins(), "needs GAMEHEARTH_ADMIN_LINK_COMMAND against an external server");
test.skip(process.env["GAMEHEARTH_URL"] !== undefined, "the test game Wettlauf only exists on the test server");
test.afterAll(async ({ baseURL }) => removeTestData(baseURL));

async function television(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.goto("/tv");
  await expect(page.getByTestId("tv-code")).toHaveText(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  return page;
}

async function partyRoom(browser: Browser): Promise<{ anna: Page; ben: Page; tv: Page; code: string }> {
  const { page: anna } = await adminAccount(browser, "Anna");
  await expect(anna.getByRole("listitem").filter({ hasText: "Wettlauf" })).toContainText("Fernseher + Handys");
  await createRoomButton(anna, "Wettlauf").click();
  await expect(anna).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
  const code = (await anna.getByTestId("room-code").textContent()) ?? "";

  const ben = await newPlayer(browser);
  await ben.goto(`/r/${code}`);
  await ben.getByLabel("Dein Name").fill("Ben");
  await ben.getByRole("button", { name: "Als Gast beitreten" }).click();
  await expect(ben.getByText("Warte, bis Anna die Partie startet")).toBeVisible();

  await expect(anna.getByRole("button", { name: "Partie starten" })).toBeDisabled();
  await expect(anna.getByText("Zum Starten muss ein Fernseher gekoppelt und verbunden sein.")).toBeVisible();

  const tv = await television(browser);
  const pairing = (await tv.getByTestId("tv-code").textContent()) ?? "";
  await anna.getByLabel("Code vom Fernseher").fill(pairing.toLowerCase());
  await anna.getByRole("button", { name: "Koppeln" }).click();
  await expect(tv.getByTestId("tv-room-code")).toHaveText(code);
  await expect(tv.getByTestId("tv-lobby")).toContainText("Ben");
  await expect(anna.getByTestId("screens")).toContainText("Fernseher 1");
  await expect(anna.getByTestId("screens")).toContainText("verbunden");
  return { anna, ben, tv, code };
}

async function hold(page: Page, ms: number): Promise<void> {
  const button = page.frameLocator("iframe").getByTestId("run");
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  if (box === null) {
    throw new Error('The "Laufen" button is not visible');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

async function setVisible(page: Page, visible: boolean): Promise<void> {
  await page.evaluate((state) => {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible ? "visible" : "hidden");
}

async function lanePositions(tv: Page, seat: string, samples: number): Promise<number[]> {
  const lane = tv.frameLocator("iframe").getByTestId(`lane-${seat}`);
  const values: number[] = [];
  for (let i = 0; i < samples; i++) {
    values.push(Number((await lane.getAttribute("data-pos")) ?? "0"));
    await tv.waitForTimeout(17);
  }
  return values;
}

test("a TV and two phones play Wettlauf: pairing, countdown, smooth movement, pause, end and new round", async ({ browser }) => {
  const { anna, ben, tv } = await partyRoom(browser);

  await anna.getByRole("button", { name: "Partie starten" }).click();
  await expect(tv.getByTestId("live-countdown")).toBeVisible();
  await expect(tv.getByTestId("live-countdown")).toBeHidden({ timeout: 10_000 });
  await expect(tv.frameLocator("iframe").getByTestId("lane-p1")).toBeVisible();
  await expect(tv.frameLocator("iframe").getByTestId("lane-p2")).toBeVisible();
  for (const page of [anna, ben]) {
    await expect(page.frameLocator("iframe").getByTestId("run")).toBeVisible();
    await expect(page.locator(".turn")).toHaveCount(0);
  }
  await tv.screenshot({ path: test.info().outputPath("tv-start.png") });

  const running = hold(ben, 1500);
  await tv.waitForTimeout(500);
  const samples = await lanePositions(tv, "p2", 30);
  await running;
  expect(samples.at(-1) ?? 0).toBeGreaterThan(samples[0] ?? 0);
  expect(samples.some((value) => Math.abs(value - Math.round(value)) > 0.05)).toBe(true);
  const benPos = Number(await ben.frameLocator("iframe").getByTestId("status").getAttribute("data-pos"));
  expect(benPos).toBeGreaterThan(15);
  await tv.screenshot({ path: test.info().outputPath("tv-running.png") });

  await setVisible(ben, false);
  await expect(tv.getByTestId("live-paused")).toContainText("Warte auf Ben", { timeout: 10_000 });
  await expect(anna.getByTestId("live-paused")).toContainText("Warte auf Ben");
  await tv.screenshot({ path: test.info().outputPath("tv-pause.png") });
  await setVisible(ben, true);
  await expect(tv.getByTestId("live-countdown")).toBeVisible({ timeout: 10_000 });
  await expect(tv.getByTestId("live-paused")).toBeHidden();
  await expect(tv.getByTestId("live-countdown")).toBeHidden({ timeout: 10_000 });

  await anna.getByRole("button", { name: "Menü" }).click();
  await anna.getByRole("menuitem", { name: "Anhalten" }).click();
  await expect(tv.getByTestId("live-paused")).toContainText("Der Gastgeber hat angehalten");
  await anna.getByRole("button", { name: "Weiterspielen" }).click();
  await expect(tv.getByTestId("live-paused")).toBeHidden();
  await expect(tv.getByTestId("live-countdown")).toBeHidden({ timeout: 10_000 });

  await hold(anna, 6500);
  await expect(tv.frameLocator("iframe").getByTestId("result")).toHaveText("Gewonnen: Anna", { timeout: 10_000 });
  await expect(anna.getByText("Partie vorbei")).toBeVisible();
  await expect(ben.getByText("Partie vorbei")).toBeVisible();
  await expect(tv.getByText("Warte auf eine neue Runde von Anna")).toBeVisible();
  await tv.screenshot({ path: test.info().outputPath("tv-end.png") });

  await anna.getByRole("button", { name: "Neue Runde" }).click();
  await expect(tv.getByTestId("tv-lobby")).toBeVisible();
  await expect(ben.getByText("Lobby · Runde 2")).toBeVisible();
});

test("a TV can be paired through the QR code on a phone and removed by the host", async ({ browser }) => {
  const { anna, ben, code } = await partyRoom(browser);
  const second = await television(browser);
  const pairing = ((await second.getByTestId("tv-code").textContent()) ?? "").replace("-", "");
  const qrTarget = await second.evaluate(() => document.querySelector("svg.qr")?.getAttribute("aria-label"));
  expect(qrTarget).toBe("QR-Code zum Koppeln dieses Fernsehers");

  await ben.goto(`/pair#${pairing}`);
  await expect(ben).toHaveURL(/\/pair$/);
  await ben.getByRole("listitem").filter({ hasText: code }).getByRole("button", { name: "Koppeln" }).click();
  await expect(ben).toHaveURL(new RegExp(`/r/${code}$`));
  await expect(second.getByTestId("tv-room-code")).toHaveText(code);
  await expect(anna.getByTestId("screens")).toContainText("Fernseher 2");

  await anna.getByTestId("screens").getByRole("listitem").filter({ hasText: "Fernseher 2" }).getByRole("button", { name: "Entfernen" }).click();
  await anna.getByRole("alertdialog").getByRole("button", { name: "Entfernen" }).click();
  await expect(second.getByTestId("tv-code")).toBeVisible();
  await expect(anna.getByTestId("screens")).not.toContainText("Fernseher 2");
});

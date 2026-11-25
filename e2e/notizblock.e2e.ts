import { expect, test, type Browser, type Page } from "@playwright/test";
import { adminAccount, canCreateAdmins, createRoomButton, newPlayer, removeTestData } from "./accounts";

test.skip(!canCreateAdmins(), "needs GAMEHEARTH_ADMIN_LINK_COMMAND against an external server");
test.skip(process.env["GAMEHEARTH_URL"] !== undefined, "the test game Notizblock only exists on the test server");
test.afterAll(async ({ baseURL }) => removeTestData(baseURL));

function frameSizes(page: Page): number[] {
  const sizes: number[] = [];
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      const text = typeof payload === "string" ? payload : payload.toString("utf8");
      if (text.startsWith('{"type":"frame"')) {
        sizes.push(text.length);
      }
    });
  });
  return sizes;
}

async function television(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.goto("/tv");
  await expect(page.getByTestId("tv-code")).toHaveText(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  return page;
}

test("phones type notes without a TV, growing ink arrives in small frames, and a TV joins the running match", async ({ browser }) => {
  const { page: anna } = await adminAccount(browser, "Anna");
  await expect(anna.getByRole("listitem").filter({ hasText: "Notizblock" })).toContainText("Fernseher optional");
  await createRoomButton(anna, "Notizblock").click();
  await expect(anna).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
  const code = (await anna.getByTestId("room-code").textContent()) ?? "";

  const ben = await newPlayer(browser);
  const sizes = frameSizes(ben);
  await ben.goto(`/r/${code}`);
  await ben.getByLabel("Dein Name").fill("Ben");
  await ben.getByRole("button", { name: "Als Gast beitreten" }).click();
  await expect(ben.getByText("Warte, bis Anna die Partie startet")).toBeVisible();

  await expect(anna.getByRole("button", { name: "Partie starten" })).toBeEnabled();
  await anna.getByRole("button", { name: "Partie starten" }).click();
  await expect(anna.getByTestId("live-countdown")).toBeHidden({ timeout: 10_000 });

  const annaPad = anna.frameLocator("iframe");
  const benPad = ben.frameLocator("iframe");
  await expect(annaPad.getByTestId("note-input")).toBeEnabled();
  await expect(annaPad.getByTestId("note-input")).toHaveAttribute("maxlength", "30");

  await annaPad.getByTestId("note-input").fill("Käse 🧀 und Brot");
  await annaPad.getByTestId("note-send").click();
  await expect(benPad.getByTestId("notes")).toContainText("Anna: Käse 🧀 und Brot");
  await expect(annaPad.getByTestId("note-input")).toHaveValue("");

  await benPad.getByTestId("note-input").fill("mit Enter");
  await benPad.getByTestId("note-input").press("Enter");
  await expect(annaPad.getByTestId("notes")).toContainText("Ben: mit Enter");

  await annaPad.getByTestId("note-input").evaluate((input: HTMLInputElement) => {
    input.maxLength = 100;
    input.value = "x".repeat(31);
  });
  await annaPad.getByTestId("note-send").click();
  await expect(annaPad.getByTestId("status")).toHaveText("illegal-move");

  for (let i = 0; i < 60; i++) {
    await benPad.getByTestId("ink").click();
  }
  await expect(annaPad.getByTestId("ink-length")).toHaveText("Tinte: 2400");
  const before = sizes.length;
  await ben.waitForTimeout(1500);
  const recent = sizes.slice(before);
  expect(recent.length).toBeGreaterThan(10);
  expect(Math.max(...recent)).toBeLessThan(600);

  const tv = await television(browser);
  const pairing = ((await tv.getByTestId("tv-code").textContent()) ?? "").replace("-", "");
  await ben.goto(`/pair#${pairing}`);
  await ben.getByRole("listitem").filter({ hasText: code }).getByRole("button", { name: "Koppeln" }).click();
  await expect(ben).toHaveURL(new RegExp(`/r/${code}$`));
  const tvPad = tv.frameLocator("iframe");
  await expect(tvPad.getByTestId("tv-notes")).toContainText("Anna: Käse 🧀 und Brot");
  await expect(tvPad.getByTestId("tv-ink")).toHaveText("Tinte: 2400");

  await tv.close();
  await anna.waitForTimeout(3000);
  await expect(anna.getByTestId("live-paused")).toBeHidden();
  await annaPad.getByTestId("note-input").fill("ohne Fernseher weiter");
  await annaPad.getByTestId("note-send").click();
  await expect(benPad.getByTestId("notes")).toContainText("Anna: ohne Fernseher weiter");

  await annaPad.getByTestId("finish").click();
  await expect(benPad.getByTestId("status")).toHaveText("Vorbei");
});

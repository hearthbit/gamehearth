import { expect, test, type Page } from "@playwright/test";
import { adminAccount, canCreateAdmins, createRoomButton, removeTestData } from "./accounts";

test.skip(!canCreateAdmins(), "needs GAMEHEARTH_ADMIN_LINK_COMMAND against an external server");
test.skip(process.env["GAMEHEARTH_URL"] !== undefined, "the test game Dorfladen only exists on the test server");
test.afterAll(async ({ baseURL }) => removeTestData(baseURL));

const frame = (page: Page) => page.frameLocator("iframe");

async function choose(page: Page, code: "DE" | "EN"): Promise<void> {
  await page.locator(".language-switch").getByRole("button", { name: code, exact: true }).click();
}

test("the language switch changes the UI, follows the account to a new device and reaches the game", async ({ browser }) => {
  const { page: anna, username, password } = await adminAccount(browser, "Anna");
  await expect(anna.locator("html")).toHaveAttribute("lang", "de");
  await choose(anna, "EN");
  await expect(anna.getByRole("heading", { name: "New game" })).toBeVisible();
  await expect(anna.getByText("Logged in as Anna")).toBeVisible();
  await expect(anna.locator("html")).toHaveAttribute("lang", "en");
  await anna.reload();
  await expect(anna.getByRole("heading", { name: "New game" })).toBeVisible();

  const phone = await (await browser.newContext({ locale: "de-DE" })).newPage();
  await phone.goto("/");
  await expect(phone.getByRole("heading", { name: "Mit Account anmelden" })).toBeVisible();
  await phone.getByLabel("Benutzername").fill(username);
  await phone.getByLabel("Passwort", { exact: true }).fill(password);
  await phone.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(phone.getByRole("heading", { name: "New game" })).toBeVisible();

  await anna.getByRole("listitem").filter({ hasText: "Dorfladen" }).getByRole("button", { name: "Create room" }).click();
  await expect(anna).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
  const code = (await anna.getByTestId("room-code").textContent()) ?? "";
  await expect(anna.getByLabel("Rounds")).toBeVisible();
  await expect(anna.getByRole("option", { name: "3 rounds" })).toBeAttached();
  await anna.getByRole("button", { name: "Start match" }).click();
  await expect(frame(anna).locator("#app")).toHaveAttribute("data-language", "en");
  await expect(frame(anna).getByTestId("language")).toContainText("en");
  await anna.screenshot({ path: test.info().outputPath("match-en.png") });

  await anna.goto("/");
  await choose(anna, "DE");
  await expect(anna.getByRole("heading", { name: "Neues Spiel" })).toBeVisible();
  await anna.goto(`/r/${code}`);
  await expect(frame(anna).locator("#app")).toHaveAttribute("data-language", "de");

  await phone.reload();
  await expect(phone.getByRole("heading", { name: "Neues Spiel" })).toBeVisible();
  await expect(createRoomButton(phone, "Dorfladen")).toBeVisible();
});

test("a TV takes its browser's language and has its own switch", async ({ browser }) => {
  const tv = await (await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 720 } })).newPage();
  await tv.goto("/tv");
  await expect(tv.getByTestId("tv-pairing")).toBeVisible();
  await expect(tv.getByRole("heading", { name: "TV" })).toBeVisible();
  await choose(tv, "DE");
  await expect(tv.getByRole("heading", { name: "Fernseher" })).toBeVisible();
  await tv.reload();
  await expect(tv.getByRole("heading", { name: "Fernseher" })).toBeVisible();
});

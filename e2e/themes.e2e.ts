import { expect, test, type Page } from "@playwright/test";
import { adminAccount, canCreateAdmins, removeTestData } from "./accounts";

test.skip(!canCreateAdmins(), "needs GAMEHEARTH_ADMIN_LINK_COMMAND against an external server");
test.afterAll(async ({ baseURL }) => removeTestData(baseURL));

const theme = (page: Page) => page.locator("html");

function themes(page: Page) {
  return page.getByRole("radiogroup", { name: "Aussehen wählen" });
}

test("the theme switch on the account page changes the look at once and follows the account to a new device", async ({ browser }) => {
  const { page: anna, username, password } = await adminAccount(browser, "Anna");
  await expect(theme(anna)).toHaveAttribute("data-theme", "neon");
  await anna.goto("/account");
  await themes(anna).getByRole("radio", { name: "Röhrenbildschirm" }).check();
  await expect(theme(anna)).toHaveAttribute("data-theme", "crt");
  await expect(anna.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0b0b0d");
  await expect(themes(anna).getByRole("radio", { name: "Röhrenbildschirm" })).toBeChecked();
  await anna.reload();
  await expect(themes(anna).getByRole("radio", { name: "Röhrenbildschirm" })).toBeChecked();
  await expect(theme(anna)).toHaveAttribute("data-theme", "crt");

  const phone = await (await browser.newContext({ locale: "de-DE" })).newPage();
  await phone.goto("/");
  await expect(phone.getByRole("heading", { name: "Mit Account anmelden" })).toBeVisible();
  await expect(theme(phone)).toHaveAttribute("data-theme", "neon");
  await themes(phone).getByRole("radio", { name: "Automatenfront" }).check();
  await expect(theme(phone)).toHaveAttribute("data-theme", "front");
  await expect(phone.locator('meta[name="color-scheme"]')).toHaveAttribute("content", "light");
  await phone.getByLabel("Benutzername").fill(username);
  await phone.getByLabel("Passwort", { exact: true }).fill(password);
  await phone.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(phone.getByRole("heading", { name: "Neues Spiel" })).toBeVisible();
  await expect(theme(phone)).toHaveAttribute("data-theme", "crt");
  await expect(themes(phone)).toHaveCount(0);

  await themes(anna).getByRole("radio", { name: "Automatenfront" }).check();
  await expect(theme(anna)).toHaveAttribute("data-theme", "front");
  await phone.reload();
  await expect(phone.getByRole("heading", { name: "Neues Spiel" })).toBeVisible();
  await expect(theme(phone)).toHaveAttribute("data-theme", "front");
});

test("a TV has its own theme switch and keeps the choice on the device", async ({ browser }) => {
  const tv = await (await browser.newContext({ locale: "de-DE", viewport: { width: 1280, height: 720 } })).newPage();
  await tv.goto("/tv");
  await expect(tv.getByTestId("tv-pairing")).toBeVisible();
  await expect(theme(tv)).toHaveAttribute("data-theme", "neon");
  await themes(tv).getByRole("radio", { name: "Röhrenbildschirm" }).check();
  await expect(theme(tv)).toHaveAttribute("data-theme", "crt");
  await tv.reload();
  await expect(tv.getByTestId("tv-pairing")).toBeVisible();
  await expect(theme(tv)).toHaveAttribute("data-theme", "crt");
  await expect(themes(tv).getByRole("radio", { name: "Röhrenbildschirm" })).toBeChecked();
});

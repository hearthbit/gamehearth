import { expect, test, type Page } from "@playwright/test";
import { adminAccount, canCreateAdmins, createRoomButton, newPlayer, removeTestData } from "./accounts";

test.skip(!canCreateAdmins(), "needs GAMEHEARTH_ADMIN_LINK_COMMAND against an external server");
test.afterAll(async ({ baseURL }) => removeTestData(baseURL));

async function joinAsGuest(page: Page, code: string, name: string): Promise<void> {
  await page.goto(`/r/${code}`);
  await page.getByLabel("Dein Name").fill(name);
  await page.getByRole("button", { name: "Als Gast beitreten" }).click();
  await expect(page.getByText(/Warte, bis .* die Partie startet/)).toBeVisible();
}

async function transferCode(page: Page): Promise<string> {
  await page.goto("/account");
  await page.getByRole("button", { name: "Code erzeugen" }).click();
  const code = (await page.getByTestId("transfer-code").textContent()) ?? "";
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  return code;
}

async function redeem(page: Page, code: string): Promise<void> {
  const card = page.getByTestId("redeem-card");
  await card.getByLabel("Übergabe-Code").fill(code.toLowerCase());
  await card.getByRole("button", { name: "Weiterspielen" }).click();
}

test("a guest takes their seats to a second device with a code, and a duplicate seat in the lobby disappears", async ({ browser }) => {
  const { page: anna } = await adminAccount(browser, "Anna");
  await createRoomButton(anna).click();
  await expect(anna).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
  const room = (await anna.getByTestId("room-code").textContent()) ?? "";

  const safari = await newPlayer(browser);
  await joinAsGuest(safari, room, "Ben");
  const first = await transferCode(safari);

  const app = await newPlayer(browser);
  await app.goto("/");
  await redeem(app, first);
  await expect(app.getByText("Angemeldet als Ben", { exact: true })).toBeVisible();
  await expect(app.getByText(`Raumcode ${room}`)).toBeVisible();
  await safari.reload();
  await expect(safari.getByRole("region", { name: "Meine Geräte" }).getByRole("listitem")).toHaveCount(2);
  await expect(safari.getByRole("button", { name: "Später hinzugekommene Geräte abmelden" })).toBeVisible();

  const phone = await newPlayer(browser);
  await joinAsGuest(phone, room, "Ben on phone");
  await expect(anna.getByText("Ben on phone")).toBeVisible();
  const second = await transferCode(safari);
  await phone.goto("/");
  await redeem(phone, second);
  const dialog = phone.getByRole("alertdialog");
  await expect(dialog.getByText(/zu dir wandern/)).toBeVisible();
  await dialog.getByRole("button", { name: "Übernehmen", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(anna.getByText("Ben on phone")).toBeHidden();
  await expect(anna.getByText("Ben", { exact: true })).toHaveCount(1);
  await expect(phone.getByText(`Raumcode ${room}`)).toBeVisible();

  await expect((await phone.request.post("/api/transfer", { data: { code: second } })).status()).toBe(404);
});

import { expect, test, type Page } from "@playwright/test";
import { adminAccount, canCreateAdmins, createRoomButton, newPlayer, removeTestData, runId, type Account } from "./accounts";

test.skip(!canCreateAdmins(), "needs GAMEHEARTH_ADMIN_LINK_COMMAND against an external server");
test.afterAll(async ({ baseURL }) => removeTestData(baseURL));

async function signIn(page: Page, account: Account, password = account.password): Promise<void> {
  await page.getByLabel("Benutzername").fill(account.username.toUpperCase());
  await page.getByLabel("Passwort", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Anmelden" }).click();
}

test("an account logs out and back in, also on a second device, and finds its rooms", async ({ browser }) => {
  const anna = await adminAccount(browser, "Anna");
  const page = anna.page;
  expect(await page.evaluate(() => document.cookie)).not.toContain("gh-session");
  await createRoomButton(page).click();
  await expect(page).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
  const code = (await page.getByTestId("room-code").textContent()) ?? "";

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Meine Räume" })).toBeVisible();
  await expect(page.getByText(`Raumcode ${code}`)).toBeVisible();
  for (const path of ["/", "/admin", "/account"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), path).toBe(true);
  }
  await page.goto("/");
  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect(page.getByRole("heading", { name: "Mit Account anmelden" })).toBeVisible();
  await expect(page.getByText(`Raumcode ${code}`)).toHaveCount(0);

  await signIn(page, anna, "wrong-password");
  await expect(page.getByText("Benutzername oder Passwort stimmt nicht.")).toBeVisible();
  await signIn(page, anna);
  await expect(page.getByText("Angemeldet als Anna")).toBeVisible();
  await expect(page.getByText(`Raumcode ${code}`)).toBeVisible();

  const tablet = await newPlayer(browser);
  await tablet.goto(`/r/${code}`);
  await tablet.getByRole("button", { name: "Ich habe einen Account" }).click();
  await signIn(tablet, anna);
  await expect(tablet.getByRole("button", { name: "Partie starten" })).toBeVisible();
  await expect(tablet.getByTestId("room-code")).toHaveText(code);
});

test("a guest joins via link, stays in after a reload and cannot create rooms", async ({ browser }) => {
  const anna = await adminAccount(browser, "Anna");
  await createRoomButton(anna.page).click();
  await expect(anna.page).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
  const code = (await anna.page.getByTestId("room-code").textContent()) ?? "";

  const ben = await newPlayer(browser);
  await ben.goto("/");
  await ben.getByLabel("Raumcode").fill(code.toLowerCase());
  await ben.getByRole("button", { name: "Beitreten" }).click();
  await expect(ben).toHaveURL(new RegExp(`/r/${code}$`));
  await ben.getByLabel("Dein Name").fill("Ben");
  await ben.getByRole("button", { name: "Als Gast beitreten" }).click();
  await expect(ben.getByText("Warte, bis Anna die Partie startet")).toBeVisible();
  await expect(anna.page.getByText("Ben", { exact: true })).toBeVisible();

  await ben.reload();
  await expect(ben.getByText("Warte, bis Anna die Partie startet")).toBeVisible();
  await ben.goto("/");
  await expect(ben.getByText("Du spielst als Gast ohne Passwort.", { exact: false })).toBeVisible();
  await expect(ben.getByText(`Raumcode ${code}`)).toBeVisible();
  await expect(ben.getByRole("button", { name: "Raum anlegen" })).toHaveCount(0);
  const status = await ben.evaluate(async () => (await fetch("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: '{"game":"mau-mau"}' })).status);
  expect(status).toBe(403);
});

test("an admin invites, a guest becomes an account through the invite and later resets the password via a link", async ({ browser }) => {
  const anna = await adminAccount(browser, "Anna");
  await createRoomButton(anna.page).click();
  await expect(anna.page).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
  const code = (await anna.page.getByTestId("room-code").textContent()) ?? "";

  const ben = await newPlayer(browser);
  await ben.goto(`/r/${code}`);
  await ben.getByLabel("Dein Name").fill("Ben");
  await ben.getByRole("button", { name: "Als Gast beitreten" }).click();
  await expect(ben.getByText("Warte, bis Anna die Partie startet")).toBeVisible();

  await anna.page.goto("/");
  await anna.page.getByRole("button", { name: "Verwaltung" }).click();
  await anna.page.getByRole("link", { name: "Nutzer & Einladungen" }).click();
  await expect(anna.page).toHaveURL(/\/admin\/users$/);
  await expect(anna.page.getByRole("heading", { name: "Einladungen" })).toBeVisible();
  await anna.page.getByLabel("Hinweis für dich").fill("for Ben");
  await anna.page.getByRole("button", { name: "Einladung erstellen" }).click();
  const invite = (await anna.page.getByRole("region", { name: "Einladungen" }).locator("code.link").textContent()) ?? "";
  expect(invite).toMatch(/\/invite#[A-Za-z0-9_-]{43}$/);
  await expect(anna.page.getByText("for Ben")).toBeVisible();

  const username = `ben-${runId}`;
  const password = "bens-secret-password";
  await ben.goto(invite);
  await expect(ben.getByText("Deine Räume als Gast bleiben erhalten")).toBeVisible();
  await expect(ben.getByLabel("Anzeigename")).toHaveValue("Ben");
  await ben.getByLabel("Benutzername").fill(username);
  await ben.getByLabel("Passwort", { exact: true }).fill(password);
  await ben.getByLabel("Passwort wiederholen").fill(password);
  await ben.getByRole("button", { name: "Account anlegen" }).click();
  await expect(ben.getByText("Angemeldet als Ben")).toBeVisible();
  await expect(ben.getByText(`Raumcode ${code}`)).toBeVisible();
  await ben.goto(invite);
  await expect(ben.getByText("Dieser Link ist ungültig, abgelaufen oder wurde schon benutzt.")).toBeVisible();

  await anna.page.reload();
  const benEntry = anna.page.locator("li.user", { hasText: `@${username}` });
  await benEntry.locator("summary").click();
  await benEntry.getByRole("button", { name: "Passwort-Link" }).click();
  const reset = (await anna.page.getByRole("region", { name: "Nutzer" }).locator("code.link").textContent()) ?? "";
  expect(reset).toMatch(/\/reset#[A-Za-z0-9_-]{43}$/);

  const phone = await newPlayer(browser);
  await phone.goto(reset);
  await expect(phone.getByText(`Neues Passwort für ${username}`)).toBeVisible();
  await phone.getByLabel("Passwort", { exact: true }).fill("brand-new-password");
  await phone.getByLabel("Passwort wiederholen").fill("brand-new-password");
  await phone.getByRole("button", { name: "Passwort speichern" }).click();
  await expect(phone.getByText("Passwort geändert.")).toBeVisible();
  await expect(phone.getByLabel("Benutzername")).toHaveValue(username);
  await phone.getByLabel("Passwort", { exact: true }).fill("brand-new-password");
  await phone.getByRole("button", { name: "Anmelden" }).click();
  await expect(phone.getByText("Angemeldet als Ben")).toBeVisible();

  await ben.goto("/");
  await expect(ben.getByRole("heading", { name: "Mit Account anmelden" })).toBeVisible();
});

test("a guest who logs in with their account takes over the seats on request and logs out everywhere", async ({ browser }) => {
  const anna = await adminAccount(browser, "Anna");
  const cem = await adminAccount(browser, "Cem");
  await createRoomButton(cem.page).click();
  await expect(cem.page).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
  const code = (await cem.page.getByTestId("room-code").textContent()) ?? "";

  const phone = await newPlayer(browser);
  await phone.goto(`/r/${code}`);
  await phone.getByLabel("Dein Name").fill("Anna on phone");
  await phone.getByRole("button", { name: "Als Gast beitreten" }).click();
  await expect(phone.getByText("Warte, bis Cem die Partie startet")).toBeVisible();
  await expect(cem.page.getByText("Anna on phone")).toBeVisible();

  await phone.goto("/");
  await phone.getByRole("button", { name: "Ich habe einen Account" }).click();
  await signIn(phone, anna);
  await expect(phone.getByRole("alertdialog")).toContainText("als Gast „Anna on phone“ in einem Raum");
  await phone.getByRole("button", { name: "Übernehmen", exact: true }).click();
  await expect(phone.getByRole("alertdialog")).toHaveCount(0);
  await expect(phone.getByText(`Raumcode ${code}`)).toBeVisible();
  await expect(cem.page.getByText("Anna", { exact: true })).toBeVisible();
  await expect(cem.page.getByText("Anna on phone")).toHaveCount(0);

  await phone.getByRole("button", { name: "Konto" }).click();
  await expect(phone.getByRole("heading", { name: "Meine Geräte" })).toBeVisible();
  await expect(phone.getByText("dieses Gerät")).toBeVisible();
  await phone.getByRole("button", { name: "Überall abmelden" }).click();
  await phone.getByRole("alertdialog").getByRole("button", { name: "Überall abmelden" }).click();
  await expect(phone.getByRole("heading", { name: "Mit Account anmelden" })).toBeVisible();
  await anna.page.reload();
  await expect(anna.page.getByRole("heading", { name: "Mit Account anmelden" })).toBeVisible();
});

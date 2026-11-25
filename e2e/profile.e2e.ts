import { expect, test, type Page } from "@playwright/test";
import { adminAccount, canCreateAdmins, createRoomButton, newPlayer, removeTestData } from "./accounts";

test.skip(!canCreateAdmins(), "needs GAMEHEARTH_ADMIN_LINK_COMMAND against an external server");
test.skip(process.env["GAMEHEARTH_URL"] !== undefined, "the test game Dorfladen only exists on the test server");
test.afterAll(async ({ baseURL }) => removeTestData(baseURL));

const frame = (page: Page) => page.frameLocator("iframe");

async function act(page: Page, move: "arbeiten" | "kaufen" | "essen"): Promise<void> {
  await expect(frame(page).getByTestId("status")).toContainText("Du bist dran");
  await frame(page).getByTestId(move).dispatchEvent("click");
}

test("profiles grow during the match, guests play with a throwaway profile, the game page shows profile and leaderboard", async ({ browser }) => {
  const { page: anna } = await adminAccount(browser, "Anna");
  await createRoomButton(anna, "Dorfladen").click();
  await expect(anna).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
  const code = (await anna.getByTestId("room-code").textContent()) ?? "";
  const ben = await newPlayer(browser);
  await ben.goto(`/r/${code}`);
  await ben.getByLabel("Dein Name").fill("Ben");
  await ben.getByRole("button", { name: "Als Gast beitreten" }).click();
  await expect(anna.getByText("Ben")).toBeVisible();
  await anna.getByRole("button", { name: "Partie starten" }).click();

  await expect(frame(anna).getByTestId("profile")).toHaveText("Münzen: 0 · Äpfel: 0 · Siege: 0");
  await act(anna, "arbeiten");
  await expect(frame(anna).getByTestId("profile")).toHaveText("Münzen: 2 · Äpfel: 0 · Siege: 0");
  await act(ben, "arbeiten");
  await expect(frame(ben).getByTestId("profile")).toHaveText("Münzen: 2 · Äpfel: 0 · Siege: 0");
  await act(anna, "arbeiten");
  await act(ben, "arbeiten");
  await expect(frame(anna).getByTestId("kaufen")).toBeVisible();
  await act(anna, "kaufen");
  await expect(frame(anna).getByTestId("profile")).toHaveText("Münzen: 1 · Äpfel: 1 · Siege: 0");
  await act(ben, "arbeiten");
  await expect(anna.getByText("Partie vorbei")).toBeVisible();
  await expect(frame(ben).getByTestId("status")).toHaveText("Gewonnen: Ben");
  await anna.screenshot({ path: test.info().outputPath("match-end.png") });

  await anna.getByRole("button", { name: "Startseite" }).first().click();
  await anna.getByRole("link", { name: "Spielseite Dorfladen" }).click();
  await expect(anna).toHaveURL(/\/game\/dorfladen$/);
  await expect(anna.getByRole("heading", { level: 1 })).toHaveText("Dorfladen");
  const profile = anna.locator(".profile-list > div");
  await expect(profile).toHaveText(["Münze1", "Apfel1", "Meiste Punkte2", "Gespielte Partien1"]);
  const best = anna.locator('[data-stat="bestwert"] .board li');
  await expect(best).toHaveCount(1);
  await expect(best.first()).toContainText("Anna");
  await expect(best.first()).toContainText("2");
  await expect(anna.locator('[data-stat="siege"]')).toContainText("Noch keine Einträge.");
  await anna.screenshot({ path: test.info().outputPath("game-page.png"), fullPage: true });

  await anna.getByRole("button", { name: "Profil zurücksetzen" }).click();
  await anna.getByRole("alertdialog").getByRole("button", { name: "Profil zurücksetzen" }).click();
  await expect(anna.getByText("Noch nichts gesammelt.", { exact: false })).toBeVisible();
  await expect(anna.locator('[data-stat="bestwert"]')).toContainText("Noch keine Einträge.");
});

test("when one match uses up an item, the other match of the same player sees it right away", async ({ browser }) => {
  const { page: cem } = await adminAccount(browser, "Cem");
  const rooms: Page[] = [];
  for (let index = 0; index < 2; index++) {
    const page = index === 0 ? cem : await cem.context().newPage();
    await page.goto("/");
    await createRoomButton(page, "Dorfladen").click();
    await expect(page).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
    await page.getByLabel("Runden").selectOption({ label: "5 Runden" });
    rooms.push(page);
  }
  const [first, second] = rooms as [Page, Page];
  await first.getByRole("button", { name: "Partie starten" }).click();
  await act(first, "arbeiten");
  await act(first, "arbeiten");
  await act(first, "kaufen");
  await expect(frame(first).getByTestId("profile")).toHaveText("Münzen: 1 · Äpfel: 1 · Siege: 0");

  await second.getByRole("button", { name: "Partie starten" }).click();
  await expect(frame(second).getByTestId("essen")).toBeVisible();
  await expect(frame(second).getByTestId("profile")).toHaveText("Münzen: 1 · Äpfel: 1 · Siege: 0");

  await act(first, "essen");
  await expect(frame(first).getByTestId("profile")).toHaveText("Münzen: 1 · Äpfel: 0 · Siege: 0");
  await expect(frame(second).getByTestId("profile")).toHaveText("Münzen: 1 · Äpfel: 0 · Siege: 0");
  await expect(frame(second).getByTestId("essen")).toHaveCount(0);
  await expect(frame(second).getByTestId("arbeiten")).toBeVisible();
  await second.screenshot({ path: test.info().outputPath("second-match.png") });
});

import { expect, test, type Page } from "@playwright/test";
import { adminAccount, canCreateAdmins, createRoomButton, newPlayer, removeTestData } from "./accounts";

test.skip(!canCreateAdmins(), "needs GAMEHEARTH_ADMIN_LINK_COMMAND against an external server");
test.skip(process.env["GAMEHEARTH_URL"] !== undefined, "the test game Glücksrad and the frozen Mau-Mau without options only exist on the test server");
test.afterAll(async ({ baseURL }) => removeTestData(baseURL));

const optionsCard = (page: Page) => page.getByTestId("room-options");

async function playTurn(page: Page): Promise<boolean> {
  const frame = page.frameLocator("iframe");
  const buttons = frame.locator(".moves button");
  if ((await buttons.count()) === 0) {
    return false;
  }
  await buttons.first().dispatchEvent("click");
  return true;
}

test("the host sets options, everyone sees them, and the game receives them", async ({ browser }) => {
  const { page: anna } = await adminAccount(browser, "Anna");
  await createRoomButton(anna, "Glücksrad").click();
  await expect(anna).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
  const code = (await anna.getByTestId("room-code").textContent()) ?? "";

  await expect(anna.getByLabel("Runden")).toHaveValue("3");
  await expect(anna.getByLabel("Joker")).toHaveValue("false");
  await anna.getByLabel("Runden").selectOption({ label: "2 Runden" });
  await anna.getByLabel("Joker").selectOption({ label: "Ja" });

  const ben = await newPlayer(browser);
  await ben.goto(`/r/${code}`);
  await ben.getByLabel("Dein Name").fill("Ben");
  await ben.getByRole("button", { name: "Als Gast beitreten" }).click();
  await expect(optionsCard(ben).getByTestId("option-runden")).toHaveText("2 Runden");
  await expect(optionsCard(ben).getByTestId("option-joker")).toHaveText("Ja");
  await expect(optionsCard(ben)).toContainText("Anna stellt die Optionen ein.");
  await expect(optionsCard(ben).locator("select")).toHaveCount(0);

  await anna.getByLabel("Runden").selectOption({ label: "5 Runden" });
  await expect(optionsCard(ben).getByTestId("option-runden")).toHaveText("5 Runden");
  await anna.screenshot({ path: test.info().outputPath("lobby-host.png") });
  await ben.screenshot({ path: test.info().outputPath("lobby-guest.png") });

  await anna.getByRole("button", { name: "Partie starten" }).click();
  for (const page of [anna, ben]) {
    await expect(page.frameLocator("iframe").getByTestId("options")).toHaveText("5 Runden, Joker ja");
  }
  await expect(anna.frameLocator("iframe").getByTestId("status")).toHaveText("Runde 1 von 5: Du bist dran");
  await expect(anna.frameLocator("iframe").getByTestId("joker")).toBeVisible();
  await anna.frameLocator("iframe").getByTestId("joker").dispatchEvent("click");
  await expect(ben.frameLocator("iframe").getByTestId("status")).toHaveText("Runde 1 von 5: Du bist dran");
  await expect(ben.frameLocator("iframe").getByTestId("joker")).toBeVisible();
  await expect(anna.frameLocator("iframe").getByTestId("last")).toContainText(/Anna dreht (eins|drei|zehn): (2|6|20) Punkte/);

  for (let step = 0; step < 200 && (await anna.getByText("Partie vorbei").count()) === 0; step++) {
    let moved = false;
    for (const page of [anna, ben]) {
      moved = (await playTurn(page)) || moved;
    }
    await anna.waitForTimeout(moved ? 100 : 150);
  }
  await expect(anna.getByText("Partie vorbei")).toBeVisible();
  await expect(ben.frameLocator("iframe").getByTestId("status")).toHaveText(/^Gewonnen: /);
  await anna.screenshot({ path: test.info().outputPath("end.png") });

  await anna.getByRole("button", { name: "Neue Runde" }).click();
  await expect(ben.getByText("Lobby · Runde 2")).toBeVisible();
  await expect(optionsCard(ben).getByTestId("option-runden")).toHaveText("5 Runden");
  await expect(optionsCard(ben).getByTestId("option-joker")).toHaveText("Ja");
  await expect(anna.getByLabel("Runden")).toHaveValue("5");
});

test("games without options show no options card", async ({ browser }) => {
  const { page: anna } = await adminAccount(browser, "Anna");
  await createRoomButton(anna).click();
  await expect(anna).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
  await expect(anna.getByTestId("room-code")).toBeVisible();
  await expect(optionsCard(anna)).toHaveCount(0);
});

import { expect, test, type Page } from "@playwright/test";
import { adminAccount, canCreateAdmins, createRoomButton, newPlayer, removeTestData } from "./accounts";

test.skip(!canCreateAdmins(), "needs GAMEHEARTH_ADMIN_LINK_COMMAND against an external server");
test.skip(process.env["GAMEHEARTH_URL"] !== undefined, "the test game Reihum only exists on the test server");
test.afterAll(async ({ baseURL }) => removeTestData(baseURL));

async function countTones(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = window as unknown as { AudioContext: typeof AudioContext; __tones: number };
    scope.__tones = 0;
    const Original = scope.AudioContext;
    scope.AudioContext = class extends Original {
      override createOscillator(): OscillatorNode {
        const oscillator = super.createOscillator();
        const start = oscillator.start.bind(oscillator);
        oscillator.start = (when?: number) => {
          scope.__tones += 1;
          start(when);
        };
        return oscillator;
      }
    };
  });
}

function tones(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __tones: number }).__tones);
}

test("a bot fills the lobby, the match plays on without a phone that is away, a seat goes to a bot and back, and game sounds play", async ({ browser }) => {
  const { page: anna } = await adminAccount(browser, "Anna");
  await countTones(anna);
  await anna.reload();
  await createRoomButton(anna, "Reihum").click();
  await expect(anna).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
  const code = (await anna.getByTestId("room-code").textContent()) ?? "";

  await anna.getByRole("button", { name: "Bot hinzufügen" }).click();
  await expect(anna.getByText("Robo-Rita")).toBeVisible();

  const ben = await newPlayer(browser);
  await ben.goto(`/r/${code}`);
  await ben.getByLabel("Dein Name").fill("Ben");
  await ben.getByRole("button", { name: "Als Gast beitreten" }).click();
  await expect(ben.getByText("Robo-Rita")).toBeVisible();
  await expect(ben.getByRole("button", { name: "Bot hinzufügen" })).toBeHidden();

  await anna.getByRole("button", { name: "Partie starten" }).click();
  await expect(anna.getByTestId("live-countdown")).toBeHidden({ timeout: 10_000 });
  const annaGame = anna.frameLocator("iframe");
  const benGame = ben.frameLocator("iframe");

  await expect(annaGame.getByTestId("sound")).toHaveText("Ton: aus");
  await anna.getByRole("button", { name: "Menü" }).click();
  await anna.getByRole("menuitemcheckbox", { name: "Ton" }).click();
  await expect(annaGame.getByTestId("sound")).toHaveText("Ton: an");
  const before = await tones(anna);
  await expect(annaGame.getByTestId("press")).toBeEnabled({ timeout: 10_000 });
  await annaGame.getByTestId("press").click();
  await expect.poll(() => tones(anna)).toBeGreaterThan(before);

  await expect(annaGame.getByTestId("presses")).toContainText(/Robo-Rita.*\(Bot\): [1-9]/, { timeout: 15_000 });

  await ben.goto("about:blank");
  await anna.waitForTimeout(3000);
  await expect(anna.getByTestId("live-paused")).toBeHidden();
  await expect(annaGame.getByTestId("skipped")).toContainText("Ben", { timeout: 15_000 });

  await anna.getByRole("button", { name: "Menü" }).click();
  await anna.getByRole("menuitem", { name: "An Bot geben: Ben" }).click();
  await anna.getByRole("alertdialog").getByRole("button", { name: "An Bot geben" }).click();
  await expect(annaGame.getByTestId("presses")).toContainText(/Ben.*\(Bot\): [1-9]/, { timeout: 15_000 });

  await ben.goto(`/r/${code}`);
  await expect(ben.getByText("Ein Bot spielt für dich")).toBeVisible();
  await ben.getByRole("button", { name: "Zurück ins Spiel" }).click();
  await expect(ben.getByText("Ein Bot spielt für dich")).toBeHidden();
  await expect(benGame.getByTestId("turn")).toBeVisible();
  await expect(annaGame.getByTestId("presses")).not.toContainText(/Ben[^:]*(Bot)/);

  await expect(annaGame.getByTestId("status")).toHaveText("Vorbei", { timeout: 120_000 });
});

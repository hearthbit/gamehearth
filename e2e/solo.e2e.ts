import { expect, test } from "@playwright/test";
import { canCreateAdmins, removeTestData } from "./accounts";
import { game, serverState, settleCache, signIn, soloPlayer, waitForLocalSave, waitForPreload, waitForServer } from "./solo";

test.skip(!canCreateAdmins(), "needs GAMEHEARTH_ADMIN_LINK_COMMAND against an external server");
test.skip(process.env["GAMEHEARTH_URL"] !== undefined, "the test game Sammler only exists on the test server");
test.afterAll(async ({ baseURL }) => removeTestData(baseURL));

test("single player: save, best score, leaderboard, offline start and sync afterwards", async ({ browser }) => {
  const { page: anna, context } = await soloPlayer(browser, "Anna");
  const entry = anna.getByRole("listitem").filter({ hasText: "Sammler" });
  await expect(entry).toContainText("allein");
  await expect(entry).toContainText("auch ohne Verbindung");
  await expect(entry.getByRole("button", { name: "Raum anlegen" })).toHaveCount(0);
  await waitForPreload(anna);

  await entry.getByRole("button", { name: "Spielen" }).click();
  await expect(anna).toHaveURL(/\/play\/sammler$/);
  const frame = game(anna);
  await expect(frame.getByTestId("status")).toHaveText("neu");
  for (let index = 0; index < 3; index++) {
    await frame.getByTestId("star").click();
  }
  await expect(frame.getByTestId("count")).toHaveText("3 ★");
  await expect(frame.getByTestId("status")).toHaveText("gespeichert");
  await waitForLocalSave(anna, (data) => (data as { sterne?: number } | null)?.sterne === 3);

  expect(await frame.locator("body").evaluate(() => {
    try {
      return typeof localStorage.getItem("x");
    } catch (error) {
      return error instanceof Error ? error.name : String(error);
    }
  })).toBe("SecurityError");

  await anna.reload();
  await expect(game(anna).getByTestId("status")).toHaveText("geladen");
  await expect(game(anna).getByTestId("count")).toHaveText("3 ★");
  await waitForServer(anna, (state) => JSON.stringify(state.save?.data) === JSON.stringify({ format: 1, sterne: 3, runden: 0 }));

  await game(anna).getByTestId("finish").click();
  await expect(game(anna).getByTestId("status")).toHaveText("Runde mit 3 Sternen beendet");
  await expect(game(anna).getByTestId("best")).toHaveText("Rekord: 3 · Schnellste Runde: 57000");
  await game(anna).getByTestId("wrong").click();
  await expect(game(anna).getByTestId("status")).toContainText('abgelehnt: The best score "unbekannt" does not exist');
  await waitForServer(anna, (state) => state.best["sterne"] === 3 && state.best["dauer"] === 57_000);

  await anna.getByRole("button", { name: "Bestenliste" }).click();
  const boards = anna.getByRole("dialog");
  await expect(boards.locator('[data-stat="sterne"]')).toContainText("Dein Bestwert: 3");
  await expect(boards.locator('[data-stat="sterne"] li.you')).toContainText("Anna");
  await expect(boards.locator('[data-stat="dauer"]')).toContainText("0:57,0");
  await boards.getByRole("button", { name: "Schließen" }).click();

  await anna.goto("/");
  await settleCache(anna);
  await context.setOffline(true);
  await anna.reload();
  await expect(anna.getByText("Keine Verbindung zum Server.")).toBeVisible();
  const offline = anna.getByRole("region", { name: "Offline spielbar" });
  await expect(offline.getByRole("listitem").filter({ hasText: "Sammler" })).toContainText("bereit");
  await offline.getByRole("button", { name: "Spielen" }).click();
  await expect(anna.getByText("allein · offline")).toBeVisible();
  await expect(game(anna).getByTestId("rounds")).toHaveText("Runden: 1");
  for (let index = 0; index < 4; index++) {
    await game(anna).getByTestId("star").click();
  }
  await game(anna).getByTestId("finish").click();
  await expect(game(anna).getByTestId("best")).toHaveText("Rekord: 4 · Schnellste Runde: 56000");
  await anna.getByRole("button", { name: "Startseite" }).first().click();

  await context.setOffline(false);
  await anna.reload();
  await waitForServer(anna, (state) => state.best["sterne"] === 4 && (state.save?.data as { runden?: number } | undefined)?.runden === 2);

  await anna.goto("/play/sammler");
  await expect(game(anna).getByTestId("rounds")).toHaveText("Runden: 2");
  await anna.getByRole("button", { name: "Menü" }).click();
  await anna.getByRole("menuitem", { name: "Spielstand löschen" }).click();
  await anna.getByRole("button", { name: "Spielstand löschen" }).click();
  await expect(game(anna).getByTestId("status")).toHaveText("neu");
  await waitForServer(anna, (state) => state.save === null);
  expect((await serverState(anna)).best["sterne"]).toBe(4);

  await anna.goto("/admin");
  const sammler = anna.getByRole("region", { name: "Spiele" }).getByRole("listitem").filter({ hasText: "Sammler 0.1.0" });
  await sammler.getByText("Bestenliste").click();
  await expect(sammler).toContainText("Anna: 4");
  await sammler.getByRole("button", { name: "Eintrag löschen" }).first().click();
  await anna.getByRole("alertdialog").getByRole("button", { name: "Eintrag löschen" }).click();
  await waitForServer(anna, (state) => state.best["sterne"] === undefined);
});

test("a game with a reducer cannot be opened as single player, and a single-player game cannot be opened in a room", async ({ browser }) => {
  const { page } = await soloPlayer(browser, "Ben");
  await page.goto("/play/mau-mau");
  await expect(page.getByText("Dieses Spiel gibt es auf diesem Server nicht oder es ist kein Einzelspieler-Spiel.")).toBeVisible();
  const created = await page.evaluate(async () => {
    const response = await fetch("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ game: "sammler" }) });
    return { status: response.status, body: (await response.json()) as { code: string } };
  });
  expect(created).toEqual({ status: 409, body: expect.objectContaining({ code: "solo-game" }) });
});

test("review 9: if a newer save from another device arrives only after the start, the game page reloads the game with it", async ({ browser }) => {
  const { page: tablet, account } = await soloPlayer(browser, "Dora");
  await tablet.goto("/play/sammler");
  for (let index = 0; index < 2; index++) {
    await game(tablet).getByTestId("star").click();
  }
  await waitForServer(tablet, (state) => (state.save?.data as { sterne?: number } | undefined)?.sterne === 2);

  const { page: phone } = await signIn(browser, account);
  await phone.goto("/play/sammler");
  await expect(game(phone).getByTestId("count")).toHaveText("2 ★");
  await phone.goto("/");

  for (let index = 0; index < 3; index++) {
    await game(tablet).getByTestId("star").click();
  }
  await waitForServer(tablet, (state) => (state.save?.data as { sterne?: number } | undefined)?.sterne === 5);

  await phone.route("**/api/solo/sammler/sync", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 6000));
    await route.continue();
  });
  await phone.goto("/play/sammler");
  await expect(game(phone).getByTestId("count")).toHaveText("2 ★", { timeout: 10_000 });
  await expect(phone.getByText("Von einem anderen Gerät kam ein neuerer Spielstand")).toBeVisible({ timeout: 15_000 });
  await expect(game(phone).getByTestId("count")).toHaveText("5 ★");
});

test("review 9: if the game list hangs, the game starts from the browser cache after a short time", async ({ browser }) => {
  const { page } = await soloPlayer(browser, "Emil");
  await waitForPreload(page);
  await page.route("**/api/games", () => undefined);
  await page.goto("/play/sammler");
  await expect(game(page).getByTestId("status")).toHaveText("neu", { timeout: 20_000 });
});

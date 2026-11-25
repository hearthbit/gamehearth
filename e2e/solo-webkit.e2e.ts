import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptInvite, adminLink, canCreateAdmins, removeTestData } from "./accounts";
import { game, settleCache, waitForPreload, waitForServer } from "./solo";

test.skip(!canCreateAdmins(), "needs GAMEHEARTH_ADMIN_LINK_COMMAND against an external server");
test.skip(process.env["GAMEHEARTH_URL"] !== undefined, "the test game Sammler only exists on the test server");
test.afterAll(async ({ baseURL }) => removeTestData(baseURL));

test("WebKit with its own profile: a never played single-player game starts offline after the preload", async ({ playwright, baseURL }) => {
  const profile = mkdtempSync(join(tmpdir(), "gamehearth-webkit-"));
  const context = await playwright.webkit.launchPersistentContext(profile, { ...(baseURL === undefined ? {} : { baseURL }), serviceWorkers: "allow", viewport: { width: 420, height: 860 } });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.on("pageerror", (error) => {
      throw error;
    });
    await acceptInvite(page, adminLink(), "Cem");
    await waitForPreload(page);
    await settleCache(page);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText("Keine Verbindung zum Server.")).toBeVisible();
    const offline = page.getByRole("region", { name: "Offline spielbar" });
    await offline.getByRole("button", { name: "Spielen" }).click();
    await expect(game(page).getByTestId("status")).toHaveText("neu", { timeout: 20_000 });
    await expect(game(page).getByTestId("icon")).toHaveAttribute("data-loaded", "ja");
    await game(page).getByTestId("star").click();
    await game(page).getByTestId("finish").click();
    await expect(game(page).getByTestId("best")).toHaveText("Rekord: 1 · Schnellste Runde: 59000");
    await context.setOffline(false);
    await waitForServer(page, (state) => state.best["sterne"] === 1);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

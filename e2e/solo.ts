import { expect, type Browser, type BrowserContext, type FrameLocator, type Page } from "@playwright/test";
import { acceptInvite, adminLink, type Account } from "./accounts";

export async function soloPlayer(browser: Browser, name: string): Promise<{ page: Page; context: BrowserContext; account: Account }> {
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  const account = await acceptInvite(page, adminLink(), name);
  return { page, context, account };
}

export function game(page: Page): FrameLocator {
  return page.frameLocator(".stage iframe");
}

export async function waitForPreload(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const last = JSON.parse(localStorage.getItem("gamehearth.solo.last") ?? "null") as { id: number } | null;
          if (last === null) {
            return false;
          }
          const data = JSON.parse(localStorage.getItem(`gamehearth.solo.${last.id}`) ?? "{}") as { ready?: Record<string, boolean> };
          return Object.values(data.ready ?? {}).some(Boolean);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
}

export async function serverState(page: Page): Promise<{ save: { data: unknown } | null; best: Record<string, number> }> {
  return page.evaluate(async () => (await fetch("/api/solo/sammler", { credentials: "same-origin" })).json());
}

export async function waitForServer(page: Page, check: (state: { save: { data: unknown } | null; best: Record<string, number> }) => boolean): Promise<void> {
  await expect.poll(async () => check(await serverState(page)), { timeout: 20_000 }).toBe(true);
}

export async function settleCache(page: Page): Promise<void> {
  await page.waitForTimeout(3000);
}

export async function signIn(browser: Browser, account: Account): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.goto("/");
  await page.getByLabel("Benutzername").fill(account.username);
  await page.getByLabel("Passwort", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByText(`Angemeldet als ${account.name}`)).toBeVisible();
  return { page, context };
}

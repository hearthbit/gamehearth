import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDev, type DevServer } from "../packages/devtool/src/dev/server";
import { soloSaveFile } from "../packages/devtool/src/dev/solo-state";
import { createGame } from "../packages/devtool/src/new";

const root = fileURLToPath(new URL("..", import.meta.url));
let server: DevServer;
let dir: string;
const output: string[] = [];

test.describe.configure({ mode: "serial" });
test.use({ deviceScaleFactor: 2 });

test.beforeAll(async () => {
  const parent = mkdtempSync(join(root, "e2e-dev-"));
  dir = join(parent, "mushroom-hunt-test");
  await createGame(dir, { template: "single", install: false, git: false, owner: "Test", run: async () => ({ code: 1, output: "" }) });
  server = await startDev(dir, { port: 0, build: "npm run build:watch", client: "dist/dev-client", out: (line) => output.push(line) });
  await expect.poll(() => server.view().client.ready, { timeout: 120_000 }).toBe(true);
});

test.afterAll(async () => {
  await server?.close();
  if (dir !== undefined) {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});

test("dev shows a single-player game with Phaser in a frame, saves to .gamehearth and shows the save and best scores", async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.goto(server.url);
  await expect(page.locator(".seat")).toHaveCount(1);
  await expect(page.locator(".seat.solo-small")).toHaveCount(1);
  await expect(page.locator("#count")).toBeHidden();
  const game = page.locator(".seat").frameLocator("iframe");
  await expect(game.locator("#field canvas")).toBeVisible();
  await page.setViewportSize({ width: 1200, height: 1000 });
  const inside = await game.locator("body").evaluate(() => ({ page: document.documentElement.scrollWidth, view: innerWidth, canvas: document.querySelector("#field canvas")?.getBoundingClientRect().right ?? 0 }));
  expect(inside.page).toBeLessThanOrEqual(inside.view);
  expect(inside.canvas).toBeLessThanOrEqual(inside.view + 1);
  await expect(game.getByText("No best time yet")).toBeVisible();
  await game.getByRole("button", { name: "Start game" }).click();
  await expect(game.locator("#menu")).toBeHidden();
  await expect(page.locator("#solo-saved")).toContainText('"level": 0');
  const saved = JSON.parse(readFileSync(join(dir, soloSaveFile), "utf8")) as { saved: { run: { level: number } } };
  expect(saved.saved.run.level).toBe(0);

  await game.locator("#field canvas").click();
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(600);
  await page.keyboard.up("ArrowRight");
  await game.getByRole("button", { name: "Down" }).hover();
  await page.mouse.down();
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.screenshot({ path: test.info().outputPath("dev-single.png") });

  await expect(async () => {
    writeFileSync(join(dir, soloSaveFile), JSON.stringify({ saved: { format: 1, unlocked: 3, run: { start: 0, level: 2, elapsedMs: 61_000 } }, best: { "best-time": 99_000 } }));
    await expect(page.locator("#solo-best")).toContainText("99000");
    await page.getByRole("button", { name: "Reload" }).click();
    await expect(game.getByRole("button", { name: "Continue: Level 3 (so far 1:01.0)" })).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 30_000 });
  await expect(game.getByText("Best time: 1:39.0")).toBeVisible();
  await expect(game.getByRole("button", { name: "Practice Level 3" })).toBeEnabled();

  await page.getByRole("button", { name: "Delete save" }).click();
  await expect(game.getByRole("button", { name: "Start game" })).toBeVisible();
  await page.getByRole("button", { name: "Delete best scores" }).click();
  await expect(game.getByText("No best time yet")).toBeVisible();
  expect(output.join("\n")).not.toMatch(/Error in the UI/);
});

test("the single-player frame follows the language selector", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.goto(server.url);
  const game = page.locator(".seat").frameLocator("iframe");
  await expect(game.getByRole("button", { name: "Start game" })).toBeVisible();
  await page.getByLabel("Language").selectOption("de");
  await expect(game.getByRole("button", { name: "Spiel starten" })).toBeVisible();
  await expect(game.locator("#title")).toHaveText("Mushroom hunt test");
  await expect(game.getByRole("group", { name: "Steuerkreuz" })).toBeVisible();
  await expect(game.getByText("Noch keine Bestzeit")).toBeVisible();
  await page.getByLabel("Language").selectOption("en");
  await expect(game.getByRole("button", { name: "Start game" })).toBeVisible();
});

test("dev plays the level's music only with Sound and Music on and names the track", async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.goto(server.url);
  const game = page.locator(".seat").frameLocator("iframe");
  const music = page.getByLabel("Music");
  await expect(music).not.toBeChecked();
  await page.getByLabel("Sound").check();
  await game.locator("#entries button").first().click();
  await expect(game.locator("#menu")).toBeHidden();
  await page.waitForTimeout(300);
  await expect(page.locator("#music-note")).toHaveText("");
  await music.check();
  await expect(page.locator("#music-note")).toHaveText("♪ Mushroom forest");
  await page.getByLabel("Sound").uncheck();
  await expect(page.locator("#music-note")).toHaveText("");
  await page.getByLabel("Sound").check();
  await expect(page.locator("#music-note")).toHaveText("♪ Mushroom forest");
  await page.reload();
  await expect(page.getByLabel("Music")).toBeChecked();
  await expect(game.locator("#menu")).toBeVisible();
  await expect(page.locator("#music-note")).toHaveText("");
  await page.getByLabel("Music").uncheck();
  await page.getByLabel("Sound").uncheck();
});

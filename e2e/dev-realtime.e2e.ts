import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDev, type DevServer } from "../packages/devtool/src/dev/server";
import { createGame } from "../packages/devtool/src/new";

const root = fileURLToPath(new URL("..", import.meta.url));
let server: DevServer;
let dir: string;
const output: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const parent = mkdtempSync(join(root, "e2e-dev-"));
  dir = join(parent, "tag-test");
  await createGame(dir, { template: "realtime", install: false, git: false, owner: "Test", run: async () => ({ code: 1, output: "" }) });
  server = await startDev(dir, {
    port: 0,
    build: "npm run build:watch",
    client: "dist/dev-client",
    out: (line) => output.push(line),
  });
  await expect.poll(() => server.view().client.ready, { timeout: 120_000 }).toBe(true);
});

test.afterAll(async () => {
  await server?.close();
  if (dir !== undefined) {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});

function phone(page: Page, index: number): FrameLocator {
  return page.locator(".seat:not(.tv)").nth(index).frameLocator("iframe");
}

function positionOf(seat: string): { x: number; y: number } {
  const state = server.view().session.state as { public: { pos: Record<string, { x: number; y: number }> } };
  return state.public.pos[seat] ?? { x: 0, y: 0 };
}

test("dev shows a TV next to the phones for the realtime template, takes inputs and can be paused", async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(server.url);
  await expect(page.locator(".seat.tv")).toHaveCount(1);
  await expect(page.locator(".seat:not(.tv)")).toHaveCount(2);
  await expect(page.locator(".seat.tv canvas, .seat.tv iframe")).toHaveCount(1);
  await expect(page.locator(".seat.tv").frameLocator("iframe").locator("#field canvas")).toBeVisible();
  for (const index of [0, 1]) {
    await expect(phone(page, index).locator(".status")).toHaveText(/Run away from|You are the catcher/);
  }

  const before = positionOf("p1");
  const right = phone(page, 0).getByRole("button", { name: "Right" });
  const box = await right.boundingBox();
  if (box === null) {
    throw new Error('The "Right" button is not visible');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1200);
  await page.mouse.up();
  expect(positionOf("p1").x).toBeGreaterThan(before.x);
  await page.screenshot({ path: test.info().outputPath("dev-realtime.png") });

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.locator("#status")).toContainText("paused");
  const tick = server.view().session.realtime?.tick ?? 0;
  await page.locator(".seat.tv").getByText("Snapshot of the TV").click();
  await expect(page.locator(".seat.tv pre")).toContainText(/"tick": \d+/);
  await page.locator(".seat:not(.tv)").first().getByText("Snapshot of p1").click();
  await expect(page.locator(".seat:not(.tv)").first().locator("pre")).toContainText('"player": "p1"');
  await page.getByRole("button", { name: "One tick" }).click();
  await expect.poll(() => server.view().session.realtime?.tick).toBe(tick + 1);
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.locator("#status")).not.toContainText("paused");
  expect(output.join("\n")).not.toMatch(/ERROR/);
});

test("a phone and the TV have their own addresses, and their frame fits completely in the window", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto(`${server.url}/tv`);
  await expect(page.locator(".seat.tv")).toHaveCount(1);
  await expect(page.locator(".seat:not(.tv)")).toHaveCount(0);
  await expect(page.locator(".seat.tv").frameLocator("iframe").locator("#field canvas")).toBeVisible();
  const tvBox = await page.locator(".seat.tv .frame").boundingBox();
  expect((tvBox?.y ?? 0) + (tvBox?.height ?? 0)).toBeLessThanOrEqual(760);
  await page.goto(`${server.url}/p2`);
  await expect(page.locator(".seat.tv")).toHaveCount(0);
  await expect(phone(page, 0).getByRole("group", { name: "D-pad" })).toBeVisible();
  const phoneBox = await page.locator(".seat .frame").boundingBox();
  expect((phoneBox?.y ?? 0) + (phoneBox?.height ?? 0)).toBeLessThanOrEqual(760);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(760);
});

test("the TV and the phones follow the language selector", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(server.url);
  await expect(phone(page, 0).locator(".status")).toHaveText(/Run away from|You are the catcher/);
  const tv = await page.locator(".seat.tv iframe").elementHandle();
  await page.getByLabel("Language").selectOption("de");
  await expect.poll(async () => tv?.evaluate((element) => element.isConnected)).toBe(false);
  await expect(page.locator(".seat.tv").frameLocator("iframe").locator("#field canvas")).toBeVisible();
  for (const index of [0, 1]) {
    await expect(phone(page, index).locator(".status")).toHaveText(/Lauf weg vor|Du fängst/);
  }
  await expect(phone(page, 0).getByRole("group", { name: "Steuerkreuz" })).toBeVisible();
  await expect(page.getByLabel("Dauer")).toBeVisible();
  await page.getByLabel("Language").selectOption("en");
  await expect(phone(page, 0).locator(".status")).toHaveText(/Run away from|You are the catcher/);
});

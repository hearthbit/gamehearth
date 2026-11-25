import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  dir = join(parent, "card-duel-test");
  await createGame(dir, { install: false, git: false, owner: "Test", run: async () => ({ code: 1, output: "" }) });
  server = await startDev(dir, {
    port: 0,
    build: "npm run build:watch",
    client: "dist/dev-client",
    out: (line) => output.push(line),
    botDelayMs: 50,
  });
  await expect.poll(() => server.view().client.ready, { timeout: 120_000 }).toBe(true);
});

test.afterAll(async () => {
  await server?.close();
  if (dir !== undefined) {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});

function seat(page: Page, index: number): FrameLocator {
  return page.locator(".seat").nth(index).frameLocator("iframe");
}

async function status(frame: FrameLocator): Promise<string> {
  return (await frame.locator("#access p").first().textContent()) ?? "";
}

async function playFirstCard(frame: FrameLocator): Promise<boolean> {
  const buttons = frame.getByRole("group", { name: "Your moves" }).getByRole("button");
  if ((await buttons.count()) === 0) {
    return false;
  }
  await buttons.first().dispatchEvent("click");
  return true;
}

async function playToEnd(page: Page, seats: number): Promise<void> {
  for (let step = 0; step < 200; step++) {
    const texts = await Promise.all(Array.from({ length: seats }, (_, index) => status(seat(page, index))));
    if (texts.every((text) => /You win!|wins\.|Tie:/.test(text))) {
      return;
    }
    let moved = false;
    for (let index = 0; index < seats; index++) {
      moved = (await playFirstCard(seat(page, index))) || moved;
    }
    await page.waitForTimeout(moved ? 120 : 200);
  }
  throw new Error("The match did not end");
}

test("two players play a whole match side by side in dev, with a view into the state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.url);
  await expect(page.locator(".seat")).toHaveCount(2);
  for (const index of [0, 1]) {
    await expect(seat(page, index).locator("#access p").first()).toHaveText("Round 1 of 5: Choose a card.");
  }
  await page.screenshot({ path: test.info().outputPath("dev-start.png") });

  await playFirstCard(seat(page, 0));
  await expect(seat(page, 1).locator("#access p").first()).toHaveText("Round 1 of 5: Choose a card.");
  await expect(seat(page, 0).locator("#access p").first()).toContainText("Waiting for Ben");

  await page.locator(".seat").first().getByText("Snapshot of p1").click();
  await expect(page.locator(".seat").first().locator("pre")).toContainText('"chosen"');
  await page.getByText("Whole state (with secret)").click();
  await expect(page.locator("#state")).toContainText('"secret"');

  const leaked = await seat(page, 0).locator("body").evaluate(async () => {
    try {
      await fetch("/__dev/view");
      return "reached";
    } catch {
      return "blocked";
    }
  });
  expect(leaked).toBe("blocked");

  await playToEnd(page, 2);
  await expect(page.locator("#status")).toHaveText("Match over");
  await page.screenshot({ path: test.info().outputPath("dev-end.png") });
});

test("a bot plays along, and a seat also runs in its own window", async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.url);
  await expect(seat(page, 0).locator("#access p").first()).not.toBeEmpty();
  const oldFrame = await page.locator(".seat").first().locator("iframe").elementHandle();
  await page.getByRole("button", { name: "New match" }).click();
  await expect.poll(async () => oldFrame?.evaluate((element) => element.isConnected)).toBe(false);
  await expect(seat(page, 0).locator("#access p").first()).toHaveText("Round 1 of 5: Choose a card.");
  await page.locator(".seat").nth(1).getByLabel("Bot").check();

  const own = await context.newPage();
  await own.goto(`${server.url}/p1`);
  await expect(own.locator(".seat")).toHaveCount(1);
  const frame = own.locator(".seat").frameLocator("iframe");
  for (let round = 0; round < 5; round++) {
    await expect(frame.locator("#access p").first()).toHaveText(`Round ${round + 1} of 5: Choose a card.`);
    const prompt = `Round ${round + 1} of 5: Choose a card.`;
    await expect(async () => {
      if ((await status(frame)) === prompt) {
        await playFirstCard(frame);
      }
      expect(await status(frame)).not.toBe(prompt);
    }).toPass({ timeout: 10_000 });
  }
  await expect(frame.locator("#access p").first()).toHaveText(/You win!|wins\.|Tie:/);
  expect(server.view().session.moves.filter((move) => move.bot)).toHaveLength(5);
  await own.close();
  await page.locator(".seat").nth(1).getByLabel("Bot").uncheck();
  await expect.poll(() => server.view().session.seats[1]?.bot).toBe(false);
});

test("the sound switch is off by default, lets the frames play their sounds and is remembered", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.url);
  await page.getByRole("button", { name: "New match" }).click();
  await expect(seat(page, 1).locator("#access p").first()).toHaveText("Round 1 of 5: Choose a card.");
  const sound = page.getByLabel("Sound");
  await expect(sound).not.toBeChecked();
  await playFirstCard(seat(page, 0));
  await expect(seat(page, 0).locator("#access p").first()).toContainText("Waiting for Ben");
  await page.waitForTimeout(300);
  await expect(page.locator("#sound-note")).toHaveText("");
  await sound.check();
  await playFirstCard(seat(page, 1));
  await expect(page.locator("#sound-note")).toHaveText(/^♪ p[12]: (coin|pop)$/);
  await page.reload();
  await expect(page.getByLabel("Sound")).toBeChecked();
  await expect(seat(page, 0).locator("#access p").first()).toHaveText("Round 2 of 5: Choose a card.");
  await page.getByLabel("Sound").uncheck();
});

test("changed rules replay the match, errors show at the top with their place in the source code", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.url);
  await page.getByRole("button", { name: "New match" }).click();
  await expect(seat(page, 0).locator("#access p").first()).toHaveText("Round 1 of 5: Choose a card.");
  await playFirstCard(seat(page, 0));
  await playFirstCard(seat(page, 1));
  await expect(seat(page, 0).locator("#access p").first()).toHaveText("Round 2 of 5: Choose a card.");

  const gameFile = join(dir, "src", "game.ts");
  const original = readFileSync(gameFile, "utf8");
  writeFileSync(gameFile, original.replace("export const handSize = 3;", "export const handSize = 3;\nexport const changed = true;"));
  await expect(page.locator("#note")).toHaveText("Rules reloaded, 2 moves replayed.");
  await expect(seat(page, 0).locator("#access p").first()).toHaveText("Round 2 of 5: Choose a card.");

  writeFileSync(gameFile, original.replace("    hand.chosen = action.card;", '    if (action.card > 0) {\n      throw new Error("On purpose");\n    }\n    hand.chosen = action.card;'));
  const problem = page.locator(".problem.rules pre");
  await expect(problem).toContainText(/ERROR \(Rules\): Replay stopped at move 1 \(p1: .*\): Error in apply for p1/);
  await expect(page.locator("#note")).toHaveText("Rules reloaded, 0 of 2 moves replayed.");
  await expect(seat(page, 0).locator("#access p").first()).toHaveText("Round 1 of 5: Choose a card.");
  await playFirstCard(seat(page, 0));
  await expect(problem).toHaveText(/^ERROR \(Rules\): Error in apply for p1/);
  await expect(problem).toContainText("On purpose");
  await expect(problem).toContainText(/at apply \(src\/game\.ts:\d+:\d+\)/);
  expect(output.join("\n")).toContain("ERROR (Rules): Error in apply for p1");
  await expect(seat(page, 1).locator("#access p").first()).toHaveText("Round 1 of 5: Choose a card.");
  await page.screenshot({ path: test.info().outputPath("dev-error.png") });

  writeFileSync(gameFile, original);
  await expect(page.locator("#note")).toContainText("Rules reloaded");
});

test("errors in the UI end up in the page and the terminal with their place in the source code", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.url);
  await expect(seat(page, 0).locator("#access p").first()).not.toBeEmpty();
  const viewFile = join(dir, "client", "src", "view.ts");
  const original = readFileSync(viewFile, "utf8");
  const signature = "export function statusLine(t: Texts, snapshot: Snapshot, players: Players, options: Options): string {";
  expect(original).toContain(signature);
  writeFileSync(viewFile, original.replace(signature, `${signature}\n  if (snapshot.player === "p2") {\n    throw new Error("UI broken");\n  }`));
  const problem = page.locator(".problem.ui pre");
  await expect(problem).toContainText("Error in the UI of p2", { timeout: 60_000 });
  await expect(problem).toContainText("UI broken");
  await expect(problem).toContainText(/client\/src\/view\.ts:\d+:\d+/);
  expect(output.join("\n")).toContain("ERROR (UI): Error in the UI of p2");
  writeFileSync(viewFile, original);
  await expect(page.locator(".problem.ui")).toHaveCount(0, { timeout: 60_000 });
});

test("a different choice in the options starts a new match, and the UI receives it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.url);
  await page.getByRole("button", { name: "New match" }).click();
  await expect(seat(page, 0).locator("#access p").first()).toHaveText("Round 1 of 5: Choose a card.");
  await expect(page.getByLabel("Rounds")).toHaveValue("5");
  await playFirstCard(seat(page, 0));
  await expect(seat(page, 0).locator("#access p").first()).toContainText("Waiting for Ben");

  await page.getByLabel("Rounds").selectOption({ label: "3 rounds" });
  for (const index of [0, 1]) {
    await expect(seat(page, index).locator("#access p").first()).toHaveText("Round 1 of 3: Choose a card.");
  }
  expect(server.view().session.options).toEqual({ rounds: 3 });
  expect(output).toContain("New match with 2 players, options rounds=3.");
  await page.screenshot({ path: test.info().outputPath("dev-options.png") });

  await playToEnd(page, 2);
  await expect(page.locator("#status")).toHaveText("Match over");
  expect(server.view().session.moves).toHaveLength(6);

  await page.getByRole("button", { name: "New match" }).click();
  await expect(seat(page, 0).locator("#access p").first()).toHaveText("Round 1 of 3: Choose a card.");
  await page.getByLabel("Rounds").selectOption({ label: "5 rounds" });
  await expect(seat(page, 0).locator("#access p").first()).toHaveText("Round 1 of 5: Choose a card.");
});

test("a seat's profile can be edited, is stored in the file, and a guest plays with an empty profile", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.url);
  await page.getByRole("button", { name: "New match" }).click();
  const anna = seat(page, 0);
  await expect(anna.locator("#access p").first()).toHaveText("Round 1 of 5: Choose a card.");

  const box = page.locator(".seat").nth(0).locator("details.profile-box");
  await box.locator("summary").click();
  await box.getByLabel("Profile of p1 as JSON").fill('{ "items": { "joker": 2 }, "stats": { "wins": 3 }, "flags": {} }');
  await box.getByRole("button", { name: "Apply" }).click();
  await expect(box.locator(".profile-note")).toHaveText("applied");
  await expect(anna.locator("#access p").nth(1)).toContainText("Your jokers: 2 · Your wins: 3");
  await expect(anna.getByRole("group", { name: "Your moves" }).getByRole("button", { name: /with joker/ }).first()).toBeVisible();
  const saved = JSON.parse(readFileSync(join(dir, ".gamehearth", "dev-profiles.json"), "utf8")) as { seats: Record<string, unknown> };
  expect(saved.seats["p1"]).toEqual({ items: { joker: 2 }, stats: { wins: 3 }, flags: {} });
  await page.locator(".seat").nth(0).screenshot({ path: test.info().outputPath("dev-profile.png") });

  await anna.getByRole("group", { name: "Your moves" }).getByRole("button", { name: /with joker/ }).first().dispatchEvent("click");
  await expect(anna.locator("#access p").nth(1)).toContainText("Your jokers: 1");

  await box.getByLabel("Profile of p1 as JSON").fill('{ "items": { "joker": 0 } }');
  await box.getByRole("button", { name: "Apply" }).click();
  await expect(box.locator(".profile-note")).toContainText("does not fit");

  await box.getByRole("checkbox").check();
  await expect(box.locator("summary")).toHaveText("Profile of p1 (guest)");
  await expect(anna.locator("#access p").first()).toHaveText("Round 1 of 5: Choose a card.");
  await expect(anna.locator("#access p").nth(1)).toContainText("Your jokers: 0 · Your wins: 0");
  await box.getByRole("checkbox").uncheck();
  await expect(box.locator("summary")).toHaveText("Profile of p1");
  await expect(anna.locator("#access p").nth(1)).toContainText("Your jokers: 1 · Your wins: 3");
});

test("the profile box warns about outdated text and unchecks the guest box when the file is broken", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.url);
  await page.getByRole("button", { name: "New match" }).click();
  await expect(seat(page, 0).locator("#access p").first()).toHaveText("Round 1 of 5: Choose a card.");
  const box = page.locator(".seat").nth(0).locator("details.profile-box");
  await box.locator("summary").click();
  const field = box.getByLabel("Profile of p1 as JSON");
  await field.fill('{ "items": { "joker": 5 } }');
  const changed = await page.evaluate(async () => {
    const response = await fetch("/__dev/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seat: "p1", profile: { items: { joker: 1 } } }) });
    return response.status;
  });
  expect(changed).toBe(200);
  await expect(box.locator(".profile-note")).toContainText("changed in the meantime");
  await box.getByRole("button", { name: "Discard" }).click();
  await expect(field).toHaveValue(/"joker": 1/);

  const file = join(dir, ".gamehearth", "dev-profiles.json");
  const before = readFileSync(file, "utf8");
  writeFileSync(file, "{ broken");
  await box.getByRole("checkbox").check();
  await expect(box.locator(".profile-note")).toContainText("not valid JSON");
  await expect(box.getByRole("checkbox")).not.toBeChecked();
  writeFileSync(file, before);
});

test("the language selector switches every frame and the own window of a seat to German and back", async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.url);
  const language = page.getByLabel("Language");
  await expect(language).toHaveValue("en");
  await expect(language.locator("option")).toHaveText(["English (en)", "German (de)"]);
  await page.getByRole("button", { name: "New match" }).click();
  await expect(seat(page, 0).locator("#access p").first()).toHaveText("Round 1 of 5: Choose a card.");
  const own = await context.newPage();
  await own.goto(`${server.url}/p2`);
  const ownFrame = own.locator(".seat").frameLocator("iframe");
  await expect(ownFrame.locator("#access p").first()).toHaveText("Round 1 of 5: Choose a card.");
  const oldFrame = await page.locator(".seat").first().locator("iframe").elementHandle();

  await language.selectOption("de");
  await expect.poll(async () => oldFrame?.evaluate((element) => element.isConnected)).toBe(false);
  for (const index of [0, 1]) {
    await expect(seat(page, index).locator("#access p").first()).toHaveText("Runde 1 von 5: Wähle eine Karte.");
  }
  await expect(seat(page, 0).getByRole("group", { name: "Deine Züge" })).toBeAttached();
  await expect(page.getByLabel("Runden")).toHaveValue("5");
  await expect(page.getByLabel("Runden").locator("option:checked")).toHaveText("5 Runden");
  await expect(own.getByLabel("Language")).toHaveValue("de");
  await expect(ownFrame.locator("#access p").first()).toHaveText("Runde 1 von 5: Wähle eine Karte.");
  expect(output).toContain("Language de, reloading the frames.");
  await page.screenshot({ path: test.info().outputPath("dev-language.png") });

  await language.selectOption("en");
  await expect(seat(page, 0).locator("#access p").first()).toHaveText("Round 1 of 5: Choose a card.");
  await expect(ownFrame.locator("#access p").first()).toHaveText("Round 1 of 5: Choose a card.");
  await own.close();
});

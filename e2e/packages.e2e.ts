import { expect, test, type Page } from "@playwright/test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addToCatalog, formatCatalog, versionEntry, type Catalog } from "../packages/devtool/src/catalog";
import { buildPackage, type BuiltPackage } from "../packages/devtool/src/package";
import { adminAccount, newPlayer, removeTestData } from "./accounts";

const external = process.env["GAMEHEARTH_URL"] !== undefined;
test.skip(external, "the external server cannot reach the test catalog on this machine");

const mauMau = fileURLToPath(new URL("../fixtures/mau-mau", import.meta.url));
const sdk = fileURLToPath(new URL("../packages/sdk/src/index.ts", import.meta.url)).replaceAll("\\", "/");
const gameName = "Mau-Mau from the catalog";

let server: Server;
let catalogUrl = "";
let adminPage: Page | undefined;

async function packageVersion(version: string): Promise<BuiltPackage> {
  const dir = mkdtempSync(join(tmpdir(), "gamehearth-e2e-package-"));
  try {
    cpSync(join(mauMau, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(mauMau, "dist", "client"), join(dir, "dist", "client"), { recursive: true });
    cpSync(join(mauMau, "LICENSE"), join(dir, "LICENSE"));
    for (const file of readdirSync(join(dir, "src"))) {
      const path = join(dir, "src", file);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll('"@gamehearth/sdk"', JSON.stringify(sdk)));
    }
    const manifest = JSON.parse(readFileSync(join(mauMau, "manifest.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, id: "mau-mau-katalog", name: gameName, version, description: "Test package for the browser tests" }));
    return await buildPackage(dir, { warnings: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.beforeAll(async () => {
  const packages = [await packageVersion("0.1.0"), await packageVersion("0.2.0")];
  const files = new Map<string, Buffer>();
  server = createServer((request, response) => {
    const data = files.get(request.url ?? "");
    response.writeHead(data === undefined ? 404 : 200);
    response.end(data);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let catalog: Catalog = { format: 1, name: "E2E catalog", games: [] };
  for (const built of packages) {
    const path = `/mau-mau-katalog-${built.pkg.manifest.version}.zip`;
    files.set(path, built.archive);
    catalog = addToCatalog(catalog, built.pkg, versionEntry(built.pkg, built.archive, `${base}${path}`));
  }
  files.set("/catalog.json", Buffer.from(formatCatalog(catalog)));
  catalogUrl = `${base}/catalog.json`;
});

test.afterAll(async ({ baseURL }) => {
  if (adminPage !== undefined) {
    await adminPage.request.post("/api/admin/games/mau-mau-katalog/remove", { data: {}, headers: { "content-type": "application/json" } }).catch(() => undefined);
    const catalogs = (await (await adminPage.request.get("/api/admin/games")).json().catch(() => ({ catalogs: [] }))) as { catalogs: { id: number }[] };
    for (const catalog of catalogs.catalogs) {
      await adminPage.request.post(`/api/admin/catalogs/${catalog.id}/delete`, { data: {}, headers: { "content-type": "application/json" } });
    }
  }
  server.closeAllConnections();
  server.close();
  await removeTestData(baseURL);
});

async function playOneMove(page: Page): Promise<boolean> {
  const buttons = await page.frameLocator("iframe").getByRole("group", { name: "Deine Züge" }).getByRole("button").all();
  if (buttons.length === 0) {
    return false;
  }
  const labels = await Promise.all(buttons.map((button) => button.textContent()));
  const index = labels.findIndex((label) => label?.includes(" legen") === true);
  await buttons[index >= 0 ? index : 0]?.dispatchEvent("click");
  return true;
}

test("an admin installs a game from a catalog, it is played, updated and removed", async ({ browser }) => {
  test.setTimeout(360_000);
  const { page: anna } = await adminAccount(browser, "Anna");
  adminPage = anna;
  await anna.getByRole("button", { name: "Verwaltung" }).click();
  const catalogs = anna.getByRole("region", { name: "Kataloge" });
  await expect(catalogs.getByRole("button", { name: "Gamehearth-Katalog hinzufügen" })).toBeVisible();
  await catalogs.getByLabel("Adresse eines Katalogs (catalog.json)").fill(catalogUrl);
  await catalogs.getByRole("button", { name: "Hinzufügen", exact: true }).click();
  const dialog = anna.getByRole("alertdialog");
  await expect(dialog).toContainText("Diesem Katalog vertrauen?");
  await expect(dialog).toContainText("WebRTC");
  await anna.screenshot({ path: test.info().outputPath("trust.png") });
  await dialog.getByRole("button", { name: "Vertrauen und hinzufügen" }).click();
  await expect(catalogs.getByText("E2E catalog", { exact: true })).toBeVisible();

  await catalogs.getByLabel(`Version ${gameName}`).selectOption("0.1.0");
  await catalogs.getByRole("button", { name: `${gameName} Installieren` }).click();
  const games = anna.getByRole("region", { name: "Spiele" });
  await expect(games.getByText(`${gameName} 0.1.0`, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(games.getByRole("button", { name: "Update auf 0.2.0" })).toBeVisible();
  await anna.screenshot({ path: test.info().outputPath("installed.png"), fullPage: true });

  await anna.goto("/");
  await anna.getByRole("listitem").filter({ hasText: gameName }).getByRole("button", { name: "Raum anlegen" }).click();
  await expect(anna).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
  const code = (await anna.getByTestId("room-code").textContent()) ?? "";
  const ben = await newPlayer(browser);
  await ben.goto(`/r/${code}`);
  await ben.getByLabel("Dein Name").fill("Ben");
  await ben.getByRole("button", { name: "Als Gast beitreten" }).click();
  await expect(anna.getByText("Ben", { exact: true })).toBeVisible();
  await anna.getByRole("button", { name: "Partie starten" }).click();
  for (const page of [anna, ben]) {
    await expect(page.frameLocator("iframe").locator("#access p").first()).not.toBeEmpty();
  }
  expect(await anna.locator("iframe").getAttribute("src")).toMatch(/^\/games\/mau-mau-katalog\/0\.1\.0\+[0-9a-f]{12}\/$/);

  for (let round = 0; round < 600 && (await anna.getByText("Partie vorbei").count()) === 0; round++) {
    let moved = false;
    for (const page of [anna, ben]) {
      if (await playOneMove(page)) {
        moved = true;
        await page.waitForTimeout(80);
      }
    }
    if (!moved) {
      await anna.waitForTimeout(100);
    }
  }
  await expect(anna.getByText("Partie vorbei")).toBeVisible();
  await expect(ben.getByText("Partie vorbei")).toBeVisible();

  const admin = await newPlayer(browser);
  await admin.context().addCookies(await anna.context().cookies());
  await admin.goto("/admin");
  await admin.getByRole("region", { name: "Spiele" }).getByRole("button", { name: "Update auf 0.2.0" }).click();
  await expect(admin.getByRole("region", { name: "Spiele" }).getByText(`${gameName} 0.2.0`, { exact: true })).toBeVisible({ timeout: 60_000 });

  await anna.getByRole("button", { name: "Neue Runde" }).click();
  await expect(anna.getByText("Lobby · Runde 2")).toBeVisible();
  await anna.getByRole("button", { name: "Partie starten" }).click();
  await expect(anna.frameLocator("iframe").locator("#access p").first()).not.toBeEmpty({ timeout: 15_000 });
  expect(await anna.locator("iframe").getAttribute("src")).toMatch(/^\/games\/mau-mau-katalog\/0\.2\.0\+[0-9a-f]{12}\/$/);

  await admin.getByRole("region", { name: "Spiele" }).getByRole("button", { name: "Entfernen" }).click();
  await expect(admin.getByRole("alertdialog")).toContainText("1 laufende Partie");
  await admin.getByRole("alertdialog").getByRole("button", { name: "Entfernen" }).click();
  await expect(admin.getByRole("region", { name: "Spiele" }).getByText(`${gameName} 0.2.0`, { exact: true })).toHaveCount(0);
  await expect(admin.getByRole("region", { name: "Kataloge" }).getByRole("button", { name: `${gameName} Installieren` })).toBeVisible();
  await expect(anna.getByText("Dieses Spiel wurde vom Server entfernt.", { exact: false })).toBeVisible();
  await expect(ben.getByText("Dieses Spiel wurde vom Server entfernt.", { exact: false })).toBeVisible();
  await anna.screenshot({ path: test.info().outputPath("removed.png") });
  await anna.goto("/");
  await expect(anna.getByRole("listitem").filter({ hasText: gameName }).getByRole("button", { name: "Raum anlegen" })).toHaveCount(0);
});

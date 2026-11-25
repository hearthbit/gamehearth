import { expect, request, type Browser, type Locator, type Page } from "@playwright/test";
import { execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export const runStart = Date.now();
export const runId = runStart.toString(36);
let accountNumber = 0;
const created: { username: string; password: string }[] = [];
const testNames = new Set(["Anna", "Ben", "Cem", "Anna on phone", "Ben on phone", ""]);

export async function newPlayer(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  return page;
}

export function canCreateAdmins(): boolean {
  return process.env["GAMEHEARTH_URL"] === undefined || process.env["GAMEHEARTH_ADMIN_LINK_COMMAND"] !== undefined;
}

export function adminLink(): string {
  const command = process.env["GAMEHEARTH_ADMIN_LINK_COMMAND"];
  const output =
    command !== undefined
      ? execSync(command, { encoding: "utf8" })
      : execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "packages/server/dist/admin.js", "admin-link"], {
          encoding: "utf8",
          env: { ...process.env, DATA_DIR: process.env["GAMEHEARTH_E2E_DATA"] },
        });
  const match = /\/invite#[A-Za-z0-9_-]+/.exec(output);
  if (match === null) {
    throw new Error(`No invite link in the output: ${output}`);
  }
  return match[0];
}

export interface Account {
  page: Page;
  username: string;
  password: string;
  name: string;
}

export async function acceptInvite(page: Page, link: string, name: string, username = `${name.toLowerCase()}-${runId}-${++accountNumber}`): Promise<Account> {
  const password = `pw-${randomBytes(9).toString("base64url")}`;
  await page.goto(link);
  await page.getByLabel("Benutzername").fill(username);
  await page.getByLabel("Anzeigename").fill(name);
  await page.getByLabel("Passwort", { exact: true }).fill(password);
  await page.getByLabel("Passwort wiederholen").fill(password);
  await page.getByRole("button", { name: "Account anlegen" }).click();
  await expect(page.getByText(`Angemeldet als ${name}`)).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  created.push({ username, password });
  return { page, username, password, name };
}

export async function removeTestData(baseURL: string | undefined): Promise<void> {
  const admin = created[0];
  if (process.env["GAMEHEARTH_URL"] === undefined || admin === undefined) {
    return;
  }
  const api = await request.newContext({ baseURL: baseURL ?? process.env["GAMEHEARTH_URL"], extraHTTPHeaders: { "content-type": "application/json" } });
  try {
    await api.post("/api/login", { data: admin });
    const rooms = (await (await api.get("/api/admin/rooms")).json()) as { rooms: { code: string; createdAt: number; members: { name: string }[] }[] };
    for (const room of rooms.rooms) {
      if (room.createdAt >= runStart && room.members.every((member) => testNames.has(member.name))) {
        await api.post(`/api/admin/rooms/${room.code}/close`, { data: {} });
      }
    }
    const users = (await (await api.get("/api/admin/users")).json()) as { users: { id: number; username: string }[] };
    const own = users.users.filter((user) => user.username.includes(`-${runId}-`) || user.username.startsWith(`ben-`) && user.username.endsWith(runId));
    const self = own.find((user) => user.username === admin.username);
    for (const user of [...own.filter((candidate) => candidate !== self), ...(self === undefined ? [] : [self])]) {
      await api.post(`/api/admin/users/${user.id}/delete`, { data: {} });
    }
  } finally {
    created.length = 0;
    await api.dispose();
  }
}

export function createRoomButton(page: Page, game = "Mau-Mau"): Locator {
  return page.getByRole("listitem").filter({ hasText: game }).getByRole("button", { name: "Raum anlegen" });
}

export async function adminAccount(browser: Browser, name: string): Promise<Account> {
  return acceptInvite(await newPlayer(browser), adminLink(), name);
}

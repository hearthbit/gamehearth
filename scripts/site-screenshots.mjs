/**
 * Screenshots for the Gamehearth website (site/img/).
 *
 * Run from the repo root:
 *
 *   npm run site:shots
 *   node scripts/site-screenshots.mjs [--skip-build] [--only=home,lobby,…] [--out=<folder>] [--keep-png] [--debug]
 *
 * Needs Node 22+, `npm install`, Chromium for Playwright (`npx playwright install chromium`)
 * and internet access to raw.githubusercontent.com and github.com. Takes about two minutes.
 *
 * What it does, from a clean start every time:
 *   1. builds the platform (`npm run build`; --skip-build if it is already built),
 *   2. starts a fresh server on localhost with a new temporary data folder and no local games,
 *   3. creates the first admin "Anna" through the emergency command `admin-link` (as the e2e tests do);
 *      everyone else joins as a demo guest (Ben, Clara, Dan) and the bots bring their own names,
 *   4. adds the public Gamehearth catalog in the admin view and installs every game it lists, newest version,
 *   5. plays a little in every game and takes the screenshots in English, phone or TV sized,
 *   6. writes them as WebP to site/img/ (encoded by Chromium's canvas; ICC, EXIF and XMP chunks are dropped),
 *   7. stops the server and deletes the temporary data folder.
 *
 * Shot names: home, home-wide, lobby, lobby-tv, mau-mau, farbfelder-tv, farbfelder-phone, mauerbrecher,
 * angelteich, kritzelkiste-draw, kritzelkiste-guess, admin-games. --only takes a comma-separated list;
 * --out writes elsewhere; --keep-png also keeps the raw PNGs; --debug adds a few intermediate PNGs.
 * Look at every image before committing it: no URL bar, no private names, no host other than localhost.
 */
import { chromium } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const outDir = resolve(root, option("out") ?? "site/img");
const only = option("only")?.split(",").filter((entry) => entry !== "");
const wanted = (name) => only === undefined || only.includes(name);
const catalogName = "Gamehearth";

const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const wide = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 };
const tvSize = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 };

function log(message) {
  console.log(`[site-shots] ${message}`);
}

async function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

function serverEnv(port, dataDir) {
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, GAMES_DIR: "", TRUST_PROXY: "", PUSH_CONTACT: "", PUSH_HOSTS: "" };
  delete env.GAMEHEARTH_URL;
  delete env.GAMEHEARTH_ADMIN_LINK_COMMAND;
  return env;
}

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "packages/server/dist/main.js"], {
    cwd: root,
    env: serverEnv(port, dataDir),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const base = `http://localhost:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`The server stopped right away:\n${output}`);
    }
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) {
        return { child, base, output: () => output };
      }
    } catch {
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  child.kill();
  throw new Error(`The server did not come up:\n${output}`);
}

function adminLink(port, dataDir) {
  const output = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "packages/server/dist/admin.js", "admin-link"], {
    cwd: root,
    encoding: "utf8",
    env: serverEnv(port, dataDir),
  });
  const match = /\/invite#[A-Za-z0-9_-]+/.exec(output);
  if (match === null) {
    throw new Error(`No invite link in the output of admin-link: ${output}`);
  }
  return match[0];
}

async function webp(converter, png, quality) {
  const encoded = await converter.evaluate(
    async ({ data, quality }) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/webp", quality });
      const buffer = new Uint8Array(await blob.arrayBuffer());
      let text = "";
      for (let index = 0; index < buffer.length; index += 0x8000) {
        text += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
      }
      return btoa(text);
    },
    { data: png.toString("base64"), quality },
  );
  return stripWebp(Buffer.from(encoded, "base64"));
}

function stripWebp(file) {
  if (file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error("Chromium did not produce a WebP file");
  }
  const kept = [];
  for (let offset = 12; offset + 8 <= file.length; ) {
    const chunk = file.toString("ascii", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const whole = Buffer.from(file.subarray(offset, offset + 8 + size + (size % 2)));
    offset += whole.length;
    if (["VP8 ", "VP8L", "ALPH"].includes(chunk)) {
      kept.push(whole);
    } else if (chunk === "VP8X") {
      whole[8] &= ~(0x20 | 0x08 | 0x04);
      kept.push(whole);
    } else if (!["ICCP", "EXIF", "XMP "].includes(chunk)) {
      throw new Error(`Unexpected WebP chunk ${chunk}`);
    }
  }
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), ...kept]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

class Shots {
  constructor(converter) {
    this.converter = converter;
    this.written = [];
  }

  async take(name, page, { quality = 0.8, clip, fullPage = false, stable = false } = {}) {
    if (!wanted(name)) {
      return;
    }
    await page.waitForTimeout(150);
    const capture = () => page.screenshot({ ...(clip === undefined ? {} : { clip }), fullPage, animations: "allow" });
    let png = await capture();
    for (let attempt = 0; stable && attempt < 10; attempt++) {
      await page.waitForTimeout(400);
      const next = await capture();
      if (next.equals(png)) {
        break;
      }
      png = next;
    }
    if (flag("keep-png")) {
      writeFileSync(join(outDir, `${name}.png`), png);
    }
    const file = await webp(this.converter, png, quality);
    writeFileSync(join(outDir, `${name}.webp`), file);
    this.written.push(`${name}.webp (${Math.round(file.length / 1024)} KB)`);
    log(`wrote ${name}.webp`);
  }

  async debug(name, page) {
    if (flag("debug")) {
      await page.screenshot({ path: join(outDir, `debug-${name}.png`) }).catch((error) => log(`debug shot ${name} failed: ${error.message}`));
    }
  }
}

async function newPage(browser, base, size) {
  const context = await browser.newContext({ ...size, baseURL: base, locale: "en-US", colorScheme: "dark", timezoneId: "UTC" });
  const page = await context.newPage();
  page.on("pageerror", (error) => log(`page error: ${error.message}`));
  return page;
}

async function settle(page, ms = 2500) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(ms);
}

async function acceptInvite(page, link, name) {
  const password = `pw-${randomBytes(12).toString("base64url")}`;
  await page.goto(link);
  await page.getByLabel("Username").fill(name.toLowerCase());
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Repeat password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText(`Logged in as ${name}`).waitFor();
}

async function joinAsGuest(browser, base, code, name, size = phone) {
  const page = await newPage(browser, base, size);
  await page.goto(`/r/${code}`);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join as guest" }).click();
  await page.getByText(/Waiting for .* to start the match/).waitFor();
  return page;
}

async function installCatalog(page) {
  await page.goto("/admin");
  const catalogs = page.locator("section", { has: page.locator("#catalogs-title") });
  await catalogs.getByRole("button", { name: `Add the ${catalogName} catalog` }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Trust and add" }).click();
  await page.getByText(/added, \d+ games?\./).waitFor({ timeout: 60_000 });
  const installed = [];
  for (let round = 0; round < 20; round++) {
    const buttons = catalogs.getByRole("button", { name: / Install$/ });
    if ((await buttons.count()) === 0) {
      break;
    }
    const button = buttons.first();
    const label = (await button.getAttribute("aria-label")) ?? "";
    const game = label.replace(/ Install$/, "");
    log(`installing ${game}`);
    await button.click();
    await page.getByText(new RegExp(`^${game.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} .* is installed\\.$`)).first().waitFor({ timeout: 180_000 });
    installed.push(game);
    await page.waitForTimeout(500);
  }
  return installed;
}

async function createRoom(page, game) {
  await page.goto("/");
  await page.getByRole("listitem").filter({ hasText: game }).getByRole("button", { name: "Create room" }).click();
  await page.waitForURL(/\/r\/[A-Z2-9]{6}$/);
  return (await page.getByTestId("room-code").textContent()) ?? "";
}

function frame(page) {
  return page.frameLocator("iframe");
}

async function startMatch(host) {
  await host.getByRole("button", { name: "Start match" }).click();
  await host.locator("iframe").waitFor({ timeout: 30_000 });
}

async function playAccessibleMove(page, prefer) {
  const buttons = await frame(page).getByRole("group", { name: "Your moves" }).getByRole("button").all();
  if (buttons.length === 0) {
    return false;
  }
  const labels = await Promise.all(buttons.map((button) => button.textContent()));
  const index = labels.findIndex((label) => prefer.some((pattern) => pattern.test(label ?? "")));
  await buttons[index >= 0 ? index : 0].dispatchEvent("click");
  return true;
}

async function maumauScene(browser, base, anna, shots) {
  const code = await createRoom(anna, "Mau-Mau");
  const ben = await joinAsGuest(browser, base, code, "Ben");
  await anna.getByText("Ben", { exact: true }).first().waitFor();
  await anna.setViewportSize({ width: 390, height: 980 });
  await settle(anna, 1500);
  await shots.take("lobby", anna);
  await anna.setViewportSize(phone.viewport);
  await startMatch(anna);
  for (const page of [anna, ben]) {
    await frame(page).locator("#access p").first().waitFor();
  }
  let moves = 0;
  for (let round = 0; round < 200 && moves < 1; round++) {
    let moved = false;
    for (const page of [anna, ben]) {
      if (await playAccessibleMove(page, [/^Play /])) {
        moved = true;
        moves++;
        await page.waitForTimeout(700);
      }
    }
    if (!moved) {
      await anna.waitForTimeout(150);
    }
  }
  for (let round = 0; round < 60; round++) {
    const annaMoves = frame(anna).getByRole("group", { name: "Your moves" }).getByRole("button");
    if ((await annaMoves.filter({ hasText: /^Play / }).count()) > 0) {
      break;
    }
    if ((await annaMoves.count()) > 0) {
      await playAccessibleMove(anna, [/^Keep/, /^Draw/]);
      await anna.waitForTimeout(700);
    } else if (await playAccessibleMove(ben, [/^Play /])) {
      await ben.waitForTimeout(700);
    } else {
      await anna.waitForTimeout(150);
    }
  }
  await settle(anna, 1500);
  await shots.take("mau-mau", anna, { stable: true });
  await ben.context().close();
}

async function holdPad(page, dx, dy, ms) {
  const box = await frame(page).getByRole("group", { name: "D-pad" }).boundingBox();
  if (box === null) {
    return;
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x + dx * box.width * 0.35, y + dy * box.height * 0.35);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

async function farbfelderScene(browser, base, anna, shots) {
  const code = await createRoom(anna, "Color Fields");
  const ben = await joinAsGuest(browser, base, code, "Ben");
  const tv = await newPage(browser, base, tvSize);
  await tv.goto("/tv");
  const pairing = (await tv.getByTestId("tv-code").textContent()) ?? "";
  await anna.getByLabel("Code from the TV").fill(pairing);
  await anna.getByRole("button", { name: "Pair", exact: true }).click();
  await tv.getByTestId("tv-room-code").waitFor();
  for (let bot = 0; bot < 2; bot++) {
    await anna.getByRole("button", { name: "Add bot" }).click();
    await anna.waitForTimeout(400);
  }
  await tv.getByTestId("tv-lobby").getByText("Tin Tim").first().waitFor().catch(() => undefined);
  await settle(tv, 1500);
  await shots.take("lobby-tv", tv);
  await startMatch(anna);
  await tv.locator("iframe").waitFor();
  await tv.getByTestId("live-countdown").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
  const paths = [
    [anna, [[1, 0, 900], [0, 1, 700], [-1, 0, 900], [0, 1, 700], [1, 0, 1200], [0, -1, 500], [1, 0, 800], [0, 1, 1300], [-1, 0, 700], [0, -1, 900]]],
    [ben, [[-1, 0, 800], [0, -1, 900], [1, 0, 700], [0, -1, 600], [-1, 0, 1100], [0, 1, 500], [-1, 0, 900], [0, -1, 1200], [1, 0, 800], [0, 1, 700]]],
  ];
  await Promise.all(
    paths.map(async ([page, steps]) => {
      for (const [index, [dx, dy, ms]] of steps.entries()) {
        await holdPad(page, dx, dy, ms);
        if (index === 4) {
          await frame(page).getByRole("button", { name: /Splat/ }).click({ timeout: 3000 }).catch(() => undefined);
        }
      }
    }),
  );
  await tv.waitForTimeout(4000);
  await shots.take("farbfelder-tv", tv);
  await shots.take("farbfelder-phone", anna);
  await anna.getByRole("button", { name: "Menu" }).click();
  await anna.getByRole("menuitem", { name: "Cancel match" }).click();
  await anna.getByRole("alertdialog").getByRole("button").last().click();
  await ben.context().close();
  await tv.context().close();
}

async function mauerbrecherScene(anna, shots) {
  await anna.goto("/");
  await anna.getByRole("listitem").filter({ hasText: "Wall Breaker" }).getByRole("button", { name: "Play" }).click();
  await anna.locator("iframe").waitFor();
  await settle(anna, 1500);
  await frame(anna).getByRole("button", { name: "Start game" }).click();
  await anna.waitForTimeout(1500);
  const box = await anna.locator("iframe").boundingBox();
  const lost = frame(anna).getByText(/Ball lost|Game over/i);
  const scored = frame(anna).getByText(/^[1-9][0-9]* points?$/);
  for (let attempt = 0; attempt < 8; attempt++) {
    await anna.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
    await anna.waitForTimeout(300);
    for (let step = 0; step < 8; step++) {
      await anna.mouse.move(box.x + box.width * (0.42 + 0.16 * Math.sin(step * 0.9)), box.y + box.height * 0.85, { steps: 4 });
      await anna.waitForTimeout(150);
      if ((await scored.count()) > 0) {
        break;
      }
    }
    if ((await lost.count()) === 0 && (await scored.count()) > 0) {
      break;
    }
    await anna.waitForTimeout(1500);
  }
  await shots.take("mauerbrecher", anna);
}

async function angelteichScene(browser, base, anna, shots) {
  const code = await createRoom(anna, "Fishing Pond");
  const ben = await joinAsGuest(browser, base, code, "Ben");
  await anna.getByRole("button", { name: "Add bot" }).click();
  await anna.waitForTimeout(500);
  await startMatch(anna);
  for (const page of [anna, ben]) {
    await frame(page).locator("#access p").first().waitFor().catch(() => undefined);
  }
  await settle(anna, 1500);
  await shots.debug("angelteich-start", anna);
  let moves = 0;
  for (let round = 0; round < 200 && moves < 10; round++) {
    let moved = false;
    for (const page of [anna, ben]) {
      if (await playAccessibleMove(page, [/starter pack/i, /Cast your line/i])) {
        moved = true;
        moves++;
        await page.waitForTimeout(2500);
      }
    }
    if (!moved) {
      await anna.waitForTimeout(300);
    }
  }
  await settle(anna, 2000);
  await shots.take("angelteich", anna);
  await ben.context().close();
}

const circle = (cx, cy, rx, ry, from = 0, to = Math.PI * 2, count = 28) =>
  Array.from({ length: count + 1 }, (_, index) => {
    const angle = from + ((to - from) * index) / count;
    return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
  });

const pictures = {
  sun: [
    { color: "Orange", points: circle(0.5, 0.46, 0.17, 0.17) },
    ...Array.from({ length: 10 }, (_, index) => {
      const angle = (Math.PI * 2 * index) / 10;
      return { color: "Orange", points: [[0.5 + 0.24 * Math.cos(angle), 0.46 + 0.24 * Math.sin(angle)], [0.5 + 0.34 * Math.cos(angle), 0.46 + 0.34 * Math.sin(angle)]] };
    }),
    { fill: "Yellow", at: [0.5, 0.46] },
  ],
  house: [
    { color: "Red", points: [[0.28, 0.46], [0.28, 0.82], [0.72, 0.82], [0.72, 0.46], [0.28, 0.46]] },
    { color: "Brown", points: [[0.22, 0.47], [0.5, 0.2], [0.78, 0.47], [0.22, 0.47]] },
    { color: "Brown", points: [[0.44, 0.82], [0.44, 0.64], [0.56, 0.64], [0.56, 0.82]] },
    { color: "Blue", points: [[0.33, 0.53], [0.33, 0.62], [0.4, 0.62], [0.4, 0.53], [0.33, 0.53]] },
    { color: "Blue", points: [[0.6, 0.53], [0.6, 0.62], [0.67, 0.62], [0.67, 0.53], [0.6, 0.53]] },
    { fill: "Red", at: [0.5, 0.36] },
    { color: "Green", points: [[0.08, 0.83], [0.92, 0.83]] },
  ],
  tree: [
    { color: "Brown", points: [[0.45, 0.86], [0.45, 0.6], [0.55, 0.6], [0.55, 0.86], [0.45, 0.86]] },
    { color: "Green", points: circle(0.5, 0.4, 0.22, 0.2) },
    { color: "Green", points: [[0.1, 0.86], [0.9, 0.86]] },
    { fill: "Green", at: [0.5, 0.4] },
    { fill: "Brown", at: [0.5, 0.75] },
  ],
  fish: [
    { color: "Orange", points: circle(0.45, 0.5, 0.24, 0.14) },
    { color: "Orange", points: [[0.68, 0.48], [0.86, 0.36], [0.86, 0.64], [0.68, 0.52]] },
    { fill: "Orange", at: [0.45, 0.5] },
    { color: "Black", points: [[0.31, 0.46], [0.315, 0.465]] },
    { color: "Blue", points: Array.from({ length: 21 }, (_, index) => [0.1 + index * 0.04, 0.8 + 0.02 * Math.sin(index * 1.3)]) },
  ],
};

const ownWords = { Anna: "house", Ben: "sun", Clara: "tree", Dan: "fish" };

async function paint(page, picture) {
  const game = frame(page);
  const canvas = game.locator(".sheet canvas");
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("The drawing sheet is not visible");
  }
  const at = ([x, y]) => [box.x + x * box.width, box.y + y * box.height];
  const tools = game.getByRole("group", { name: "Tools" });
  const pencil = (color) => game.getByRole("group", { name: "Pencils" }).getByRole("button", { name: color, exact: true });
  for (const step of picture) {
    if (step.fill !== undefined) {
      await pencil(step.fill).click();
      const fill = tools.getByRole("button", { name: "Fill", exact: true });
      if ((await fill.getAttribute("aria-pressed")) !== "true") {
        await fill.click();
      }
      await page.mouse.click(...at(step.at));
      await page.waitForTimeout(250);
      continue;
    }
    await pencil(step.color).click();
    await tools.getByRole("button", { name: "medium", exact: true }).click();
    const [first, ...rest] = step.points.map(at);
    await page.mouse.move(...first);
    await page.mouse.down();
    for (const point of rest) {
      await page.mouse.move(...point, { steps: 4 });
    }
    await page.mouse.up();
    await page.waitForTimeout(120);
  }
}

async function guess(page, text) {
  const input = frame(page).getByLabel("Your guess");
  await input.fill(text);
  await input.press("Enter");
  await page.waitForTimeout(700);
}

async function kritzelkisteScene(browser, base, anna, shots) {
  const code = await createRoom(anna, "Doodle Box");
  await anna.getByLabel("Language of the words").selectOption({ label: "English" });
  await anna.getByLabel("Own words").selectOption({ label: "Yes" });
  await anna.getByLabel("Rounds", { exact: true }).selectOption({ label: "1 round" });
  const players = { Anna: anna };
  for (const name of ["Ben", "Clara", "Dan"]) {
    players[name] = await joinAsGuest(browser, base, code, name);
  }
  await startMatch(anna);
  for (const [name, page] of Object.entries(players)) {
    const input = frame(page).getByLabel("Word …");
    await input.waitFor({ timeout: 20_000 });
    await input.fill(ownWords[name]);
    await input.press("Enter");
    await page.waitForTimeout(400);
    await frame(page).getByRole("button", { name: "Done", exact: true }).click();
  }
  let drawer;
  for (let attempt = 0; attempt < 80 && drawer === undefined; attempt++) {
    for (const [name, page] of Object.entries(players)) {
      if ((await frame(page).locator(".choices button.choice").count()) > 0) {
        drawer = name;
      }
    }
    await anna.waitForTimeout(250);
  }
  if (drawer === undefined) {
    throw new Error("Nobody got to pick a word in Doodle Box");
  }
  const drawerPage = players[drawer];
  const own = frame(drawerPage).locator(".choices button.choice", { hasText: "Word by" }).first();
  const word = ((await own.locator(".cw").textContent()) ?? "").trim();
  const author = Object.keys(ownWords).find((name) => ownWords[name] === word);
  log(`${drawer} draws "${word}" by ${author}`);
  await own.click();
  await frame(drawerPage).locator(".sheet canvas").waitFor();
  await drawerPage.waitForTimeout(800);
  await paint(drawerPage, pictures[word]);
  const guessers = Object.keys(players).filter((name) => name !== drawer && name !== author);
  const [first, second] = guessers;
  await guess(players[second], word === "sun" ? "ball" : "box");
  await guess(players[first], word === "sun" ? "flower" : "tent");
  await guess(players[first], word);
  await guess(players[second], word === "sun" ? "orange" : "barn");
  await drawerPage.waitForTimeout(1500);
  await shots.take("kritzelkiste-draw", drawerPage);
  const guesser = players[second];
  await frame(guesser).getByRole("button", { name: "Show all guesses" }).click({ timeout: 3000 }).catch(() => undefined);
  await guesser.waitForTimeout(600);
  await shots.debug("kritzelkiste-guess-expanded", guesser);
  const row = await frame(guesser).getByLabel("Your guess").boundingBox();
  const height = row === null ? undefined : Math.min(844, Math.ceil(row.y + row.height + 28));
  await shots.take("kritzelkiste-guess", guesser, height === undefined ? {} : { clip: { x: 0, y: 0, width: 390, height } });
  for (const [name, page] of Object.entries(players)) {
    if (name !== "Anna") {
      await page.context().close();
    }
  }
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  if (!flag("skip-build")) {
    log("building the platform");
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build", "--silent"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  }
  const dataDir = mkdtempSync(join(tmpdir(), "gamehearth-site-"));
  const port = await freePort();
  const server = await startServer(port, dataDir);
  log(`fresh server on ${server.base}`);
  const browser = await chromium.launch();
  try {
    const converter = await (await browser.newContext()).newPage();
    const shots = new Shots(converter);
    const anna = await newPage(browser, server.base, phone);
    await acceptInvite(anna, adminLink(port, dataDir), "Anna");
    const installed = await installCatalog(anna);
    log(`installed: ${installed.join(", ")}`);

    await anna.goto("/");
    await settle(anna);
    await shots.take("home", anna);
    const annaWide = await newPage(browser, server.base, wide);
    await annaWide.context().addCookies(await anna.context().cookies());
    await annaWide.goto("/");
    await settle(annaWide);
    await shots.take("home-wide", annaWide);

    const scenes = [
      [["lobby", "mau-mau"], () => maumauScene(browser, server.base, anna, shots)],
      [["lobby-tv", "farbfelder-tv", "farbfelder-phone"], () => farbfelderScene(browser, server.base, anna, shots)],
      [["mauerbrecher"], () => mauerbrecherScene(anna, shots)],
      [["angelteich"], () => angelteichScene(browser, server.base, anna, shots)],
      [["kritzelkiste-draw", "kritzelkiste-guess"], () => kritzelkisteScene(browser, server.base, anna, shots)],
    ];
    for (const [names, scene] of scenes) {
      if (names.some(wanted)) {
        log(`scene ${names.join(", ")}`);
        await scene();
      }
    }

    await anna.goto("/admin");
    await settle(anna, 1500);
    await shots.take("admin-games", anna);

    log(`done: ${shots.written.join(", ")}`);
  } finally {
    await browser.close();
    const stopped = new Promise((done) => server.child.once("exit", done));
    server.child.kill();
    await Promise.race([stopped, new Promise((done) => setTimeout(done, 5000))]);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

await main();

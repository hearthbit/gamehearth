import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const publicDir = fileURLToPath(new URL("../packages/client/public/", import.meta.url));
const targets = [
  { source: "icon.svg", file: "icon-192.png", size: 192 },
  { source: "icon.svg", file: "icon-512.png", size: 512 },
  { source: "icon.svg", file: "icon-180.png", size: 180 },
  { source: "icon-maskable.svg", file: "icon-maskable-512.png", size: 512 },
];

const browser = await chromium.launch();
try {
  for (const target of targets) {
    const svg = readFileSync(publicDir + target.source, "utf8");
    const page = await browser.newPage({ viewport: { width: target.size, height: target.size }, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${target.size}" height="${target.size}" `)}</body></html>`);
    writeFileSync(publicDir + target.file, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: target.size, height: target.size } }));
    await page.close();
  }
} finally {
  await browser.close();
}

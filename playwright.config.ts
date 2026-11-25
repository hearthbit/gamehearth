import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 8199;
const fakePushPort = 8198;
const external = process.env["GAMEHEARTH_URL"];
const dataDir = join(tmpdir(), "gamehearth-e2e-data");
process.env["GAMEHEARTH_E2E_DATA"] = dataDir;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 180_000,
  workers: 1,
  reporter: "list",
  outputDir: join(tmpdir(), "gamehearth-e2e-results"),
  use: {
    baseURL: external ?? `http://127.0.0.1:${port}`,
    browserName: "chromium",
    viewport: { width: 420, height: 860 },
    locale: "de-DE",
    trace: "retain-on-failure",
    actionTimeout: 20_000,
  },
  ...(external === undefined
    ? {
        webServer: {
          command: "npm run build --silent && node --disable-warning=ExperimentalWarning scripts/e2e-server.mjs",
          url: `http://127.0.0.1:${port}/api/health`,
          reuseExistingServer: false,
          timeout: 240_000,
          stdout: "ignore" as const,
          stderr: "pipe" as const,
          env: { PORT: String(port), DATA_DIR: dataDir, PUSH_HOSTS: `http://127.0.0.1:${fakePushPort}` },
        },
      }
    : {}),
});

import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dataDir = process.env["DATA_DIR"];
if (dataDir === undefined || dataDir === "") {
  throw new Error("DATA_DIR is missing");
}
rmSync(dataDir, { recursive: true, force: true });
process.env["GAMES_DIR"] ||= fileURLToPath(new URL("../fixtures", import.meta.url));
await import("../packages/server/dist/main.js");

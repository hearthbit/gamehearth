import { fileURLToPath } from "node:url";

process.env["GAMES_DIR"] ||= fileURLToPath(new URL("../fixtures", import.meta.url));
await import("../packages/server/dist/main.js");

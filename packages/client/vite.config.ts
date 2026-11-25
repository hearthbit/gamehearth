import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { serviceWorker } from "./sw-plugin.ts";

const server = process.env["GAMEHEARTH_SERVER"] ?? "http://localhost:8080";

export default defineConfig({
  plugins: [serviceWorker(fileURLToPath(new URL(".", import.meta.url)))],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    proxy: {
      "/api": server,
      "/games": server,
      "/ws": { target: server.replace(/^http/, "ws"), ws: true },
    },
  },
});

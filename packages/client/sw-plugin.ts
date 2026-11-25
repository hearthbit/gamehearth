import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { pushTexts } from "./src/texts.ts";

export const shellFiles = ["/manifest.webmanifest", "/icon.svg", "/icon-192.png"];

export interface ShellEntry {
  path: string;
  content: string | Uint8Array;
}

export function shellVersion(entries: readonly ShellEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(entry.path);
    hash.update("\n");
    hash.update(entry.content);
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 12);
}

export function renderServiceWorker(template: string, shell: readonly string[], version: string): string {
  return template
    .replace('"__SHELL__"', JSON.stringify(shell))
    .replace("__VERSION__", version)
    .replace('"__PUSH_TEXTS__"', JSON.stringify(pushTexts));
}

export function serviceWorker(root: string): Plugin {
  return {
    name: "gamehearth-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const entries: ShellEntry[] = [];
      const assets: string[] = [];
      for (const [file, output] of Object.entries(bundle)) {
        if (file.startsWith("assets/")) {
          assets.push(`/${file}`);
          entries.push({ path: `/${file}`, content: "" });
        } else if (file === "index.html" && output.type === "asset") {
          entries.push({ path: "/", content: output.source });
        }
      }
      for (const file of shellFiles) {
        entries.push({ path: file, content: readFileSync(join(root, "public", file)) });
      }
      const shell = ["/", ...shellFiles, ...assets.sort()];
      const template = readFileSync(join(root, "src", "sw.js"), "utf8");
      this.emitFile({ type: "asset", fileName: "sw.js", source: renderServiceWorker(template, shell, shellVersion(entries)) });
    },
  };
}

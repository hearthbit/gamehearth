import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Finding } from "./findings";
import type { Manifest } from "./manifest";

const sourcePattern = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte)$/;
const skippedDirs = new Set(["node_modules", "dist", "build", ".git", ".gamehearth", "test", "tests", "coverage"]);
const maxFiles = 2000;
const maxFileBytes = 1024 * 1024;

interface Trap {
  pattern: RegExp;
  message: string;
}

const traps: Trap[] = [
  {
    pattern: /\b(localStorage|sessionStorage)\b/,
    message: "uses localStorage or sessionStorage; neither exists in the sandboxed iframe. Saves go through game.save() and game.saved.",
  },
  { pattern: /\bindexedDB\b/, message: "uses indexedDB; it does not exist in the sandboxed iframe. Saves go through game.save() and game.saved." },
  { pattern: /\bdocument\.cookie\b/, message: "uses document.cookie; there are no cookies in the sandboxed iframe." },
  { pattern: /\bnavigator\.serviceWorker\b|\bcaches\.open\b/, message: "uses a service worker or the Cache API; offline, the platform loads the game itself." },
  {
    pattern: /\bnew\s+(WebSocket|EventSource|RTCPeerConnection)\b/,
    message: "opens its own connection; games talk to the platform only through the SDK, and the CSP blocks connections to the outside.",
  },
  {
    pattern: /(\bfetch|\bXMLHttpRequest|\.load\.\w+)\s*\([^)]*["'`]https?:\/\//,
    message: "loads something from a foreign URL; the CSP only allows files from the game's own client folder. Put graphics and data into the game.",
  },
];

const connectImport = /import\s*(type\s*)?\{[^}]*\bconnect\b[^}]*\}\s*from\s*["']@gamehearth\/sdk\/client["']/;
const recordCall = /([A-Za-z_$#][\w$]*)\s*\.\s*record\(\s*["'`]([^"'`]+)["'`]/g;
const receiverPatterns = [/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+connectSolo\b/g, /(#?[A-Za-z_$][\w$]*)\s*[?!]?\s*:\s*SoloGame\b/g];

export async function scanSoloClient(gameDir: string, manifest: Manifest): Promise<Finding[]> {
  const files = await sourceFiles(gameDir, manifest.client);
  const findings: Finding[] = [];
  const stats = manifest.stats ?? {};
  let usesSolo = false;
  const texts = new Map<string, string>();
  const receivers = new Set<string>();
  for (const file of files) {
    try {
      const text = await readFile(file, "utf8");
      texts.set(file, text);
      for (const pattern of receiverPatterns) {
        for (const match of text.matchAll(pattern)) {
          receivers.add(match[1] as string);
        }
      }
    } catch {
      continue;
    }
  }
  for (const [file, text] of texts) {
    const name = relative(gameDir, file).split("\\").join("/");
    const lines = text.split(/\r?\n/);
    if (text.includes("connectSolo")) {
      usesSolo = true;
    }
    lines.forEach((line, index) => {
      const code = /^\s*(\/\/|\/\*|\*)/.test(line) ? "" : line;
      for (const trap of traps) {
        if (trap.pattern.test(code)) {
          findings.push({ severity: "warning", kind: "sandbox", message: `${name}:${index + 1} ${trap.message}`, detail: line.trim().slice(0, 160) });
        }
      }
      for (const match of code.matchAll(recordCall)) {
        const receiver = match[1] as string;
        const stat = match[2] as string;
        const sure = receivers.has(receiver);
        if (Object.hasOwn(stats, stat) || (!sure && receivers.size > 0)) {
          continue;
        }
        const known = Object.keys(stats);
        findings.push({
          severity: sure ? "error" : "warning",
          kind: "solo",
          message: `${name}:${index + 1} reports ${sure ? "" : "probably "}the best score "${stat}", which is not listed under stats in manifest.json (${known.length === 0 ? "there is none there yet" : `known: ${known.join(", ")}`}). The platform rejects it.`,
        });
      }
    });
    if (connectImport.test(text)) {
      findings.push({
        severity: "error",
        kind: "solo",
        message: `${name} imports connect from @gamehearth/sdk/client. Single-player games without a reducer call connectSolo(); the platform rejects connect() on the single-player page.`,
      });
    }
  }
  if (!usesSolo && files.length > 0) {
    findings.push({
      severity: "warning",
      kind: "solo",
      message: "No source file calls connectSolo(). Without it, the game can neither save nor report best scores; if that is intended, this warning can stay.",
    });
  }
  return findings;
}

async function sourceFiles(gameDir: string, clientDir: string): Promise<string[]> {
  const skippedPath = join(gameDir, ...clientDir.split("/"));
  const found: string[] = [];
  const walk = async (dir: string) => {
    if (found.length >= maxFiles || dir === skippedPath) {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirs.has(entry.name) && !entry.name.startsWith(".")) {
          await walk(path);
        }
      } else if (entry.isFile() && sourcePattern.test(entry.name) && !/\.(test|spec)\.[^.]+$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        found.push(path);
      }
    }
  };
  await walk(gameDir);
  const sized: string[] = [];
  for (const file of found) {
    const text = await readFile(file).catch(() => undefined);
    if (text !== undefined && text.length <= maxFileBytes) {
      sized.push(file);
    }
  }
  return sized;
}

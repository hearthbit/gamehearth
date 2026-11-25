import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let runner: Promise<string> | undefined;

export function devtoolRoot(): string {
  return dirname(createRequire(import.meta.url).resolve("gamehearth/package.json"));
}

export function buildGuestRunner(): Promise<string> {
  runner ??= bundleGuestRunner().catch((error: unknown) => {
    runner = undefined;
    throw error;
  });
  return runner;
}

async function bundleGuestRunner(): Promise<string> {
  const result = await build({
    entryPoints: [join(devtoolRoot(), "src", "sandbox", "guest.ts")],
    write: false,
    bundle: true,
    platform: "neutral",
    format: "iife",
    target: "es2022",
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (output === undefined) {
    throw new Error("esbuild produced no guest runner");
  }
  return output.text;
}

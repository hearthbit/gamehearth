import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const mauMauSource = fileURLToPath(new URL("../../../fixtures/mau-mau", import.meta.url));

export function withStubClient(source: string, withClient = true): string {
  const dir = mkdtempSync(join(tmpdir(), "gamehearth-mau-mau-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(source, "src"), join(dir, "src"), { recursive: true });
  const sdk = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url)).replaceAll("\\", "/");
  for (const file of readdirSync(join(dir, "src"))) {
    const path = join(dir, "src", file);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll('"@gamehearth/sdk"', JSON.stringify(sdk)));
  }
  const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(withClient ? { ...manifest, client: "client" } : manifest, null, 2));
  if (withClient) {
    mkdirSync(join(dir, "client"), { recursive: true });
    writeFileSync(join(dir, "client", "index.html"), '<!doctype html><meta charset="utf-8"><title>Mau-Mau</title>');
  }
  return dir;
}

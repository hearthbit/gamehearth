import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const templates = fileURLToPath(new URL("../templates", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "gamehearth-release-"));

afterAll(() => rmSync(work, { recursive: true, force: true }));

function releaseName(template: string, manifest: object): string {
  const workflow = readFileSync(join(templates, template, "github", "workflows", "release.yml"), "utf8");
  const line = workflow.split("\n").find((entry) => entry.trim().startsWith("name=$(node -p "));
  if (line === undefined) throw new Error(`no name line in ${template}`);
  const expression = line.trim().slice("name=$(node -p ".length, -1);
  writeFileSync(join(work, "manifest.json"), JSON.stringify(manifest));
  return execFileSync(process.execPath, ["-p", JSON.parse(expression) as string], { cwd: work, encoding: "utf8" }).trim();
}

describe("release workflow of the templates", () => {
  it.each(["turn-based", "realtime", "single"])("%s names the release in the game's default language", (template) => {
    expect(releaseName(template, { name: { de: "Kritzelkiste", en: "Doodle Box" }, languages: ["de", "en"] })).toBe("Kritzelkiste");
    expect(releaseName(template, { name: "Mau-Mau" })).toBe("Mau-Mau");
  });
});

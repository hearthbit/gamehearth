import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const devtool = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("../../../scripts/write-starter.mjs", import.meta.url));
const work = mkdtempSync(join(devtool, "starter-test-"));

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("starter snapshot", () => {
  it("Review 9: does not write into a folder that is not a snapshot of the starter", () => {
    const target = join(work, "projects");
    mkdirSync(join(target, "other-project"), { recursive: true });
    writeFileSync(join(target, "other-project", "important.txt"), "stays");
    const run = spawnSync(process.execPath, [script, target], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("is neither empty nor a snapshot of the starter");
    expect(readFileSync(join(target, "other-project", "important.txt"), "utf8")).toBe("stays");
  });

  it("requires a target folder", () => {
    const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(run.status).toBe(2);
  });
});

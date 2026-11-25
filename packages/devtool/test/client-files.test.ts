import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectClient, maxClientFiles } from "../src/client-files";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function gameWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gamehearth-client-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...path.split("/")), content);
  }
  return dir;
}

describe("inspectClient", () => {
  it("lists all files sorted with size and checksum", async () => {
    const dir = gameWith({ "dist/client/index.html": "<p>", "dist/client/assets/b.js": "b", "dist/client/assets/a.png": "aa" });
    const inspection = await inspectClient(dir, "dist/client");
    expect(inspection.ok).toBe(true);
    if (inspection.ok) {
      expect(inspection.files.map((file) => [file.path, file.size])).toEqual([
        ["assets/a.png", 2],
        ["assets/b.js", 1],
        ["index.html", 3],
      ]);
      expect(inspection.bytes).toBe(6);
      expect(inspection.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("reports a missing folder with a pointer to the build", async () => {
    const inspection = await inspectClient(gameWith({ "manifest.json": "{}" }), "dist/client");
    expect(inspection).toEqual({ ok: false, problems: [expect.stringContaining("npm run build")] });
  });

  it("reports a missing index.html", async () => {
    const inspection = await inspectClient(gameWith({ "client/main.js": "" }), "client");
    expect(inspection).toEqual({ ok: false, problems: ["The client folder client has no index.html"] });
  });

  it("rejects paths outside the game folder", async () => {
    const inspection = await inspectClient(gameWith({ "client/index.html": "" }), "../client");
    expect(inspection.ok).toBe(false);
  });

  it("rejects file names that cause trouble when served", async () => {
    const inspection = await inspectClient(gameWith({ "client/index.html": "", "client/a%2e.js": "" }), "client");
    expect(inspection).toEqual({ ok: false, problems: [expect.stringContaining("file names may only")] });
  });

  it("limits the number of files", async () => {
    const files: Record<string, string> = { "client/index.html": "" };
    for (let index = 0; index <= maxClientFiles; index++) {
      files[`client/f/${index}.txt`] = "";
    }
    const inspection = await inspectClient(gameWith(files), "client");
    expect(inspection).toEqual({ ok: false, problems: [`The client has more than ${maxClientFiles} files`] });
  }, 60_000);

  it("rejects symlinks in the client", async () => {
    const dir = gameWith({ "client/index.html": "", "secret.txt": "x" });
    try {
      symlinkSync(join(dir, "secret.txt"), join(dir, "client", "secret.txt"));
    } catch {
      return;
    }
    const inspection = await inspectClient(dir, "client");
    expect(inspection).toEqual({ ok: false, problems: [expect.stringContaining("is a symlink")] });
  });
});

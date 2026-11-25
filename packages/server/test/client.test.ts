import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { clientUrl } from "../src/games";
import { createSetup, hostRoom, zaehlenV1, type Setup } from "./helpers";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function prepare(): Promise<Setup> {
  const setup = await createSetup();
  cleanups.push(() => setup.cleanup());
  return setup;
}

function copyFixture(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gamehearth-spiel-"));
  cpSync(source, dir, { recursive: true });
  const entry = join(dir, "src", "index.ts");
  const sdk = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url)).replaceAll("\\", "/");
  writeFileSync(entry, readFileSync(entry, "utf8").replace('"@gamehearth/sdk"', JSON.stringify(sdk)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("Client part of a build", () => {
  it("copies the client into the build and names its address in the room", async () => {
    const setup = await prepare();
    const build = await setup.library.install(zaehlenV1);
    expect([...build.clientFiles]).toEqual(["index.html"]);
    expect(readFileSync(join(build.clientDir, "index.html"), "utf8")).toContain("Testspiel");
    const host = hostRoom(setup, "zaehlen", "Anna");
    const view = await setup.rooms.view(host.code, host.user);
    expect(view.game.client).toBe(clientUrl(build.build));
    expect(view.game.client).toMatch(/^\/games\/zaehlen\/1\.0\.0\+[0-9a-f]{12}\/$/);
  });

  it("turns a change only to the client into a new build", async () => {
    const setup = await prepare();
    const dir = copyFixture(zaehlenV1);
    const first = await setup.library.install(dir);
    writeFileSync(join(dir, "client", "index.html"), "<p>neu</p>");
    const second = await setup.library.install(dir);
    expect(second.build).not.toBe(first.build);
    expect(readFileSync(join(second.clientDir, "index.html"), "utf8")).toBe("<p>neu</p>");
    expect(existsSync(join(first.clientDir, "index.html"))).toBe(true);
  });

  it("does not install a game without a client folder", async () => {
    const setup = await prepare();
    const dir = copyFixture(zaehlenV1);
    rmSync(join(dir, "client"), { recursive: true });
    await expect(setup.library.install(dir)).rejects.toThrow("The client folder client is missing");
  });

  it("treats a build with a changed client file as damaged and repairs it", async () => {
    const setup = await prepare();
    const build = await setup.library.install(zaehlenV1);
    writeFileSync(join(build.clientDir, "index.html"), "<script>manipuliert</script>");
    const reopened = await setup.reopen();
    cleanups.push(() => reopened.cleanup());
    expect(await reopened.library.load(build.build)).toBeUndefined();
    const repaired = await reopened.library.install(zaehlenV1);
    expect(repaired.build).toBe(build.build);
    expect(readFileSync(join(repaired.clientDir, "index.html"), "utf8")).toContain("Testspiel");
  });
});

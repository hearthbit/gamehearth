import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { startDev, type DevServer } from "../src/dev/server";
import { DevSoloState, soloSaveFile } from "../src/dev/solo-state";

const devtool = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(devtool, "dev-solo-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const stats = { punkte: { label: "Punkte", better: "higher" as const }, zeit: { label: "Zeit", better: "lower" as const, format: "time" as const } };

function soloGame(name: string, screen = "small"): string {
  const dir = join(work, name);
  const files: Record<string, string> = {
    "manifest.json": JSON.stringify({
      id: name,
      name: "Solo",
      version: "0.1.0",
      sdk: "^0.1.2",
      license: { code: "MIT", assets: "CC0-1.0" },
      mode: "single",
      players: { min: 1, max: 1 },
      server: false,
      client: "dist/client",
      roles: { player: { inputs: ["touch"], screen } },
      stats,
    }),
    "dist/client/index.html": '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="main.js"></script></body></html>',
    "dist/client/main.js": "document.body.textContent = 'solo';",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

let server: DevServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${server?.port}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${server?.port}` },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("dev for single-player games without a reducer", () => {
  it("starts without rules and match and shows save and best scores from the file in the game folder", async () => {
    const dir = soloGame("start", "medium");
    const lines: string[] = [];
    server = await startDev(dir, { port: 0, out: (line) => lines.push(line) });
    expect(lines.join("\n")).toContain("Save and best scores: ");
    expect(lines.join("\n")).not.toContain("One seat:");
    const view = server.view();
    expect(view.solo).toMatchObject({ saved: null, best: {}, screen: "medium", stats });
    expect(view.session.seats.map((seat) => seat.seat)).toEqual(["p1"]);
    expect(view.problems).toEqual([]);
  });

  it("saves, keeps only better best scores and writes everything to .gamehearth/dev-save.json", async () => {
    const dir = soloGame("save");
    server = await startDev(dir, { port: 0, out: () => {} });
    expect((await post("/__dev/solo", { action: "save", data: { level: 3 } })).body).toMatchObject({ ok: true, solo: { saved: { level: 3 } } });
    await post("/__dev/solo", { action: "record", stat: "punkte", value: 50 });
    await post("/__dev/solo", { action: "record", stat: "punkte", value: 40 });
    await post("/__dev/solo", { action: "record", stat: "zeit", value: 9000 });
    const answer = await post("/__dev/solo", { action: "record", stat: "zeit", value: 8000 });
    expect(answer.body).toMatchObject({ ok: true, solo: { best: { punkte: 50, zeit: 8000 } } });
    expect(JSON.parse(readFileSync(join(dir, soloSaveFile), "utf8"))).toEqual({ saved: { level: 3 }, best: { punkte: 50, zeit: 8000 } });
  });

  it("rejects unknown best scores and broken saves and reports them in the terminal", async () => {
    const dir = soloGame("error");
    const lines: string[] = [];
    server = await startDev(dir, { port: 0, out: (line) => lines.push(line) });
    const unknown = await post("/__dev/solo", { action: "record", stat: "sterne", value: 1 });
    expect(unknown.body).toMatchObject({ ok: false, code: "invalid-stat", message: 'The best score "sterne" does not exist. Under stats in manifest.json there are: punkte, zeit.' });
    expect(lines.join("\n")).toContain('The best score "sterne" does not exist');
    expect(server.view().problems).toEqual([expect.objectContaining({ title: "Best score rejected" })]);
    expect((await post("/__dev/solo", { action: "save", data: null })).body).toMatchObject({ ok: false, code: "invalid-save" });
    await post("/__dev/solo", { action: "save", data: { ok: 1 } });
    expect(server.view().problems.map((problem) => problem.title)).toEqual(["Best score rejected"]);
    await post("/__dev/solo", { action: "record", stat: "punkte", value: 1 });
    expect(server.view().problems).toEqual([]);
  });

  it("Review 9b: takes only best scores from the file that the manifest knows and says so on the page and in the terminal", async () => {
    const dir = soloGame("names");
    mkdirSync(join(dir, ".gamehearth"), { recursive: true });
    writeFileSync(join(dir, soloSaveFile), JSON.stringify({ saved: null, best: { Punkte: 120, highscore: 5, punkte: 7 } }));
    const lines: string[] = [];
    server = await startDev(dir, { port: 0, out: (line) => lines.push(line) });
    expect(server.view().solo?.best).toEqual({ punkte: 7 });
    expect(server.view().problems).toEqual([expect.objectContaining({ title: "Save file", message: expect.stringContaining('The best score "Punkte" does not exist') })]);
    expect(lines.join("\n")).toContain('The best score "highscore" does not exist');
  });

  it("Review 9b: does not write into a broken file and reports it in the terminal too", async () => {
    const dir = soloGame("broken");
    mkdirSync(join(dir, ".gamehearth"), { recursive: true });
    const broken = '{ "saved": null, "best": { "punkte": 9999 }, }';
    writeFileSync(join(dir, soloSaveFile), broken);
    const lines: string[] = [];
    server = await startDev(dir, { port: 0, out: (line) => lines.push(line) });
    expect(lines.join("\n")).toContain("is not valid JSON");
    for (const body of [{ action: "save", data: { level: 1 } }, { action: "record", stat: "punkte", value: 3 }, { action: "clear-best" }]) {
      expect((await post("/__dev/solo", body)).body).toMatchObject({ ok: false, code: "broken-save-file" });
    }
    expect(readFileSync(join(dir, soloSaveFile), "utf8")).toBe(broken);
  });

  it("deletes save and best scores separately", async () => {
    const dir = soloGame("delete");
    server = await startDev(dir, { port: 0, out: () => {} });
    await post("/__dev/solo", { action: "save", data: { level: 3 } });
    await post("/__dev/solo", { action: "record", stat: "punkte", value: 50 });
    await post("/__dev/solo", { action: "clear-save" });
    expect(server.view().solo).toMatchObject({ saved: null, best: { punkte: 50 } });
    await post("/__dev/solo", { action: "clear-best" });
    expect(server.view().solo).toMatchObject({ saved: null, best: {} });
  });

  it("reads a file edited by hand and reports a broken one", async () => {
    const dir = soloGame("hand");
    mkdirSync(join(dir, ".gamehearth"), { recursive: true });
    writeFileSync(join(dir, soloSaveFile), JSON.stringify({ saved: { level: 9 }, best: { punkte: 7 } }));
    server = await startDev(dir, { port: 0, out: () => {} });
    expect(server.view().solo).toMatchObject({ saved: { level: 9 }, best: { punkte: 7 } });
    writeFileSync(join(dir, soloSaveFile), "{ broken");
    expect(server.view().solo).toMatchObject({ saved: null, problem: expect.stringContaining("is not valid JSON") });
  });

  it("has no moves, matches or bots", async () => {
    const dir = soloGame("without");
    server = await startDev(dir, { port: 0, out: () => {} });
    for (const path of ["/__dev/move", "/__dev/new", "/__dev/bot", "/__dev/step"]) {
      expect((await post(path, { seat: "p1", playerCount: 1 })).body).toMatchObject({ ok: false, code: "solo" });
    }
    expect((await post("/__dev/solo", { action: "conjure" })).body).toMatchObject({ ok: false, code: "bad-request" });
  });

  it("writes the file only when something is saved", () => {
    const dir = soloGame("empty");
    const state = new DevSoloState(dir, () => stats);
    expect(state.view("small")).toMatchObject({ saved: null, best: {} });
    expect(existsSync(join(dir, soloSaveFile))).toBe(false);
  });
});

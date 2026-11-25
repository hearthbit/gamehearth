import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packageOf } from "./catalog-helpers";
import { createSetup, hostRoom, joinRoom, type Setup } from "./helpers";

let setup: Setup;
const temporary: string[] = [];

beforeEach(async () => {
  setup = await createSetup(undefined, {}, { realtime: { timers: false } });
});

afterEach(async () => {
  await setup.cleanup();
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeGame(): string {
  const dir = mkdtempSync(join(tmpdir(), "gamehearth-platzhalter-"));
  temporary.push(dir);
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "client"));
  writeFileSync(join(dir, "client", "index.html"), "<!doctype html><title>Notes</title>");
  writeFileSync(
    join(dir, "src", "index.ts"),
    `import { defineGame, int, text } from "@gamehearth/sdk";
type State = { public: { notes: string[]; total: number }; players: Record<string, Record<string, never>>; secret: null };
type Action = { type: "note"; text: string; n: number };
export default defineGame<State, Action>({
  setup: ({ players }) => ({ public: { notes: [], total: 0 }, players: Object.fromEntries(players.map((player) => [player, {}])), secret: null }),
  legalMoves: () => [{ type: "note", text: text({ min: 1, max: 10 }), n: int({ min: 1, max: 3 }) }],
  apply(state, action) {
    if (typeof action.text !== "string" || typeof action.n !== "number") {
      throw new Error("got a placeholder instead of a value");
    }
    state.public.notes.push(action.text);
    state.public.total += action.n;
  },
  result: (state) => (state.public.notes.length >= 30 ? { winners: [] } : undefined),
});
`,
  );
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "notizen",
      name: "Notizen",
      version: "1.0.0",
      sdk: "^0.1.7",
      license: { code: "MIT", assets: "CC0-1.0" },
      mode: "turn-based",
      players: { min: 1, max: 3 },
      server: true,
      client: "client",
      roles: { player: { inputs: ["touch", "keyboard"], screen: "small" } },
    }),
  );
  return dir;
}

describe("Placeholders on the server", () => {
  it("fills placeholders in the trial match when installing a package", async () => {
    expect((await setup.library.installPackage((await packageOf(writeGame())).archive)).manifest.id).toBe("notizen");
  });

  it("accepts a typed move in a room and rejects one outside the placeholder", async () => {
    await setup.library.installPackage((await packageOf(writeGame())).archive);
    const anna = hostRoom(setup, "notizen", "Anna");
    await joinRoom(setup, anna.code, "Ben");
    await setup.rooms.start(anna.code, anna.user);
    await setup.rooms.move(anna.code, anna.user, { type: "note", text: "Käse 🧀", n: 3 }, 0);
    await expect(setup.rooms.move(anna.code, anna.user, { type: "note", text: "x".repeat(11), n: 1 }, 1)).rejects.toMatchObject({ code: "illegal-move" });
    const view = await setup.rooms.view(anna.code, anna.user);
    expect(view.snapshot?.public).toEqual({ notes: ["Käse 🧀"], total: 3 });
  });
});

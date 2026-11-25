import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OptionsSpec } from "@gamehearth/sdk/platform";
import { checkGame, chosenOptions, optionVariants, quickjsRuns } from "../src/check";
import type { GameRun } from "../src/runner";
import { formatReport } from "../src/format";

const dir = fileURLToPath(new URL("./fixtures/options-bug", import.meta.url));

const spec: OptionsSpec = {
  ziel: {
    label: "Ziel",
    type: "choice",
    default: 10,
    choices: [
      { value: 10, label: "10" },
      { value: 20, label: "20" },
      { value: 30, label: "30" },
    ],
  },
  gross: { label: "Große Schritte", type: "boolean", default: false },
};

describe("optionVariants", () => {
  it("plays the default and every other value of an option once, with the rest at their default", () => {
    expect(optionVariants(spec)).toEqual([
      { ziel: 10, gross: false },
      { ziel: 20, gross: false },
      { ziel: 30, gross: false },
      { ziel: 10, gross: true },
    ]);
  });

  it("returns exactly one empty variant without options", () => {
    expect(optionVariants(undefined)).toEqual([{}]);
  });
});

describe("chosenOptions", () => {
  it("reads values from the command line according to the type of the option", () => {
    expect(chosenOptions(spec, {})).toBeUndefined();
    expect(chosenOptions(spec, { ziel: "30" })).toEqual({ ziel: 30, gross: false });
    expect(chosenOptions(spec, { gross: "true", ziel: "20" })).toEqual({ ziel: 20, gross: true });
  });

  it("explains unknown options and values", () => {
    expect(chosenOptions(spec, { ziel: "40" })).toBe("--option ziel=40: there is no such value; possible values are 10, 20, 30.");
    expect(chosenOptions(spec, { gross: "ja" })).toBe("--option gross=ja: there is no such value; possible values are true, false.");
    expect(chosenOptions(spec, { runden: "3" })).toBe("--option runden: there is no such option; known options are ziel, gross.");
    expect(chosenOptions(undefined, { runden: "3" })).toBe("--option runden: the game has no options (options in manifest.json).");
    expect(chosenOptions(spec, { toString: "1" })).toContain("there is no such option");
  });
});

describe("check with options", () => {
  it("finds an error that only exists with one value of an option and names the command to replay it", async () => {
    const report = await checkGame(dir, { games: 8, players: 2, quickjsGames: 4 });
    expect(report.notes).toContainEqual(expect.stringContaining("4 variants"));
    const errors = report.findings.filter((finding) => finding.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "game-error", phase: "apply", options: { ziel: 30, gross: false } });
    expect(errors[0]?.message).toContain("broken at target 30");
    expect(report.findings.filter((finding) => finding.kind === "engine")).toEqual([]);
    const text = formatReport(report, dir);
    expect(text).toContain("options ziel=30");
    expect(text).toMatch(/Replay: npm run gamehearth -- check \. --players 2 --seed check-2-\d+ --option ziel=30/);
  }, 60_000);

  it("plays all matches only with this choice when --option is given", async () => {
    const report = await checkGame(dir, { games: 6, players: 3, options: { ziel: "20", gross: "true" }, quickjsGames: 2 });
    expect(report.findings).toEqual([]);
    expect(report.notes.some((note) => note.includes("variants"))).toBe(false);
    expect(report.summaries).toMatchObject([{ playerCount: 3, games: 6, finished: 6 }]);
  }, 60_000);

  it("replays exactly the reported match with --seed and --option", async () => {
    const first = await checkGame(dir, { games: 8, players: 2, quickjsGames: 0 });
    const failed = first.findings.find((finding) => finding.kind === "game-error");
    expect(failed?.seed).toBeDefined();
    const replay = await checkGame(dir, { players: 2, seed: failed?.seed as string, options: { ziel: "30" }, quickjsGames: 1 });
    expect(replay.replay?.options).toEqual({ ziel: 30, gross: false });
    expect(replay.findings.filter((finding) => finding.kind === "game-error")).toHaveLength(1);
    expect(formatReport(replay, dir)).toContain(`Match with seed ${failed?.seed as string} and 2 players, options ziel=30:`);
    const plain = await checkGame(dir, { players: 2, seed: failed?.seed as string, quickjsGames: 0 });
    expect(plain.findings).toEqual([]);
  }, 60_000);

  it("rejects unknown options before a match runs", async () => {
    const report = await checkGame(dir, { options: { ziel: "40" } });
    expect(report.findings).toEqual([expect.objectContaining({ severity: "error", kind: "options", message: expect.stringContaining("possible values are 10, 20, 30") })]);
    expect(report.summaries).toEqual([]);
  });

  it("Review 10: reports a variant in which matches never end as an error", async () => {
    const work = mkdtempSync(join(fileURLToPath(new URL("..", import.meta.url)), "check-endless-"));
    try {
      cpSync(dir, work, { recursive: true });
      const file = join(work, "src", "index.ts");
      const source = readFileSync(file, "utf8")
        .replace('    if (options.ziel === 30 && state.public.count > 25) {\n      throw new Error("broken at target 30");\n    }\n', "")
        .replace("    state.public.count += action.amount;", "    state.public.count += options.ziel === 30 ? 0 : action.amount;");
      expect(source).toContain("options.ziel === 30 ? 0");
      writeFileSync(file, source);
      const report = await checkGame(work, { games: 40, players: 2, maxMoves: 200, quickjsGames: 0 });
      const endless = report.findings.filter((finding) => finding.kind === "never-ends");
      expect(endless).toEqual([expect.objectContaining({ severity: "error", options: { ziel: 30, gross: false } })]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);

  it("Review 10: replays every variant at least once in QuickJS", async () => {
    const run = (seed: string, ziel: number): GameRun => ({ playerCount: 2, seed, options: { ziel, gross: false }, moves: [], ending: "finished", findings: [] });
    const runs = [run("check-2-0", 10), run("check-2-1", 20), run("check-2-2", 30), run("check-2-3", 10), run("check-2-10", 20), run("check-2-5", 30)];
    const seeds = (selected: GameRun[][]) => selected.map((list) => list.map((entry) => entry.seed));
    expect(seeds(quickjsRuns([runs], 1))).toEqual([["check-2-0", "check-2-1", "check-2-2"]]);
    expect(seeds(quickjsRuns([runs], 4))).toEqual([["check-2-0", "check-2-1", "check-2-2", "check-2-3"]]);
    const report = await checkGame(dir, { games: 8, players: 3, quickjsGames: 1 });
    expect(report.notes).toContainEqual("4 matches also replayed in QuickJS, the JS engine of the server.");
  }, 60_000);

  it("replays each variant once across all player counts, with the fewest players", () => {
    const run = (playerCount: number, index: number, ziel: number): GameRun => ({
      playerCount,
      seed: `check-${playerCount}-${index}`,
      options: { ziel, gross: false },
      moves: [],
      ending: "finished",
      findings: [],
    });
    const perCount = [4, 2, 3].map((playerCount) => [10, 20, 30].map((ziel, index) => run(playerCount, index, ziel)));
    const selected = quickjsRuns(perCount, 1);
    expect(selected.map((list) => list.map((entry) => entry.seed))).toEqual([["check-4-0"], ["check-2-0", "check-2-1", "check-2-2"], ["check-3-0"]]);
    expect(selected.flat()).toHaveLength(5);
  });

  it("plays every variant at least once, even if fewer matches are requested", async () => {
    const report = await checkGame(dir, { games: 1, players: 2, quickjsGames: 0 });
    expect(report.summaries[0]?.games).toBe(4);
  }, 60_000);
});

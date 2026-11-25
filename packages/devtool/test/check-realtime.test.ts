import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkGame, type CheckOptions } from "../src/check";
import type { Finding } from "../src/findings";
import { formatReport } from "../src/format";
import { Sandbox } from "../src/sandbox/sandbox";

afterEach(() => {
  vi.restoreAllMocks();
});

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

async function check(name: string, options: CheckOptions = {}) {
  return checkGame(fixture(name), { games: 4, ...options });
}

function only(findings: readonly Finding[], kind: Finding["kind"]): Finding[] {
  return findings.filter((finding) => finding.kind === kind);
}

describe("check with realtime games", () => {
  it("plays an error-free realtime game tick by tick and names the game time", async () => {
    const report = await check("rt-dots");
    expect(report.findings).toEqual([]);
    expect(report.summaries.map((summary) => [summary.playerCount, summary.finished, summary.averageSeconds])).toEqual([
      [2, 4, 3],
      [3, 4, 3],
    ]);
    expect(report.notes.join("\n")).toMatch(/Realtime: in every tick, bots press/);
    expect(formatReport(report)).toMatch(/on average 3 s of game time/);
  }, 60_000);

  it("reports matches without an end after the game time limit as an error with the tick", async () => {
    const report = await check("rt-endless", { games: 2, maxSeconds: 5, quickjsGames: 0 });
    const [endless] = only(report.findings, "never-ends");
    expect(endless).toMatchObject({ severity: "error", step: 100, unit: "tick" });
    expect(endless?.message).toMatch(/after 5 seconds of game time \(100 ticks\)/);
    expect(formatReport(report)).toMatch(/tick 100/);
    expect(formatReport(report)).toMatch(/--max-seconds 5/);
  }, 60_000);

  it("requires tick with mode realtime and rejects tick in turn-based games", async () => {
    const missing = await check("rt-no-tick", { games: 1, quickjsGames: 0 });
    expect(only(missing.findings, "manifest")[0]?.message).toMatch(/mode "realtime", but it has no function tick/);
    const extra = await check("rt-tick-turn", { games: 1, quickjsGames: 0 });
    expect(only(extra.findings, "manifest")[0]?.message).toMatch(/has a function tick, but according to manifest.json it is not mode "realtime"/);
  }, 60_000);

  it("reports an error in tick with the phase and the tick number", async () => {
    const report = await check("rt-tick-error", { games: 1, quickjsGames: 0 });
    expect(only(report.findings, "game-error")[0]).toMatchObject({ phase: "tick", step: 30, unit: "tick", message: "tick threw an error: wall at tick 30" });
  }, 60_000);

  it("finds leaks in the inputs also in realtime", async () => {
    const report = await check("rt-leak", { games: 2, quickjsGames: 0 });
    expect(only(report.findings, "leak")).not.toHaveLength(0);
  }, 60_000);

  it("warns when a tick takes too long in QuickJS", async () => {
    const report = await check("rt-slow", { games: 1, players: 2, quickjsGames: 1 });
    const [slow] = only(report.findings, "engine");
    expect(slow).toMatchObject({ severity: "warning" });
    expect(slow?.message).toMatch(/A tick takes long on the server \(QuickJS\)/);
    expect(slow?.detail).toMatch(/on average \d+\.\d ms/);
  }, 60_000);

  it("acceptance run: repeats a tick after a single timeout in QuickJS instead of reporting an error", async () => {
    const original = Sandbox.prototype.run;
    let calls = 0;
    const failOn = new Set([5]);
    vi.spyOn(Sandbox.prototype, "run").mockImplementation(function (this: Sandbox, ...args: Parameters<Sandbox["run"]>) {
      if (args[0] === "stepMatch") {
        calls += 1;
        if (failOn.has(calls)) {
          return { ok: false, failure: { kind: "timeout", message: "Time limit of 100 ms exceeded" } };
        }
      }
      return original.apply(this, args);
    });
    const once = await check("rt-dots", { games: 1, players: 2, quickjsGames: 1 });
    expect(only(once.findings, "engine")).toEqual([]);
    calls = 0;
    failOn.add(6);
    const twice = await check("rt-dots", { games: 1, players: 2, quickjsGames: 1 });
    expect(only(twice.findings, "engine")[0]?.message).toMatch(/Time limit of 100 ms/);
  }, 60_000);

  it("replays a single realtime match and shows the inputs with their tick", async () => {
    const report = await check("rt-dots", { seed: "check-2-0", players: 2, quickjsGames: 0 });
    expect(report.replay?.ticks).toBe(60);
    const text = formatReport(report);
    expect(text).toMatch(/Tick \d+: p\d \{"type":"dir","dir":-?\d\}/);
    expect(text).toMatch(/60 ticks \(3 seconds of game time\)/);
  }, 60_000);
});

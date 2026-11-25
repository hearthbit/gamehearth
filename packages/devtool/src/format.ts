import { relative } from "node:path";
import { defaultOptions, localize, tickMs, type GameOptions, type OptionsSpec } from "@gamehearth/sdk/platform";
import { defaultMaxMoves, defaultMaxSeconds, defaultTimeoutMs, type CheckReport, type CountSummary } from "./check";
import { clockStart } from "./runner";
import type { Finding } from "./findings";

export function formatReport(report: CheckReport, cwd: string = process.cwd()): string {
  const where = (relative(cwd, report.gameDir) || ".").replaceAll("\\", "/");
  const command = replayCommand(where, report.settings, report.manifest?.options);
  const lines: string[] = [];
  lines.push(`Checking ${report.manifest === undefined ? where : localize(report.manifest.name, report.manifest.languages?.[0])} (${where})`, "");

  if (report.manifest !== undefined) {
    lines.push("Manifest: OK");
  }
  for (const note of report.notes) {
    lines.push(`Note: ${note}`);
  }

  const random = report.summaries.filter((summary) => summary.bots !== true);
  const withBot = report.summaries.filter((summary) => summary.bots === true);
  if (random.length > 0) {
    lines.push("", "Bot matches:");
    for (const summary of random) {
      lines.push(`  ${formatSummary(summary)}`);
    }
  }
  if (withBot.length > 0) {
    lines.push("", "Matches in which the game's bot plays every seat:");
    for (const summary of withBot) {
      lines.push(`  ${formatSummary(summary)}`);
    }
  }

  if (report.replay !== undefined) {
    const run = report.replay;
    const changed = changedOptions(report.manifest?.options, run.options);
    lines.push(
      "",
      `Match with seed ${run.seed} and ${players(run.playerCount)}${changed.length === 0 ? "" : `, options ${changed.join(", ")}`}${run.bots === true ? ", every seat played by the game's bot" : ""}:`,
    );
    const away = [...(run.away ?? [])];
    run.moves.forEach((move, index) => {
      const tick = Math.round((move.now - clockStart) / tickMs) + 1;
      while (run.ticks !== undefined && away.length > 0 && (away[0]?.tick ?? 0) <= tick) {
        lines.push(`  ${awayLine(away.shift())}`);
      }
      const label = run.ticks === undefined ? `Move ${index + 1}` : `Tick ${tick}`;
      lines.push(`  ${label}: ${move.player} ${JSON.stringify(move.action)}`);
    });
    for (const change of away) {
      lines.push(`  ${awayLine(change)}`);
    }
    if (run.ticks !== undefined) {
      lines.push(`  ${run.ticks} ticks (${Math.round((run.ticks * tickMs) / 1000)} seconds of game time)`);
    }
    lines.push(`  End: ${run.result === undefined ? "no result" : `winners ${run.result.winners.join(", ") || "none"}`}`);
  }

  const errors = report.findings.filter((finding) => finding.severity === "error");
  const warnings = report.findings.filter((finding) => finding.severity === "warning");
  for (const finding of report.findings) {
    lines.push("", ...formatFinding(finding, command, report.manifest?.options));
  }
  lines.push("", `Result: ${count(errors.length, "error", "errors")}, ${count(warnings.length, "warning", "warnings")}`);
  return lines.join("\n");
}

export function formatSummary(summary: CountSummary): string {
  const parts = [`${players(summary.playerCount)}: ${count(summary.games, "match", "matches")}`];
  if (summary.finished === summary.games) {
    parts.push("all finished");
  } else {
    parts.push(`${summary.finished} finished, ${summary.tooLong} too long, ${summary.failed} failed`);
  }
  if (summary.averageSeconds !== undefined) {
    parts.push(`on average ${summary.averageSeconds} s of game time (longest ${summary.longestSeconds ?? 0} s)${summary.bots === true ? "" : ` and ${summary.averageMoves} inputs`}`);
  } else {
    parts.push(`on average ${summary.averageMoves} moves (longest ${summary.longest})`);
  }
  if (summary.finished > 0) {
    const shares = Object.entries(summary.wins)
      .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
      .map(([seat, wins]) => `${seat} ${Math.round((wins / summary.finished) * 100)}%`);
    if (shares.length > 0) {
      parts.push(`wins: ${shares.join(", ")}`);
    }
    if (summary.shared > 0) {
      parts.push(`matches with several winners (count for each of them): ${summary.shared}`);
    }
    if (summary.withoutWinner > 0) {
      parts.push(`without a winner: ${summary.withoutWinner}`);
    }
  }
  return parts.join(", ");
}

function awayLine(change: { tick: number; seats: string[] } | undefined): string {
  if (change === undefined) {
    return "";
  }
  return `Tick ${change.tick}: ${change.seats.length === 0 ? "nobody is away" : `away: ${change.seats.join(", ")}`}`;
}

export function changedOptions(spec: OptionsSpec | undefined, options: GameOptions | undefined): string[] {
  const defaults = defaultOptions(spec);
  return Object.entries(options ?? {})
    .filter(([name, value]) => defaults[name] !== value)
    .map(([name, value]) => `${name}=${String(value)}`);
}

type Replay = (playerCount: number, seed: string, options: GameOptions | undefined, bots?: boolean) => string;

function replayCommand(where: string, settings: CheckReport["settings"], spec: OptionsSpec | undefined): Replay {
  const path = /^[\w./:-]+$/.test(where) ? where : `"${where}"`;
  const extra = [
    settings.maxMoves === defaultMaxMoves ? "" : ` --max-moves ${settings.maxMoves}`,
    settings.maxSeconds === defaultMaxSeconds ? "" : ` --max-seconds ${settings.maxSeconds}`,
    settings.timeoutMs === defaultTimeoutMs ? "" : ` --timeout ${settings.timeoutMs}`,
  ].join("");
  return (playerCount, seed, options, bots) => {
    const chosen = changedOptions(spec, options).map((entry) => ` --option ${/^[\w=.-]+$/.test(entry) ? entry : `"${entry}"`}`).join("");
    return `npm run gamehearth -- check ${path} --players ${playerCount} --seed ${seed}${bots === true ? " --bots" : ""}${chosen}${extra}`;
  };
}

function formatFinding(finding: Finding, command: Replay, spec: OptionsSpec | undefined): string[] {
  const label = finding.severity === "error" ? "ERROR  " : "WARNING";
  const lines = [`${label}  ${finding.message}`];
  if (finding.detail !== undefined) {
    lines.push(`         ${finding.detail}`);
  }
  const context: string[] = [];
  if (finding.playerCount !== undefined) context.push(players(finding.playerCount));
  if (finding.seed !== undefined) context.push(`seed ${finding.seed}`);
  if (finding.bots === true) context.push("every seat played by the game's bot");
  const changed = changedOptions(spec, finding.options);
  if (changed.length > 0) context.push(`options ${changed.join(", ")}`);
  if (finding.step !== undefined) context.push(finding.step === 0 ? "at the start" : `${finding.unit === "tick" ? "tick" : "move"} ${finding.step}`);
  if (finding.phase !== undefined) context.push(`in ${finding.phase}`);
  if (finding.player !== undefined) context.push(`seat ${finding.player}`);
  if ((finding.count ?? 1) > 1) context.push(`${finding.count} times in total`);
  if (context.length > 0) {
    lines.push(`         ${context.join(", ")}`);
  }
  if (finding.seed !== undefined && finding.playerCount !== undefined) {
    lines.push(`         Replay: ${command(finding.playerCount, finding.seed, finding.options, finding.bots === true)}`);
  }
  if (finding.stack !== undefined) {
    lines.push(...finding.stack.split("\n").map((line) => `         ${line.trim()}`));
  }
  return lines;
}

function count(value: number, singular: string, plural: string): string {
  return `${value === 0 ? "no" : value} ${value === 1 ? singular : plural}`;
}

export function players(count: number): string {
  return `${count} ${count === 1 ? "player" : "players"}`;
}

import type { GameOptions } from "@gamehearth/sdk/platform";

export type Severity = "error" | "warning";

export type FindingKind =
  | "manifest"
  | "client"
  | "cover"
  | "load"
  | "game-error"
  | "never-ends"
  | "nondeterministic"
  | "hang"
  | "leak"
  | "forbidden"
  | "suspicious"
  | "players"
  | "options"
  | "engine"
  | "sandbox"
  | "solo"
  | "profile"
  | "ids"
  | "bot";

export interface Finding {
  severity: Severity;
  kind: FindingKind;
  message: string;
  detail?: string;
  playerCount?: number;
  seed?: string;
  options?: GameOptions;
  bots?: true;
  step?: number;
  unit?: "tick";
  phase?: string;
  player?: string;
  stack?: string;
  count?: number;
}

export class FindingCollector {
  readonly #byKey = new Map<string, Finding>();

  add(finding: Finding): void {
    const key = `${finding.severity}|${finding.kind}|${finding.message}`;
    const existing = this.#byKey.get(key);
    if (existing === undefined) {
      this.#byKey.set(key, { ...finding, count: 1 });
    } else {
      existing.count = (existing.count ?? 1) + 1;
    }
  }

  addAll(findings: readonly Finding[]): void {
    for (const finding of findings) {
      this.add(finding);
    }
  }

  list(): Finding[] {
    return [...this.#byKey.values()].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  }
}

function severityRank(severity: Severity): number {
  return severity === "error" ? 0 : 1;
}

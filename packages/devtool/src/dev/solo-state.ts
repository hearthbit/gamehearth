import { maxStatValue, recordProblem, saveProblem, statNamePattern } from "@gamehearth/sdk/platform";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StatSpec } from "../manifest";
import type { SoloDevView } from "./view";

export type { SoloDevView };

export const soloSaveFile = join(".gamehearth", "dev-save.json");

export type SoloResult = { ok: true } | { ok: false; code: string; message: string };

interface Stored {
  saved: unknown;
  best: Record<string, number>;
  broken: boolean;
}

export class DevSoloState {
  readonly #file: string;
  readonly #stats: () => Record<string, StatSpec>;
  #problem: string | undefined;

  constructor(gameDir: string, stats: () => Record<string, StatSpec>) {
    this.#file = join(gameDir, soloSaveFile);
    this.#stats = stats;
  }

  get path(): string {
    return this.#file;
  }

  get problem(): string | undefined {
    this.#read();
    return this.#problem;
  }

  view(screen: SoloDevView["screen"]): SoloDevView {
    const stored = this.#read();
    return { file: soloSaveFile.split("\\").join("/"), saved: stored.saved, best: stored.best, stats: this.#stats(), screen, problem: this.#problem };
  }

  save(data: unknown): SoloResult {
    const problem = saveProblem(data);
    if (problem !== undefined) {
      return { ok: false, code: "invalid-save", message: problem };
    }
    const stored = this.#read();
    return this.#write(stored, { saved: data, best: stored.best });
  }

  record(stat: unknown, value: unknown): SoloResult {
    const problem = recordProblem(stat, value);
    if (problem !== undefined) {
      return { ok: false, code: "invalid-stat", message: problem };
    }
    const stats = this.#stats();
    const name = stat as string;
    const spec = Object.hasOwn(stats, name) ? stats[name] : undefined;
    if (spec === undefined) {
      const known = Object.keys(stats);
      return {
        ok: false,
        code: "invalid-stat",
        message: `The best score "${name}" does not exist. ${known.length === 0 ? "Add it under stats in manifest.json." : `Under stats in manifest.json there are: ${known.join(", ")}.`}`,
      };
    }
    const stored = this.#read();
    const current = Object.hasOwn(stored.best, name) ? stored.best[name] : undefined;
    const better = current === undefined || (spec.better === "higher" ? (value as number) > current : (value as number) < current);
    return better ? this.#write(stored, { saved: stored.saved, best: { ...stored.best, [name]: value as number } }) : { ok: true };
  }

  clearSave(): SoloResult {
    const stored = this.#read();
    return this.#write(stored, { saved: null, best: stored.best });
  }

  clearBest(): SoloResult {
    const stored = this.#read();
    return this.#write(stored, { saved: stored.saved, best: {} });
  }

  #read(): Stored {
    if (!existsSync(this.#file)) {
      this.#problem = undefined;
      return { saved: null, best: {}, broken: false };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#file, "utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
      this.#problem = `${soloSaveFile} is not valid JSON (${error instanceof Error ? error.message : String(error)}). The game starts without a save, and dev writes nothing to it until the file is repaired or deleted.`;
      return { saved: null, best: {}, broken: true };
    }
    const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const saved = record["saved"] ?? null;
    const problems: string[] = [];
    const savedProblem = saved === null ? undefined : saveProblem(saved);
    if (savedProblem !== undefined) {
      problems.push(savedProblem);
    }
    const best: Record<string, number> = {};
    const stats = this.#stats();
    const rawBest = record["best"];
    if (rawBest !== null && typeof rawBest === "object" && !Array.isArray(rawBest)) {
      for (const [stat, value] of Object.entries(rawBest as Record<string, unknown>)) {
        if (!statNamePattern.test(stat) || !Object.hasOwn(stats, stat)) {
          problems.push(`The best score "${stat}" does not exist; under stats in manifest.json there are: ${Object.keys(stats).join(", ") || "none"}. It is skipped.`);
        } else if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > maxStatValue) {
          problems.push(`The best score "${stat}" is not a finite number. It is skipped.`);
        } else {
          best[stat] = value;
        }
      }
    }
    this.#problem = problems.length === 0 ? undefined : `${soloSaveFile}: ${problems.join(" ")}`;
    return { saved: savedProblem === undefined ? saved : null, best, broken: false };
  }

  #write(current: Stored, next: Omit<Stored, "broken">): SoloResult {
    if (current.broken) {
      return { ok: false, code: "broken-save-file", message: this.#problem ?? `${soloSaveFile} is broken.` };
    }
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ saved: next.saved, best: next.best }, null, 2)}\n`);
      renameSync(temporary, this.#file);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: "platform-error", message: `${soloSaveFile} cannot be written: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

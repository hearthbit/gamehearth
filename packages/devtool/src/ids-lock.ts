import { catalogIds, catalogSections, profileIdPattern, type CatalogSection } from "@gamehearth/sdk/platform";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "./findings";
import { catalogOf, type Manifest } from "./manifest";

export type IdsLockMode = "write" | "verify";

export const idsLockFile = "ids.lock";

export const idsLockNote =
  "Maintained by gamehearth check. Every ID listed here stays in the game forever (in manifest.json, if need be with \"deprecated\": true). Only IDs that were never published may be removed by hand.";

export interface IdsLock {
  format: 1;
  items: string[];
  stats: string[];
  flags: string[];
}

export interface IdsLockReport {
  findings: Finding[];
  notes: string[];
  written: boolean;
}

export function idsLockMode(env: Readonly<Record<string, string | undefined>> = process.env): IdsLockMode {
  const ci = env["CI"];
  return ci !== undefined && ci !== "" && ci !== "false" && ci !== "0" ? "verify" : "write";
}

export function formatIdsLock(lock: IdsLock): string {
  return `${JSON.stringify({ format: 1, note: idsLockNote, items: lock.items, stats: lock.stats, flags: lock.flags }, null, 2)}\n`;
}

export function parseIdsLock(text: string): IdsLock | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return `${idsLockFile} is not valid JSON`;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || (raw as Record<string, unknown>)["format"] !== 1) {
    return `${idsLockFile} does not have the form { "format": 1, "items": [...], "stats": [...], "flags": [...] }`;
  }
  const record = raw as Record<string, unknown>;
  const lock: IdsLock = { format: 1, items: [], stats: [], flags: [] };
  for (const section of catalogSections) {
    const list = record[section] ?? [];
    if (!Array.isArray(list) || !list.every((id) => typeof id === "string" && profileIdPattern.test(id))) {
      return `${idsLockFile}: ${section} must be a list of IDs like "bait-worm"`;
    }
    lock[section] = [...new Set(list as string[])].sort();
  }
  return lock;
}

export async function checkIdsLock(dir: string, manifest: Manifest, mode: IdsLockMode): Promise<IdsLockReport> {
  const report: IdsLockReport = { findings: [], notes: [], written: false };
  const current = catalogIds(catalogOf(manifest));
  const file = join(dir, idsLockFile);
  let text: string | undefined;
  try {
    text = await readFile(file, "utf8");
  } catch {
    text = undefined;
  }
  const empty = catalogSections.every((section) => current[section].length === 0);
  if (text === undefined && empty) {
    return report;
  }
  const parsed = text === undefined ? { format: 1 as const, items: [], stats: [], flags: [] } : parseIdsLock(text);
  if (typeof parsed === "string") {
    report.findings.push({
      severity: "error",
      kind: "ids",
      message: `${parsed}. The file lists every ID the game ever had; restore it from the history (git) instead of creating it anew.`,
    });
    return report;
  }
  for (const section of catalogSections) {
    const missing = parsed[section].filter((id) => !current[section].includes(id));
    if (missing.length > 0) {
      report.findings.push({
        severity: "error",
        kind: "ids",
        message: `manifest.json: ${describeIds(section, missing)} in ${idsLockFile}, but ${missing.length === 1 ? "is" : "are"} missing under ${section}. Profiles outlive game versions; an ID that was published once must never disappear. Add it back and mark it with "deprecated": true. Only an ID that was never published may be deleted from ${idsLockFile} by hand.`,
      });
    }
  }
  const added = Object.fromEntries(catalogSections.map((section) => [section, current[section].filter((id) => !parsed[section].includes(id))])) as Record<
    CatalogSection,
    string[]
  >;
  const newIds = catalogSections.filter((section) => added[section].length > 0);
  if (newIds.length === 0 && text !== undefined) {
    return report;
  }
  const listed = newIds.map((section) => `${section}: ${added[section].join(", ")}`).join("; ");
  if (mode === "verify") {
    report.findings.push({
      severity: "error",
      kind: "ids",
      message:
        text === undefined
          ? `${idsLockFile} is missing, although manifest.json has IDs (${listed}). Run npm run check locally and commit ${idsLockFile}; in CI (CI set) check does not write the file itself.`
          : `${idsLockFile} is out of date, it lacks ${listed}. Run npm run check locally and commit ${idsLockFile}; in CI (CI set) check does not write the file itself.`,
    });
    return report;
  }
  const next: IdsLock = { format: 1, items: [], stats: [], flags: [] };
  for (const section of catalogSections) {
    next[section] = [...new Set([...parsed[section], ...current[section]])].sort();
  }
  await writeFile(file, formatIdsLock(next));
  report.written = true;
  report.notes.push(
    text === undefined
      ? `${idsLockFile} created with ${listed}. The file belongs in the repo; it records which IDs ever existed.`
      : `${idsLockFile}: newly added ${listed}. The change belongs in the repo.`,
  );
  return report;
}

function describeIds(section: CatalogSection, ids: readonly string[]): string {
  const names = ids.map((id) => `"${id}"`).join(", ");
  const one = section === "items" ? "The item" : section === "stats" ? "The stat" : "The flag";
  const many = section === "items" ? "The items" : section === "stats" ? "The stats" : "The flags";
  return ids.length === 1 ? `${one} ${names} is listed` : `${many} ${names} are listed`;
}

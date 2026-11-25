import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type BackupKind = "daily" | "manual" | "migration";

export interface BackupInfo {
  file: string;
  kind: BackupKind;
  createdAt: number;
  bytes: number;
}

export const dailyBackupsKept = 7;
export const backupIntervalMs = 24 * 60 * 60 * 1000;

const namePattern = /^gamehearth-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})-(daily|manual|migration)(?:-v\d+)?\.sqlite$/;

export function writeBackup(db: DatabaseSync, dir: string, kind: BackupKind, now: number, schemaVersion?: number): BackupInfo {
  mkdirSync(dir, { recursive: true });
  const suffix = kind === "migration" && schemaVersion !== undefined ? `${kind}-v${schemaVersion}` : kind;
  let stamp = now;
  let file = `gamehearth-${timestamp(stamp)}-${suffix}.sqlite`;
  while (existsSync(join(dir, file))) {
    stamp += 1;
    file = `gamehearth-${timestamp(stamp)}-${suffix}.sqlite`;
  }
  const temporary = join(dir, `${file}.tmp`);
  rmSync(temporary, { force: true });
  db.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
  renameSync(temporary, join(dir, file));
  return { file, kind, createdAt: stamp, bytes: statSync(join(dir, file)).size };
}

export function listBackups(dir: string): BackupInfo[] {
  if (!existsSync(dir)) {
    return [];
  }
  const backups: BackupInfo[] = [];
  for (const file of readdirSync(dir)) {
    const match = namePattern.exec(file);
    if (match === null) {
      continue;
    }
    const [year, month, day, hour, minute, second, milli] = match.slice(1, 8).map(Number) as [number, number, number, number, number, number, number];
    backups.push({
      file,
      kind: match[8] as BackupKind,
      createdAt: Date.UTC(year, month - 1, day, hour, minute, second, milli),
      bytes: statSync(join(dir, file)).size,
    });
  }
  return backups.sort((a, b) => b.createdAt - a.createdAt || b.file.localeCompare(a.file));
}

export function pruneBackups(dir: string, keep = dailyBackupsKept): string[] {
  const all = listBackups(dir);
  const removed = (["daily", "manual"] as const).flatMap((kind) =>
    all
      .filter((backup) => backup.kind === kind)
      .slice(keep)
      .map((backup) => backup.file),
  );
  for (const file of removed) {
    rmSync(join(dir, file), { force: true });
  }
  return removed;
}

export function backupIfDue(db: DatabaseSync, dir: string, now: number, intervalMs = backupIntervalMs): BackupInfo | undefined {
  const latest = listBackups(dir).find((backup) => backup.kind === "daily");
  if (latest !== undefined && now - latest.createdAt < intervalMs) {
    return undefined;
  }
  const backup = writeBackup(db, dir, "daily", now);
  pruneBackups(dir);
  return backup;
}

function timestamp(time: number): string {
  const date = new Date(time);
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}-${pad(date.getUTCMilliseconds(), 3)}`;
}

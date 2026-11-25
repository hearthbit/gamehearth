import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupIfDue, listBackups, pruneBackups, writeBackup } from "../src/backup";
import { migrate, openDatabase, schemaVersion, userVersion } from "../src/db";

let dir: string;
const day = 24 * 60 * 60 * 1000;
const start = Date.UTC(2026, 10, 17, 9, 30, 0, 5);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gamehearth-backup-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function oldDatabase(version: number): string {
  const file = join(dir, "alt.sqlite");
  const db = new DatabaseSync(file);
  migrate(db, version);
  db.prepare("INSERT INTO rooms (code, game_id, build, status, created_at, updated_at) VALUES ('ABCDEF', 'mau-mau', 'b', 'lobby', 1, 1)").run();
  db.close();
  return file;
}

describe("Database backup", () => {
  it("backs up the old state before a migration and migrates afterwards", () => {
    const logs: string[] = [];
    const file = oldDatabase(1);
    const db = openDatabase(file, { backupDir: join(dir, "backups"), clock: () => start, log: (message) => logs.push(message) });
    expect(userVersion(db)).toBe(schemaVersion);
    db.close();
    const backups = listBackups(join(dir, "backups"));
    expect(backups).toEqual([{ file: "gamehearth-20261117-093000-005-migration-v1.sqlite", kind: "migration", createdAt: start, bytes: expect.any(Number) }]);
    const copy = new DatabaseSync(join(dir, "backups", backups[0]?.file as string));
    expect(userVersion(copy)).toBe(1);
    expect(copy.prepare("SELECT code FROM rooms").all()).toEqual([{ code: "ABCDEF" }]);
    copy.close();
    expect(logs).toEqual([expect.stringContaining("from version 1 to")]);
  });

  it("does not back up a new or current database", () => {
    openDatabase(join(dir, "neu.sqlite"), { backupDir: join(dir, "backups") }).close();
    openDatabase(join(dir, "neu.sqlite"), { backupDir: join(dir, "backups") }).close();
    expect(listBackups(join(dir, "backups"))).toEqual([]);
  });

  it("backs up daily, keeps seven and leaves migration copies alone", () => {
    const backups = join(dir, "backups");
    const db = openDatabase(oldDatabase(1), { backupDir: backups, clock: () => start });
    expect(backupIfDue(db, backups, start)?.kind).toBe("daily");
    expect(backupIfDue(db, backups, start + day - 1)).toBeUndefined();
    for (let index = 1; index <= 9; index++) {
      expect(backupIfDue(db, backups, start + index * day)?.kind).toBe("daily");
    }
    writeBackup(db, backups, "manual", start + 10 * day);
    expect(pruneBackups(backups)).toHaveLength(0);
    const kept = listBackups(backups);
    expect(kept.filter((backup) => backup.kind === "migration")).toHaveLength(1);
    expect(kept.filter((backup) => backup.kind !== "migration").map((backup) => backup.kind)).toEqual(["manual", ...Array(7).fill("daily")]);
    expect(backupIfDue(db, backups, start + 10 * day + 1)?.kind).toBe("daily");
    db.close();
  });

  it("overwrites nothing and ignores other files", () => {
    const backups = join(dir, "backups");
    const db = openDatabase(join(dir, "neu.sqlite"));
    writeBackup(db, backups, "manual", start);
    writeBackup(db, backups, "manual", start);
    writeFileSync(join(backups, "notizen.txt"), "x");
    writeFileSync(join(backups, "gamehearth-20261117-093000-005-manual.sqlite.tmp"), "halb");
    expect(listBackups(backups).map((backup) => backup.file)).toEqual([
      "gamehearth-20261117-093000-006-manual.sqlite",
      "gamehearth-20261117-093000-005-manual.sqlite",
    ]);
    expect(readdirSync(backups)).toHaveLength(4);
    db.close();
  });
});

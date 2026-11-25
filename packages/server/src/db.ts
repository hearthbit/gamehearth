import { DatabaseSync } from "node:sqlite";
import { writeBackup } from "./backup";

const migrations = [
  `
  CREATE TABLE rooms (
    code TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    build TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('lobby', 'running', 'finished')),
    version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    match TEXT
  );
  CREATE INDEX rooms_by_activity ON rooms (status, updated_at);
  CREATE TABLE members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    host INTEGER NOT NULL DEFAULT 0,
    seat TEXT,
    joined_at INTEGER NOT NULL
  );
  CREATE INDEX members_by_room ON members (room_code, id);
  CREATE TABLE history (
    room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('move', 'refresh')),
    seat TEXT,
    action TEXT,
    now INTEGER NOT NULL,
    profiles TEXT,
    PRIMARY KEY (room_code, version)
  );
  `,
  `
  ALTER TABLE rooms ADD COLUMN round INTEGER NOT NULL DEFAULT 1;
  CREATE TABLE history_by_round (
    room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    version INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('move', 'refresh')),
    seat TEXT,
    action TEXT,
    now INTEGER NOT NULL,
    profiles TEXT,
    PRIMARY KEY (room_code, round, version)
  );
  INSERT INTO history_by_round (room_code, round, version, kind, seat, action, now, profiles)
    SELECT room_code, 1, version, kind, seat, action, now, profiles FROM history;
  DROP TABLE history;
  ALTER TABLE history_by_round RENAME TO history;
  CREATE TABLE rounds (
    room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    build TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('finished', 'aborted')),
    match TEXT NOT NULL,
    ended_at INTEGER NOT NULL,
    PRIMARY KEY (room_code, round)
  );
  `,
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('account', 'guest')),
    username TEXT UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
    locked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    active_at INTEGER NOT NULL,
    CHECK ((kind = 'account') = (username IS NOT NULL))
  );
  CREATE INDEX users_by_activity ON users (kind, active_at);
  CREATE TABLE credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('password')),
    secret TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX credentials_one_password ON credentials (user_id) WHERE kind = 'password';
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    adopt_guest_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    agent TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL,
    expires_at INTEGER
  );
  CREATE INDEX sessions_by_user ON sessions (user_id);
  CREATE TABLE links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('setup', 'invite', 'reset')),
    role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    note TEXT,
    username TEXT,
    display_name TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  INSERT INTO users (id, kind, display_name, created_at, active_at)
    SELECT id, 'guest', name, joined_at, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) FROM members;
  CREATE TABLE members_by_user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    legacy_token_hash TEXT UNIQUE,
    host INTEGER NOT NULL DEFAULT 0,
    seat TEXT,
    joined_at INTEGER NOT NULL,
    UNIQUE (room_code, user_id)
  );
  INSERT INTO members_by_user (id, room_code, user_id, legacy_token_hash, host, seat, joined_at)
    SELECT id, room_code, id, token_hash, host, seat, joined_at FROM members;
  DROP TABLE members;
  ALTER TABLE members_by_user RENAME TO members;
  CREATE INDEX members_by_room ON members (room_code, id);
  CREATE INDEX members_by_user_id ON members (user_id);
  `,
  `
  CREATE TABLE settings (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    failing_since INTEGER
  );
  ALTER TABLE members ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE transfer_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX transfer_codes_by_user ON transfer_codes (user_id);
  `,
  `
  CREATE TABLE catalogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    checked_at INTEGER NOT NULL,
    error TEXT,
    added_at INTEGER NOT NULL
  );
  CREATE TABLE installed_games (
    game_id TEXT PRIMARY KEY,
    build TEXT NOT NULL,
    version TEXT NOT NULL,
    catalog_id INTEGER REFERENCES catalogs(id) ON DELETE SET NULL,
    installed_at INTEGER NOT NULL
  );
  CREATE INDEX rooms_by_game ON rooms (game_id, status);
  `,
  `
  CREATE TABLE screens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    device_hash TEXT NOT NULL UNIQUE,
    paired_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL
  );
  CREATE INDEX screens_by_room ON screens (room_code, id);
  `,
  `
  CREATE TABLE solo_saves (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id TEXT NOT NULL,
    data TEXT,
    saved_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, game_id)
  );
  CREATE TABLE stats (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id TEXT NOT NULL,
    stat TEXT NOT NULL,
    value REAL,
    source TEXT NOT NULL DEFAULT 'client' CHECK (source IN ('client', 'server')),
    updated_at INTEGER NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, game_id, stat)
  );
  CREATE INDEX stats_by_game ON stats (game_id, stat, value);
  `,
  `
  ALTER TABLE rooms ADD COLUMN options TEXT;
  `,
  `
  CREATE TABLE profiles (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id TEXT NOT NULL,
    items TEXT NOT NULL DEFAULT '{}',
    flags TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, game_id)
  );
  CREATE INDEX profiles_by_game ON profiles (game_id);
  ALTER TABLE rooms ADD COLUMN guest_profiles TEXT;
  CREATE TABLE history_with_start (
    room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    version INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('start', 'move', 'refresh')),
    seat TEXT,
    action TEXT,
    now INTEGER NOT NULL,
    profiles TEXT,
    PRIMARY KEY (room_code, round, version)
  );
  INSERT INTO history_with_start (room_code, round, version, kind, seat, action, now, profiles)
    SELECT room_code, round, version, kind, seat, action, now, profiles FROM history;
  DROP TABLE history;
  ALTER TABLE history_with_start RENAME TO history;
  `,
  `
  ALTER TABLE users ADD COLUMN language TEXT;
  ALTER TABLE push_subscriptions ADD COLUMN language TEXT;
  ALTER TABLE catalogs ADD COLUMN error_code TEXT;
  `,
  `
  ALTER TABLE users ADD COLUMN theme TEXT;
  `,
  `
  ALTER TABLE members ADD COLUMN bot INTEGER;
  ALTER TABLE members ADD COLUMN autopilot INTEGER NOT NULL DEFAULT 0;
  `,
];

export const schemaVersion = migrations.length;

export interface DatabaseOptions {
  backupDir?: string;
  clock?: () => number;
  log?: (message: string) => void;
}

export function openDatabase(file: string, options: DatabaseOptions = {}): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  const current = userVersion(db);
  if (options.backupDir !== undefined && current > 0 && current < migrations.length) {
    const backup = writeBackup(db, options.backupDir, "migration", (options.clock ?? Date.now)(), current);
    options.log?.(`Database backed up before the migration from version ${current} to ${migrations.length}: ${backup.file}`);
  }
  migrate(db);
  return db;
}

export function userVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function migrate(db: DatabaseSync, target = migrations.length): void {
  for (let version = userVersion(db); version < target; version++) {
    transaction(db, () => {
      db.exec(migrations[version] as string);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

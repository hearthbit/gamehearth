import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { AccountService } from "../src/accounts";
import { openDatabase } from "../src/db";
import { GameLibrary } from "../src/games";
import { RoomService, type RoomServiceOptions } from "../src/rooms";
import { SandboxHost, type SandboxHostOptions } from "../src/sandbox/host";

export const mauMauSource = fileURLToPath(new URL("../../../fixtures/mau-mau", import.meta.url));
export const mauMauDir = withStubClient(mauMauSource);
export const wettlaufSource = fileURLToPath(new URL("../../../fixtures/wettlauf", import.meta.url));
export const wettlaufDir = withStubClient(wettlaufSource);
export const gluecksradSource = fileURLToPath(new URL("../../../fixtures/gluecksrad", import.meta.url));
export const gluecksradDir = withStubClient(gluecksradSource);
export const dorfladenSource = fileURLToPath(new URL("../../../fixtures/dorfladen", import.meta.url));
export const dorfladenDir = withStubClient(dorfladenSource);
export const sammeltakt = fileURLToPath(new URL("./fixtures/sammeltakt", import.meta.url));
export const takt = fileURLToPath(new URL("./fixtures/takt", import.meta.url));
export const wachsend = fileURLToPath(new URL("./fixtures/wachsend", import.meta.url));
export const tickfehler = fileURLToPath(new URL("./fixtures/tickfehler", import.meta.url));
export const zaehlenV1 = fileURLToPath(new URL("./fixtures/zaehlen-v1", import.meta.url));
export const zaehlenV2 = fileURLToPath(new URL("./fixtures/zaehlen-v2", import.meta.url));
export const startfehler = fileURLToPath(new URL("./fixtures/startfehler", import.meta.url));

export const cheapPasswords = { N: 1024, r: 8, p: 1 };

export interface Seat {
  code: string;
  user: number;
  token: string;
}

export interface Setup {
  dir: string;
  db: DatabaseSync;
  sandbox: SandboxHost;
  library: GameLibrary;
  rooms: RoomService;
  accounts: AccountService;
  logs: string[];
  reopen(): Promise<Setup>;
  cleanup(): Promise<void>;
}

export async function createSetup(
  dir = mkdtempSync(join(tmpdir(), "gamehearth-server-")),
  sandboxOptions: Partial<SandboxHostOptions> = {},
  roomOptions: Partial<RoomServiceOptions> = {},
): Promise<Setup> {
  const logs: string[] = [];
  const log = (message: string) => logs.push(message);
  const sandbox = await SandboxHost.start({ log, ...sandboxOptions });
  const db = openDatabase(join(dir, "test.sqlite"));
  const library = new GameLibrary(join(dir, "builds"), sandbox, db);
  let clock = 1_000;
  const rooms = new RoomService(db, library, sandbox, { serverMaxPlayers: 12, clock: () => (clock += 1000), log, ...roomOptions });
  const accounts = new AccountService(db, { passwordCost: cheapPasswords });
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      rooms.stop();
      db.close();
      await sandbox.close();
    }
  };
  return {
    dir,
    db,
    sandbox,
    library,
    rooms,
    accounts,
    logs,
    async reopen() {
      await close();
      return createSetup(dir, sandboxOptions, roomOptions);
    },
    async cleanup() {
      await close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let accountNumber = 0;

export function account(setup: Setup, name: string, role: "player" | "admin" = "player"): { user: number; token: string } {
  const db = setup.db;
  const now = Date.now();
  accountNumber += 1;
  const username = `${name.replace(/[^A-Za-z0-9._-]/g, "") || "user"}-${accountNumber}`;
  const id = Number(
    db
      .prepare("INSERT INTO users (kind, username, display_name, role, created_at, active_at) VALUES ('account', ?, ?, ?, ?, ?)")
      .run(username, name, role, now, now).lastInsertRowid,
  );
  return { user: id, token: setup.accounts.createSession(id).token };
}

export function guest(setup: Setup, name: string): { user: number; token: string } {
  const user = setup.accounts.createGuest(name);
  return { user: user.id, token: setup.accounts.createSession(user.id).token };
}

export function hostRoom(setup: Setup, game: string, name: string): Seat {
  const host = account(setup, name);
  return { ...setup.rooms.createRoom(game, host.user), ...host };
}

export async function joinRoom(setup: Setup, code: string, name: string): Promise<Seat> {
  const member = guest(setup, name);
  const joined = await setup.rooms.joinRoom(code, member.user);
  return { code: joined.code, ...member };
}

export function withStubClient(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gamehearth-mau-mau-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(source, "src"), join(dir, "src"), { recursive: true });
  const sdk = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url)).replaceAll("\\", "/");
  for (const file of readdirSync(join(dir, "src"))) {
    const path = join(dir, "src", file);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll('"@gamehearth/sdk"', JSON.stringify(sdk)));
  }
  const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, client: "client" }, null, 2));
  mkdirSync(join(dir, "client", "assets"), { recursive: true });
  writeFileSync(join(dir, "client", "index.html"), '<!doctype html><meta charset="utf-8"><script type="module" src="./assets/main.js"></script>');
  writeFileSync(join(dir, "client", "assets", "main.js"), "document.body.textContent = 'Mau-Mau';");
  if (typeof manifest["cover"] === "string") {
    writeFileSync(join(dir, "client", manifest["cover"]), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"><rect width="4" height="3" fill="#7ec8e3"/></svg>');
  }
  return dir;
}

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AccountService } from "./accounts";
import { backupIfDue, listBackups, pruneBackups, writeBackup } from "./backup";
import { CatalogService } from "./catalogs";
import { cleanUp, describeCleanup } from "./cleanup";
import { readConfig } from "./config";
import { openDatabase } from "./db";
import { defaultText, GameLibrary } from "./games";
import { PushService } from "./push/service";
import { RoomService } from "./rooms";
import { SandboxHost } from "./sandbox/host";
import { SoloService } from "./solo";
import { startServer } from "./transport";

const lobbyIdleMs = 24 * 60 * 60 * 1000;
const sweepMs = 10 * 60 * 1000;

const config = readConfig(process.env);
if (Array.isArray(config)) {
  for (const problem of config) {
    console.error(problem);
  }
  process.exit(1);
}

mkdirSync(config.dataDir, { recursive: true });
const backupDir = join(config.dataDir, "backups");
const db = openDatabase(join(config.dataDir, "gamehearth.sqlite"), { backupDir, log: console.log });
const backup = () => {
  try {
    const written = backupIfDue(db, backupDir, Date.now());
    if (written !== undefined) {
      console.log(`Database backed up: ${written.file}`);
    }
  } catch (error) {
    console.error(`Database backup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};
backup();
const backupTimer = setInterval(backup, 60 * 60 * 1000);
backupTimer.unref();
const sandbox = await SandboxHost.start();
const library = new GameLibrary(join(config.dataDir, "builds"), sandbox, db, { maxPlayers: config.serverMaxPlayers, log: console.error });
for (const problem of await library.restore()) {
  console.error(`Game not available: ${problem}`);
}
if (config.gamesDir !== undefined) {
  const report = await library.installAll(config.gamesDir);
  for (const build of report.installed) {
    console.log(`Local game from GAMES_DIR: ${defaultText(build.manifest.name, build.manifest.languages)} (${build.build})`);
  }
  for (const problem of report.problems) {
    console.error(`Game not installed: ${problem}`);
  }
}
const installedGames = library.installed();
console.log(
  installedGames.length === 0
    ? 'No games installed yet; an admin manages catalogs and games in the admin view ("Verwaltung")'
    : `Games: ${installedGames.map((game) => `${defaultText(game.name, game.languages)} ${game.version}${game.source === "local" ? " (local)" : ""}`).join(", ")}`,
);
const catalogs = new CatalogService(db, library, { log: console.error });
const day = 24 * 60 * 60 * 1000;
const rooms = new RoomService(db, library, sandbox, {
  serverMaxPlayers: config.serverMaxPlayers,
  maxHostedRooms: config.maxHostedRooms,
  maxRoomsPerUser: config.maxRoomsPerUser,
  lobbyIdleMs,
  finishedRoomMs: config.finishedRoomDays * day,
  idleGameMs: config.idleGameDays * day,
});
for (const game of installedGames.filter((entry) => entry.source === "local")) {
  rooms.gameChanged(game.id);
}
const restored = await rooms.restoreRealtime();
if (restored.length > 0) {
  console.log(`Realtime matches paused until everyone is back: ${restored.join(", ")}`);
}
rooms.restoreBots();
const accounts = new AccountService(db, { guestIdleMs: config.guestDays * day });
const push = new PushService(db, { contact: config.pushContact, hosts: config.pushHosts, log: console.error });
console.log(`Web Push ready: ${push.count()} subscriptions${config.pushContact === undefined ? "" : `, contact ${config.pushContact}`}`);
const setup = accounts.ensureSetupLink();
if (setup !== undefined) {
  console.log(`Gamehearth is not set up yet. Open this link on your server to create the first admin (valid for 24 hours or until the next start): /setup#${setup}`);
}
const tidy = () => {
  try {
    const message = describeCleanup(cleanUp(rooms, accounts, lobbyIdleMs));
    if (message !== undefined) {
      console.log(message);
    }
  } catch (error) {
    console.error(`Cleanup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
  void library.sweep(() => rooms.referencedBuilds()).then(
    (removed) => {
      if (removed.length > 0) {
        console.log(`Old builds deleted: ${removed.join(", ")}`);
      }
    },
    (error: unknown) => console.error(`Cleaning up builds failed: ${error instanceof Error ? error.message : String(error)}`),
  );
  void catalogs.refreshDue();
};
tidy();
const sweep = setInterval(tidy, sweepMs);
sweep.unref();
if (!existsSync(join(config.clientDir, "index.html"))) {
  console.error(`UI missing in ${config.clientDir}; pages answer with 503 until it is built (npm run build)`);
}
const running = await startServer({
  rooms,
  accounts,
  library,
  port: config.port,
  trustProxy: config.trustProxy,
  clientDir: config.clientDir,
  quarantine: () => sandbox.quarantinedBuilds(),
  push,
  catalogs,
  solo: new SoloService(db, library),
  backups: {
    list: () => listBackups(backupDir),
    create: () => {
      const written = writeBackup(db, backupDir, "manual", Date.now());
      pruneBackups(backupDir);
      console.log(`Database backed up on request: ${written.file}`);
      return written;
    },
  },
});
console.log(`Gamehearth running on port ${running.port}, data in ${config.dataDir}`);

const shutdown = () => {
  clearInterval(sweep);
  clearInterval(backupTimer);
  rooms.stop();
  push.close();
  void running
    .close()
    .then(() => sandbox.close())
    .then(() => {
      db.close();
      process.exit(0);
    });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

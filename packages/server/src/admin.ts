import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AccountService } from "./accounts";
import { runAdminCommand } from "./admin-commands";
import { openDatabase } from "./db";

const dataDir = resolve(process.env["DATA_DIR"] || "data");
const file = join(dataDir, "gamehearth.sqlite");
if (!existsSync(file)) {
  console.error(`No database at ${file}. Is DATA_DIR correct, and has the server been started before?`);
  process.exit(1);
}
const db = openDatabase(file, { backupDir: join(dataDir, "backups"), log: console.log });
const result = runAdminCommand(process.argv.slice(2), new AccountService(db));
db.close();
(result.ok ? console.log : console.error)(result.output);
process.exit(result.ok ? 0 : 1);

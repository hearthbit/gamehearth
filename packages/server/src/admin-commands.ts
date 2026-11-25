import type { AccountService } from "./accounts";

export const adminUsage = `Usage:
  admin-link [--url https://games.example.org]             one-time link for a new admin account (24 hours)
  reset-link <username> [--url https://games.example.org]  one-time link to reset the password (24 hours)`;

const day = 24 * 60 * 60 * 1000;

export function runAdminCommand(args: readonly string[], accounts: AccountService): { ok: boolean; output: string } {
  const rest = [...args];
  let base = "";
  const urlIndex = rest.indexOf("--url");
  if (urlIndex >= 0) {
    const value = rest[urlIndex + 1];
    if (value === undefined || !/^https?:\/\/[^\s/#]+/.test(value)) {
      return { ok: false, output: `--url needs an address like https://games.example.org\n\n${adminUsage}` };
    }
    base = value.replace(/\/+$/, "");
    rest.splice(urlIndex, 2);
  }
  const [command, ...params] = rest;
  if (command === "admin-link" && params.length === 0) {
    const { token } = accounts.createInvite(undefined, { role: "admin", note: "Emergency link from the command line", expiresInMs: day });
    return { ok: true, output: `Invite for a new admin (valid for 24 hours, single use):\n${base}/invite#${token}` };
  }
  if (command === "reset-link" && params.length === 1) {
    const user = accounts.findAccount(params[0] as string);
    if (user === undefined) {
      return { ok: false, output: `There is no account ${params[0] ?? ""}` };
    }
    const token = accounts.createResetLink(user.id);
    return { ok: true, output: `Password reset link for ${user.username ?? ""} (valid for 24 hours, single use):\n${base}/reset#${token}` };
  }
  return { ok: false, output: adminUsage };
}

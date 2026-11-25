import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validContact, validPushHost } from "./push/service";

export interface Config {
  port: number;
  serverMaxPlayers: number;
  dataDir: string;
  gamesDir: string | undefined;
  clientDir: string;
  trustProxy: boolean;
  maxHostedRooms: number;
  maxRoomsPerUser: number;
  guestDays: number;
  finishedRoomDays: number;
  idleGameDays: number;
  pushContact: string | undefined;
  pushHosts: string[];
}

export const defaultClientDir = fileURLToPath(new URL("../../client/dist", import.meta.url));

export function readConfig(env: Record<string, string | undefined>): Config | string[] {
  const problems: string[] = [];
  const wholeNumber = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") {
      return fallback;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
      return fallback;
    }
    return value;
  };
  const trust = env["TRUST_PROXY"];
  if (trust !== undefined && trust !== "" && trust !== "0" && trust !== "1") {
    problems.push(`TRUST_PROXY must be 0 or 1, got "${trust}"`);
  }
  const contact = env["PUSH_CONTACT"]?.trim() || undefined;
  if (contact !== undefined && !validContact(contact)) {
    problems.push(`PUSH_CONTACT must start with mailto: or https://, got "${contact}"`);
  }
  const pushHosts = (env["PUSH_HOSTS"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (const entry of pushHosts) {
    if (!validPushHost(entry)) {
      problems.push(`PUSH_HOSTS contains "${entry}"; allowed are hosts (push.example.org), patterns (*.push.example.org) and origins (https://push.example.org:8443)`);
    }
  }
  const config: Config = {
    port: wholeNumber("PORT", 8080, 0, 65_535),
    serverMaxPlayers: wholeNumber("MAX_PLAYERS", 12, 1, 100),
    dataDir: resolve(env["DATA_DIR"] || "data"),
    gamesDir: env["GAMES_DIR"] ? resolve(env["GAMES_DIR"]) : undefined,
    clientDir: resolve(env["CLIENT_DIR"] || defaultClientDir),
    trustProxy: trust === "1",
    maxHostedRooms: wholeNumber("MAX_HOSTED_ROOMS", 20, 1, 10_000),
    maxRoomsPerUser: wholeNumber("MAX_ROOMS_PER_USER", 50, 1, 10_000),
    guestDays: wholeNumber("GUEST_DAYS", 30, 1, 3650),
    finishedRoomDays: wholeNumber("FINISHED_ROOM_DAYS", 30, 1, 3650),
    idleGameDays: wholeNumber("IDLE_GAME_DAYS", 90, 1, 3650),
    pushContact: contact,
    pushHosts,
  };
  return problems.length > 0 ? problems : config;
}

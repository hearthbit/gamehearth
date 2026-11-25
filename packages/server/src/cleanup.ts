import type { AccountService } from "./accounts";
import type { RoomService } from "./rooms";

export interface CleanupReport {
  lobbies: number;
  rooms: number;
  guests: number;
}

export function cleanUp(rooms: RoomService, accounts: AccountService, lobbyIdleMs: number): CleanupReport {
  const lobbies = rooms.expireIdleLobbies(lobbyIdleMs).length;
  const expiredRooms = rooms.expireRooms().length;
  const guests = accounts.expiredGuests();
  for (const guest of guests) {
    rooms.removeUser(guest);
    accounts.deleteUser(guest);
  }
  accounts.sweep();
  return { lobbies, rooms: expiredRooms, guests: guests.length };
}

export function describeCleanup(report: CleanupReport): string | undefined {
  const parts = [
    report.lobbies > 0 ? `${report.lobbies} orphaned lobbies` : undefined,
    report.rooms > 0 ? `${report.rooms} old rooms` : undefined,
    report.guests > 0 ? `${report.guests} expired guests` : undefined,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : `Cleaned up: ${parts.join(", ")}`;
}

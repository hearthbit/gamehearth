import { cloneProfile, emptyProfile, profileProblem, readProfile, type ProfileData } from "@gamehearth/sdk/platform";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const devProfilesFile = join(".gamehearth", "dev-profiles.json");

export type ProfilesResult = { ok: true } | { ok: false; code: string; message: string };

interface Stored {
  seats: Record<string, ProfileData>;
  guests: string[];
  broken: boolean;
}

const seatPattern = /^p\d{1,2}$/;
const untilRepaired = "dev writes nothing to it until it is repaired; after that, start a new match.";

export class DevProfiles {
  readonly #file: string;
  #problem: string | undefined;

  constructor(gameDir: string) {
    this.#file = join(gameDir, devProfilesFile);
  }

  get path(): string {
    return this.#file;
  }

  get problem(): string | undefined {
    this.#read();
    return this.#problem;
  }

  profile(seat: string): ProfileData {
    const stored = this.#read();
    const profile = Object.hasOwn(stored.seats, seat) ? stored.seats[seat] : undefined;
    return profile === undefined ? emptyProfile() : cloneProfile(profile);
  }

  guests(): string[] {
    return [...this.#read().guests];
  }

  isGuest(seat: string): boolean {
    return this.#read().guests.includes(seat);
  }

  save(profiles: Readonly<Record<string, ProfileData>>, guests: readonly string[]): ProfilesResult {
    const stored = this.#read();
    const seats = { ...stored.seats };
    for (const [seat, profile] of Object.entries(profiles)) {
      if (!guests.includes(seat)) {
        seats[seat] = cloneProfile(profile);
      }
    }
    return this.#write(stored, { seats, guests: stored.guests });
  }

  setGuest(seat: string, guest: boolean): ProfilesResult {
    const stored = this.#read();
    const guests = guest ? [...new Set([...stored.guests, seat])].sort() : stored.guests.filter((entry) => entry !== seat);
    return this.#write(stored, { seats: stored.seats, guests });
  }

  #read(): Stored {
    if (!existsSync(this.#file)) {
      this.#problem = undefined;
      return { seats: {}, guests: [], broken: false };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#file, "utf8").replace(/^﻿/, ""));
    } catch (error) {
      this.#problem = `${devProfilesFile} is not valid JSON (${error instanceof Error ? error.message : String(error)}). All seats play with empty profiles, and ${untilRepaired}`;
      return { seats: {}, guests: [], broken: true };
    }
    const problems: string[] = [];
    const seats: Record<string, ProfileData> = {};
    let guests: string[] = [];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      problems.push(`The file must be an object of the form { "seats": { "p1": { … } }, "guests": [] }, but is ${Array.isArray(raw) ? "a list" : JSON.stringify(raw)}.`);
    } else {
      const record = raw as Record<string, unknown>;
      for (const key of Object.keys(record).filter((entry) => entry !== "seats" && entry !== "guests")) {
        problems.push(`The key ${JSON.stringify(key.slice(0, 40))} does not exist; allowed are "seats" and "guests".`);
      }
      const rawSeats = record["seats"];
      if (rawSeats !== undefined && (rawSeats === null || typeof rawSeats !== "object" || Array.isArray(rawSeats))) {
        problems.push(`"seats" must be an object with one profile per seat, e.g. { "p1": { "items": { … } } }.`);
      } else if (rawSeats !== undefined) {
        for (const [seat, profile] of Object.entries(rawSeats as Record<string, unknown>)) {
          const problem = seatPattern.test(seat) ? profileProblem(profile) : "seats are called p1, p2 and so on";
          if (problem === undefined) {
            seats[seat] = readProfile(profile);
          } else {
            problems.push(`seats.${seat.slice(0, 20)}: ${problem}. The seat starts with an empty profile.`);
          }
        }
      }
      const rawGuests = record["guests"];
      if (rawGuests !== undefined && !(Array.isArray(rawGuests) && rawGuests.every((seat) => typeof seat === "string" && seatPattern.test(seat)))) {
        problems.push(`"guests" must be a list of seats, e.g. ["p2"].`);
      } else if (Array.isArray(rawGuests)) {
        guests = [...(rawGuests as string[])];
      }
    }
    this.#problem = problems.length === 0 ? undefined : `${devProfilesFile}: ${problems.join(" ")} ${untilRepaired}`;
    return { seats, guests, broken: problems.length > 0 };
  }

  #write(current: Stored, next: Omit<Stored, "broken">): ProfilesResult {
    if (current.broken) {
      return { ok: false, code: "broken-profiles-file", message: this.#problem ?? `${devProfilesFile} is broken.` };
    }
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.tmp`;
      const seats = Object.fromEntries(Object.keys(next.seats).sort().map((seat) => [seat, next.seats[seat]]));
      writeFileSync(temporary, `${JSON.stringify({ seats, guests: next.guests }, null, 2)}\n`);
      renameSync(temporary, this.#file);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: "platform-error", message: `${devProfilesFile} cannot be written: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
